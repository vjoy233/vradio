package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.QualityStore
import io.github.vjoy233.vradio.model.DiagnosticResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/* B2 源质量聚合（contracts/quality-summary.json）：四档稳定性 / 聚合计数与 lastObservedAt 派生 /
   playback·diagnostic 分流（自动体检只产 diagnostic）/ trim 契约淘汰序与 keep 集 / 坏文件恢复 / 持久往返。 */
class QualityAggregateTest {

  @get:Rule val tmp = TemporaryFolder()

  private val DAY = 86400000L
  private var now = 100L * DAY

  private fun store(cap: Int = 2_000_000) = QualityStore(tmp.newFolder(), { now }, cap)

  private fun diag(url: String, ok: Boolean, lat: Long = 0, at: Long = now, mode: String = "direct") =
    DiagnosticResult(url, ok, if (ok) "OK" else "NETWORK", mode == "hls", mode, 0, "", 0, lat, "", at)

  private fun ok(q: QualityStore, id: String, lat: Long = 500, at: Long = now, mode: String = "direct") =
    q.recordDiagnostic(id, diag(id, true, lat, at, mode), "manual")

  private fun fail(q: QualityStore, id: String, at: Long = now) =
    q.recordDiagnostic(id, diag(id, false, at = at), "manual")

  /* ---------- 稳定性四档 ---------- */

  @Test fun 确定档good() {
    val q = store()
    ok(q, "http://a/1", 800); ok(q, "http://a/1", 900); ok(q, "http://a/1", 700)
    assertEquals("good", q.summary("http://a/1")!!.stability)
  }

  @Test fun 样本不足unknown() {
    val q = store()
    ok(q, "http://a/1"); ok(q, "http://a/1")
    assertEquals("unknown", q.summary("http://a/1")!!.stability)   // 样本 < 3
  }

  @Test fun 超窗unknown() {
    val q = store()
    val old = now - 40 * DAY
    ok(q, "http://a/1", at = old); ok(q, "http://a/1", at = old); ok(q, "http://a/1", at = old)
    assertEquals("unknown", q.summary("http://a/1")!!.stability)   // 近 30 天窗内无观察
  }

  @Test fun 成功率低poor() {
    val q = store()
    ok(q, "http://a/1"); fail(q, "http://a/1"); fail(q, "http://a/1"); fail(q, "http://a/1")
    assertEquals("poor", q.summary("http://a/1")!!.stability)      // 1/4 = 0.25 < 0.5
  }

  @Test fun 连续失败poor() {
    val q = store()
    repeat(10) { ok(q, "http://a/1") }                             // 成功率 10/13 ≈ 0.77 ≥ 0.5
    fail(q, "http://a/1"); fail(q, "http://a/1"); fail(q, "http://a/1")
    assertEquals("poor", q.summary("http://a/1")!!.stability)      // 但连续失败 ≥3 一票否决
  }

  @Test fun 中间档fair() {
    val q = store()
    // 7 成功 3 失败 = 0.7：≥0.5 不 poor、<0.8 不到 good，尾部成功 cf=0
    ok(q, "http://a/1"); fail(q, "http://a/1"); ok(q, "http://a/1"); fail(q, "http://a/1")
    ok(q, "http://a/1"); fail(q, "http://a/1"); ok(q, "http://a/1"); ok(q, "http://a/1"); ok(q, "http://a/1"); ok(q, "http://a/1")
    assertEquals("fair", q.summary("http://a/1")!!.stability)
  }

  @Test fun 高延迟拦good() {
    val q = store()
    ok(q, "http://a/1", 3000); ok(q, "http://a/1", 3200); ok(q, "http://a/1", 2800)
    val s = q.summary("http://a/1")!!
    assertEquals(3000, s.avgLatencyMs)                             // avg ≥ 2500ms
    assertEquals("fair", s.stability)
  }

  /* ---------- 聚合计数与派生 ---------- */

  @Test fun 多源聚合计数与lastObservedAt() {
    val q = store()
    val id = "http://a/1"; val s2 = "http://a/2.mp3"
    q.recordDiagnostic(id, diag(s2, true, 400, at = now - 3000), "boot")
    now += 100
    q.recordPlayback(id, s2, false, 0, "direct", "watchdog")       // 断流
    now += 100
    q.recordPlayback(id, id, true, 900, "direct", "play")          // 成功起播
    val s = q.summary(id)!!
    assertEquals(2, s.okCount); assertEquals(1, s.failCount); assertEquals(1, s.disconnects)
    assertEquals(now, s.lastOkAt)                                  // 成功起播时刻（diag 的 checkedAt 更旧被 max 盖过）
    assertEquals(now - 100, s.lastFailAt)
    assertEquals(now, s.lastPlaybackAt)
    assertEquals(now, s.lastObservedAt)                            // = max(三时间)
    assertEquals((400 + 900) / 2, s.avgLatencyMs)
  }

  @Test fun 空延迟样本不计入均值() {
    val q = store()
    q.recordPlayback("http://a/1", "http://a/1", true, 0, "direct", "play")   // lat≤0 不进 latSum/latN
    ok(q, "http://a/1", 600)
    assertEquals(600, q.summary("http://a/1")!!.avgLatencyMs)
  }

  @Test fun sourceCount与directCount按传入源表() {
    val q = store()
    ok(q, "http://a/1")
    val s = q.summary("http://a/1", listOf("http://a/1", "http://a/2.m3u8", "http://a/3.m3u8?t=1"))!!
    assertEquals(3, s.sourceCount); assertEquals(1, s.directCount)   // m3u8 形态不算直流
    assertEquals(1, q.summary("http://a/1")!!.sourceCount)           // 不传 = 已观测源数
  }

  @Test fun metadata按modes派生() {
    val q = store()
    ok(q, "http://h/1", mode = "hls"); ok(q, "http://h/1", mode = "hls")
    assertEquals("none", q.summary("http://h/1")!!.metadata)         // 纯 hls
    q.recordPlayback("http://m/1", "http://m/1.mp3", true, 100, "direct", "play")
    assertEquals("icy", q.summary("http://m/1")!!.metadata)          // 纯 direct
    ok(q, "http://x/1", mode = "hls")
    q.recordPlayback("http://x/1", "http://x/1", true, 100, "direct", "play")
    assertEquals("mixed", q.summary("http://x/1")!!.metadata)
  }

  @Test fun 每台源封顶6() {
    val q = store()
    for (i in 1..8) ok(q, "http://a/0", at = now + i)
    for (i in 1..8) q.recordDiagnostic("http://a/0", diag("http://a/$i", true), "manual")
    assertEquals(6, q.summary("http://a/0")!!.sourceCount)           // 第 7+ 源样本被丢（caps.sourcesPerStation）
  }

  /* ---------- playback / diagnostic 分流 ---------- */

  @Test fun 自动体检只产diagnostic不产playback() {
    val q = store()
    ok(q, "http://a/1", at = now - 1000); fail(q, "http://a/1")
    val s = q.summary("http://a/1")!!
    assertEquals(0L, s.lastPlaybackAt)                              // 诊断样本永不触碰 lastPlaybackAt
    assertEquals(0, s.disconnects)                                  // 也不产断流计数
  }

  @Test fun 断流计数只认error与watchdog() {
    val q = store()
    q.recordPlayback("http://a/1", "http://a/1", false, 0, "direct", "switch")   // 切源失败不算断流
    q.recordPlayback("http://a/1", "http://a/1", false, 0, "direct", "watchdog")
    q.recordPlayback("http://a/1", "http://a/1", false, 0, "direct", "error")
    assertEquals(2, q.summary("http://a/1")!!.disconnects)
  }

  @Test fun 连续失败计数是台级且被任一源成功清零() {
    val q = store()
    val id = "http://a/1"
    repeat(8) { ok(q, id) }
    fail(q, id); fail(q, id)                                            // cf=2
    q.recordDiagnostic(id, diag("http://a/2.mp3", true, 500), "boot")   // 另一源成功 → 台级 cf 清零
    fail(q, id); fail(q, id)                                            // cf=2（若未清零则 4 → poor）
    val s = q.summary(id)!!
    assertEquals(9, s.okCount); assertEquals(4, s.failCount)
    assertEquals("fair", s.stability)                                   // 率 9/13≈0.69、cf=2 → fair
  }

  /* ---------- trim 契约淘汰序 ---------- */

  @Test fun trim淘汰序非保护集最久未访问先走() {
    // 量出单台字节数，cap 设 2.2 台：终态只容 keep + 最晚访问的非保护台
    val probe = QualityStore(tmp.newFolder(), { now }, 2_000_000)
    ok(probe, "http://s0/1")
    val per = probe.sizeBytes()
    val q = QualityStore(tmp.newFolder(), { now }, per * 2 + per / 5)
    q.keepHint = setOf("http://k/1")
    ok(q, "http://k/1", at = 100)                                   // keep（收藏保护的形态）
    ok(q, "http://a/1", at = 200); ok(q, "http://b/1", at = 300); ok(q, "http://c/1", at = 150)
    ok(q, "http://d/1", at = 400)
    assertNull(q.summary("http://c/1")); assertNull(q.summary("http://a/1")); assertNull(q.summary("http://b/1"))
    assertNotNull(q.summary("http://d/1"))                          // 最晚访问的非保护台留下
    assertNotNull(q.summary("http://k/1"))                          // 保护台最后才轮到
  }

  @Test fun trim同刻按identityUrl字典序() {
    val probe = QualityStore(tmp.newFolder(), { now }, 2_000_000)
    ok(probe, "http://s0/1")
    val per = probe.sizeBytes()
    val q = QualityStore(tmp.newFolder(), { now }, per * 2 + per / 5)
    q.keepHint = setOf("http://k/1")
    ok(q, "http://k/1")
    ok(q, "http://x/1"); ok(q, "http://y/1")                        // 同刻两条非保护
    assertNull(q.summary("http://x/1"))                             // 字典序小者先走
    assertNotNull(q.summary("http://y/1"))
  }

  /* ---------- 落盘与容错 ---------- */

  @Test fun 坏文件按空库恢复() {
    val dir = tmp.newFolder()
    File(dir, QualityStore.FILE).writeText("not json{")
    val q = QualityStore(dir, { now })
    q.load()
    assertNull(q.summary("http://a/1"))
    ok(q, "http://a/1"); ok(q, "http://a/1"); ok(q, "http://a/1")    // 坏件后照常写入自愈
    assertEquals("good", q.summary("http://a/1")!!.stability)
  }

  @Test fun 持久往返重启仍在() {
    val dir = tmp.newFolder()
    val q1 = QualityStore(dir, { now })
    ok(q1, "http://a/1", 700); fail(q1, "http://a/2.mp3")
    q1.recordPlayback("http://a/1", "http://a/1", true, 900, "direct", "play")
    val before = q1.summary("http://a/1")
    val q2 = QualityStore(dir, { now })
    q2.load()
    assertEquals(before, q2.summary("http://a/1"))
  }

  @Test fun 无记录summary为null() {
    assertNull(store().summary("http://none/1"))
  }
}
