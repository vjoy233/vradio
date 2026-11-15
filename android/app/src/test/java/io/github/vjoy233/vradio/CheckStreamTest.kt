package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.check.CheckStream
import io.github.vjoy233.vradio.check.GuardDns
import io.github.vjoy233.vradio.check.RawHttp
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

/* CheckStream 离线部分：FakeRaw 喂罐头响应，验收字节纪律/HTML 拒收（含谎报 Content-Type 的内容嗅探，review P2）/
   HLS 链路/相对分片解析/逐跳重定向复查（回环/私网 Location 拒收 + 深度上限，review P1-5）。
   网络实现（OkHttpRaw 的 GuardDns 连接级护栏按纯函数测）不在此整体测——真流验收靠端上行为验证
   （AGENTS.md：行为验证 = 实际点播）。 */
class CheckStreamTest {

  private class FakeRaw(private val map: Map<String, RawHttp.Resp?>) : RawHttp {
    override suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String>): RawHttp.Resp? = map[url]
  }

  private fun resp(bytes: Long, ct: String, status: Int = 200, body: ByteArray = ByteArray(0), location: String? = null) =
    RawHttp.Resp(status, ct, bytes, body, location = location)

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

  // —— 逐跳重定向复查（B1 review P1-5：每跳 Location 过 SafeTarget，回环/私网拒收；Web request() 护栏镜像）——

  @Test fun 重定向公网链逐跳跟随() = runBlocking {   // 相对 Location 拼回 base 后过 SafeTarget，正常跟到最终流
    val v = cs(mapOf(
      "http://a/1.mp3" to resp(0, "", status = 302, location = "/hop.mp3"),
      "http://a/hop.mp3" to resp(9000, "audio/mpeg"))).check("http://a/1.mp3")
    assertTrue(v.ok); assertEquals(CheckStream.Verdict.Code.OK, v.code)
  }

  @Test fun 重定向到回环拒收() = runBlocking {
    val v = cs(mapOf("http://a/1.mp3" to resp(0, "", status = 302, location = "http://127.0.0.1/x.mp3"))).check("http://a/1.mp3")
    assertFalse(v.ok); assertEquals(CheckStream.Verdict.Code.REDIRECT_REJECTED, v.code)
  }

  @Test fun 重定向到私网拒收() = runBlocking {   // 10/8、192.168/16、172.16/12 与十六进制变形（SafeTarget WHATWG 归一）
    for (loc in listOf("http://10.0.0.1/x.mp3", "http://192.168.1.1/x.mp3", "http://172.16.0.1/x.mp3", "http://0x7f.0.0.1/x.mp3")) {
      val v = cs(mapOf("http://a/1.mp3" to resp(0, "", status = 302, location = loc))).check("http://a/1.mp3")
      assertEquals(CheckStream.Verdict.Code.REDIRECT_REJECTED, v.code)
    }
  }

  @Test fun 重定向深度上限拒收() = runBlocking {   // >5 跳 → REDIRECT_REJECTED（Web maxRedirect=5 同款）
    val m = HashMap<String, RawHttp.Resp?>()
    for (i in 0..5) m["http://h/$i.mp3"] = resp(0, "", status = 302, location = "http://h/${i + 1}.mp3")
    m["http://h/6.mp3"] = resp(9000, "audio/mpeg")
    val v = cs(m).check("http://h/0.mp3")
    assertEquals(CheckStream.Verdict.Code.REDIRECT_REJECTED, v.code)
  }

  @Test fun 入口私网地址预检拒() = runBlocking {   // 初始 URL 即回环/私网 → INVALID_URL（Web safeTarget 同口径）
    assertEquals(CheckStream.Verdict.Code.INVALID_URL, cs(emptyMap()).check("http://127.0.0.1/x.mp3").code)
    assertEquals(CheckStream.Verdict.Code.INVALID_URL, cs(emptyMap()).check("http://10.0.0.1/x.mp3").code)
  }

  @Test fun hls清单重定向私网拒收() = runBlocking {
    val v = cs(mapOf("http://x/p.m3u8" to resp(0, "", status = 302, location = "http://192.168.0.9/p.m3u8"))).check("http://x/p.m3u8")
    assertEquals(CheckStream.Verdict.Code.REDIRECT_REJECTED, v.code)
  }

  @Test fun GuardDns地址公网判定() {   // 连接级护栏纯函数（Web isPrivateIp 同口径；字面量解析不发 DNS）
    for (bad in listOf("127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.9.9", "100.64.0.1", "0.0.0.0", "::1", "::", "fc00::1", "fd12::3456", "fe80::1"))
      assertFalse(GuardDns.isPublicAddr(InetAddress.getByName(bad)))
    for (good in listOf("8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"))
      assertTrue(GuardDns.isPublicAddr(InetAddress.getByName(good)))
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
