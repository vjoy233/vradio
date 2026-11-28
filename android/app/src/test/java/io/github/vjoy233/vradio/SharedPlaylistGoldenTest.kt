package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.PlaylistParser
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/* 同 Web 读取仓库唯一人工期望；仅 JVM，不表示设备验收。 */
class SharedPlaylistGoldenTest {
  private fun res(name: String) = javaClass.classLoader!!.getResourceAsStream("fixtures/$name")!!
    .bufferedReader(Charsets.UTF_8).use { it.readText() }

  // 对键集合、数组长度和值逐路径断言；不把缺键当 null。
  private fun compare(expected: Any, actual: Any, path: String) {
    if (expected is JSONObject && actual is JSONObject) {
      val ek = expected.keys().asSequence().toSet(); val ak = actual.keys().asSequence().toSet()
      for (k in (ek + ak).sorted()) {
        assertTrue("$path.$k: 字段缺失或多余", k in ek && k in ak)
        compare(expected.get(k), actual.get(k), "$path.$k")
      }
    } else if (expected is JSONArray && actual is JSONArray) {
      assertEquals("$path.length", expected.length(), actual.length())
      for (i in 0 until expected.length()) compare(expected.get(i), actual.get(i), "$path[$i]")
    } else assertEquals(path, expected, actual)
  }

  private fun project(r: PlaylistParser.Result): JSONObject = JSONObject()
    .put("format", r.format).put("invalid", r.invalid).put("dups", r.dups)
    .put("entries", JSONArray().apply { r.entries.forEach { e -> put(JSONObject()
      .put("name", e.name).put("category", e.category).put("url", e.url)
      .put("logo", e.logo).put("externalId", e.externalId).put("sourceFormat", e.sourceFormat)) } })

  @Test fun sharedFixtures() {
    val cases = JSONObject(res("playlist-expected.json")).getJSONArray("cases")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      fun optional(k: String): String? = if (c.isNull(k)) null else c.getString(k)
      val r = PlaylistParser.parse(res(c.getString("file")), optional("hint"), optional("baseUrl"))
      compare(c.getJSONObject("out"), project(r), c.getString("name"))
    }
  }

  @Test fun reportsNestedFieldPath() {
    val expected = JSONObject("""{"entries":[{"url":"expected"}]}""")
    val actual = JSONObject("""{"entries":[{"url":"actual"}]}""")
    var message = ""
    try { compare(expected, actual, "sample") } catch (e: AssertionError) { message = e.message ?: "" }
    assertTrue(message, message.contains("sample.entries[0].url"))
  }
}
