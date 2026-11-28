package io.github.vjoy233.vradio

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue

internal object GoldenJson {
  // 对键集合、数组长度和值逐路径断言；不把缺键当 null。
  fun compare(expected: Any, actual: Any, path: String) {
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

}
