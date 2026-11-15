package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.metadata.LegacyMetadataSink
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
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "", 2000L))
    assertTrue(d.dropped)                       // 空曲讯整体丢弃（HLS 不猜歌名）
    assertEquals("T1", s2.display)              // 显示不被覆盖
    assertEquals("T1", st.display)              // 状态未变
  }

  @Test fun 迟到事件丢弃() {
    val st = MetadataPipeline.State("http://a/1", ev("http://a/1", "T1", 5000L), "T1")
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "T2", 4000L))   // at 早于上一曲
    assertTrue(d.dropped); assertEquals("T1", s2.display)
    val (s3, d3) = MetadataPipeline.accept(s2, ev("http://a/1", "T2", 5000L))  // 同刻不迟到
    assertFalse(d3.dropped); assertEquals("T2", s3.display)
  }

  @Test fun 切台串台事件丢弃() {
    val st = MetadataPipeline.State("http://a/1", ev("http://a/1", "T1", 1000L), "T1")
    val (s2, d) = MetadataPipeline.accept(st, ev("http://b/1", "T9", 2000L))   // 旧台事件
    assertTrue(d.dropped); assertEquals("T1", s2.display)
  }

  @Test fun 同曲去重30s窗v2() {
    val st = MetadataPipeline.State("http://a/1", ev("http://a/1", "T1", 1000L), "T1")
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "T1", 20_000L)) // 窗内同名
    assertTrue(d.dropped); assertEquals("T1", s2.display); assertEquals(20_000L, s2.last!!.at)  // last 随事件前移（窗基准刷新）
  }

  /* ---------- LegacyMetadataSink 回归（AIbot P1-2：flag 关闭独立分支，与 feat/r4-b2 PlayerHolder ICY 段
     逐项一致——空曲讯/重复曲讯/迟到事件（reset 清 last 防串台）/历史写入（键=台主 URL）；footer/icy-br/
     MediaSession 走 show=setSong 与 IcyHeaders 原路径（B2 起未动）） ---------- */

  /** B2 对照基准：feat/r4-b2 PlayerHolder.onMetadata(IcyInfo) 段语义原文平移（lastSong 判定 + onSong 归档）。 */
  private class B2Ref {
    var lastSong = ""; private set
    val show = ArrayList<String>(); val hist = ArrayList<Pair<String, String>>()
    fun play(t: String, u0: String) {          // B2：t.isEmpty()||t==lastSong → continue（不产事件）
      if (t.isEmpty() || t == lastSong) return
      val old = lastSong
      lastSong = t
      show.add(t)
      if (old.isNotEmpty()) hist.add(u0 to old) // B2：uiMut/pushMeta 后 if(old.isNotEmpty()) onSong(u0, old)
    }
    fun reset() { lastSong = "" }               // B2：play/refresh/stop 清 lastSong
  }

  private fun sink() : Triple<LegacyMetadataSink, MutableList<String>, MutableList<Pair<String, String>>> {
    val show = mutableListOf<String>(); val hist = mutableListOf<Pair<String, String>>()
    return Triple(LegacyMetadataSink(show = { show.add(it) }, archive = { u, t -> hist.add(u to t) }), show, hist)
  }

  @Test fun legacy管线外独立分支B2语义全矩阵() {
    val (sk, show, hist) = sink(); val ref = B2Ref()
    val u0 = "http://a/1"
    val seq = listOf("A", "A", "", "A", "B", "A")   // 重复/空曲讯/空后回同曲/换歌/A-B-A 抖动
    for (t in seq) { sk.accept(u0, ev(u0, t, 1000L)); ref.play(t, u0) }
    sk.reset(); ref.reset()                           // 切台：清 last（旧世代事件由 PlayerHolder 世代令牌拦，不进 sink）
    val u1 = "http://b/1"
    for (t in listOf("X", "X", "Y")) { sk.accept(u1, ev(u1, t, 2000L)); ref.play(t, u1) }
    assertEquals(ref.show, show)                      // 上屏/setSong（ui.song + MediaSession）序列一致
    assertEquals(ref.hist, hist)                      // radio.songs 入史序列一致（键=台主 URL）
    assertEquals(listOf(u0 to "A", u0 to "B", u1 to "X"), hist)   // 明确断言：换歌旧曲一律入史（无 30s 窗）
  }

  @Test fun legacy空曲讯不覆盖有效曲名() {
    val (sk, show, hist) = sink()
    sk.accept("http://a/1", ev("http://a/1", "T1", 1000L))
    sk.accept("http://a/1", ev("http://a/1", "", 2000L))   // 空曲讯：无动作（显示保留 T1，不入史）
    assertEquals(listOf("T1"), show); assertTrue(hist.isEmpty())
    assertEquals("T1", sk.last)                            // last 不被空曲讯清（B2：空事件 continue 不动 lastSong）
  }

  @Test fun legacy重复曲讯不重渲不入史() {
    val (sk, show, hist) = sink()
    val e = ev("http://a/1", "T1", 1000L)
    sk.accept("http://a/1", e); sk.accept("http://a/1", e.copy(at = 600_000L))   // 任意久后的同名：仍去重（连续同名口径）
    assertEquals(listOf("T1"), show); assertTrue(hist.isEmpty())
  }

  @Test fun legacy切台reset后旧曲不串台不入史() {
    val (sk, show, hist) = sink()
    sk.accept("http://a/1", ev("http://a/1", "T1", 1000L))
    sk.reset()                                             // 切台/刷新/全部失败：清 last
    sk.accept("http://b/1", ev("http://b/1", "T2", 2000L)) // 新台首曲
    assertEquals(listOf("T1", "T2"), show)
    assertTrue(hist.isEmpty())                             // T1 不入史（B2：切台 lastSong 清零，不归档）
  }

  @Test fun legacy与v2管线入史窗差异实证() {   // flag 真切换行为：v2 30s 窗去重、legacy 换歌一律入史
    val (sk, _, hist) = sink()
    val u0 = "http://a/1"
    for (t in listOf("A", "B", "A", "B")) sk.accept(u0, ev(u0, t, 1000L))   // at 全同刻（窗内）
    assertEquals(listOf("A", "B", "A"), hist.map { it.second })             // legacy：B→A→B 三次换歌三次入史
    var st = MetadataPipeline.State()
    val seq = listOf("A" to 1000L, "B" to 5000L, "A" to 8000L, "B" to 12_000L)
    for ((t, at) in seq) st = MetadataPipeline.accept(st, ev(u0, t, at)).first
    // v2 管线：A、B 首次入史后 30s 窗内不再重复入（见 v2同名30s内已入史不重复入史 用例）；此处仅证 legacy 无窗
    assertEquals(3, hist.size)
  }

  @Test fun 换曲旧曲入史新曲上屏() {
    val st = MetadataPipeline.State("http://a/1", ev("http://a/1", "旧曲", 1000L), "旧曲")
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "新曲", 60_000L))
    assertEquals("新曲", d.show); assertEquals("http://a/1", d.archiveU0); assertEquals("旧曲", d.archiveTitle)
    assertEquals("新曲", s2.display); assertEquals("新曲", s2.last!!.title)
  }

  @Test fun v2同名30s内已入史不重复入史() {   // 抖动 A-B-A-B 防重复刷史（Web mpHistDecide 同语义）
    var st = MetadataPipeline.State()
    st = MetadataPipeline.accept(st, ev("http://a/1", "A", 1000L)).first
    var r = MetadataPipeline.accept(st, ev("http://a/1", "B", 5000L))
    assertEquals("A", r.second.archiveTitle)                       // A 入史
    r = MetadataPipeline.accept(r.first, ev("http://a/1", "A", 10_000L))
    assertEquals("B", r.second.archiveTitle)                       // B 入史
    r = MetadataPipeline.accept(r.first, ev("http://a/1", "B", 15_000L))
    assertNull(r.second.archiveTitle)                              // A 30s 窗内已入史 → 跳过（不入史）
    r = MetadataPipeline.accept(r.first, ev("http://a/1", "A", 45_000L))
    assertEquals("B", r.second.archiveTitle)                       // B 已出窗 → 可再入
  }

  @Test fun 首曲不归档() {
    val st = MetadataPipeline.reset(MetadataPipeline.State("http://a/1", ev("http://a/1", "旧", 1000L), "旧"), "http://a/1")
    assertEquals("", st.display); assertNull(st.last)
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "首曲", 2000L))
    assertEquals("首曲", d.show); assertNull(d.archiveU0)   // refresh 后同曲重报：只上屏不重复入史
  }

  @Test fun reset清空旧世代再接受新台() {
    var st = MetadataPipeline.State("http://a/1", ev("http://a/1", "T1", 1000L), "T1")
    st = MetadataPipeline.reset(st, "http://b/1")            // 切台：先清空再接受新世代事件
    assertEquals("http://b/1", st.station); assertEquals("", st.display); assertNull(st.last)
    val (s2, d) = MetadataPipeline.accept(st, ev("http://b/1", "T2", 2000L))
    assertFalse(d.dropped); assertEquals("T2", s2.display)
    // 清空后旧台迟到事件因 identityUrl 不匹配丢弃
    val (_, d3) = MetadataPipeline.accept(s2, ev("http://a/1", "T1", 3000L))
    assertTrue(d3.dropped)
  }

  @Test fun 无台态接受首个事件确立世代() {
    val st = MetadataPipeline.reset(MetadataPipeline.State(), null)
    val (s2, d) = MetadataPipeline.accept(st, ev("http://a/1", "T1", 1000L))
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
