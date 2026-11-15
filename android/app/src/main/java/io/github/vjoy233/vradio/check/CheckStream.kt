package io.github.vjoy233.vradio.check

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.SafeTarget
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
import java.net.Inet4Address
import java.net.InetAddress
import java.net.URI
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext

/* 流可用性探测（update-sources.js checkStream 移植，server.js /api/check 与 /api/mystation 同引擎）。
   字节验收纪律（AGENTS.md 已知坑，xmcdn 假流免疫的唯一资产）：
   **不能信状态码/Content-Type**——喜马拉雅 CDN 假流回 200+audio/mpeg 但只吐几百字节，
   部分频道漂移已死；唯一可信证据 = 观察窗内持续吐数据 ≥ 阈值字节。Content-Type 仅用来拒
   text/html 错误页；直流路径不看状态码（与 Web 同款），HLS 清单例外要求 HTTP 200。
   并发由调用方（AppVm）控制；蜻蜓系建流 5-10s 属正常，mystation 入口传 12s 窗。
   B1（plan-expansion-r4 §5.1）：Verdict 结构化——所有正常/失败/HLS 分支都返回完整结构，
   code 是程序分支唯一依据，why 仍是人读文案（UI 不得按 why 反推状态）。
   SSRF 双层护栏（B1 review P1-5，§13.4 对齐 Web）：字符串层 = 入口/每跳 Location 过 SafeTarget
   （data/Guards.kt）；连接层 = OkHttpRaw 挂 GuardDns（guardLookup 镜像，实际建连解析即校验）。 */

/** 字节级拉流接口（okhttp 实现在下；探活专用，曲讯/台标走 HttpText）。 */
interface RawHttp {
  /** location = 重定向 Location 头（B1 review P1-5：OkHttp 已关自动跟随，3xx 原样上抛由 CheckStream 逐跳复查）。 */
  data class Resp(val status: Int, val ct: String, val bytes: Long, val body: ByteArray, val latencyMs: Long = 0,
    val location: String? = null)
  /** 读到 maxBytes / 流自然结束 / 窗口到即返回；bytes = 窗内累计总字节（超限部分不保但计数）。
      latencyMs = 建流延迟（请求发起 → 响应头到达，TTFB 近似；B1 诊断字段）。失败返回 null 不抛。 */
  suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String> = emptyMap()): Resp?
}

/** 连接级校验（Web guardLookup 镜像，B1 review P1-5）：自定义 Dns 传给 OkHttp——校验的就是实际建连用的
    那次解析，DNS rebinding 换 IP 也逃不过；解析出任一回环/私网/链路本地/CGNAT/ULA 地址即拒
    （UnknownHostException → IOException → NETWORK）。isPublicAddr 纯函数 JVM 直测。 */
object GuardDns : okhttp3.Dns {
  override fun lookup(hostname: String): List<InetAddress> {
    val addrs = okhttp3.Dns.SYSTEM.lookup(hostname)
    if (addrs.any { !isPublicAddr(it) }) throw UnknownHostException("目标解析到内网/环回地址: $hostname")
    return addrs
  }

  /** 地址公网判定（Web isPrivateIp 同口径：回环/ANY/链路本地/私网 A·B·C + 100.64/10 CGNAT + fc/fd ULA）。
      InetAddress 自带口径缺 CGNAT 与 IPv6 ULA（其 isSiteLocalAddress 只认已废弃的 fec0/10），在此补齐。 */
  fun isPublicAddr(a: InetAddress): Boolean {
    if (a.isAnyLocalAddress || a.isLoopbackAddress || a.isLinkLocalAddress || a.isSiteLocalAddress) return false
    val h = (a.hostAddress ?: "").substringBefore('%').lowercase()
    if (a is Inet4Address) {
      val o = h.split('.'); val b0 = o.getOrNull(0)?.toIntOrNull() ?: return true; val b1 = o.getOrNull(1)?.toIntOrNull() ?: return true
      return !(b0 == 100 && b1 in 64..127)                    // 100.64.0.0/10 CGNAT（Web isPrivateIp 同款）
    }
    return !(h == "::" || h.startsWith("fc") || h.startsWith("fd")) // IPv6：ANY/ULA fc00-fdff
  }
}

/** okhttp 实现：读静默超时 = 窗口、绝对截止 = 窗 + 1.5s（update-sources.js request 的 socket timeout + deadline 双闸同款）；
    关自动重定向（B1 review P1-5）——逐跳 Location 的 SafeTarget 复查在 CheckStream.fetch，自动跟随会整段绕过。 */
class OkHttpRaw(private val base: OkHttpClient = OkHttpClient()) : RawHttp {
  override suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String>): RawHttp.Resp? =
    withContext(Dispatchers.IO) {
      try {
        val client = base.newBuilder()
          .followRedirects(false)
          .followSslRedirects(false)
          .dns(GuardDns)                                       // 连接级护栏（guardLookup 镜像）
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
              RawHttp.Resp(resp.code, resp.header("Content-Type") ?: "", n, bos.toByteArray(), lat, resp.header("Location"))
            }
          }
        } finally { h.dispose() }
      } catch (_: IOException) { null }            // 超时/拒连/流中断（含 GuardDns 拒）：网络失败≠死台结论，统一「网络失败」
      catch (_: IllegalArgumentException) { null } // 畸形 URL
    }
}

class CheckStream(private val http: RawHttp) {
  /** 结构化探活结论（B1，contracts/source-diagnostic.json 契约面）。code 判定次序（双端须一致）：
   *  直流/分片 = SHORT_BODY（窗内字节不足，fixture 336B 假流口径——先于 HTML 判，判序冻结）> HTML
   *  （isHtmlResp：CT 头或正文前缀，字节达标后仍执行内容判定——≥8000B HTML 错误页谎报 CT 也拒，review P2）> OK；
   *  REDIRECT_REJECTED（B1 review P1-5）：OkHttp 已关自动跟随，fetch 逐跳复查 Location——每跳过 SafeTarget
   *  形态校验、≤MAX_REDIRECTS 跳，超限/目标非公网即拒（Web request() 重定向护栏镜像）；
   *  INVALID_URL = 入口 SafeTarget 预检拒（含私网/回环字面量，Web safeTarget 同口径）。 */
  data class Verdict(val ok: Boolean, val bytes: Long, val hls: Boolean, val why: String, val code: Code,
    val httpStatus: Int, val contentType: String, val latencyMs: Long, val checkedAt: Long) {
    enum class Code { OK, NETWORK, HTML, HTTP, EMPTY_PLAYLIST, NO_SEGMENT, SHORT_BODY, REDIRECT_REJECTED, INVALID_URL }
  }

  companion object {
    // 与 Web 同款 \.m3u8?(\?|$)/i：.M3U8 大小写变形同判（server.js nowplaying 短路先例）
    private val RE_HLS = Regex("\\.m3u8?(\\?|$)", RegexOption.IGNORE_CASE)
    private const val MAX_DIRECT = 24000L   // 直流攒够即收上限（JS 同款）
    private const val MAX_PLAYLIST = 8000L  // m3u8 清单
    private const val MAX_SEGMENT = 16000L  // 首段分片
    private const val MAX_REDIRECTS = 5     // 重定向跳数上限（update-sources.js request 默认 maxRedirect=5 同款）
    private val REDIRECTS = setOf(301, 302, 303, 307)  // 跟随的状态码集（Web request 同款；308 两侧都不跟）
  }

  private class RedirectRejected(msg: String) : Exception(msg)

  suspend fun check(url: String, windowMs: Long = C.CHECK_WINDOW_MS): Verdict {
    if (!SafeTarget.ok(url)) return v(false, 0, false, "地址不合法", Verdict.Code.INVALID_URL, 0, "", 0) // 入口预检（B1 review P1-5：Web safeTarget 同口径，含私网/回环字面量拒）
    return if (RE_HLS.containsMatchIn(url)) checkHls(url, windowMs, 0) else checkDirect(url, windowMs)
  }

  /** 单阶段拉取 + 逐跳重定向复查（B1 review P1-5，update-sources.js request() 重定向护栏镜像）：OkHttp 已关
      自动跟随，3xx 由本层逐跳——Location 先相对解析拼回 base（畸形 → 拒）、再过 SafeTarget 形态校验（回环/
      私网字面量直拒；域名解析的连接级校验在 OkHttpRaw 的 GuardDns），≤MAX_REDIRECTS 跳。网络失败仍 null
      （→ NETWORK）；护栏拒抛 RedirectRejected（→ REDIRECT_REJECTED）。 */
  private suspend fun fetch(url: String, win: Long, maxBytes: Long): RawHttp.Resp? {
    var cur = url
    var depth = 0
    while (true) {
      val r = http.get(cur, win, maxBytes) ?: return null
      val loc = r.location
      if (loc == null || r.status !in REDIRECTS) return r
      if (depth >= MAX_REDIRECTS) throw RedirectRejected("too many redirects")
      val next = resolve(loc, cur)
      if (next == null || !SafeTarget.ok(next)) throw RedirectRejected("重定向目标非公网: $loc")
      cur = next; depth++
    }
  }

  private fun v(ok: Boolean, bytes: Long, hls: Boolean, why: String, code: Verdict.Code, st: Int, ct: String, lat: Long) =
    Verdict(ok, bytes, hls, why, code, st, ct, lat, System.currentTimeMillis())

  /** 非 HLS：窗内累计 ≥8000B 且非 HTML 认活（不看状态码）。HTML 判定 = CT 头或正文前缀嗅探（isHtmlResp，
      与 Web htmlLike 双端同款，review P2）——字节达标后仍执行，谎报 Content-Type 的大 HTML 错误页也拒。 */
  private suspend fun checkDirect(url: String, win: Long): Verdict {
    val r = try { fetch(url, win, MAX_DIRECT) }
    catch (e: RedirectRejected) { return v(false, 0, false, e.message ?: "重定向被拒", Verdict.Code.REDIRECT_REJECTED, 0, "", 0) }
      ?: return v(false, 0, false, "网络失败", Verdict.Code.NETWORK, 0, "", 0)
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
    val pl = try { fetch(url, win, MAX_PLAYLIST) }
    catch (e: RedirectRejected) { return v(false, 0, true, e.message ?: "重定向被拒", Verdict.Code.REDIRECT_REJECTED, 0, "", 0) }
      ?: return v(false, 0, true, "网络失败", Verdict.Code.NETWORK, 0, "", 0)
    if (pl.status != 200) return v(false, pl.bytes, true, "清单 HTTP ${pl.status}", Verdict.Code.HTTP, pl.status, pl.ct, pl.latencyMs)
    val seg = String(pl.body, Charsets.UTF_8).split(Regex("\r?\n")).map { it.trim() }
      .firstOrNull { it.isNotEmpty() && !it.startsWith("#") }
      ?: return v(false, pl.bytes, true, "清单无分片", Verdict.Code.EMPTY_PLAYLIST, pl.status, pl.ct, pl.latencyMs)
    val segUrl = resolve(seg, url)
      ?: return v(false, pl.bytes, true, "分片地址无法解析", Verdict.Code.NO_SEGMENT, pl.status, pl.ct, pl.latencyMs)
    if (RE_HLS.containsMatchIn(segUrl) && depth < 2) return checkHls(segUrl, win, depth + 1)
    val r2 = try { fetch(segUrl, win, MAX_SEGMENT) }
    catch (e: RedirectRejected) { return v(false, 0, true, e.message ?: "重定向被拒", Verdict.Code.REDIRECT_REJECTED, 0, "", 0) }
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
