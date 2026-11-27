package io.github.vjoy233.vradio.discovery

import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.net.URI

/** C3 预发布只读精选 sidecar 解析面；不联网、不写文件、不接主库/UI。 */
data class DiscoveryItem(
  val name: String,
  val url: String,
  val genre: String,
  val upstream: String,
  val commit: String,
)

data class DiscoverySource(
  val v: Int,
  val source: String,
  val license: String,
  val commit: String,
  val generatedAt: String,
  val items: List<DiscoveryItem>,
)

data class DiscoveryManifest(val v: Int, val sha256: String, val bytes: Int)

object DiscoverySourceParser {
  const val MAX_BYTES = 512 * 1024
  const val MAX_ITEMS = 300
  const val MAX_MANIFEST_BYTES = 4096
  private const val SOURCE = "recommended-radio-streams"
  private val SHA = Regex("[0-9a-f]{40}")
  private val HASH = Regex("[0-9a-f]{64}")
  private val ISO = Regex("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z")

  private fun urlOk(s: String): Boolean = runCatching { val u = URI(s); (u.scheme == "http" || u.scheme == "https") && !u.host.isNullOrBlank() && !s.any { it <= ' ' || it == '"' || it == '<' || it == '>' } }.getOrDefault(false)

  fun parse(text: String, maxBytes: Int = MAX_BYTES): DiscoverySource? {
    if (maxBytes < 1 || text.isEmpty() || text.length > maxBytes || text.length > MAX_BYTES) return null
    val bytes = text.toByteArray(Charsets.UTF_8)
    if (bytes.size > maxBytes || bytes.size > MAX_BYTES) return null
    return runCatching {
      val o = JSONObject(text)
      if (o.optInt("v", -1) != 1 || o.optString("source") != SOURCE ||
        o.optString("license") != "CC0-1.0") return@runCatching null
      val commit = o.optString("commit")
      val generated = o.optString("generatedAt")
      if (!SHA.matches(commit) || !ISO.matches(generated) || runCatching { Instant.parse(generated) }.isFailure || DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.parse(generated)) != generated) return@runCatching null
      val a = o.optJSONArray("items") ?: return@runCatching null
      if (a.length() > MAX_ITEMS) return@runCatching null
      val items = ArrayList<DiscoveryItem>(a.length())
      for (i in 0 until a.length()) {
        val x = a.optJSONObject(i) ?: return@runCatching null
        val name = x.optString("name").trim()
        val url = x.optString("url").trim()
        val genre = x.optString("genre").trim()
        val upstream = x.optString("upstream").trim()
        val ic = x.optString("commit")
        if (name.isEmpty() || name.length > 200 || genre.length > 120 ||
          upstream != SOURCE || !urlOk(url) || url.length > 2048 || ic != commit) return@runCatching null
        items += DiscoveryItem(name, url, genre, upstream, ic)
      }
      DiscoverySource(1, SOURCE, "CC0-1.0", commit, generated, items)
    }.getOrNull()
  }

  fun parseManifest(text: String): DiscoveryManifest? {
    if (text.isEmpty() || text.length > MAX_MANIFEST_BYTES || text.toByteArray(Charsets.UTF_8).size > MAX_MANIFEST_BYTES) return null
    return runCatching {
    val o = JSONObject(text)
    val h = o.optString("sha256")
    val n = o.optInt("bytes", -1)
    if (o.optInt("v", -1) != 1 || !HASH.matches(h) || n < 1 || n > MAX_BYTES) null
    else DiscoveryManifest(1, h, n)
    }.getOrNull()
  }

  /** 校验 sidecar UTF-8 字节数与独立 manifest；通过后再交给 parse。 */
  fun verify(text: String, manifest: DiscoveryManifest): Boolean {
    if (manifest.v != 1 || !HASH.matches(manifest.sha256) || manifest.bytes !in 1..MAX_BYTES ||
      text.isEmpty() || text.length > MAX_BYTES || text.length > manifest.bytes) return false
    val b = text.toByteArray(Charsets.UTF_8)
    if (b.size != manifest.bytes || b.size > MAX_BYTES) return false
    val got = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    return got == manifest.sha256 && parse(text) != null
  }
}
