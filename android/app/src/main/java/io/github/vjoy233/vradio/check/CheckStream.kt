package io.github.vjoy233.vradio.check

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.model.DiagnosticResult
import kotlinx.coroutines.DisposableHandle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
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
   并发由调用方（AppVm）控制；蜻蜓系建流 5-10s 属正常，mystation 入口传 12s 窗。
   B1（plan-expansion-r4 §5.1）：Verdict 结构化——所有正常/失败/HLS 分支都返回完整结构，
   code 是程序分支唯一依据，why 仍是人读文案（UI 不得按 why 反推状态）。 */

/** 字节级拉流接口（okhttp 实现在下；探活专用，曲讯/台标走 HttpText）。 */
interface RawHttp {
  data class Resp(val status: Int, val ct: String, val bytes: Long, val body: ByteArray, val latencyMs: Long = 0)
  /** 读到 maxBytes / 流自然结束 / 窗口到即返回；bytes = 窗内累计总字节（超限部分不保但计数）。
      latencyMs = 建流延迟（请求发起 → 响应头到达，TTFB 近似；B1 诊断字段）。失败返回 null 不抛。 */
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
          val t0 = System.nanoTime()                     // 建流延迟采样起点（B1：响应头到达即停）
          call.execute().use { resp ->
            val lat = (System.nanoTime() - t0) / 1_000_000L
            val src = resp.body?.byteStream()
            if (src == null) null
            else {
              val bos = ByteArrayOutputStream(minOf(maxBytes, 1L shl 20).toInt())
              val buf = ByteArray(65536)
              var n = 0L
              while (true) {                       // 直播流攒够即收，不读完（JS res.on('data') 同款）；body 保留
                val r = src.read(buf)              // 流头——跨上限的读按剩余截断（前缀完整供 isHtmlResp 嗅探用）
                if (r < 0) break
                val room = (maxBytes - bos.size()).toInt()
                if (room > 0) bos.write(buf, 0, minOf(r, room))
                n += r
                if (n >= maxBytes) break
              }
              RawHttp.Resp(resp.code, resp.header("Content-Type") ?: "", n, bos.toByteArray(), lat)
            }
          }
        } finally { h.dispose() }
      } catch (_: IOException) { null }            // 超时/拒连/流中断：网络失败≠死台结论，探活层面统一「网络失败」
      catch (_: IllegalArgumentException) { null } // 畸形 URL
    }
}

class CheckStream(private val http: RawHttp) {
  /** 结构化探活结论（B1，contracts/source-diagnostic.json 契约面）。code 判定次序（双端须一致）：
   *  直流/分片 = SHORT_BODY（窗内字节不足，fixture 336B 假流口径——先于 HTML 判，判序冻结）> HTML
   *  （isHtmlResp：CT 头或正文前缀，字节达标后仍执行内容判定——≥8000B HTML 错误页谎报 CT 也拒，review P2）> OK；
   *  REDIRECT_REJECTED/INVALID_URL 安卓侧不可达值——okhttp 默认跟重定向不逐跳复查（G P3 留档的
   *  已知差异），INVALID_URL 仅在入口 http(s) 形态预检时触发；两值保留是为枚举与 Web/契约对齐。 */
  data class Verdict(val ok: Boolean, val bytes: Long, val hls: Boolean, val why: String, val code: Code,
    val httpStatus: Int, val contentType: String, val latencyMs: Long, val checkedAt: Long) {
    enum class Code { OK, NETWORK, HTML, HTTP, EMPTY_PLAYLIST, NO_SEGMENT, SHORT_BODY, REDIRECT_REJECTED, INVALID_URL }
  }

  companion object {
    // 与 Web 同款 \.m3u8?(\?|$)/i：.M3U8 大小写变形同判（server.js nowplaying 短路先例）
    private val RE_HLS = Regex("\\.m3u8?(\\?|$)", RegexOption.IGNORE_CASE)
    private val RE_URL = Regex("^https?://", RegexOption.IGNORE_CASE)
    private const val MAX_DIRECT = 24000L   // 直流攒够即收上限（JS 同款）
    private const val MAX_PLAYLIST = 8000L  // m3u8 清单
    private const val MAX_SEGMENT = 16000L  // 首段分片
  }

  suspend fun check(url: String, windowMs: Long = C.CHECK_WINDOW_MS): Verdict {
    if (!RE_URL.containsMatchIn(url)) return v(false, 0, false, "地址不合法", Verdict.Code.INVALID_URL, 0, "", 0)
    return if (RE_HLS.containsMatchIn(url)) checkHls(url, windowMs, 0) else checkDirect(url, windowMs)
  }

  private fun v(ok: Boolean, bytes: Long, hls: Boolean, why: String, code: Verdict.Code, st: Int, ct: String, lat: Long) =
    Verdict(ok, bytes, hls, why, code, st, ct, lat, System.currentTimeMillis())

  /** 非 HLS：窗内累计 ≥8000B 且非 HTML 认活（不看状态码）。HTML 判定 = CT 头或正文前缀嗅探（isHtmlResp，
      与 Web htmlLike 双端同款，review P2）——字节达标后仍执行，谎报 Content-Type 的大 HTML 错误页也拒。 */
  private suspend fun checkDirect(url: String, win: Long): Verdict {
    val r = http.get(url, win, MAX_DIRECT) ?: return v(false, 0, false, "网络失败", Verdict.Code.NETWORK, 0, "", 0)
    val code = when {
      r.bytes < C.CHECK_MIN_BYTES -> Verdict.Code.SHORT_BODY             // 窗内字节不足（336B 假流类，fixture 口径；先于 HTML 判——判序冻结）
      isHtmlResp(r.ct, r.body) -> Verdict.Code.HTML                      // 整页 HTML 错误页（CT 头或内容前缀）
      else -> Verdict.Code.OK
    }
    val why = when (code) {
      Verdict.Code.HTML -> "HTML 错误页 ${r.bytes}B"
      Verdict.Code.SHORT_BODY -> "窗内仅 ${r.bytes}B（假流）"
      else -> "${if (r.ct.isEmpty()) "未知类型" else r.ct} ${r.bytes}B"
    }
    return v(code == Verdict.Code.OK, r.bytes, false, why, code, r.status, r.ct, r.latencyMs)
  }

  /** HLS：拉清单 → 首个非 # 行为分片 → 拉分片验收 ≥6000B；master playlist 递归解一层（depth<2）。
      清单活、分片建连失败/地址解析失败归 NO_SEGMENT（bytes/contentType 报清单侧观察值，fixture 口径）。 */
  private suspend fun checkHls(url: String, win: Long, depth: Int): Verdict {
    val pl = http.get(url, win, MAX_PLAYLIST) ?: return v(false, 0, true, "网络失败", Verdict.Code.NETWORK, 0, "", 0)
    if (pl.status != 200) return v(false, pl.bytes, true, "清单 HTTP ${pl.status}", Verdict.Code.HTTP, pl.status, pl.ct, pl.latencyMs)
    val seg = String(pl.body, Charsets.UTF_8).split(Regex("\r?\n")).map { it.trim() }
      .firstOrNull { it.isNotEmpty() && !it.startsWith("#") }
      ?: return v(false, pl.bytes, true, "清单无分片", Verdict.Code.EMPTY_PLAYLIST, pl.status, pl.ct, pl.latencyMs)
    val segUrl = resolve(seg, url)
      ?: return v(false, pl.bytes, true, "分片地址无法解析", Verdict.Code.NO_SEGMENT, pl.status, pl.ct, pl.latencyMs)
    if (RE_HLS.containsMatchIn(segUrl) && depth < 2) return checkHls(segUrl, win, depth + 1)
    val r2 = http.get(segUrl, win, MAX_SEGMENT)
      ?: return v(false, pl.bytes, true, "网络失败", Verdict.Code.NO_SEGMENT, pl.status, pl.ct, pl.latencyMs)
    val code = when {
      isHtml(r2.ct) && r2.bytes >= C.CHECK_MIN_BYTES_HLS -> Verdict.Code.HTML
      r2.bytes < C.CHECK_MIN_BYTES_HLS -> Verdict.Code.SHORT_BODY
      else -> Verdict.Code.OK
    }
    val why = when (code) {
      Verdict.Code.OK -> "hls分片 ${r2.bytes}B"
      Verdict.Code.HTML -> "分片 HTML 错误页 ${r2.bytes}B"
      else -> "分片窗内仅 ${r2.bytes}B"
    }
    return v(code == Verdict.Code.OK, r2.bytes, true, why, code, r2.status, r2.ct, r2.latencyMs)
  }

  private fun isHtml(ct: String) = ct.contains("text/html", ignoreCase = true)

  /** HTML 错误页判定（review P2，Web htmlLike 双端同款）：CT 头 text/html **或** 正文前缀嗅探（BOM/空白后
      以 <!doctype html / <html+空白或> 开头）。音频/TS 流首字节是 ID3/0xFF/0x47 等帧头，前缀嗅探不会误伤。 */
  private fun isHtmlResp(ct: String, body: ByteArray): Boolean {
    if (isHtml(ct)) return true
    val head = String(body.copyOfRange(0, minOf(256, body.size)), Charsets.UTF_8)
      .trimStart('\uFEFF').trimStart().lowercase()
    if (head.startsWith("<!doctype html")) return true
    return head.startsWith("<html") && head.length > 5 && (head[5] == '>' || head[5].isWhitespace())
  }

  /** 相对分片拼回远端 base（JS new URL(seg, url)）；URI 对未转义中文等非法字符会抛——绝对地址直收，相对解析失败即拒。 */
  private fun resolve(seg: String, base: String): String? {
    if (seg.startsWith("http://", true) || seg.startsWith("https://", true)) return seg
    return try { URI(base).resolve(seg).toString() } catch (_: Exception) { null }
  }
}

/** Verdict → DiagnosticResult（B1 源详情面板/质量事件的数据面）：mode 探活视角 = direct 直流字节验收 / hls 分片验收。 */
fun CheckStream.Verdict.toDiagnostic(url: String): DiagnosticResult = DiagnosticResult(
  url, ok, code.name, hls, if (hls) "hls" else "direct", httpStatus, contentType, bytes, latencyMs, why, checkedAt)

/** DiagnosticResult 的 JSON 编解码（contracts/source-diagnostic.json 的 result 形态；fixture 互读/双端对齐用）。
    url/code 为必备字段（缺即 null），其余字段缺省回退中性值。 */
object DiagnosticCodec {
  fun parse(o: JSONObject): DiagnosticResult? {
    val url = o.optString("url")
    val code = o.optString("code")
    if (url.isEmpty() || code.isEmpty()) return null
    return DiagnosticResult(url, o.optBoolean("ok"), code, o.optBoolean("hls"), o.optString("mode"),
      o.optInt("httpStatus", 0), o.optString("contentType"), o.optLong("bytes", 0L),
      o.optLong("latencyMs", 0L), o.optString("why"), o.optLong("checkedAt", 0L))
  }

  fun toJson(r: DiagnosticResult): JSONObject = JSONObject()
    .put("url", r.url).put("ok", r.ok).put("code", r.code).put("hls", r.hls).put("mode", r.mode)
    .put("httpStatus", r.httpStatus).put("contentType", r.contentType).put("bytes", r.bytes)
    .put("latencyMs", r.latencyMs).put("why", r.why).put("checkedAt", r.checkedAt)
}
