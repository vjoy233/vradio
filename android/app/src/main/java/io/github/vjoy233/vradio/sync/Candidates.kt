package io.github.vjoy233.vradio.sync

/* 同步候选管线纯函数（B2，plan-expansion-r4 §6.2，镜像 Web update-sources 侧并行实现的语义规范）：
   ① normalizeUrl 只做保守归一化（去空白、scheme/host 小写、删默认端口、保留 path/query/尾斜杠），
     **只用于比对，绝不替换原 URL**、不盲删 query、不用重定向后地址；
   ② dedupe 三层：精确 URL → 归一化 URL → 同分类同名多源合并（不同分类同名不强并）；
   ③ SyncEngine 端内同步的国内候选经 fromLine/dedupe 走这套（跨节全局 URL 去重是本批新增能力，
     既有分类/装配行为不变）。validationResult 预留（逐台实测在欧美节已有，国内节不探活）。 */

/** 一个候选源行（台 × 源的一行；stationName+category 是台维度，url 是源维度）。
 *  duplicateKey = 「分类|台名」合并键（dedupe 赋值）：同键候选 = 同台多源（下游同名行自然并源），
 *  不同分类同名 → 不同键不并。upstream/upstreamId/logoUrl 是来源追踪字段（radio-meta.json 口径）。 */
data class SyncCandidate(
  val stationName: String,
  val category: String,
  val url: String,
  val upstream: String,
  val upstreamId: String = "",
  val logoUrl: String = "",
  val normalizedUrl: String = "",
  val duplicateKey: String = "",
  val validationResult: String? = null,   // null = 未实测（国内节口径）
)

object Candidates {

  private val RE_PARTS = Regex("^(https?)://([^/?#]*)(.*)$", RegexOption.IGNORE_CASE)
  private val RE_URL = Regex("^https?://", RegexOption.IGNORE_CASE)

  /** 保守归一化（只用于比对）：去空白、scheme/host 小写、删默认端口（:80/:443，含空端口形态）、
   *  path/query/尾斜杠原样保留（不补也不删）。非 http(s)/无 host → null。
   *  userinfo 保留不剥（比对场景足够；契约未列 userinfo 归一）。 */
  fun normalizeUrl(raw: String): String? {
    val u = raw.trim()
    val m = RE_PARTS.find(u) ?: return null
    val scheme = m.groupValues[1].lowercase()
    var authority = m.groupValues[2]
    val rest = m.groupValues[3]                       // path?query#frag 原样
    val at = authority.lastIndexOf('@')
    val userinfo = if (at >= 0) authority.substring(0, at) else ""
    if (at >= 0) authority = authority.substring(at + 1)
    var host = authority; var port = ""
    if (!host.startsWith("[")) {                      // IPv6 字面量整体保留（比对场景不拆端口）
      val c = host.lastIndexOf(':')
      if (c >= 0) { port = host.substring(c + 1); host = host.substring(0, c) }
    }
    if (host.isEmpty()) return null
    host = host.lowercase()
    val default = (scheme == "http" && (port == "80" || port.isEmpty())) ||
      (scheme == "https" && (port == "443" || port.isEmpty()))
    if (default) port = ""
    return "$scheme://${if (userinfo.isEmpty()) "" else "$userinfo@"}$host" +
      (if (port.isNotEmpty()) ":$port" else "") + rest
  }

  /** radio.txt 行（「台名,URL」）→ 候选。台名空/URL 非 http(s) → null（格式过滤，质量门同源口径）。 */
  fun fromLine(cat: String, line: String, upstream: String, upstreamId: String = "", logoUrl: String = ""): SyncCandidate? {
    val f = line.split(',')
    if (f.size != 2) return null                       // 与 RadioTxt 行协议同款：3+ 字段容错跳过
    val name = f[0].trim()
    val url = f[1].trim()
    if (name.isEmpty() || !RE_URL.containsMatchIn(url)) return null
    return SyncCandidate(name, cat, url, upstream, upstreamId, logoUrl,
      normalizeUrl(url) ?: "", "$cat|$name")
  }

  /** 三层去重（顺序固定）：① 精确 URL（首现保留）→ ② 归一化 URL（首现保留）→ ③ 同分类同名
   *  多源合并 = 共享 duplicateKey（全部保留，下游按同名行并源）；不同分类同名键不同不强并。
   *  胜者的来源字段（upstream/upstreamId/logoUrl）原样保留。 */
  fun dedupe(candidates: List<SyncCandidate>): List<SyncCandidate> {
    val seenExact = HashSet<String>()
    val seenNorm = HashSet<String>()
    val out = ArrayList<SyncCandidate>(candidates.size)
    for (c in candidates) {
      if (!seenExact.add(c.url)) continue
      if (c.normalizedUrl.isNotEmpty() && !seenNorm.add(c.normalizedUrl)) continue
      out.add(if (c.duplicateKey.isEmpty()) c.copy(duplicateKey = "${c.category}|${c.stationName}") else c)
    }
    return out
  }

  /** 候选 → radio.txt 行（SyncEngine 装配用；台名内逗号已由 fromLine 的 2 字段约束排除）。 */
  fun toLine(c: SyncCandidate): String = "${c.stationName},${c.url}"
}
