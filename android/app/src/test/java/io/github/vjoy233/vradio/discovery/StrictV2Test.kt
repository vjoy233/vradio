package io.github.vjoy233.vradio.discovery

import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class StrictV2Test {
  private val fixture = JSONObject(javaClass.classLoader!!.getResourceAsStream("fixtures/c3-strict-v2-generated.json")!!.bufferedReader(Charsets.UTF_8).use { it.readText() })
  private fun bytes(o: JSONObject, key: String) = Base64.getDecoder().decode(o.getString(key))
  private fun each(a: JSONArray, f: (JSONObject) -> Unit) { for (i in 0 until a.length()) f(a.getJSONObject(i)) }
  private fun comparable(x: Any?): Any? = when (x) {
    JSONObject.NULL -> null
    is JSONObject -> x.keys().asSequence().associateWith { comparable(x.get(it)) }
    is JSONArray -> (0 until x.length()).map { comparable(x.get(it)) }
    is Number -> x.toLong()
    else -> x
  }
  @Test fun sharedSidecars() = each(fixture.getJSONArray("sidecar")) { c ->
    val result = runCatching { StrictV2.sidecar(bytes(c, "rawBase64")) }
    assertEquals(c.getString("id"), c.getBoolean("accept"), result.isSuccess)
    if (result.isSuccess) assertEquals(c.getString("id"), comparable(c.getJSONObject("output")), result.getOrThrow())
  }
  @Test fun controlsAndUrls() {
    each(fixture.getJSONArray("controls")) { c ->
      val raw = bytes(c, "rawBase64")
      val ok = if (c.getString("id").startsWith("pointer")) runCatching { StrictV2.pointer(raw) }.isSuccess
        else runCatching { StrictV2.manifest(raw) }.isSuccess
      assertEquals(c.getString("id"), c.getBoolean("accept"), ok)
    }
    assertFalse(StrictV2.url("https://example.com/[a]"))
    assertFalse(StrictV2.url("https://example.com/?x=[a]"))
    assertTrue(StrictV2.url("https://example.com/%5Ba%5D"))
    val concepts = JSONObject(javaClass.classLoader!!.getResourceAsStream("fixtures/c3-strict-v2-cases.json")!!.bufferedReader().use { it.readText() })
    each(concepts.getJSONArray("urlAdversarial")) { c -> assertEquals(c.getString("url"), c.getBoolean("formatAccept"), StrictV2.url(c.getString("url"))) }
  }
  @Test fun generationsAndSelection() = each(fixture.getJSONArray("pointer")) { c ->
    // 旧 cross-commit 把 upstream 和 delivery 混为一谈，不能用其选择期望。
    if (c.getString("id") == "cross-commit") return@each
    val expected = c.getJSONObject("expected"); val gs = c.getJSONObject("generations")
    fun get(id: String): Map<String, Any?>? = runCatching {
      val g = gs.getJSONObject(id); StrictV2.generation(id, bytes(g, "manifestBase64"), bytes(g, "sidecarBase64")).sidecar
    }.getOrNull()
    val p = runCatching { StrictV2.pointer(bytes(c, "pointerBase64")) }.getOrNull()
    val current = p?.let { get(it.first) }; val previous = p?.second?.let { get(it) }
    val selection = when { current != null -> "current"; previous != null -> "previous"; else -> "unavailable" }
    assertEquals(c.getString("id"), expected.getString("selection"), selection)
    if (expected.has("degraded")) assertEquals(c.getString("id"), expected.getBoolean("degraded"), p?.second != null && previous == null)
    if (expected.has("output")) assertEquals(c.getString("id"), comparable(expected.getJSONObject("output")), current ?: previous)
  }
  @Test fun simulatedDeliveryIsolation() {
    val cases = fixture.getJSONArray("pointer")
    val cross = (0 until cases.length()).map { cases.getJSONObject(it) }.first { it.getString("id") == "cross-commit" }
    val p = StrictV2.pointer(bytes(cross, "pointerBase64")); val gs = cross.getJSONObject("generations")
    val previous = gs.getJSONObject(p.second!!)
    var calls = 0
    fun select(previousDelivery: String): StrictV2.Generation? {
      if (previousDelivery != "delivery-A") return null // 测试注入的取得证据，仅模拟而非认证
      calls++
      return StrictV2.generation(p.second!!, bytes(previous, "manifestBase64"), bytes(previous, "sidecarBase64"))
    }
    // previous 原始字节有效；只有模拟 delivery 不同导致拒绝。
    assertEquals("b".repeat(40), StrictV2.generation(p.second!!, bytes(previous, "manifestBase64"), bytes(previous, "sidecarBase64")).sidecar["commit"])
    assertNull(select("delivery-B")); assertEquals(0, calls)
    val selected = select("delivery-A")!!
    assertEquals(1, calls); assertEquals("b".repeat(40), selected.sidecar["commit"])
    assertEquals("unverified", selected.provenance)
  }
  @Test fun sharedAdversarialBytes() {
    val data = JSONObject(javaClass.classLoader!!.getResourceAsStream("fixtures/c3-strict-v2-adversarial.json")!!.bufferedReader(Charsets.UTF_8).use { it.readText() })
    each(data.getJSONArray("entries")) { e ->
      val raw = bytes(e, "rawBase64")
      val result = runCatching {
        if (e.getString("kind") == "sidecar") StrictV2.sidecar(raw)
        else {
          val p = StrictV2.pointer(bytes(e, "pointerBase64"))
          StrictV2.generation(p.first, raw, bytes(e, "sidecarBase64"), "a".repeat(40))
        }
      }
      assertEquals(e.getString("id"), e.getString("proposed") == "accept", result.isSuccess)
      if (e.getString("id") == "depth-4099") assertTrue(result.exceptionOrNull() is IllegalArgumentException)
    }
  }
  @Test fun sharedBindingCases() {
    val data = JSONObject(javaClass.classLoader!!.getResourceAsStream("fixtures/c3-strict-v2-adversarial.json")!!.bufferedReader(Charsets.UTF_8).use { it.readText() })
    each(data.getJSONArray("bindingCases")) { e ->
      val binding = if (e.isNull("expectedUpstreamCommit")) null else e.getString("expectedUpstreamCommit")
      val result = runCatching {
        val p = StrictV2.pointer(bytes(e, "pointerBase64"))
        StrictV2.generation(p.first, bytes(e, "manifestBase64"), bytes(e, "sidecarBase64"), binding)
      }
      assertEquals(e.getString("id"), e.getString("proposed") == "accept", result.isSuccess)
      if (result.isSuccess) {
        assertEquals("unverified", result.getOrThrow().provenance)
        assertEquals(e.getString("upstreamStatus"), if (binding == null) "unverified" else "pinned")
      }
    }
  }
  @Test fun nestedInputIsBounded() {
    fun nested(n: Int) = ("{\"x\":" + "[".repeat(n - 1) + "0" + "]".repeat(n - 1) + "}").toByteArray()
    assertTrue(runCatching { StrictV2.depthProbe(nested(3)) }.isSuccess)
    assertTrue(runCatching { StrictV2.depthProbe(nested(4)) }.exceptionOrNull() is IllegalArgumentException)
    val failure = runCatching { StrictV2.depthProbe(nested(10000)) }.exceptionOrNull()
    assertTrue("必须主动拒绝，不能栈溢出", failure is IllegalArgumentException)
  }
  @Test fun rawHashAndBindingAreMandatory() {
    val g = fixture.getJSONArray("pointer").getJSONObject(0).getJSONObject("generations")
    val id = g.keys().next(); val entry = g.getJSONObject(id)
    val raw = bytes(entry, "sidecarBase64"); val manifest = bytes(entry, "manifestBase64")
    assertEquals("unverified", StrictV2.generation(id, manifest, raw).provenance)
    assertEquals("unverified", StrictV2.generation(id, manifest, raw, "a".repeat(40)).provenance)
    val mutated = raw.clone(); mutated[mutated.lastIndex] = ' '.code.toByte()
    assertTrue(runCatching { StrictV2.generation(id, manifest, mutated, "a".repeat(40)) }.isFailure)
    assertTrue(runCatching { StrictV2.generation("0".repeat(64), manifest, raw, "a".repeat(40)) }.isFailure)
    for (bad in listOf("b".repeat(40), "", "A".repeat(40), "a".repeat(39), "a".repeat(41))) {
      assertTrue("binding=$bad", runCatching { StrictV2.generation(id, manifest, raw, bad) }.isFailure)
    }
  }
  @Test fun localFallbackIsSeparate() = each(fixture.getJSONArray("localFallback")) { c ->
    assertTrue(runCatching { StrictV2.pointer(bytes(c, "pointerBase64")) }.isFailure)
    val g = c.getJSONObject("local")
    val local = if (c.getString("localRevocationPolicyResult") == "allow") runCatching {
      StrictV2.generation(g.getString("id"), bytes(g, "manifestBase64"), bytes(g, "sidecarBase64")).sidecar
    }.getOrNull() else null
    val expected = c.getJSONObject("expected")
    assertEquals(c.getString("id"), expected.getString("selection"), if (local == null) "unavailable" else "local")
    if (local != null) assertEquals(comparable(expected.getJSONObject("output")), local)
  }
}
