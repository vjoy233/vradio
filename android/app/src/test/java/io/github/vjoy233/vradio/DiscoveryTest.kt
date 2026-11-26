package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.Library
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.discovery.Discovery
import io.github.vjoy233.vradio.discovery.DiscoveryInput
import io.github.vjoy233.vradio.discovery.QInfo
import io.github.vjoy233.vradio.discovery.RecoveryLog
import io.github.vjoy233.vradio.model.Station
import java.io.File
import kotlin.io.path.createTempDirectory
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/* 发现页（B3-C，plan-expansion-r4 §7.3）：六分组规则全矩阵 + originMask（Library 装配打 starter 位）+
   无质量降级 / 隐藏·死台过滤（正在播例外）/ 20 上限 / 字典序 tie-break / 组内降序 / 同台跨组 / 7 天窗。 */
class DiscoveryTest {

  private lateinit var dir: File
  @Before fun setup() { dir = createTempDirectory("vradio-disc").toFile(); Store.init(dir) }
  @After fun teardown() { dir.deleteRecursively() }

  private fun st(cat: String = "华语音乐", name: String, url: String, starter: Boolean = false,
                 hidden: Boolean = false, dead: Boolean = false): Station {
    val s = Station(cat, name, mutableListOf(url))
    s.starter = starter; s.hidden = hidden; if (dead) s.health = "dead"
    return s
  }

  private fun good(url: String, lastObs: Long, icy: Boolean = true, direct: Int = 1) =
    url to QInfo("good", direct, if (icy) "icy" else "none", lastObs)

  @Test fun 验证边界及最近URL回绑() {
    val a = st(name = "A", url = "http://a/1")
    val b = st(name = "B", url = "http://b/1")
    val c = st(name = "C", url = "http://c/1", hidden = true)
    val now = 40L * 86400000L
    val g = Discovery.build(DiscoveryInput(stations = listOf(a, b, c), now = now,
      verifiedAt = mapOf(a.u0 to now - 1, b.u0 to now - 30L * 86400000L, c.u0 to now - 1),
      attentionAt = mapOf(a.u0 to 10L, c.u0 to 20L), recentUrls = setOf(a.u0)))
    assertEquals(listOf(a.u0), g.recentlyVerified.map { it.u0 })
    assertEquals(listOf(a.u0), g.needsAttention.map { it.u0 })
    assertEquals(listOf(b.u0), g.unlistened.map { it.u0 })
  }

  @Test fun 六分组基本归组() {
    val a = st(name = "稳定台", url = "http://a/1")
    val b = st(name = "新增台", url = "http://b/1")
    val c = st(name = "恢复台", url = "http://c/1")
    val d = st(name = "曲讯台", url = "http://d/1")
    val e = st(name = "没听过", url = "http://e/1")
    val f = st(name = "精选台", url = "http://f/1", starter = true)
    val g = st(name = "普通台", url = "http://g/1")
    val g2 = Discovery.build(DiscoveryInput(
      stations = listOf(a, b, c, d, e, f, g),
      quality = mapOf("http://a/1" to QInfo("good", 1, "none", 100L),  // 稳定直连（无曲讯）
                      "http://c/1" to QInfo("fair", 0, "none", 300L),
                      "http://d/1" to QInfo("fair", 1, "icy", 200L),   // 非 good：只进有曲讯
                      "http://g/1" to QInfo("fair", 1, "icy", 50L)),
      firstSeenAt = mapOf("http://b/1" to 500L),
      recoveredAt = mapOf(c.key to 400L),
      recentKeys = setOf(a.key, b.key, c.key, d.key, f.key, g.key),   // e 不在最近 → 未听过
    ))
    assertEquals(listOf("http://a/1"), g2.stableDirect.map { it.u0 })
    assertEquals(listOf("http://b/1"), g2.recentlyAdded.map { it.u0 })
    assertEquals(listOf("http://c/1"), g2.recentlyRecovered.map { it.u0 })
    assertEquals(listOf("http://d/1", "http://g/1"), g2.withMetadata.map { it.u0 })   // icy 全收、lastObservedAt 降序
    assertEquals(listOf("http://e/1"), g2.unlistened.map { it.u0 })
    assertEquals(listOf("http://f/1"), g2.featured.map { it.u0 })
    // 无质量记录（b/e/f）→ 暂无质量数据（同刻按字典序），不拦非质量组跨组
    assertEquals(listOf("http://b/1", "http://e/1", "http://f/1"), g2.noQualityData.map { it.u0 })
  }

  @Test fun 无质量记录归暂无质量数据不误判() {
    val a = st(name = "台A", url = "http://a/1")
    val b = st(name = "台B", url = "http://b/1")
    val g = Discovery.build(DiscoveryInput(
      stations = listOf(a, b),
      quality = mapOf(good("http://b/1", 100L)),
      recentKeys = setOf(a.key, b.key),   // 都听过：未听过组空
    ))
    assertEquals(listOf("http://a/1"), g.noQualityData.map { it.u0 })
    assertTrue(g.stableDirect.isEmpty() || g.stableDirect.none { it.u0 == "http://a/1" })   // 无记录不进质量组（更不进 poor 判定）
    assertEquals(listOf("http://b/1"), g.stableDirect.map { it.u0 })
  }

  @Test fun 稳定直连须good且directCount大于零() {
    val onlyHls = st(name = "纯HLS", url = "http://h/1")
    val fair = st(name = "一般", url = "http://f/1")
    val g = Discovery.build(DiscoveryInput(
      stations = listOf(onlyHls, fair),
      quality = mapOf("http://h/1" to QInfo("good", 0, "none", 100L),   // good 但 directCount=0
                      "http://f/1" to QInfo("fair", 2, "icy", 100L)),   // direct 够但非 good
    ))
    assertTrue(g.stableDirect.isEmpty())
  }

  @Test fun 手动隐藏彻底消失() {
    val a = st(name = "藏台", url = "http://a/1", hidden = true)
    val b = st(name = "藏分类", url = "http://b/1")
    val g = Discovery.build(DiscoveryInput(
      stations = listOf(a, b),
      hiddenCats = setOf(b.c),
      quality = mapOf(good("http://a/1", 100L), good("http://b/1", 100L)),
      firstSeenAt = mapOf("http://a/1" to 100L, "http://b/1" to 100L),
    ))
    assertTrue(g.stableDirect.isEmpty() && g.recentlyAdded.isEmpty() && g.noQualityData.isEmpty())
  }

  @Test fun 死台过滤与正在播例外() {
    val dead = st(name = "死台", url = "http://d/1", dead = true)
    val playing = st(name = "正在播死台", url = "http://p/1", dead = true)
    val g = Discovery.build(DiscoveryInput(
      stations = listOf(dead, playing),
      playingKey = playing.key,
      quality = mapOf(good("http://d/1", 100L), good("http://p/1", 200L)),
    ))
    assertTrue(g.stableDirect.none { it.u0 == "http://d/1" })           // 死台默认过滤（发现页无死台开关）
    assertTrue(g.stableDirect.any { it.u0 == "http://p/1" })            // 正在播例外口径（visible 同款）
  }

  @Test fun 每组二十上限() {
    val sts = (1..25).map { st(name = "台$it", url = "http://s/$it") }
    val g = Discovery.build(DiscoveryInput(
      stations = sts,
      quality = sts.associate { good(it.u0, 100L + it.u0.length) },   // 时间各异（1-9 同长按字典序 tie-break）
    ))
    assertEquals(20, g.stableDirect.size)
    assertTrue(g.noQualityData.isEmpty())   // 全有质量记录 → 兜底组空
    val g2 = Discovery.build(DiscoveryInput(stations = sts))   // 全无记录 → 兜底组也封顶 20
    assertEquals(20, g2.noQualityData.size)
  }

  @Test fun 同刻identityUrl字典序稳定排序() {
    val sts = listOf(st(name = "C", url = "http://c/1"), st(name = "A", url = "http://a/1"), st(name = "B", url = "http://b/1"))
    val g = Discovery.build(DiscoveryInput(
      stations = sts, quality = sts.associate { good(it.u0, 100L) },
    ))
    assertEquals(listOf("http://a/1", "http://b/1", "http://c/1"), g.stableDirect.map { it.u0 })
  }

  @Test fun 组内按lastObservedAt降序新增按firstSeenAt降序() {
    val old = st(name = "旧", url = "http://old/1")
    val new_ = st(name = "新", url = "http://new/1")
    val addOld = st(name = "增旧", url = "http://ao/1")
    val addNew = st(name = "增新", url = "http://an/1")
    val g = Discovery.build(DiscoveryInput(
      stations = listOf(old, new_, addOld, addNew),
      quality = mapOf(good(old.u0, 100L), good(new_.u0, 999L)),
      firstSeenAt = mapOf(addOld.u0 to 100L, addNew.u0 to 999L),
    ))
    assertEquals(listOf("http://new/1", "http://old/1"), g.stableDirect.map { it.u0 })       // lastObservedAt 降序
    assertEquals(listOf("http://an/1", "http://ao/1"), g.recentlyAdded.map { it.u0 })        // firstSeenAt 降序
  }

  @Test fun 同台可跨组() {
    val a = st(name = "全能台", url = "http://a/1", starter = true)
    val g = Discovery.build(DiscoveryInput(
      stations = listOf(a),
      quality = mapOf(good(a.u0, 100L)),
      firstSeenAt = mapOf(a.u0 to 100L),
      recoveredAt = mapOf(a.key to 100L),
    ))
    assertEquals(1, g.stableDirect.size); assertEquals(1, g.withMetadata.size)
    assertEquals(1, g.recentlyAdded.size); assertEquals(1, g.recentlyRecovered.size)
    assertEquals(1, g.unlistened.size); assertEquals(1, g.featured.size)   // 六组全中（组内各只一次）
  }

  @Test fun 无meta新增组为空() {
    val a = st(name = "台A", url = "http://a/1")
    val g = Discovery.build(DiscoveryInput(stations = listOf(a)))
    assertTrue(g.recentlyAdded.isEmpty())
  }

  @Test fun 恢复记录七天窗() {
    val now = 8L * 86400000L
    val kept = RecoveryLog.prune(mapOf("k1" to now - 6 * 86400000L, "k2" to now - 8 * 86400000L), now)
    assertEquals(mapOf("k1" to now - 6 * 86400000L), kept)   // 满 7 天的过期
    val g = Discovery.build(DiscoveryInput(
      stations = listOf(st(name = "旧恢复", url = "http://a/1")),
      recoveredAt = kept,   // 调用侧过期清理后（AppVm 口径）
    ))
    assertTrue(g.recentlyRecovered.isEmpty())   // 无明确转移记录不猜
  }

  /* ---------- originMask：Library 装配打 starter 位 ---------- */

  @Test fun starter位装配打点() {
    val l = Library(Store, dir, "华语音乐,#genre#\nCNR 音乐之声,http://ngcdn003.cnr.cn/live/yyzs/index.m3u8\n无关台,http://x/1")
    l.reload()
    val dup = l.stations.first { it.n == "CNR 音乐之声" }
    assertTrue(dup.starter)                                       // 主列表同名代表台带位（不比对 URL）
    assertTrue(l.stations.first { it.n == "Love Radio FM103.7 经典金曲" }.starter)   // 缺位并入的精选台自带位
    assertFalse(l.stations.first { it.n == "无关台" }.starter)
    // 发现页「精选」= starter 位命中（同名但 URL 已由主列表提供的台仍出现）
    val g = Discovery.build(DiscoveryInput(stations = l.stations.toList()))
    assertTrue(g.featured.any { it.n == "CNR 音乐之声" })
    assertTrue(g.featured.size >= 14)                             // 14 精选全命中（≤20 上限内）
  }

  @Test fun starter位URL命中也打点() {   // originMask 双端口径：URL 命中或精确同名（只打标记不动装配）
    val l = Library(Store, dir, "华语音乐,#genre#\n别名台,http://lhttp.qingting.fm/live/273/64k.mp3")
    l.reload()
    assertTrue(l.stations.first { it.n == "别名台" }.starter)                    // URL 命中的主列表台带位
    assertTrue(l.stations.any { it.n == "Love Radio FM103.7 经典金曲" })         // 不同名 → 精选台照常并入（装配现状不变）
    val g = Discovery.build(DiscoveryInput(stations = l.stations.toList()))
    assertTrue(g.featured.any { it.n == "别名台" })
  }

  @Test fun starter位不持久化参与equals() {   // 运行时字段：同名台拷贝/相等性不受影响
    val a = Station("华语音乐", "台A", mutableListOf("http://a/1"))
    val b = Station("华语音乐", "台A", mutableListOf("http://a/1"))
    a.starter = true
    assertEquals(a, b)
    assertEquals(a.hashCode(), b.hashCode())
  }
}
