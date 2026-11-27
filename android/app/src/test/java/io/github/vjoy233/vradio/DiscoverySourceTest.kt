package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.discovery.DiscoverySourceParser
import io.github.vjoy233.vradio.discovery.DiscoveryManifest
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest

class DiscoverySourceTest {
  private val commit = "0123456789abcdef0123456789abcdef01234567"
  private val body = """{"v":1,"source":"recommended-radio-streams","license":"CC0-1.0","commit":"$commit","generatedAt":"2026-11-26T00:00:00.000Z","items":[{"name":"Test","url":"http://example.com/a","genre":"ambient","upstream":"recommended-radio-streams","commit":"$commit"}]}"""
  private fun hash(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

  @Test fun validFixtureAndManifest() {
    val s = DiscoverySourceParser.parse(body)!!
    assertEquals(1, s.items.size)
    val m = DiscoveryManifest(1, hash(body), body.toByteArray().size)
    assertTrue(DiscoverySourceParser.verify(body, m))
  }

  @Test fun rejectsWrongCommitAndHttpStillAllowed() {
    assertNotNull(DiscoverySourceParser.parse(body))
    assertNull(DiscoverySourceParser.parse(body.replaceFirst("\"commit\":\"$commit\"", "\"commit\":\"${"f".repeat(40)}\"")))
  }

  @Test fun rejectsOversizeAndTooManyItems() {
    assertNull(DiscoverySourceParser.parse(body, 8))
    val item = body.substringAfter("\"items\":[").substringBeforeLast("]}")
    fun withItems(n: Int) = body.substringBefore("\"items\":[") + "\"items\":[" + List(n) { item }.joinToString(",") + "]}"
    assertEquals(300, DiscoverySourceParser.parse(withItems(300))!!.items.size)
    assertNull(DiscoverySourceParser.parse(withItems(301)))
  }

  @Test fun rejectsMalformedUrls() {
    assertNull(DiscoverySourceParser.parse(body.replace("http://example.com/a", "http://")))
    assertNull(DiscoverySourceParser.parse(body.replace("http://example.com/a", "http://example.com/a\\nX")))
    assertNull(DiscoverySourceParser.parse(body.replace("http://example.com/a", "file:///tmp/a")))
  }

  @Test fun inputAndManifestBoundaries() {
    val m = DiscoveryManifest(1, hash(body), body.toByteArray().size)
    assertTrue(DiscoverySourceParser.verify(body, m))
    assertFalse(DiscoverySourceParser.verify(body, m.copy(v = 2)))
    assertFalse(DiscoverySourceParser.verify("a".repeat(DiscoverySourceParser.MAX_BYTES + 1), m))
    assertNull(DiscoverySourceParser.parse("a".repeat(DiscoverySourceParser.MAX_BYTES + 1)))
    assertNull(DiscoverySourceParser.parseManifest("a".repeat(DiscoverySourceParser.MAX_MANIFEST_BYTES + 1)))
    assertNull(DiscoverySourceParser.parseManifest("中".repeat(1500)))
    assertNotNull(DiscoverySourceParser.parseManifest("""{"v":1,"sha256":"${m.sha256}","bytes":${m.bytes}}"""))
  }

  @Test fun sharedGoldenCases() {
    val text = javaClass.classLoader!!.getResourceAsStream("fixtures/discovery-c3-golden.json")!!.bufferedReader(Charsets.UTF_8).use { it.readText() }
    val cases = org.json.JSONObject(text).getJSONArray("cases")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      assertEquals(c.getString("id"), c.getBoolean("accept"), DiscoverySourceParser.parse(c.getJSONObject("sidecar").toString()) != null)
    }
  }

  @Test fun timestampValidation() {
    for (bad in listOf("2026-11-26T00:00:00Z", "2026-02-30T00:00:00.000Z", "2026-11-26T00:00:00.123+00:00", "2026-11-26T24:00:00.000Z", "2026-11-26T00:00:00.12Z"))
      assertNull(bad, DiscoverySourceParser.parse(body.replace("2026-11-26T00:00:00.000Z", bad)))
    assertNotNull(DiscoverySourceParser.parse(body.replace(".000Z", ".123Z")))
  }

  @Test fun manifestMismatchFailsClosed() {
    val m = DiscoveryManifest(1, "0".repeat(64), body.toByteArray().size)
    assertFalse(DiscoverySourceParser.verify(body, m))
  }
}
