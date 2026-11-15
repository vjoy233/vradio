package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.model.ImportedStation
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory
import java.io.StringReader
import java.net.URI
import java.util.TreeMap

/* 歌单多格式解析器（r4/B4，Web playlist-import.js 同构——同输入同输出条目集）：
   PLS / XSPF / ASX(WAX/WMX) / m3u(csv 收敛) / 纯 URL 五格式；识别顺序 = 显式提示 → 文件头 → 内容特征 → 纯 URL。
   安全（§13.4）：纯本地零网络（本对象不持有任何网络代码路径）；XML 经 XmlPullParser 且显式关闭 DOCTYPE
   处理（KXmlParser 默认不解析外部实体/不取外部 DTD——setFeature 是意图声明，异常容忍旧实现），未声明实体
   引用不展开（XML 流里直接跳过）；URL 只收 http(s)。条目封顶 500、台名 40 字、分类 24 字、文件内按 URL 去重。
   纯 JVM 可测（不 import android.*；单测环境 android.jar 的 XmlPullParserFactory 是抛异常桩，挂 kxml2 真实现，
   见 build.gradle.kts 测试依赖注）。 */

object PlaylistParser {

  const val MAX_ENTRIES = 500
  private const val NAME_MAX = 40
  private const val CAT_MAX = 24
  private const val XML_MAX = 2 * 1024 * 1024

  data class Result(
    val format: String,                  // 识别结果：pls|xspf|asx|m3u|url
    val entries: List<ImportedStation>,  // URL 去重后的有效条目（封顶 500）
    val invalid: Int,                    // 非 http(s) 地址（或无 baseUrl 的相对地址）被剔除数
    val dups: Int,                       // 文件内重复 URL 去重数
  )

  fun parse(text: String, format: String? = null, baseUrl: String? = null): Result {
    val fmt = detect(text, format)
    val r = when (fmt) {
      "pls" -> pls(text)
      "xspf" -> xml(text, baseUrl, xspf = true)
      "asx" -> xml(text, baseUrl, xspf = false)
      "m3u" -> m3u(text)
      else -> urls(text)
    }
    val seen = HashSet<String>()
    val out = ArrayList<ImportedStation>()
    var dups = 0
    for (e in r.first) {
      if (!seen.add(e.url)) { dups++; continue }
      out.add(e)
      if (out.size >= MAX_ENTRIES) break
    }
    return Result(fmt, out, r.second, dups)
  }

  /* —— 格式识别（与 Web detect 同序）：① 显式扩展名/MIME/格式名 → ② 文件头 → ③ 内容特征 → ④ 纯 URL —— */
  fun normHint(f: String?): String? {
    val s = f?.lowercase()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    if (s.contains("xspf")) return "xspf"
    if (Regex("\\.(asx|wax|wmx|asf)(\\?|$)").containsMatchIn(s) || s.contains("ms-asf") || s.contains("ms-asx")) return "asx"
    if (Regex("\\.pls(\\?|$)").containsMatchIn(s) || s.contains("scpls")) return "pls"
    if (Regex("\\.m3u8?(\\?|$)").containsMatchIn(s) || s.contains("mpegurl")) return "m3u"
    return listOf("pls", "xspf", "asx", "m3u", "url").firstOrNull { it == s }
  }

  fun detect(text: String, hint: String?): String {
    normHint(hint)?.let { return it } // ① 显式提示最优先（误标后果 = 空解析，改名重试即可）
    val head = text.take(4096)
    if (head.trimStart().startsWith("[playlist]", true)) return "pls"                                  // ② 文件头
    if (Regex("(^|\\r?\\n)#EXTM3U", RegexOption.IGNORE_CASE).containsMatchIn(head)) return "m3u"
    if (Regex("<asx[\\s>]|<entry[\\s>]|<entryref[\\s>]", RegexOption.IGNORE_CASE).containsMatchIn(head)) return "asx"
    if (Regex("<playlist[\\s>]|<tracklist[\\s>]", RegexOption.IGNORE_CASE).containsMatchIn(head)) return "xspf"
    if (Regex("file\\d+\\s*=", RegexOption.IGNORE_CASE).containsMatchIn(head)) return "pls"           // ③ 内容特征
    if (text.contains("#EXTINF", true)) return "m3u"
    if (Regex(",\\s*https?://", RegexOption.IGNORE_CASE).containsMatchIn(head)) return "m3u"          // csv 风格（radio.txt 形态）
    return "url"                                                                                      // ④ 纯 URL 列表
  }

  /* —— 清洗/工具（口径与 Web 一致）—— */
  private fun isHttp(u: String) = u.startsWith("http://", true) || u.startsWith("https://", true)
  private fun hostOf(u: String): String =
    Regex("^https?://([^/?#]+)", RegexOption.IGNORE_CASE).find(u)?.groupValues?.get(1) ?: ""
  private fun fallbackName(u: String) = hostOf(u).ifEmpty { u.take(NAME_MAX) }
  private fun cleanName(n: String) = n.replace(Regex("[\\r\\n]+"), " ").trim().take(NAME_MAX)
  private fun cleanCat(c: String) =
    c.replace(Regex("[,\\r\\n|#]"), " ").trim().take(CAT_MAX).ifEmpty { "自定义" }

  /** 相对 URL 解析（XSPF/ASX）：绝对 http(s) 原样；有 baseUrl 才解析（URI.resolve），失败/无 base = null */
  private fun resolveUrl(u: String, baseUrl: String?): String? {
    val s = u.trim()
    if (isHttp(s)) return s
    if (!baseUrl.isNullOrEmpty() && isHttp(baseUrl)) {
      return runCatching { val abs = URI(baseUrl).resolve(s).toString(); if (isHttp(abs)) abs else null }.getOrNull()
    }
    return null
  }

  /* —— PLS：FileN/TitleN 键大小写不敏感；NumberOfEntries 只作提示；缺标题用 URL host —— */
  private fun pls(text: String): Pair<List<ImportedStation>, Int> {
    val files = TreeMap<Int, String>()
    val titles = HashMap<Int, String>()
    for (raw in text.split(Regex("\\r?\\n"))) {
      val i = raw.indexOf('=')
      if (i < 0) continue
      val key = raw.substring(0, i).trim().lowercase()
      val v = raw.substring(i + 1).trim()
      when {
        key.startsWith("file") -> key.removePrefix("file").toIntOrNull()?.let { files[it] = v }
        key.startsWith("title") -> key.removePrefix("title").toIntOrNull()?.let { titles[it] = v }
      }
    }
    val out = ArrayList<ImportedStation>()
    var invalid = 0
    for (n in files.keys) { // TreeMap 键序 = FileN 序号升序
      val u = files[n] ?: continue
      if (!isHttp(u)) { invalid++; continue }
      out.add(ImportedStation(cleanName(titles[n] ?: "").ifEmpty { fallbackName(u) }, "自定义", u, "", "", "pls"))
    }
    return out to invalid
  }

  /* —— XSPF/ASX 共用 XmlPullParser 事件流（localName 小写比较，命名空间不敏感）：
     XSPF 取 track 内 title/album/image/identifier/location（多 location 取首个可解析）；
     ASX 取 entry 内 title + ref@href（属性名大小写兼容）；ENTRYREF 元素名不同天然跳过——不递归网络下载 —— */
  private fun xml(text: String, baseUrl: String?, xspf: Boolean): Pair<List<ImportedStation>, Int> {
    val p = newPullParser(text) ?: return emptyList<ImportedStation>() to 0
    val out = ArrayList<ImportedStation>()
    var invalid = 0
    val target = if (xspf) "track" else "entry"
    try {
      var title = ""; var album = ""; var image = ""; var identifier = ""
      val locs = ArrayList<String>()
      var inTarget = false
      var textTag = ""              // 正在累积文本的子元素名（空 = 不在关心的子元素里）
      var buf = StringBuilder()
      var ev = p.eventType
      while (ev != XmlPullParser.END_DOCUMENT) {
        when (ev) {
          XmlPullParser.START_TAG -> {
            val n = p.name.lowercase()
            if (n == target) { inTarget = true; title = ""; album = ""; image = ""; identifier = ""; locs.clear() }
            else if (inTarget) {
              when (n) {
                "title", "album", "image", "identifier", "location" -> { textTag = n; buf = StringBuilder() }
                "ref" -> if (!xspf) { // ASX REF@HREF：属性名大小写兼容（getAttributeValue 大小写敏感，手动遍历）
                  for (ai in 0 until p.attributeCount)
                    if (p.getAttributeName(ai).lowercase() == "href") { p.getAttributeValue(ai)?.let { locs.add(it) }; break }
                }
              }
            }
          }
          XmlPullParser.TEXT, XmlPullParser.CDSECT -> if (textTag.isNotEmpty()) buf.append(p.text)
          XmlPullParser.END_TAG -> {
            val n = p.name.lowercase()
            if (inTarget && n == textTag && textTag.isNotEmpty()) {
              when (n) {
                "title" -> title = buf.toString()
                "album" -> album = buf.toString()
                "image" -> image = buf.toString()
                "identifier" -> identifier = buf.toString()
                "location" -> locs.add(buf.toString())
              }
              textTag = ""
            } else if (n == target && inTarget) {
              inTarget = false
              val nm = cleanName(title).ifEmpty { cleanName(album) }
              var pick: String? = null
              for (l in locs) { val u = resolveUrl(l, baseUrl); if (u != null) { pick = u; break } }
              if (pick == null) invalid++
              else out.add(ImportedStation(nm.ifEmpty { fallbackName(pick) }, "自定义", pick,
                image.trim().take(512), identifier.trim().take(128), if (xspf) "xspf" else "asx"))
            }
          }
        }
        ev = p.next()
      }
    } catch (_: Exception) { /* 畸形 XML/未声明实体：已收条目保留（尽力收口径，Web Node 侧同款；不向上抛） */ }
    return out to invalid
  }

  private fun newPullParser(text: String): XmlPullParser? {
    if (text.length > XML_MAX) return null // XML 文本 >2MB 拒绝（入口长度先钳）
    return runCatching {
      val f = XmlPullParserFactory.newInstance()
      f.isNamespaceAware = false // 关命名空间后 name 即 localName（命名空间不敏感处理）
      val p = f.newPullParser()
      // 显式声明禁 DOCTYPE 处理（KXmlParser 默认即不解析外部实体/不取外部 DTD；关 FEATURE 意在固化意图）
      runCatching { p.setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL, false) }
      p.setInput(StringReader(text))
      p
    }.getOrNull()
  }

  /* —— m3u 与 csv（radio.txt 形态）收敛一份：#EXTINF/#genre# 节/URL 行/名字,地址 行（RadioTxt.parse 同款算法） —— */
  private fun m3u(text: String): Pair<List<ImportedStation>, Int> {
    val out = ArrayList<ImportedStation>()
    var invalid = 0
    var sec = "自定义"
    var pendN = ""; var pendC = ""; var pend = false
    for (raw in text.split(Regex("\\r?\\n"))) {
      val line = raw.trim()
      if (line.isEmpty() || line.startsWith("#VRADIO")) continue // 本项目导出标记行，不影响导入
      if (line.endsWith("#genre#")) { sec = cleanCat(line.replace(Regex(",#genre#$"), "")); continue } // 大小写敏感（Web/RadioTxt 同判）
      if (line.startsWith("#EXTINF:", true)) {
        var q = false; var sep = -1 // 引号外的第一个逗号才是「属性区,台名」分隔（属性值可含逗号）
        for (j in 8 until line.length) { val ch = line[j]; if (ch == '"') q = !q else if (ch == ',' && !q) { sep = j; break } }
        val attrs = if (sep >= 0) line.substring(0, sep) else ""
        val name = if (sep >= 0) line.substring(sep + 1).trim() else ""
        val g = Regex("group-title=\"([^\"]*)\"").find(attrs)?.groupValues?.get(1)?.trim().orEmpty()
        pend = true; pendN = cleanName(name); pendC = if (g.isNotEmpty()) cleanCat(g) else sec
        continue
      }
      if (line.startsWith("#")) continue
      if (isHttp(line)) {
        out.add(ImportedStation((if (pend) pendN else "").ifEmpty { fallbackName(line) }, if (pend) pendC else sec, line, "", "", "m3u"))
        pend = false; continue
      }
      val i = line.lastIndexOf(',')
      if (i < 0) { invalid++; continue }
      val nm = cleanName(line.substring(0, i)); val u = line.substring(i + 1).trim()
      if (nm.isEmpty() || !isHttp(u)) { invalid++; continue }
      out.add(ImportedStation(nm, sec, u, "", "", "m3u"))
    }
    return out to invalid
  }

  /* —— 纯 URL 列表：每行一个地址，名字取 host，杂行计入非法 —— */
  private fun urls(text: String): Pair<List<ImportedStation>, Int> {
    val out = ArrayList<ImportedStation>()
    var invalid = 0
    for (raw in text.split(Regex("\\r?\\n"))) {
      val line = raw.trim()
      if (line.isEmpty() || line.startsWith("#")) continue
      if (isHttp(line)) out.add(ImportedStation(fallbackName(line), "自定义", line, "", "", "url"))
      else invalid++
    }
    return out to invalid
  }
}
