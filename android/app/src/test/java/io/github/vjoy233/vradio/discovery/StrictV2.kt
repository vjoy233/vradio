package io.github.vjoy233.vradio.discovery

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle

/** 实验性离线解析器；不授予联网许可，不接生产数据路径。 */
internal object StrictV2 {
  private const val SOURCE = "recommended-radio-streams"
  private val hash = Regex("[0-9a-f]{64}")
  private val commit = Regex("[0-9a-f]{40}")
  private val date = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z")
  private val dateFormat = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withResolverStyle(ResolverStyle.STRICT)
  private fun checkIt(ok: Boolean) { require(ok) { "invalid v2" } }
  private fun json(bytes: ByteArray, limit: Int): Map<String, Any?> {
    checkIt(bytes.size <= limit && bytes.isNotEmpty())
    val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    checkIt(!text.startsWith('\uFEFF'))
    @Suppress("UNCHECKED_CAST")
    return Json(text).parse() as? Map<String, Any?> ?: error("object required")
  }
  private fun fields(o: Map<String, Any?>, vararg names: String) = checkIt(o.keys == names.toSet())
  private fun str(o: Map<String, Any?>, key: String) = o[key] as? String ?: error("string required")
  private fun version(o: Map<String, Any?>) = checkIt(o["v"] == 2L)
  private fun validText(s: String, max: Int, nonempty: Boolean) {
    checkIt((!nonempty || s.isNotEmpty()) && s.toByteArray(Charsets.UTF_8).size <= max)
    checkIt(s.none { it.code in 0..31 || it.code in 127..159 })
  }
  fun url(s: String): Boolean = runCatching {
    checkIt(s.toByteArray(Charsets.UTF_8).size <= 2048 && s.all { it.code in 33..126 })
    val m = Regex("^https?://([^/?#]+)([^#]*)$").matchEntire(s) ?: error("url")
    val authority = m.groupValues[1]; val rest = m.groupValues[2]
    checkIt(!authority.contains('@') && !authority.contains('\\'))
    val parts = authority.split(':'); checkIt(parts.size <= 2)
    val host = parts[0]; checkIt(host.length in 1..253)
    if (parts.size == 2) { val p = parts[1]; checkIt(p.matches(Regex("[0-9]+")) && (p.toIntOrNull() ?: 0) in 1..65535) }
    val labels = host.split('.'); checkIt(labels.all { it.length in 1..63 && it.matches(Regex("[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?")) })
    if (host.all { it.isDigit() || it == '.' } || labels.last().first().isDigit()) {
      checkIt(labels.size == 4 && labels.all { it.matches(Regex("0|[1-9][0-9]{0,2}")) && (it.toIntOrNull() ?: 256) <= 255 })
    }
    var i = 0
    val allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/?@!$&'()*+,;="
    while (i < rest.length) {
      if (rest[i] == '%') { checkIt(i + 2 < rest.length && rest.substring(i + 1, i + 3).matches(Regex("[0-9a-fA-F]{2}"))); i += 3 }
      else { checkIt(rest[i] in allowed); i++ }
    }
    true
  }.getOrDefault(false)
  fun sidecar(raw: ByteArray): Map<String, Any?> {
    val o = json(raw, 524288); fields(o, "v", "source", "license", "commit", "generatedAt", "items"); version(o)
    checkIt(str(o, "source") == SOURCE && str(o, "license") == "CC0-1.0")
    val c = str(o, "commit"); checkIt(commit.matches(c)); val d = str(o, "generatedAt")
    checkIt(date.matches(d)); LocalDateTime.parse(d, dateFormat)
    val items = o["items"] as? List<*> ?: error("items"); checkIt(items.size <= 300)
    val seen = mutableSetOf<String>()
    for (value in items) {
      @Suppress("UNCHECKED_CAST") val item = value as? Map<String, Any?> ?: error("item")
      fields(item, "name", "url", "genre", "upstream", "commit")
      validText(str(item, "name"), 200, true); validText(str(item, "genre"), 120, false)
      val u = str(item, "url"); checkIt(url(u) && seen.add(u))
      checkIt(str(item, "upstream") == SOURCE && str(item, "commit") == c)
    }
    return o
  }
  fun pointer(raw: ByteArray): Pair<String, String?> {
    val o = json(raw, 4096); fields(o, "v", "current", "previous"); version(o)
    val current = str(o, "current"); checkIt(hash.matches(current))
    val previous = o["previous"] as? String; checkIt(o["previous"] == null || previous != null)
    checkIt(previous == null || (hash.matches(previous) && previous != current)); return current to previous
  }
  fun manifest(raw: ByteArray): Pair<String, Long> {
    val o = json(raw, 4096); fields(o, "v", "sha256", "bytes"); version(o)
    val h = str(o, "sha256"); val n = o["bytes"] as? Long ?: error("bytes")
    checkIt(hash.matches(h) && n in 1..524288); return h to n
  }
  fun generation(id: String, manifest: ByteArray, raw: ByteArray, binding: String?): Map<String, Any?> {
    checkIt(binding != null && commit.matches(binding)); checkIt(hash.matches(id)); val (h, n) = manifest(manifest)
    checkIt(h == id && n == raw.size.toLong() && raw.size in 1..524288)
    val actual = MessageDigest.getInstance("SHA-256").digest(raw).joinToString("") { "%02x".format(it.toInt() and 255) }
    checkIt(actual == h); return sidecar(raw).also { checkIt(it["commit"] == binding) }
  }

  // 仅用于检验容器深度护栏；不是协议入口。
  fun depthProbe(raw: ByteArray) = json(raw, 524288)

  /** 小型严格 JSON；不使用 Android 的宽松 org.json。 */
  private class Json(private val s: String) {
    private var i = 0
    private fun ws() { while (i < s.length && s[i] in " \t\r\n") i++ }
    private fun take(c: Char): Boolean { ws(); if (i < s.length && s[i] == c) { i++; return true }; return false }
    fun parse(): Any? { val v = value(); ws(); require(i == s.length); return v }
    private var depth = 0
    private fun value(): Any? { ws(); require(i < s.length); return when (s[i]) {
      '{', '[' -> { require(depth < 3); depth++; try { if (s[i] == '{') obj() else arr() } finally { depth-- } }
      '"' -> string(); 't' -> literal("true", true); 'f' -> literal("false", false); 'n' -> literal("null", null)
      else -> number()
    } }
    private fun literal(t: String, v: Any?): Any? { require(s.startsWith(t, i)); i += t.length; return v }
    private fun obj(): Map<String, Any?> { require(take('{')); val m = linkedMapOf<String, Any?>(); if (take('}')) return m
      do { ws(); require(i < s.length && s[i] == '"'); val k = string(); require(!m.containsKey(k) && take(':')); m[k] = value() } while (take(',')); require(take('}')); return m }
    private fun arr(): List<Any?> { require(take('[')); val a = mutableListOf<Any?>(); if (take(']')) return a
      do { a.add(value()) } while (take(',')); require(take(']')); return a }
    private fun string(): String { require(s[i++] == '"'); val b = StringBuilder(); while (i < s.length) {
      val c = s[i++]; if (c == '"') { val r = b.toString(); var j = 0; while (j < r.length) { val x = r[j]; if (x.isHighSurrogate()) { require(j + 1 < r.length && r[j + 1].isLowSurrogate()); j++ } else require(!x.isLowSurrogate()); j++ }; return r }
      require(c.code >= 32); if (c != '\\') b.append(c) else { require(i < s.length); when (val e = s[i++]) {
        '"', '\\', '/' -> b.append(e); 'b' -> b.append('\b'); 'f' -> b.append('\u000c'); 'n' -> b.append('\n'); 'r' -> b.append('\r'); 't' -> b.append('\t')
        'u' -> { require(i + 4 <= s.length); val h = s.substring(i, i + 4); require(h.matches(Regex("[0-9a-fA-F]{4}"))); b.append(h.toInt(16).toChar()); i += 4 }; else -> error("escape")
      } } }; error("string") }
    private fun number(): Long { val start = i; if (i < s.length && s[i] == '-') i++; require(i < s.length)
      if (s[i] == '0') i++ else { require(s[i] in '1'..'9'); while (i < s.length && s[i] in '0'..'9') i++ }
      // 本协议唯一允许的数字是整数；小数和指数均拒绝。
      return s.substring(start, i).toLong() }
  }
}
