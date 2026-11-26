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
    val many = body.replace("\"items\":[{", "\"items\":[{" + ",{}".repeat(300))
    assertNull(DiscoverySourceParser.parse(many))
  }

  @Test fun rejectsMalformedUrls() {
    assertNull(DiscoverySourceParser.parse(body.replace("http://example.com/a", "http://")))
    assertNull(DiscoverySourceParser.parse(body.replace("http://example.com/a", "http://example.com/a\\nX")))
    assertNull(DiscoverySourceParser.parse(body.replace("http://example.com/a", "file:///tmp/a")))
  }

  @Test fun manifestMismatchFailsClosed() {
    val m = DiscoveryManifest(1, "0".repeat(64), body.toByteArray().size)
    assertFalse(DiscoverySourceParser.verify(body, m))
  }
}
