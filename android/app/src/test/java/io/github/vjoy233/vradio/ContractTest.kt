package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.Backup
import io.github.vjoy233.vradio.data.CfgCodec
import io.github.vjoy233.vradio.data.QualityStore
import io.github.vjoy233.vradio.model.DiagnosticResult
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/* 契约测试（B0）：与 Web test/contracts.js 同源——读仓库根 contracts/radio-keys.json（经 gradle test resources
   接线），比对 C.KEYS 三侧白名单；v2/v3 备份黄金样本互读；radio.cfg v2 迁移与新字段 round-trip；
   B2 质量聚合黄金样本 round-trip（AIbot P1-2，Web test/quality-store.js [7] 同源消费）；
   B3 收听统计契约形状冻结（AIbot 复核 P1/P2：条件获取 + 409 code + 落盘确认模型）。 */
class ContractTest {

  @get:Rule val tmp = TemporaryFolder()

  private fun res(name: String): String =
    javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText()

  @Test fun keysMatchSpec() {
    val spec = JSONObject(res("radio-keys.json")).getJSONObject("keys")
    val expected = spec.keys().asSequence().toList().sorted()
    assertEquals(expected, C.KEYS.sorted())
    val excluded = JSONObject(res("radio-keys.json")).getJSONArray("excluded").let { (0 until it.length()).map { i -> it.getString(i) } }
    for (k in excluded) assertFalse("排除键 $k 误入 C.KEYS", C.KEYS.contains(k))
  }

  @Test fun keyConstantsBidirectional() { // 声明 ↔ 引用双向一致（AIbot P2：对齐 Web test/contracts.js readAndroidKeys——
    // 反射扫 K_* 常量声明：全部须被 C.KEYS 引用（无死声明）、C.KEYS 每项须有声明背书（无裸字符串），防单侧漂移）
    val declared = C::class.java.declaredFields.filter { it.name.startsWith("K_") }
      .map { it.name to (it.get(null) as String) }
    assertTrue("未发现 K_* 常量声明", declared.isNotEmpty())
    for ((name, v) in declared) assertTrue("常量 $name 未被 C.KEYS 引用", C.KEYS.contains(v))
    for (k in C.KEYS) assertTrue("C.KEYS 条目 $k 无对应 K_* 常量声明", declared.any { it.second == k })
    assertEquals(declared.size, declared.map { it.second }.distinct().size) // 无重复值（重名键必被上两条拦截，这里兜底）
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

  @Test fun qualityFilesShapeInContract() { // AIbot P1-2：契约 files 节冻结双包装形态描述（Web 侧 test/contracts.js 同款断言）
    val qc = JSONObject(res("quality-summary.json"))
    val files = qc.getJSONObject("files")
    assertTrue(files.getString("web").contains("{ v:1, rev"))
    assertTrue(files.getString("android").contains("{ v:1, stations"))
  }

  @Test fun listenStatsContractShape() { // B3/AIbot 复核 P1/P2：收听统计契约——files 双包装 + 写失败确认模型 +
    // GET ?rev= 条件获取 + 409 机器可读 code 语义在位（Web test/contracts.js 同款断言双端点名；
    // 行为驱动在 Web test/listen-stats.js 与 ListenStatsTest 连续写失败→成功测试）
    val lc = JSONObject(res("listen-stats-summary.json"))
    val files = lc.getJSONObject("files")
    assertTrue(files.getString("web").contains("{ v:1, rev"))
    assertTrue(files.getString("android").contains("{ v:1, days"))
    assertTrue(files.getString("shared").contains("YYYY-MM-DD"))
    assertTrue(files.getString("writeFailure").contains("下次 flush"))
    // AIbot 三轮 P1：Android 写失败 pending 持久化/启动恢复语义在位（行为测试 = ListenStatsTest 重启恢复用例；
    // Web test/contracts.js 同款断言双端点名）
    assertTrue(files.getString("android").contains("listen-stats.pending.json")
      && files.getString("writeFailure").contains("不双计"))
    val api = lc.getJSONObject("api")
    assertTrue(api.getString("GET /api/listenstats?rev=<optional>").contains("notModified"))
    val post = api.getString("POST /api/listenstats")
    assertTrue(post.contains("'schema'") && post.contains("'batch-limit'"))
    val tests = lc.getJSONObject("tests")
    assertTrue(tests.getString("web").contains("test/listen-stats.js"))
    assertTrue(tests.getString("android").contains("ListenStatsTest"))
  }

  @Test fun qualityAggregateGoldenRoundTrip() { // AIbot P1-2：双端黄金样本——两包装层（{v,stations} vs {v,rev,ops,data}）共享内层聚合形态
    val fx = JSONObject(res("fixtures/quality-aggregate.json"))
    val id = fx.getString("identityUrl")
    var now = 0L
    val q = QualityStore(tmp.newFolder(), { now })   // playback 的 at 取 clock：逐事件推进到 fixture 时刻
    val evs = fx.getJSONArray("events")
    for (i in 0 until evs.length()) {
      val e = evs.getJSONObject(i)
      val url = e.getString("sourceUrl"); val mode = e.getString("mode")
      if (e.getString("kind") == "diagnostic")
        q.recordDiagnostic(id, DiagnosticResult(url, e.getBoolean("ok"),
          if (e.getBoolean("ok")) "OK" else "NETWORK", mode == "hls", mode, 0, "",
          e.getLong("bytes"), e.getLong("latencyMs"), "", e.getLong("at")), e.getString("trigger"))
      else {
        now = e.getLong("at")
        q.recordPlayback(id, url, e.getBoolean("ok"), e.getLong("latencyMs"), mode, e.getString("trigger"))
      }
    }
    now = fx.getJSONObject("expected").getLong("lastObservedAt")   // 评估时刻 = 30 天窗内
    val s = q.summary(id)!!
    val exp = fx.getJSONObject("expected")
    assertEquals(exp.getString("identityUrl"), s.identityUrl)
    assertEquals(exp.getInt("sourceCount"), s.sourceCount)
    assertEquals(exp.getInt("directCount"), s.directCount)
    assertEquals(exp.getInt("okCount"), s.okCount)
    assertEquals(exp.getInt("failCount"), s.failCount)
    assertEquals(exp.getLong("lastOkAt"), s.lastOkAt)
    assertEquals(exp.getLong("lastFailAt"), s.lastFailAt)
    assertEquals(exp.getLong("lastPlaybackAt"), s.lastPlaybackAt)
    assertEquals(exp.getLong("lastObservedAt"), s.lastObservedAt)
    assertEquals(exp.getLong("avgLatencyMs"), s.avgLatencyMs)
    assertEquals(exp.getInt("disconnects"), s.disconnects)
    assertEquals(exp.getString("metadata"), s.metadata)
    assertEquals(exp.getString("stability"), s.stability)
  }
}
