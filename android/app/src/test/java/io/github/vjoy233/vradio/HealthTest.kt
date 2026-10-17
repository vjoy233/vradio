package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.check.Health
import io.github.vjoy233.vradio.model.FavEntry
import io.github.vjoy233.vradio.model.HealthEntry
import io.github.vjoy233.vradio.model.RecentEntry
import io.github.vjoy233.vradio.model.Station
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* 死台分档生命周期：normalize 兼容与 TTL / onDead 升级停运档 / onAlive 撤销 / toJson 往返 /
   bootScope（收藏+最近 ∪ 死标记、节流与封顶、隐藏跳过、URL 回绑）。 */
class HealthTest {
  private val DAY = 86400000L
  private val NOW = 100L * DAY

  private fun st(name: String, vararg urls: String, cat: String = "华语音乐", hidden: Boolean = false) =
    Station(cat, name, urls.toMutableList(), hidden = hidden)

  @Test fun normalize空与坏JSON() {
    assertTrue(Health.normalize(null).isEmpty())
    assertTrue(Health.normalize("").isEmpty())
    assertTrue(Health.normalize("not json{").isEmpty())
    assertTrue(Health.normalize("{}").isEmpty())
  }

  @Test fun normalize旧格式兼容() {
    // 无 t0/n/perm → 疑似档、n=1、t0=t（app.js:59）
    val m = Health.normalize("""{"华语音乐|台A":{"u":["http://a/1"],"t":${NOW - DAY}}}""", NOW)
    val e = m["华语音乐|台A"]!!
    assertEquals(listOf("http://a/1"), e.u)
    assertEquals(1, e.n); assertEquals(NOW - DAY, e.t); assertEquals(NOW - DAY, e.t0); assertEquals(0, e.perm)
  }

  @Test fun normalize疑似TTL与停运永存() {
    val raw = """{"a":{"u":["http://a"],"t":${NOW - 181 * DAY}},""" +      // 疑似超 180 天 → 清
      """"b":{"u":["http://b"],"t":${NOW - 179 * DAY}},""" +               // 未到 TTL → 留
      """"c":{"u":["http://c"],"t":${NOW - 181 * DAY},"perm":1},""" +      // 停运档永不过期
      """"d":{"u":"非数组"},"e":"非对象"}"""                                  // 容错丢弃
    val m = Health.normalize(raw, NOW)
    assertFalse(m.containsKey("a")); assertTrue(m.containsKey("b")); assertTrue(m.containsKey("c"))
    assertFalse(m.containsKey("d")); assertFalse(m.containsKey("e"))
    assertEquals(1, m["c"]!!.perm)
  }

  @Test fun onDead首死入疑似并升级停运档() {
    val marks = LinkedHashMap<String, HealthEntry>()
    val t0 = 100L * DAY
    Health.onDead(marks, "k", listOf("http://a/1"), t0)
    assertEquals(HealthEntry(listOf("http://a/1"), t0, t0, 1, 0), marks["k"])
    Health.onDead(marks, "k", listOf("http://a/1"), t0 + DAY)               // 连续确认 n+1，未到升级条件
    assertEquals(2, marks["k"]!!.n); assertEquals(0, marks["k"]!!.perm)
    Health.onDead(marks, "k", listOf("http://a/1"), t0 + 31 * DAY)          // n=3 且首死 ≥30 天 → 停运档
    assertEquals(3, marks["k"]!!.n); assertEquals(1, marks["k"]!!.perm)
    Health.onDead(marks, "k", listOf("http://a/1"), t0 + 100 * DAY)         // perm 粘性
    assertEquals(4, marks["k"]!!.n); assertEquals(1, marks["k"]!!.perm)
    assertEquals(t0, marks["k"]!!.t0)                                       // t0 = 首死时刻不漂移
  }

  @Test fun onDead快照封顶6条() {
    val marks = LinkedHashMap<String, HealthEntry>()
    Health.onDead(marks, "k", (1..8).map { "http://a/$it" }, NOW)
    assertEquals(6, marks["k"]!!.u.size)
  }

  @Test fun onAlive撤销() {
    val marks = LinkedHashMap<String, HealthEntry>()
    Health.onDead(marks, "k", listOf("http://a"), NOW)
    Health.onAlive(marks, "k")
    assertNull(marks["k"])
  }

  @Test fun toJson往返() {
    val marks = LinkedHashMap<String, HealthEntry>()
    Health.onDead(marks, "华语音乐|台A", listOf("http://a/1"), NOW - DAY)
    Health.onDead(marks, "k2", listOf("http://b"), NOW - DAY)
    val back = Health.normalize(Health.toJson(marks), NOW)
    assertEquals(marks, back)
  }

  @Test fun bootScope收藏最近与去重() {
    val s1 = st("台A", "http://a/1"); val s2 = st("台B", "http://b/1")
    val sHidden = st("隐藏台", "http://h/1", hidden = true)
    val favs = listOf(FavEntry("华语音乐|台A", listOf("http://a/1")), FavEntry("华语音乐|隐藏台", listOf("http://h/1")))
    val recents = listOf(RecentEntry("华语音乐|台B", "台B", listOf("http://b/1")), RecentEntry("华语音乐|台A", "台A", listOf("http://a/1")))
    val l = Health.bootScope(LinkedHashMap(), favs, recents, listOf(s1, s2, sHidden), NOW)
    assertEquals(listOf(s1, s2), l)   // 收藏在先、最近去重补位、隐藏台不测
  }

  @Test fun bootScopeURL回绑() {
    // 收藏键已漂移（改名），但 URL 快照仍命中 → 回绑进范围（身份公理）
    val s = st("新台名", "http://a/1")
    val l = Health.bootScope(LinkedHashMap(), listOf(FavEntry("华语音乐|旧台名", listOf("http://a/1"))), emptyList(), listOf(s), NOW)
    assertEquals(listOf(s), l)
  }

  @Test fun bootScope死标记节流与档位间隔() {
    val s = st("台A", "http://a/1")
    val marks = LinkedHashMap<String, HealthEntry>()
    marks["华语音乐|台A"] = HealthEntry(listOf("http://a/1"), NOW - 2 * DAY, NOW - 90 * DAY, 2, 0)      // 疑似 2 天前 → 24h 节流入列
    marks["华语音乐|台B"] = HealthEntry(listOf("http://b/1"), NOW - 3 * DAY, NOW - 90 * DAY, 9, 1)      // 停运 3 天 → 7 天间隔未到，跳过
    marks["华语音乐|台C"] = HealthEntry(listOf("http://c/1"), NOW - 8 * DAY, NOW - 90 * DAY, 9, 1)      // 停运 8 天 → 入列
    marks["华语音乐|台D"] = HealthEntry(listOf("http://d/1"), NOW - 10 * DAY, NOW - 90 * DAY, 2, 0)     // 疑似 10 天 → 入列但 t 更旧
    val sb = st("台B", "http://b/1"); val sc = st("台C", "http://c/1"); val sd = st("台D", "http://d/1")
    val l = Health.bootScope(marks, emptyList(), emptyList(), listOf(s, sb, sc, sd), NOW)
    assertEquals(listOf(sd, sc, s), l)  // 死标记内纯 t 升序（sync.js scopeDead sort 同款：台D 10天→台C 8天→台A 2天），台B 被停运档 7 天节流挡下
  }

  @Test fun bootScope封顶与最近收藏上限() {
    // 收藏+最近 ≤30（scopeFavRecent 同款）
    val many = (1..40).map { st("台$it", "http://a/$it") }
    val favs = many.take(20).map { FavEntry(it.key, listOf(it.u0)) }
    val recents = many.drop(20).map { RecentEntry(it.key, it.n, listOf(it.u0)) }
    assertEquals(30, Health.bootScope(LinkedHashMap(), favs, recents, many, NOW).size)
    // 死标记 ≤200 最旧优先轮转（C.BOOT_CHECK_CAP）
    val deadSts = (1..250).map { st("死台$it", "http://d/$it") }
    val marks = LinkedHashMap<String, HealthEntry>()
    deadSts.forEachIndexed { i, s -> marks[s.key] = HealthEntry(listOf(s.u0), NOW - (i + 1) * DAY, NOW - 300 * DAY, 2, 0) }
    val l = Health.bootScope(marks, emptyList(), emptyList(), deadSts, NOW)
    assertEquals(200, l.size)
    assertEquals("死台250", l.first().n)   // t 最旧（250 天前）者优先
  }
}
