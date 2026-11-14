package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.check.CheckStream
import io.github.vjoy233.vradio.check.DiagnosticCodec
import io.github.vjoy233.vradio.check.RawHttp
import io.github.vjoy233.vradio.check.toDiagnostic
import io.github.vjoy233.vradio.model.DiagnosticResult
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* DiagnosticModelTest（B1，plan-expansion-r4 §5.6）：Verdict 全 code 分支返回完整结构（B1 硬约束——
   所有正常/失败/HLS 分支都带 code/why/httpStatus/contentType/latencyMs/checkedAt）；
   Verdict.Code 枚举与 contracts/source-diagnostic.json 的 codes 数组零漂移；
   DiagnosticResult 与 contracts/fixtures/diagnostic-results.json 黄金样本逐字段对齐。 */
class DiagnosticModelTest {

  private class FakeRaw(private val map: Map<String, RawHttp.Resp?>) : RawHttp {
    override suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String>): RawHttp.Resp? = map[url]
  }

  private fun resp(bytes: Long, ct: String, status: Int = 200, body: ByteArray = ByteArray(0)) =
    RawHttp.Resp(status, ct, bytes, body)

  private fun cs(map: Map<String, RawHttp.Resp?>) = CheckStream(FakeRaw(map))

  private fun res(name: String): String =
    javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText()

  @Test fun codeEnumMatchesContract() { // contracts/source-diagnostic.json codes 数组 = Verdict.Code 全集
    val codes = JSONObject(res("source-diagnostic.json")).getJSONArray("codes")
    val expected = (0 until codes.length()).map { codes.getString(it) }
    assertEquals(expected, CheckStream.Verdict.Code.values().map { it.name })
  }

  @Test fun 直流全分支完整结构() = runBlocking {
    val ok = cs(mapOf("http://a/1.mp3" to resp(12000, "audio/mpeg"))).check("http://a/1.mp3")
    assertEquals(CheckStream.Verdict.Code.OK, ok.code); assertTrue(ok.ok)
    assertEquals(200, ok.httpStatus); assertEquals("audio/mpeg", ok.contentType)
    assertTrue(ok.checkedAt > 0); assertTrue(ok.why.isNotEmpty())

    val short = cs(mapOf("http://a/1.mp3" to resp(336, "audio/mpeg"))).check("http://a/1.mp3")
    assertEquals(CheckStream.Verdict.Code.SHORT_BODY, short.code); assertFalse(short.ok)
    assertEquals(336, short.bytes); assertEquals(200, short.httpStatus)

    val html = cs(mapOf("http://a/1.mp3" to resp(9000, "text/html"))).check("http://a/1.mp3")
    assertEquals(CheckStream.Verdict.Code.HTML, html.code); assertFalse(html.ok); assertEquals("text/html", html.contentType)

    val net = cs(emptyMap()).check("http://a/1.mp3")
    assertEquals(CheckStream.Verdict.Code.NETWORK, net.code); assertFalse(net.ok)
    assertEquals(0, net.httpStatus); assertEquals("", net.contentType); assertEquals(0L, net.bytes)

    val bad = cs(emptyMap()).check("ftp://x/1")
    assertEquals(CheckStream.Verdict.Code.INVALID_URL, bad.code); assertFalse(bad.ok)
  }

  @Test fun hls全分支完整结构() = runBlocking {
    val pl = "http://x/p.m3u8"
    val ok = cs(mapOf(
      pl to resp(300, "application/vnd.apple.mpegurl", body = "#EXTM3U\ns.ts\n".toByteArray()),
      "http://x/s.ts" to resp(7000, "video/mp2t"))).check(pl)
    assertEquals(CheckStream.Verdict.Code.OK, ok.code); assertTrue(ok.ok); assertTrue(ok.hls)

    val http = cs(mapOf(pl to resp(50, "", status = 404))).check(pl)
    assertEquals(CheckStream.Verdict.Code.HTTP, http.code); assertEquals(404, http.httpStatus)

    val empty = cs(mapOf(pl to resp(50, "", body = "#EXTM3U\r\n#EXT-X-ENDLIST\r\n".toByteArray()))).check(pl)
    assertEquals(CheckStream.Verdict.Code.EMPTY_PLAYLIST, empty.code); assertEquals(200, empty.httpStatus)

    val noSeg = cs(mapOf(pl to resp(410, "application/vnd.apple.mpegurl", body = "#EXTM3U\ngone.ts\n".toByteArray()))).check(pl)
    assertEquals(CheckStream.Verdict.Code.NO_SEGMENT, noSeg.code); assertEquals(410, noSeg.bytes) // 清单侧观察值（fixture 口径）

    val shortSeg = cs(mapOf(
      pl to resp(300, "", body = "#EXTM3U\ns.ts\n".toByteArray()),
      "http://x/s.ts" to resp(5999, "video/mp2t"))).check(pl)
    assertEquals(CheckStream.Verdict.Code.SHORT_BODY, shortSeg.code); assertFalse(shortSeg.ok)
  }

  @Test fun 全code枚举可构造() { // 九个 code 都能构造出完整结构（REDIRECT_REJECTED 安卓侧不产、枚举仍在）
    for (c in CheckStream.Verdict.Code.values()) {
      val v = CheckStream.Verdict(true, 1, false, "w", c, 200, "x", 3, 5L)
      assertEquals(c, v.code)
    }
  }

  @Test fun verdict转Diagnostic映射() = runBlocking {
    val v = cs(mapOf("http://a/1.mp3" to resp(12000, "audio/mpeg"))).check("http://a/1.mp3")
    val d = v.toDiagnostic("http://a/1.mp3")
    assertEquals("http://a/1.mp3", d.url); assertEquals("OK", d.code); assertTrue(d.ok)
    assertEquals("direct", d.mode); assertFalse(d.hls)
    assertEquals(v.httpStatus, d.httpStatus); assertEquals(v.bytes, d.bytes); assertEquals(v.checkedAt, d.checkedAt)

    val h = cs(emptyMap()).check("http://x/p.m3u8")
    assertEquals("hls", h.toDiagnostic("http://x/p.m3u8").mode)   // 探活视角：m3u8 形态 = hls 分片验收
  }

  @Test fun fixture逐字段对齐() { // contracts/fixtures/diagnostic-results.json 黄金样本 ↔ DiagnosticCodec 互读
    val j = JSONObject(res("fixtures/diagnostic-results.json"))
    assertFalse(j.getBoolean("ok"))
    val rs = j.getJSONArray("results")
    assertEquals(3, rs.length())
    val list = ArrayList<DiagnosticResult>()
    for (i in 0 until rs.length()) {
      val d = DiagnosticCodec.parse(rs.getJSONObject(i))
      assertNotNull(d); list.add(d!!)
    }
    val d0 = list[0]   // OK 直流
    assertEquals("https://music.example.test/live.mp3", d0.url); assertTrue(d0.ok); assertEquals("OK", d0.code)
    assertEquals("direct", d0.mode); assertFalse(d0.hls); assertEquals(12000L, d0.bytes); assertEquals(320L, d0.latencyMs)
    assertEquals("audio/mpeg", d0.contentType); assertEquals(200, d0.httpStatus)
    assertEquals("audio/mpeg 12000B", d0.why); assertEquals(1731500000000L, d0.checkedAt)
    val d1 = list[1]   // HLS 无分片
    assertEquals("NO_SEGMENT", d1.code); assertFalse(d1.ok); assertTrue(d1.hls); assertEquals("hls", d1.mode)
    assertEquals(410L, d1.bytes); assertEquals("application/vnd.apple.mpegurl", d1.contentType)
    val d2 = list[2]   // 336B 假流（fixture 口径：text/html 且窗内不足 → SHORT_BODY 而非 HTML）
    assertEquals("SHORT_BODY", d2.code); assertEquals(336L, d2.bytes); assertEquals("text/html", d2.contentType)
    // round-trip：编回 JSON 再读，全部字段不丢
    for (d in list) {
      val back = DiagnosticCodec.parse(DiagnosticCodec.toJson(d))
      assertEquals(d, back)
    }
  }

  @Test fun codec坏形状容错() {
    assertNullShape(JSONObject())                                   // 空
    assertNullShape(JSONObject().put("url", "http://a/1"))          // 缺 code
    assertNullShape(JSONObject().put("code", "OK"))                 // 缺 url
    assertNotNull(DiagnosticCodec.parse(JSONObject().put("url", "http://a/1").put("code", "OK")))   // 最小形态可读
  }

  private fun assertNullShape(o: JSONObject) { assertEquals(null, DiagnosticCodec.parse(o)) }
}
