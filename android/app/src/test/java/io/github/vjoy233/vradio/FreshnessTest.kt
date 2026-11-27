package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.sync.Freshness
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import java.io.File

class FreshnessTest {
  @get:Rule val tmp = TemporaryFolder()
  @Test fun sharedFixture() {
    val raw = javaClass.classLoader!!.getResourceAsStream("fixtures/freshness.json")!!.bufferedReader().readText()
    val fixture = JSONObject(raw); val now = fixture.getLong("now"); val cases = fixture.getJSONArray("cases")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i); val f = c.optJSONObject("fact")
      val state = Freshness.state(Freshness.parse(c.getJSONObject("pref").toString()), f?.optLong("refreshedAt"), f?.optString("provenance"), now)
      assertEquals(c.getString("name"), c.getString("age"), state.age)
      assertEquals(c.getString("name"), c.getBoolean("prompt"), state.prompt)
    }
    assertEquals(Freshness.Pref(), Freshness.parse("{bad"))
  }
  @Test fun factRequiresCurrentRadioHashAndWitness() {
    val dir = tmp.root; val radio = File(dir, "radio.txt"); val stamp = File(dir, "stamp.json")
    radio.writeText("hello")
    assertNull(Freshness.fact(dir))
    val hash = java.security.MessageDigest.getInstance("SHA-256").digest("hello".toByteArray()).joinToString("") { "%02x".format(it) }
    stamp.writeText(JSONObject().put("radioHash", hash).put("freshnessProvenance", "device-full-sync").put("freshnessAt", 123L).toString())
    assertEquals(123L, Freshness.fact(dir)!!.refreshedAt)
    radio.writeText("changed"); assertNull(Freshness.fact(dir))
  }
}
