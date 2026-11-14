package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.Backup
import io.github.vjoy233.vradio.data.CfgCodec
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* 契约测试（B0）：与 Web test/contracts.js 同源——读仓库根 contracts/radio-keys.json（经 gradle test resources
   接线），比对 C.KEYS 三侧白名单；v2/v3 备份黄金样本互读；radio.cfg v2 迁移与新字段 round-trip。 */
class ContractTest {

  private fun res(name: String): String =
    javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText()

  @Test fun keysMatchSpec() {
    val spec = JSONObject(res("radio-keys.json")).getJSONObject("keys")
    val expected = spec.keys().asSequence().toList().sorted()
    assertEquals(expected, C.KEYS.sorted())
    val excluded = JSONObject(res("radio-keys.json")).getJSONArray("excluded").let { (0 until it.length()).map { i -> it.getString(i) } }
    for (k in excluded) assertFalse("排除键 $k 误入 C.KEYS", C.KEYS.contains(k))
  }

  @Test fun backupV2FixtureReadable() { // Android 现行 v2 导出格式 ↔ fixture 互读
    val p = Backup.parseImport(res("fixtures/backup-v2.json"))
    assertNotNull(p)
    assertTrue(p!!.data.isNotEmpty())
    for (k in p.data.keys) assertTrue("非白名单键 $k", C.KEYS.contains(k))
    assertNotNull(p.my)
    assertTrue(p.my!!.any { it.endsWith("#genre#") })
  }

  @Test fun backupV3FixtureShape() { // v3 结构（B4 落完整读取；此处先冻结形态与键面）
    val j = JSONObject(res("fixtures/backup-v3.json"))
    assertEquals("vradio-backup", j.getString("format"))
    assertEquals(3, j.getInt("version"))
    val d = j.getJSONObject("data")
    for (k in d.keys()) assertTrue("非白名单键 $k", C.KEYS.contains(k))
    assertTrue(j.has("myRadio"))
    assertTrue(j.getJSONObject("extensions").length() == 0) // 默认空 extensions
  }

  @Test fun cfgV2RoundTrip() { // v1（无 v）迁移 + 三新字段清洗/回写 round-trip
    val v1 = """{"moves":{"https://a.example/x":"新闻资讯"},"srcs":{"https://a.example/x":["https://b.example/y"]}}"""
    val c1 = CfgCodec.parse(v1)
    assertEquals(2, c1.v) // 无 v 视为 v1 → v2
    val v2 = CfgCodec.parse(
      """{"v":2,"srcManualOrder":{"https://a.example/x":["https://b.example/y","https://a.example/x"]},""" +
        """"srcDisabled":{"https://a.example/x":["https://dead.example/z"]},""" +
        """"srcLabels":{"https://b.example/y":"车机备用"},"bad":{"ignored":true}}"""
    )
    assertEquals(listOf("https://b.example/y", "https://a.example/x"), v2.srcManualOrder["https://a.example/x"])
    assertEquals(listOf("https://dead.example/z"), v2.srcDisabled["https://a.example/x"])
    assertEquals("车机备用", v2.srcLabels["https://b.example/y"])
    val back = CfgCodec.parse(CfgCodec.toJson(v2)) // round-trip 不丢字段
    assertEquals(v2, back)
  }
}
