package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.CfgCodec
import io.github.vjoy233.vradio.data.Library
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.model.Cfg
import io.github.vjoy233.vradio.model.HealthEntry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory

/* CfgSourceLifecycleTest（B1，plan-expansion-r4 §5.4/§5.6）：srcManualOrder/srcDisabled/srcLabels 三字段的
   有效顺序语义（manual 全列/部分列/含未知 URL/无 manual）、禁用剔除与全禁（NO_ENABLED_SOURCE）、
   u[]/u[0] 物理序不动（身份公理）、收藏/健康回绑不受排序影响、旧 cfg 无新字段行为不变、
   恢复默认两动作彼此独立、cfg round-trip 不丢三字段。 */
class CfgSourceLifecycleTest {
  private lateinit var dir: File

  @Before fun setup() { dir = createTempDirectory("vradio-b1").toFile(); Store.init(dir) }
  @After fun teardown() { dir.deleteRecursively() }

  private fun lib(main: String = "", cfgJson: String? = null): Library {
    if (cfgJson != null) Store.set("radio.cfg", cfgJson)
    val l = Library(Store, dir, main, "", { 1000L })
    l.reload()
    return l
  }

  private val MAIN = "华语音乐,#genre#\n台A,http://a/1\n台A,http://a/2\n台A,http://a/3"

  private fun stA(l: Library) = l.stations.first { it.n == "台A" }

  // —— 有效顺序语义 ——

  @Test fun manual全列重排() { // manual 列全三个 URL → mo 按 manual 序
    val l = lib(MAIN, """{"v":2,"srcManualOrder":{"http://a/1":["http://a/3","http://a/1","http://a/2"]}}""")
    assertEquals(listOf(2, 0, 1), stA(l).mo)
    assertEquals("http://a/1", stA(l).u0)                       // 物理序不动
  }

  @Test fun manual部分列未列按原序追加() { // 只列 c → c 前，a/b 按 u 原序追加
    val l = lib(MAIN, """{"v":2,"srcManualOrder":{"http://a/1":["http://a/3"]}}""")
    assertEquals(listOf(2, 0, 1), stA(l).mo)
  }

  @Test fun manual含未知URL丢弃() { // 同步漂移后的死键不占位；未列台照旧追加
    val l = lib(MAIN, """{"v":2,"srcManualOrder":{"http://a/1":["http://gone/x","http://a/2"]}}""")
    assertEquals(listOf(1, 0, 2), stA(l).mo)
  }

  @Test fun 无manual则mo为null默认序() {
    val l = lib(MAIN, """{"v":2,"moves":{}}""")   // 有 v 但无三字段
    assertNull(stA(l).mo)
    assertEquals(listOf(0, 1, 2), stA(l).effOrder())
  }

  @Test fun 追加源参与人工序() { // srcs 挂尾后 manual 覆盖追加源；u[0] 仍是身份键
    val l = lib(MAIN, """{"v":2,"srcs":{"http://a/1":["http://s/9"]},"srcManualOrder":{"http://a/1":["http://s/9","http://a/1"]}}""")
    val s = stA(l)
    assertEquals(listOf("http://a/1", "http://a/2", "http://a/3", "http://s/9"), s.u)  // 物理序：追加挂尾
    assertEquals(listOf(3, 0, 1, 2), s.mo)                                             // 有效序：s/9 提前
  }

  // —— 禁用语义 ——

  @Test fun 禁用剔除出播放顺序但保留在mo() {
    val l = lib(MAIN, """{"v":2,"srcManualOrder":{"http://a/1":["http://a/1","http://a/2","http://a/3"]},"srcDisabled":{"http://a/1":["http://a/1"]}}""")
    val s = stA(l)
    assertEquals(setOf(0), s.dis)
    assertEquals(listOf(0, 1, 2), s.mo)                         // mo 是排序维度（含禁用位）
    assertEquals(listOf(1, 2), s.effOrder())                    // effOrder 是播放维度（禁用剔除）
    assertEquals("http://a/1", s.u0)                            // 主源禁用也不换身份键
  }

  @Test fun 全禁即NO_ENABLED_SOURCE判据() {
    val l = lib(MAIN, """{"v":2,"srcDisabled":{"http://a/1":["http://a/1","http://a/2","http://a/3"]}}""")
    assertTrue(stA(l).effOrder().isEmpty())                     // PlayerHolder.play 据此进 NO_ENABLED_SOURCE
  }

  @Test fun 禁用未知URL忽略() {
    val l = lib(MAIN, """{"v":2,"srcDisabled":{"http://a/1":["http://gone/x"]}}""")
    assertTrue(stA(l).dis.isEmpty())
  }

  @Test fun 标签只挂本台源() {
    val l = lib(MAIN + "\n台B,http://b/1", """{"v":2,"srcLabels":{"http://a/2":"备用","http://b/1":"主听"}}""")
    assertEquals(mapOf("http://a/2" to "备用"), stA(l).lbl)
    assertEquals(mapOf("http://b/1" to "主听"), l.stations.first { it.n == "台B" }.lbl)
  }

  // —— 编辑动作（Library 整表写 + reapplyCfg 即时生效） ——

  @Test fun 上移下移材料化完整序() {
    val l = lib(MAIN)
    val s = stA(l)
    l.srcMove(s, 2, true)                                       // 源3 上移一位 → [0,2,1]
    assertEquals(listOf(0, 2, 1), s.mo)
    assertEquals(listOf("http://a/1", "http://a/3", "http://a/2"), l.cfg.srcManualOrder["http://a/1"])
    l.srcMove(s, 0, true)                                       // 首位再上移 = 无操作
    assertEquals(listOf(0, 2, 1), s.mo)
    l.srcMove(s, 0, false)                                      // 首位下移 → [2,0,1]
    assertEquals(listOf(2, 0, 1), s.mo)
    l.srcMove(s, 1, false)                                      // manual 序末位（u 索引 1）再下移 = 无操作
    assertEquals(listOf(2, 0, 1), s.mo)
  }

  @Test fun 排序落盘且重启后复用() { // cfg 持久 → 新 Library（同 store）重载仍生效
    val l = lib(MAIN)
    l.srcMove(stA(l), 1, true)                                  // [1,0,2]
    val l2 = Library(Store, dir, MAIN, "", { 1000L })
    l2.reload()
    assertEquals(listOf(1, 0, 2), l2.stations.first { it.n == "台A" }.mo)
  }

  @Test fun 禁用切换往返() {
    val l = lib(MAIN)
    val s = stA(l)
    l.srcDisabledToggle(s, 0)
    assertEquals(listOf("http://a/1"), l.cfg.srcDisabled["http://a/1"])
    assertEquals(setOf(0), s.dis)
    l.srcDisabledToggle(s, 0)                                   // 再切 = 取消禁用（空表整键删除）
    assertFalse(l.cfg.srcDisabled.containsKey("http://a/1"))
    assertTrue(s.dis.isEmpty())
  }

  @Test fun 撤销人工排序保留禁用与追加源() { // 恢复默认两动作独立：ResetOrder 只删 srcManualOrder
    val l = lib(MAIN, """{"v":2,"srcs":{"http://a/1":["http://s/9"]},"srcManualOrder":{"http://a/1":["http://a/2"]},"srcDisabled":{"http://a/1":["http://a/3"]}}""")
    val s = stA(l)
    assertEquals(listOf(1, 0, 2, 3), s.mo)                       // manual=[a/2] 前置，其余按 u 原序（含追加源 s/9）
    l.srcOrderReset(s)
    assertNull(s.mo)                                            // 人工序已撤 → 默认序
    assertEquals(listOf("http://a/3"), l.cfg.srcDisabled["http://a/1"])   // 禁用保留
    assertEquals(listOf("http://s/9"), l.cfg.srcs["http://a/1"])          // 追加源保留
    assertEquals(4, s.u.size)                                   // 追加源仍在列
    assertEquals(setOf(2), s.dis)                               // 禁用位照旧（u 空间索引不变）
  }

  @Test fun 撤销无人工序是安全无操作() {
    val l = lib(MAIN)
    l.srcOrderReset(stA(l))                                     // 本无 srcManualOrder：不动 cfg
    assertTrue(l.cfg.srcManualOrder.isEmpty())
    assertNull(stA(l).mo)
  }

  // —— 身份公理：排序/禁用后 u 物理序与回绑面 ——

  @Test fun 排序禁用后主URL与物理序不变() {
    val l = lib(MAIN)
    val s = stA(l)
    l.srcMove(s, 2, true); l.srcMove(s, 2, true); l.srcDisabledToggle(s, 1)
    assertEquals(listOf("http://a/1", "http://a/2", "http://a/3"), s.u)     // u 物理序永不重排
    assertEquals("http://a/1", s.u0)
    assertEquals(listOf("http://a/1", "http://a/2", "http://a/3"), s.dU)    // 留底同步未受污染
  }

  @Test fun 收藏与健康回绑不受排序影响() { // 收藏/死标记按 URL 回绑（任一源命中）——排序只动 mo 不动回绑面
    Store.set("radio.favs", "[{\"k\":\"华语音乐|台A\",\"u\":[\"http://a/2\"]}]")
    Store.set("radio.health", "{\"华语音乐|台B\":{\"u\":[\"http://a/3\"],\"t\":100,\"t0\":100,\"n\":1,\"perm\":0}}")
    val l = lib(MAIN.replace("台A,http://a/3", "台B,http://a/3"),  // 台B 与台A 分键（a/3 归台B）
      """{"v":2,"srcManualOrder":{"http://a/1":["http://a/2","http://a/1"]},"srcDisabled":{"http://a/1":["http://a/1"]}}""")
    assertTrue(l.isFav(l.stations.first { it.n == "台A" }))       // a/2 命中收藏照旧
    assertEquals("dead", l.stations.first { it.n == "台B" }.health) // a/3 死标记照旧
    // srcmem2 不经 cfg 通道：reapplyCfg 不碰 radio.srcmem2（PlayerHolder 私有持久键）
    Store.set("radio.srcmem2", """{"http://a/1":{"i":2,"t":100}}""")
    l.srcMove(l.stations.first { it.n == "台A" }, 0, false)
    assertEquals("""{"http://a/1":{"i":2,"t":100}}""", Store.get("radio.srcmem2"))
  }

  // —— 旧数据兼容与 round-trip ——

  @Test fun 旧cfg无新字段行为不变() { // v1（无 v/无三字段）：mo=null、dis 空、effOrder=默认序
    val l = lib(MAIN, """{"moves":{"http://a/1":"欧美音乐"}}""")
    val s = stA(l)
    assertNull(s.mo); assertTrue(s.dis.isEmpty()); assertTrue(s.lbl.isEmpty())
    assertEquals(listOf(0, 1, 2), s.effOrder())
    assertEquals("欧美音乐", s.c)                                 // 既有维护层语义照旧
  }

  @Test fun cfgRoundTrip不丢三字段() {
    val c = Cfg(
      srcs = mapOf("http://a/1" to listOf("http://s/9")),
      srcManualOrder = mapOf("http://a/1" to listOf("http://a/2", "http://a/1")),
      srcDisabled = mapOf("http://a/1" to listOf("http://a/3")),
      srcLabels = mapOf("http://a/2" to "车机备用"),
    )
    assertEquals(c, CfgCodec.parse(CfgCodec.toJson(c)))
    assertEquals(4, CfgCodec.count(c))                           // srcs+manual+disabled+labels 各计 1
  }
}
