package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.check.CheckStream
import io.github.vjoy233.vradio.check.RawHttp
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/* CheckStream 离线部分：FakeRaw 喂罐头响应，验收字节纪律/HTML 拒收（含谎报 Content-Type 的内容嗅探，review P2）/
   HLS 链路/相对分片解析。网络实现（OkHttpRaw）不在此测——真流验收靠端上行为验证（AGENTS.md：行为验证 = 实际点播）。 */
class CheckStreamTest {

  private class FakeRaw(private val map: Map<String, RawHttp.Resp?>) : RawHttp {
    override suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String>): RawHttp.Resp? = map[url]
  }

  private fun resp(bytes: Long, ct: String, status: Int = 200, body: ByteArray = ByteArray(0)) =
    RawHttp.Resp(status, ct, bytes, body)

  private fun cs(map: Map<String, RawHttp.Resp?>) = CheckStream(FakeRaw(map))

  @Test fun 直流活流() = runBlocking {
    val v = cs(mapOf("http://a/1.mp3" to resp(10000, "audio/mpeg"))).check("http://a/1.mp3")
    assertTrue(v.ok); assertEquals(10000, v.bytes); assertFalse(v.hls)
  }

  @Test fun 直流假流字节不足() = runBlocking {
    val v = cs(mapOf("http://a/1.mp3" to resp(336, "audio/mpeg"))).check("http://a/1.mp3")   // xmcdn 假流 336B 形态
    assertFalse(v.ok); assertEquals(336, v.bytes)
  }

  @Test fun 直流HTML错误页拒收() = runBlocking {
    val v = cs(mapOf("http://a/1.mp3" to resp(9000, "text/html"))).check("http://a/1.mp3")
    assertFalse(v.ok)
    assertEquals(CheckStream.Verdict.Code.HTML, v.code)
  }

  @Test fun 直流大HTML谎报CT内容嗅探拒收() = runBlocking {   // review P2：字节达标后仍执行 HTML 内容判定（Web htmlLike 同款）
    val body = ("<html>" + "x".repeat(9000) + "</html>").toByteArray()
    val v = cs(mapOf("http://a/1.mp3" to resp(9000, "application/octet-stream", body = body))).check("http://a/1.mp3")
    assertFalse(v.ok)
    assertEquals(CheckStream.Verdict.Code.HTML, v.code)
  }

  @Test fun 直流小HTML谎报CT仍按字节不足() = runBlocking {   // 判序冻结：SHORT_BODY 先于 HTML（不前移判定）
    val body = ("<html>" + "x".repeat(300) + "</html>").toByteArray()
    val v = cs(mapOf("http://a/1.mp3" to resp(500, "application/octet-stream", body = body))).check("http://a/1.mp3")
    assertFalse(v.ok)
    assertEquals(CheckStream.Verdict.Code.SHORT_BODY, v.code)
  }

  @Test fun 直流网络失败() = runBlocking {
    val v = cs(emptyMap()).check("http://a/1.mp3")
    assertFalse(v.ok); assertEquals("网络失败", v.why)
  }

  @Test fun hls全链() = runBlocking {
    val pl = "http://x/live/playlist.m3u8"
    val seg = "http://x/live/seg123.ts"
    val v = cs(mapOf(
      pl to resp(300, "application/vnd.apple.mpegurl", body = "#EXTM3U\r\n#EXT-X-TARGETDURATION:10\r\nseg123.ts\r\n".toByteArray()),
      seg to resp(7000, "video/mp2t"))).check(pl)
    assertTrue(v.ok); assertTrue(v.hls); assertEquals(7000, v.bytes); assertEquals("hls分片 7000B", v.why)
  }

  @Test fun hls相对分片拼回远端base() = runBlocking {
    val pl = "http://x/live/a/playlist.m3u8"
    val v = cs(mapOf(
      pl to resp(300, "application/x-mpegURL", body = "#EXTM3U\n../b/chunk1.ts\n".toByteArray()),
      "http://x/live/b/chunk1.ts" to resp(9000, "video/mp2t"))).check(pl)   // 相对路径 ../b/ 必须解析回远端而非本地
    assertTrue(v.ok)
  }

  @Test fun hls分片字节不足() = runBlocking {
    val pl = "http://x/p.m3u8"
    val v = cs(mapOf(
      pl to resp(200, "", body = "#EXTM3U\ns.ts\n".toByteArray()),
      "http://x/s.ts" to resp(5999, "video/mp2t"))).check(pl)
    assertFalse(v.ok)
  }

  @Test fun master先解variant再验分片() = runBlocking {
    val master = "http://x/master.m3u8"; val variant = "http://x/v1.m3u8"; val seg = "http://x/a1.ts"
    val v = cs(mapOf(
      master to resp(120, "", body = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nv1.m3u8\n".toByteArray()),
      variant to resp(120, "", body = "#EXTM3U\na1.ts\n".toByteArray()),
      seg to resp(12000, "video/mp2t"))).check(master)
    assertTrue(v.ok); assertTrue(v.hls)
  }

  @Test fun hls清单非200() = runBlocking {
    val v = cs(mapOf("http://x/p.m3u8" to resp(50, "", status = 404))).check("http://x/p.m3u8")
    assertFalse(v.ok); assertEquals("清单 HTTP 404", v.why)
  }

  @Test fun hls清单无分片() = runBlocking {
    val v = cs(mapOf("http://x/p.m3u8" to resp(50, "", body = "#EXTM3U\r\n#EXT-X-ENDLIST\r\n".toByteArray()))).check("http://x/p.m3u8")
    assertFalse(v.ok); assertEquals("清单无分片", v.why)
  }

  @Test fun m3u8大小写变形同判hls() = runBlocking {
    val v = cs(emptyMap()).check("http://x/live.M3U8")
    assertTrue(v.hls); assertEquals("网络失败", v.why)
  }
}
