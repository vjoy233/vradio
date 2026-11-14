package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.metadata.MetadataNormalizer
import io.github.vjoy233.vradio.metadata.MetadataPipeline
import io.github.vjoy233.vradio.model.Confidence
import io.github.vjoy233.vradio.model.MetadataEvent
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* MetadataEvent 形态 + MetadataPipeline 固定序（B3-A，contracts/metadata-event.json eventOrder）：
   校验 identityUrl/世代 → 空曲讯不覆盖 → 丢弃迟到 → 同曲去重 → 更新当前 → 与上一曲比较入史；
   切台/刷新/全部失败先清空（reset）再接受新世代事件。 */
class MetadataEventTest {

  private fun ev(u0: String, title: String, at: Long) = MetadataNormalizer.normalize(
    MetadataNormalizer.IcyRaw(title = title, source = "icy", at = at), MetadataNormalizer.IcyCtx(u0))

  @Test fun 事件形态九字段() {   // 契约 event 节逐字段
    val e = ev("https://main.example/live", "Artist - Title", 1731500000000L)
    assertEquals("https://main.example/live", e.stationIdentityUrl)
    assertEquals("Artist - Title", e.title); assertEquals("Artist", e.artist); assertEquals("Title", e.track)
    assertEquals("", e.program); assertEquals(0, e.bitrateKbps); assertEquals("icy", e.source)
    assertEquals(1731500000000L, e.at); assertEquals(Confidence.PARSED, e.confidence)
  }

  @Test fun 契约字段名零漂移() {
    val j = JSONObject(javaClass.classLoader!!.getResourceAsStream("metadata-event.json")!!
      .bufferedReader().readText()).getJSONObject("event")
    val expect = ArrayList<String>()
    for (k in j.keys()) expect.add(k)
    assertEquals(listOf("artist", "at", "bitrateKbps", "confidence", "program", "source",
      "stationIdentityUrl", "title", "track"), expect.sorted())   // 键序按 JSON 解析器迭代序，比较用字典序
  }

  /* ---------- 管线固定序 ---------- */

  @Test fun 空曲讯不覆盖有效曲名() {
    val st = MetadataPipeline.State("http://a/1", ev("http://a/1", "T1", 1000L), "T1")
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "", 2000L), dedup30s = true)
    assertTrue(d.dropped)                       // 空曲讯整体丢弃（HLS 不猜歌名）
    assertEquals("T1", s2.display)              // 显示不被覆盖
    assertEquals("T1", st.display)              // 状态未变
  }

  @Test fun 迟到事件丢弃() {
    val st = MetadataPipeline.State("http://a/1", ev("http://a/1", "T1", 5000L), "T1")
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "T2", 4000L), dedup30s = true)   // at 早于上一曲
    assertTrue(d.dropped); assertEquals("T1", s2.display)
    val (s3, d3) = MetadataPipeline.accept(s2, ev("http://a/1", "T2", 5000L), dedup30s = true)  // 同刻不迟到
    assertFalse(d3.dropped); assertEquals("T2", s3.display)
  }

  @Test fun 切台串台事件丢弃() {
    val st = MetadataPipeline.State("http://a/1", ev("http://a/1", "T1", 1000L), "T1")
    val (s2, d) = MetadataPipeline.accept(st, ev("http://b/1", "T9", 2000L), dedup30s = true)   // 旧台事件
    assertTrue(d.dropped); assertEquals("T1", s2.display)
  }

  @Test fun 同曲去重30s窗v2() {
    val st = MetadataPipeline.State("http://a/1", ev("http://a/1", "T1", 1000L), "T1")
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "T1", 20_000L), dedup30s = true) // 窗内同名
    assertTrue(d.dropped); assertEquals("T1", s2.display); assertEquals(20_000L, s2.last!!.at)  // last 随事件前移（窗基准刷新）
  }

  @Test fun legacy同曲按连续同名去重() {
    val st = MetadataPipeline.State("http://a/1", ev("http://a/1", "T1", 1000L), "T1")
    // dedup30s=false（现状口径）：连续同名丢弃，不限时间窗
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "T1", 600_000L), dedup30s = false)
    assertTrue(d.dropped); assertEquals("T1", s2.display)
  }

  @Test fun 换曲旧曲入史新曲上屏() {
    val st = MetadataPipeline.State("http://a/1", ev("http://a/1", "旧曲", 1000L), "旧曲")
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "新曲", 60_000L), dedup30s = true)
    assertEquals("新曲", d.show); assertEquals("http://a/1", d.archiveU0); assertEquals("旧曲", d.archiveTitle)
    assertEquals("新曲", s2.display); assertEquals("新曲", s2.last!!.title)
  }

  @Test fun v2同名30s内已入史不重复入史() {   // 抖动 A-B-A-B 防重复刷史（Web mpHistDecide 同语义）
    var st = MetadataPipeline.State()
    st = MetadataPipeline.accept(st, ev("http://a/1", "A", 1000L), dedup30s = true).first
    var r = MetadataPipeline.accept(st, ev("http://a/1", "B", 5000L), dedup30s = true)
    assertEquals("A", r.second.archiveTitle)                       // A 入史
    r = MetadataPipeline.accept(r.first, ev("http://a/1", "A", 10_000L), dedup30s = true)
    assertEquals("B", r.second.archiveTitle)                       // B 入史
    r = MetadataPipeline.accept(r.first, ev("http://a/1", "B", 15_000L), dedup30s = true)
    assertNull(r.second.archiveTitle)                              // A 30s 窗内已入史 → 跳过（不入史）
    r = MetadataPipeline.accept(r.first, ev("http://a/1", "A", 45_000L), dedup30s = true)
    assertEquals("B", r.second.archiveTitle)                       // B 已出窗 → 可再入
  }

  @Test fun 首曲不归档() {
    val st = MetadataPipeline.reset(MetadataPipeline.State("http://a/1", ev("http://a/1", "旧", 1000L), "旧"), "http://a/1")
    assertEquals("", st.display); assertNull(st.last)
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "首曲", 2000L), dedup30s = true)
    assertEquals("首曲", d.show); assertNull(d.archiveU0)   // refresh 后同曲重报：只上屏不重复入史
  }

  @Test fun reset清空旧世代再接受新台() {
    var st = MetadataPipeline.State("http://a/1", ev("http://a/1", "T1", 1000L), "T1")
    st = MetadataPipeline.reset(st, "http://b/1")            // 切台：先清空再接受新世代事件
    assertEquals("http://b/1", st.station); assertEquals("", st.display); assertNull(st.last)
    val (s2, d) = MetadataPipeline.accept(st, ev("http://b/1", "T2", 2000L), dedup30s = true)
    assertFalse(d.dropped); assertEquals("T2", s2.display)
    // 清空后旧台迟到事件因 identityUrl 不匹配丢弃
    val (_, d3) = MetadataPipeline.accept(s2, ev("http://a/1", "T1", 3000L), dedup30s = true)
    assertTrue(d3.dropped)
  }

  @Test fun 无台态接受首个事件确立世代() {
    val st = MetadataPipeline.reset(MetadataPipeline.State(), null)
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "T1", 1000L), dedup30s = true)
    assertFalse(d.dropped); assertEquals("http://a/1", s2.station)
  }

  @Test fun 决策dropped判定() {
    assertTrue(MetadataPipeline.Decision(null, null, null).dropped)
    assertFalse(MetadataPipeline.Decision("T", null, null).dropped)
    assertFalse(MetadataPipeline.Decision(null, "http://a/1", "T").dropped)
  }

  @Test fun 事件dataClass逐字段相等() {   // 黄金值直接构造 round-trip（供双端比对的最小形态）
    val e = MetadataEvent("https://main.example/live", "Artist - Title", "Artist", "Title",
      "", 128, "icy", 1731500000000L, Confidence.PARSED)
    assertEquals(e, ev("https://main.example/live", "Artist - Title", 1731500000000L).copy(bitrateKbps = 128))
  }
}
