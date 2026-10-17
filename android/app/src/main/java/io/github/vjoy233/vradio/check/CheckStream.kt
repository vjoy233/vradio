package io.github.vjoy233.vradio.check

import io.github.vjoy233.vradio.consts.C
import kotlinx.coroutines.DisposableHandle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext

/* 流可用性探测（update-sources.js checkStream 移植，server.js /api/check 与 /api/mystation 同引擎）。
   字节验收纪律（AGENTS.md 已知坑，xmcdn 假流免疫的唯一资产）：
   **不能信状态码/Content-Type**——喜马拉雅 CDN 假流回 200+audio/mpeg 但只吐几百字节，
   部分频道漂移已死；唯一可信证据 = 观察窗内持续吐数据 ≥ 阈值字节。Content-Type 仅用来拒
   text/html 错误页；直流路径不看状态码（与 Web 同款），HLS 清单例外要求 HTTP 200。
   并发由调用方（AppVm）控制；蜻蜓系建流 5-10s 属正常，mystation 入口传 12s 窗。 */

/** 字节级拉流接口（okhttp 实现在下；探活专用，曲讯/台标走 HttpText）。 */
interface RawHttp {
  data class Resp(val status: Int, val ct: String, val bytes: Long, val body: ByteArray)
  /** 读到 maxBytes / 流自然结束 / 窗口到即返回；bytes = 窗内累计总字节（超限部分不保但计数）。失败返回 null 不抛。 */
  suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String> = emptyMap()): Resp?
}

/** okhttp 实现：读静默超时 = 窗口、绝对截止 = 窗 + 1.5s（update-sources.js request 的 socket timeout + deadline 双闸同款）。 */
class OkHttpRaw(private val base: OkHttpClient = OkHttpClient()) : RawHttp {
  override suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String>): RawHttp.Resp? =
    withContext(Dispatchers.IO) {
      try {
        val client = base.newBuilder()
          .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
          .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
          .build()
        val req = Request.Builder().url(url)
          .header("User-Agent", "vradio/0.1 (+local radio player)")   // UA 同 Web（update-sources.js request()）
          .apply { headers.forEach { (k, v) -> header(k, v) } }
          .build()
        val call = client.newCall(req)
        call.timeout().timeout(timeoutMs + 1500, TimeUnit.MILLISECONDS)  // 绝对截止：慢速活流不悬挂
        val h: DisposableHandle = coroutineContext.job.invokeOnCompletion { if (it != null) call.cancel() }
        try {
          call.execute().use { resp ->
            val src = resp.body?.byteStream()
            if (src == null) null
            else {
              val bos = ByteArrayOutputStream(minOf(maxBytes, 1L shl 20).toInt())
              val buf = ByteArray(65536)
              var n = 0L
              while (true) {                       // 直播流攒够即收，不读完（JS res.on('data') 同款）
                val r = src.read(buf)
                if (r < 0) break
                n += r
                if (n <= maxBytes) bos.write(buf, 0, r)
                if (n >= maxBytes) break
              }
              RawHttp.Resp(resp.code, resp.header("Content-Type") ?: "", n, bos.toByteArray())
            }
          }
        } finally { h.dispose() }
      } catch (_: IOException) { null }            // 超时/拒连/流中断：网络失败≠死台结论，探活层面统一「网络失败」
      catch (_: IllegalArgumentException) { null } // 畸形 URL
    }
}

class CheckStream(private val http: RawHttp) {
  data class Verdict(val ok: Boolean, val bytes: Long, val hls: Boolean, val why: String)

  companion object {
    // 与 Web 同款 \.m3u8?(\?|$)/i：.M3U8 大小写变形同判（server.js nowplaying 短路先例）
    private val RE_HLS = Regex("\\.m3u8?(\\?|$)", RegexOption.IGNORE_CASE)
    private const val MAX_DIRECT = 24000L   // 直流攒够即收上限（JS 同款）
    private const val MAX_PLAYLIST = 8000L  // m3u8 清单
    private const val MAX_SEGMENT = 16000L  // 首段分片
  }

  suspend fun check(url: String, windowMs: Long = C.CHECK_WINDOW_MS): Verdict =
    if (RE_HLS.containsMatchIn(url)) checkHls(url, windowMs, 0) else checkDirect(url, windowMs)

  /** 非 HLS：窗内累计 ≥8000B 且非 HTML 认活（不看状态码）。 */
  private suspend fun checkDirect(url: String, win: Long): Verdict {
    val r = http.get(url, win, MAX_DIRECT) ?: return Verdict(false, 0, false, "网络失败")
    val ok = r.bytes >= C.CHECK_MIN_BYTES && !isHtml(r.ct)
    return Verdict(ok, r.bytes, false, "${if (r.ct.isEmpty()) "未知类型" else r.ct} ${r.bytes}B")
  }

  /** HLS：拉清单 → 首个非 # 行为分片 → 拉分片验收 ≥6000B；master playlist 递归解一层（depth<2）。 */
  private suspend fun checkHls(url: String, win: Long, depth: Int): Verdict {
    val pl = http.get(url, win, MAX_PLAYLIST) ?: return Verdict(false, 0, true, "网络失败")
    if (pl.status != 200) return Verdict(false, pl.bytes, true, "清单 HTTP ${pl.status}")
    val seg = String(pl.body, Charsets.UTF_8).split(Regex("\r?\n")).map { it.trim() }
      .firstOrNull { it.isNotEmpty() && !it.startsWith("#") }
      ?: return Verdict(false, pl.bytes, true, "清单无分片")
    val segUrl = resolve(seg, url) ?: return Verdict(false, pl.bytes, true, "分片地址无法解析")
    if (RE_HLS.containsMatchIn(segUrl) && depth < 2) return checkHls(segUrl, win, depth + 1)
    val r2 = http.get(segUrl, win, MAX_SEGMENT) ?: return Verdict(false, 0, true, "网络失败")
    val ok = r2.bytes >= C.CHECK_MIN_BYTES_HLS && !isHtml(r2.ct)
    return Verdict(ok, r2.bytes, true, "hls分片 ${r2.bytes}B")
  }

  private fun isHtml(ct: String) = ct.contains("text/html", ignoreCase = true)

  /** 相对分片拼回远端 base（JS new URL(seg, url)）；URI 对未转义中文等非法字符会抛——绝对地址直收，相对解析失败即拒。 */
  private fun resolve(seg: String, base: String): String? {
    if (seg.startsWith("http://", true) || seg.startsWith("https://", true)) return seg
    return try { URI(base).resolve(seg).toString() } catch (_: Exception) { null }
  }
}
