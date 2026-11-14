package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.Backup
import io.github.vjoy233.vradio.data.Library
import io.github.vjoy233.vradio.data.MyRadio
import io.github.vjoy233.vradio.data.Store
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory

/* 备份 v3（B4，plan-expansion-r4 §8.3/§8.4）：v3 黄金样本互读（contracts/fixtures/backup-v3.json）、
 * v1/v2/v3 三版本读取、导出形状（对照 contracts/backup-v3.schema.json）、未知扩展忽略、坏 JSON 回退、
 * 质量聚合迁移字段裁剪、导入失败回滚原语（Store 快照恢复 + MyRadio 拒收不动原文件）。
 * 与 Web test/backup-v3.js 消费同一批 fixtures 断言同款期望（Web↔Android 双端一致）。 */
class BackupV3Test {

  private lateinit var dir: File
  private lateinit var lib: Library

  private fun res(name: String): String =
    javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText()

  @Before fun setup() {
    dir = createTempDirectory("vradio-b4").toFile()
    Store.init(dir)
    lib = Library(Store, dir, "华语音乐,#genre#\n台A,http://a/1", "我的,#genre#\r\n台C,http://c/1\r\n")
    lib.reload()
  }
  @After fun teardown() { dir.deleteRecursively() }

  @Test fun v3FixtureReadable() { // 黄金样本：ver=3、myRadio→my、extensions 空 → 无 sidecar
    val p = Backup.parseImport(res("fixtures/backup-v3.json"))
    assertNotNull(p)
    assertEquals(3, p!!.ver)
    assertEquals(13, p.data.size)
    for (k in p.data.keys) assertTrue("非白名单键 $k", C.KEYS.contains(k))
    assertEquals(listOf("自建,#genre#", "我的电台,https://example.test/live"), p.my)
    assertNull(p.quality)
  }

  @Test fun v2FixtureReadable() { // v2 黄金样本：ver=2、读 my 数组
    val p = Backup.parseImport(res("fixtures/backup-v2.json"))
    assertNotNull(p)
    assertEquals(2, p!!.ver)
    assertEquals(13, p.data.size)
    assertEquals(listOf("自建,#genre#", "我的电台,https://example.test/live"), p.my)
  }

  @Test fun v1NoMyField() { // v1：无 my 字段 → my=null（不动 my-radio.txt）
    val p = Backup.parseImport("{\"v\":1,\"at\":1,\"data\":{\"radio.favs\":\"[]\",\"radio.vol\":\"90\"}}")!!
    assertEquals(1, p.ver)
    assertNull(p.my)
    assertEquals("90", p.data["radio.vol"])
  }

  @Test fun v2MyMissingMeansUntouched() { // v2/v3 字段缺失按不动处理；空数组才是「恢复为空」
    assertNull(Backup.parseImport("{\"v\":2,\"data\":{\"radio.vol\":\"90\"}}")!!.my)
    assertEquals(emptyList<String>(), Backup.parseImport("{\"v\":3,\"version\":3,\"data\":{\"radio.vol\":\"90\"},\"myRadio\":[]}")!!.my)
  }

  @Test fun exportV3Shape() { // 导出统一 v3：五字段形状 + app=android + extensions 空（B2 前无 sidecar 生产方）
    val out = Backup.exportAll(lib, "我的,#genre#\r\n台C,http://c/1\r\n", 1731500000000L)
    val j = JSONObject(out)
    assertEquals("vradio-backup", j.getString("format"))
    assertEquals(3, j.getInt("version"))
    assertEquals(1731500000000L, j.getLong("createdAt"))
    assertEquals("android", j.getString("app"))
    assertEquals(Store.snapshot().size, j.getJSONObject("data").length())
    assertEquals(listOf("我的,#genre#", "台C,http://c/1"),
      (0 until j.getJSONArray("myRadio").length()).map { j.getJSONArray("myRadio").getString(it) })
    assertEquals(0, j.getJSONObject("extensions").length())
  }

  @Test fun qualitySidecarParsedAndTrimmed() { // v3 sidecar：判定 + 迁移字段裁剪（嵌套形态、未知字段剔除）
    val j = JSONObject(res("fixtures/backup-v3.json"))
    val data = JSONObject()
    val src = JSONObject().put("okCount", 5).put("failCount", 1).put("lastOkAt", 99)
      .put("modes", org.json.JSONArray(listOf("direct", "proxy", "bogus")))
      .put("rawResponse", "SECRET").put("dns", "1.2.3.4")
    val entry = JSONObject().put("cf", 1).put("sources", JSONObject().put("https://main.example/live", src))
    data.put("https://main.example/live", entry)
    data.put("ftp://bad.example/x", JSONObject().put("cf", 0).put("sources", JSONObject()))
    j.put("extensions", JSONObject().put("sidecars", JSONObject().put("quality", JSONObject().put("v", 1).put("data", data))))
    val p = Backup.parseImport(j.toString())!!
    assertNotNull(p.quality)
    val q = p.quality!!.getJSONObject("data").getJSONObject("https://main.example/live")
      .getJSONObject("sources").getJSONObject("https://main.example/live")
    assertEquals(5, q.getInt("okCount"))
    assertEquals(org.json.JSONArray(listOf("direct", "proxy")).toString(), q.getJSONArray("modes").toString()) // modes 只收合法枚举去重（JSONArray 无 equals，比字符串）
    assertTrue(!q.has("rawResponse") && !q.has("dns")) // 响应正文/DNS 类字段绝不迁移
    assertTrue(!p.quality!!.getJSONObject("data").has("ftp://bad.example/x")) // 非 http(s) 键丢弃
  }

  @Test fun unknownExtensionsIgnored() { // extensions.foo / sidecars.listenStats / 顶层杂字段：忽略不失败
    val j = JSONObject(res("fixtures/backup-v3.json"))
    j.put("extensions", JSONObject().put("foo", JSONObject().put("bar", 1))
      .put("sidecars", JSONObject().put("listenStats", JSONObject().put("v", 1))))
    j.put("futureField", 42)
    val p = Backup.parseImport(j.toString())
    assertNotNull(p)
    assertNull(p!!.quality) // listenStats（B3 未落地）忽略
  }

  @Test fun invalidReturnsNull() {
    assertNull(Backup.parseImport("不是json"))
    assertNull(Backup.parseImport("[1,2]"))
    assertNull(Backup.parseImport("{\"version\":3}")) // 无 data
    assertNull(Backup.parseImport("{\"data\":{}}")) // 无有效键
    assertNull(Backup.parseImport("{\"data\":{\"radio.junk\":\"x\"}}")) // 全是白名单外键
    assertNull(Backup.parseImport("{\"data\":{\"radio.vol\":123}}")) // 非 string 值不收
  }

  @Test fun importRollbackPrimitives() { // 导入失败回滚原语（三阶段 commit 的构件）：快照恢复 + 超限拒收不动原文件
    Store.set(C.K_VOL, "90")
    val snap = Store.snapshot()                       // 提交前快照（AppVm.applyConfirmed 同款）
    Store.applyAll(mapOf(C.K_VOL to "30", C.K_THEME to "dark"))
    assertEquals("30", Store.get(C.K_VOL))
    Store.applyAll(snap)                              // 回滚：缺键 remove、有键写回
    assertEquals("90", Store.get(C.K_VOL))
    assertNull(Store.get(C.K_THEME))
    val mr = MyRadio(dir)
    assertTrue(mr.append("台A", "自建", "http://a.example/1"))
    val before = mr.readText()
    val huge = (1..501).joinToString("\r\n") { "台$it,http://a.example/$it" }
    assertEquals(false, mr.replace(huge))             // v3 my 超限：导入路径的失败位
    assertEquals(before, mr.readText())               // 拒后原文件不动（回滚=重写回旧文本，此处天然无需重写）
  }
}
