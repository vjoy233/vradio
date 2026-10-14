package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.model.Station
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URLEncoder
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.TimeUnit

/* 文本拉取接口（台标解析与 sync 层 Gh 复用）：超时/字节封顶/失败 null。
   okhttp 实现见本文件底部 OkHttpText（D6 唯一网络破例）。 */
interface HttpText {
  suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String> = emptyMap()): String?
}

/* 台标数据唯一所有者（对标 logos.js）：三级来源 = STARTER.l → logos.txt 内置表 → 运行时缓存；
   按需解析只对「收藏 + 正在播」（prime 由调用方把关，控制请求量——全量 1600+ 台不抓）；
   负缓存 7 天自动过期重试；缓存落 filesDir/logos-cache.json（可重建，不入 13 键主源）。
   图片本体由 UI 层直连加载，坏图回退首字母色块。 */
class Logos(private val filesDir: File, private val http: HttpText, private val clock: () -> Long) {
  private data class Mem(val u: String? = null, val x: Boolean = false, val t: Long = 0) // 正缓存 {u,t} | 负缓存 {x,t}

  private val file = LinkedHashMap<String, String>() // logos.txt：「分类|台名」 → URL
  private val mem = HashMap<String, Mem>()           // 运行时缓存
  private val busy = HashSet<String>()               // 在飞键集合：多路并发触发同一台不重复解析
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  init { loadCache() }

  /* logos.txt 全文装载（AppVm 从 assets/D7 副本注入）：行「分类|台名,图片URL」，# 注释行跳过 */
  fun loadBuiltins(text: String) {
    file.clear()
    for (raw in text.split(Regex("\\r?\\n"))) {
      val line = raw.trim()
      if (line.isEmpty() || line.startsWith("#")) continue
      val i = line.lastIndexOf(',')
      if (i < 0) continue // URL 可含逗号：最后一个逗号才是分隔
      val u = line.substring(i + 1).trim()
      // 引号/空白/尖括号 URL 直接拒收（上游镜像仓库可控数据，防逃逸——logos.js 同款纵深）
      if ((u.startsWith("http://") || u.startsWith("https://")) && !BAD_CHARS.containsMatchIn(u))
        file[line.substring(0, i).trim()] = u
    }
  }

  /* 同步窥探（渲染用，绝不发请求）：STARTER.l → 内置表 → 运行时缓存，无则空串（UI 出首字母色块） */
  fun get(s: Station): String = synchronized(mem) {
    if (s.l.isNotEmpty()) return s.l
    val k = ekey(s)
    file[k]?.let { return it }
    return mem[k]?.u ?: ""
  }

  /* 按需异步解析（收藏+正在播优先）：已有台标/新鲜负缓存/在飞均跳过；成功正缓存、失败负缓存 7 天后重试 */
  fun prime(s: Station, isFavOrPlaying: Boolean) {
    if (!isFavOrPlaying) return
    if (get(s).isNotEmpty()) return
    val k = ekey(s)
    synchronized(mem) { mem[k]?.let { if (it.x && clock() - it.t < C.LOGOS_NEG_MS) return } }
    if (!synchronized(busy) { busy.add(k) }) return
    scope.launch {
      try {
        val u = runCatching { resolve(s) }.getOrDefault("")
        synchronized(mem) { mem[k] = if (u.isNotEmpty()) Mem(u = u, t = clock()) else Mem(x = true, t = clock()) }
        save()
      } finally { synchronized(busy) { busy.remove(k) } }
    }
  }

  /* 解析链：蜻蜓台（任一源 qingting.fm/live/{id}）→ m.qtfm.cn 频道页封面（确定性映射）；
     其它台 → Radio Browser byurl favicon（镜像 de1 国内可直连；Web 经 /proxy，安卓直连）。 */
  private suspend fun resolve(s: Station): String {
    val id = s.u.firstNotNullOfOrNull { QT_LIVE.find(it)?.groupValues?.get(1) }
    if (id != null) {
      val html = px("https://m.qtfm.cn/channels/$id/") { t -> t.contains("<img class=\"img\" src=\"") }
      val u = QT_IMG.find(html)?.groupValues?.get(1)
      if (u != null && !BAD_CHARS.containsMatchIn(u)) return u
    }
    val r = px("https://de1.api.radio-browser.info/json/stations/byurl?url=" + URLEncoder.encode(s.u0, "UTF-8")) { t -> t.trim().startsWith("[") }
    val f = runCatching { JSONArray(r).optJSONObject(0)?.optString("favicon") }.getOrNull() ?: ""
    return if ((f.startsWith("http://") || f.startsWith("https://")) && !BAD_CHARS.containsMatchIn(f)) f else ""
  }

  private suspend fun px(url: String, ok: (String) -> Boolean): String { // 8s 超时 + 桩页校验不过重试一次（logos.js 同款）
    repeat(2) {
      val t = http.get(url, 8000L, 512 * 1024L, mapOf("User-Agent" to UA))
      if (t != null && ok(t)) return t
    }
    throw IllegalStateException("stub page")
  }

  private fun ekey(s: Station) = s.c + "|" + s.n

  private fun loadCache() {
    val f = File(filesDir, CACHE)
    if (!f.exists()) return
    val o = runCatching { JSONObject(f.readText()) }.getOrNull() ?: return // 坏文件视为空缓存（可重建）
    for (k in o.keys()) {
      val e = o.optJSONObject(k) ?: continue
      if (!e.has("u") && !e.has("x")) continue
      mem[k] = Mem(if (e.has("u")) e.optString("u") else null, e.optInt("x") > 0 || e.optBoolean("x"), e.optLong("t"))
    }
  }

  private fun save() { // 总量封顶 600（FIFO by t，logos.js cap 同款）+ tmp+rename 原子写
    synchronized(mem) {
      for (k in mem.keys.sortedBy { mem[it]?.t ?: 0L }) { if (mem.size <= C.LOGOS_CAP) break; mem.remove(k) }
      runCatching {
        val o = JSONObject()
        for ((k, m) in mem) {
          val e = JSONObject()
          if (m.u != null) e.put("u", m.u).put("t", m.t) else e.put("x", 1).put("t", m.t)
          o.put(k, e)
        }
        filesDir.mkdirs()
        val tmp = File(filesDir, "$CACHE.tmp")
        tmp.writeText(o.toString())
        Files.move(tmp.toPath(), File(filesDir, CACHE).toPath(), StandardCopyOption.ATOMIC_MOVE)
      }
    }
  }

  private companion object {
    const val CACHE = "logos-cache.json"
    const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" // server.js /proxy 同款 UA（蜻蜓 SSR 页需要）
    val QT_LIVE = Regex("qingting\\.fm/live/(\\d+)")
    val QT_IMG = Regex("<img class=\"img\" src=\"(http[^\"]+pic\\.(?:qtfm|qingting)\\.[^\"]+)\" alt=\"[^\"]*\"")
    val BAD_CHARS = Regex("[\\s\"'<>]")
  }
}

/* HttpText 的 okhttp 实现：per-call 超时（newBuilder 共享连接池）；超字节封顶/非 2xx/网络失败一律 null */
class OkHttpText : HttpText {
  private val base = OkHttpClient()

  override suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String>): String? =
    withContext(Dispatchers.IO) {
      runCatching {
        val client = base.newBuilder()
          .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
          .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
          .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
          .build()
        val rb = Request.Builder().url(url)
        for ((k, v) in headers) rb.header(k, v)
        client.newCall(rb.build()).execute().use { r ->
          if (!r.isSuccessful) return@use null
          val body = r.body ?: return@use null
          // 字节流循环读：攒够即收、超封顶判失败（与 OkHttpRaw 同口径；okio request() 返回 Boolean 易误用）
          val bos = java.io.ByteArrayOutputStream()
          val buf = ByteArray(65536)
          var n = 0L
          while (true) {
            val read = body.byteStream().read(buf)
            if (read < 0) break
            n += read
            if (n > maxBytes) return@use null
            bos.write(buf, 0, read)
            if (n >= maxBytes) break
          }
          String(bos.toByteArray(), Charsets.UTF_8)
        }
      }.getOrNull()
    }
}
