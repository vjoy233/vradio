package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.Backup
import io.github.vjoy233.vradio.data.Library
import io.github.vjoy233.vradio.data.MyRadio
import io.github.vjoy233.vradio.data.QualityStore
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.stats.ListenSidecar
import io.github.vjoy233.vradio.stats.ListenStats
import io.github.vjoy233.vradio.stats.ListenStatsCodec
import io.github.vjoy233.vradio.stats.StatsDay
import io.github.vjoy233.vradio.stats.StatsState
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory

/* 备份 v3（B4，plan-expansion-r4 §8.3/§8.4）：v3 黄金样本互读（contracts/fixtures/backup-v3.json 双 sidecar）、
 * v1/v2/v3 三版本读取、导出形状（对照 contracts/backup-v3.schema.json）、未知扩展忽略、坏 JSON 回退、
 * 质量/收听统计迁移字段裁剪（qualityTrim/lsTrim）、导入失败回滚原语（Store 快照恢复 + MyRadio 拒收不动原文件）；
 * AIbot review P1-1/P2-2：质量 sidecar 经 QualityStore.replaceImport 实际落盘 + 落盘失败恢复旧快照（saver 缝注入失败）+
 * commitImport 提交段回滚序（fake 协作方断言四件回滚：Store → my-radio → quality → listenStats）+
 * LS 经 ListenSidecar 真落盘 round-trip（AppVm.applyConfirmed 同款凭据）。
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

  @Test fun v3FixtureReadable() { // 黄金样本：ver=3、myRadio→my、双 sidecar（quality+listenStats）读回（B4 补齐）
    val p = Backup.parseImport(res("fixtures/backup-v3.json"))
    assertNotNull(p)
    assertEquals(3, p!!.ver)
    assertEquals(14, p.data.size)
    for (k in p.data.keys) assertTrue("非白名单键 $k", C.KEYS.contains(k))
    assertEquals(listOf("自建,#genre#", "我的电台,https://example.test/live"), p.my)
    assertNotNull(p.quality)                                        // 质量 sidecar：嵌套聚合形态
    assertEquals(2, p.quality!!.getJSONObject("data").getJSONObject("https://main.example/live").getInt("cf"))
    assertNotNull(p.listenStats)                                    // 收听统计 sidecar：日桶形态（与 Web 同款期望）
    assertEquals(1800000L, p.listenStats!!.getJSONObject("data").getJSONObject("2026-11-14").getLong("ms"))
    assertEquals(2, p.listenStats!!.getJSONObject("data").getJSONObject("2026-11-13").getInt("sessions"))
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

  @Test fun unknownExtensionsIgnored() { // extensions.foo / sidecars.timewarp / 顶层杂字段：忽略不失败；listenStats 裁空=无
    val j = JSONObject(res("fixtures/backup-v3.json"))
    j.put("extensions", JSONObject().put("foo", JSONObject().put("bar", 1))
      .put("sidecars", JSONObject()
        .put("timewarp", JSONObject().put("v", 1).put("data", JSONObject().put("x", 1)))
        .put("listenStats", JSONObject().put("v", 1).put("data", JSONObject().put("bad-day", JSONObject().put("ms", 5))))))
    j.put("futureField", 42)
    val p = Backup.parseImport(j.toString())
    assertNotNull(p)
    assertNull(p!!.quality)                                     // 黄金样本 extensions 被覆写：无 quality
    assertNull(p.listenStats)                                   // 坏日键全裁 → 空 days 视为无 sidecar（含 0 天无确认意义）
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

  // —— AIbot review P1-1/P2-2：v3 质量 sidecar 真正落盘 + 失败恢复旧快照（applyConfirmed 提交段） ——

  private fun qData(id: String, ok: Int, extra: String = ""): JSONObject { // 嵌套形态 {id:{cf,sources:{…}}}
    val src = JSONObject().put("okCount", ok)
    if (extra.isNotEmpty()) src.put("modes", org.json.JSONArray(listOf(extra)))
    return JSONObject().put(id, JSONObject().put("cf", 0)
      .put("sources", JSONObject().put(id, src)))
  }

  @Test fun qualitySidecarReplaceImportCommitsToDisk() { // 确认后经事务接口实际写入：内存 + filesDir/quality.json
    val qs = QualityStore(dir)
    assertTrue(qs.replaceImport(qData("https://main.example/live", 37, "direct")))
    val agg = qs.summary("https://main.example/live")!!  // 内存态即导入数据（原地换 = 缓存即时重载）
    assertEquals(37, agg.okCount)
    assertEquals(37, agg.samples)
    assertEquals("icy", agg.metadata)                     // direct 观测 → icy 派生
    val disk = JSONObject(java.io.File(dir, QualityStore.FILE).readText())
      .getJSONObject("stations").getJSONObject("https://main.example/live")
      .getJSONObject("sources").getJSONObject("https://main.example/live")
    assertEquals(37, disk.getInt("okCount"))              // 盘上也是导入数据（真正落盘，非仅校验留存）
  }

  @Test fun qualitySidecarReplaceImportFailureRestoresSnapshot() { // 落盘失败 → 恢复导入前内存态（不留半导入）
    var failWrites = false
    val qs = QualityStore(dir, saver = { !failWrites })   // 写入缝注入失败（fake 落盘通道）
    assertTrue(qs.replaceImport(qData("https://old.example/live", 3)))
    val snap = qs.capture()                               // applyConfirmed 提交前快照（同款凭据）
    failWrites = true
    assertFalse(qs.replaceImport(qData("https://new.example/live", 9)))
    assertEquals(snap, qs.capture())                      // 内存已恢复导入前态
    failWrites = false
    assertTrue(qs.restore(snap))                          // 显式回滚通道（applyConfirmed 三件回滚用）
    assertEquals(snap, qs.capture())
    assertNull(qs.summary("https://new.example/live"))    // 导入数据不残留
  }

  @Test fun commitImportTxOrderAndRollback() { // applyConfirmed 提交段（协作方 fake）：成功序 / my 失败双回滚 / quality 失败三件回滚 / LS 失败四件回滚
    fun io(calls: MutableList<String>, myOk: Boolean, qOk: Boolean, lsOk: Boolean = true) = Backup.ImportIO(
      { calls.add("store") }, { calls.add("store-rb") },
      { calls.add("my"); myOk }, { calls.add("my-rb"); true },
      { calls.add("q"); qOk }, { calls.add("q-rb"); true },
      { calls.add("ls"); lsOk }, { calls.add("ls-rb"); true })
    val q = JSONObject().put("v", 1).put("data", qData("https://main.example/live", 1))
    val ls = JSONObject().put("v", 1).put("data", JSONObject().put("2026-11-14", JSONObject().put("ms", 1000).put("sessions", 1)))
    val data = mapOf(C.K_VOL to "30")
    run {                                                   // 成功：三步顺序、零回滚（无 LS 数据 = 三件）
      val c = mutableListOf<String>()
      assertNull(Backup.commitImport(data, listOf("我的,#genre#"), q, io(c, true, true)))
      assertEquals(listOf("store", "my", "q"), c)
    }
    run {                                                   // 双 sidecar 成功：四步顺序（B4 收官级）
      val c = mutableListOf<String>()
      assertNull(Backup.commitImport(data, listOf("我的,#genre#"), q, io(c, true, true), ls))
      assertEquals(listOf("store", "my", "q", "ls"), c)
    }
    run {                                                   // my 失败：Store+my 回滚，质量未提交未动（失败在提交前）
      val c = mutableListOf<String>()
      assertEquals("个人电台恢复失败（可能超限或写入异常）；已尝试回滚，但并发操作可能影响结果，请核对数据", Backup.commitImport(data, listOf("台,http://x/1"), q, io(c, false, true)))
      assertEquals(listOf("store", "my", "store-rb", "my-rb"), c)
    }
    run {                                                   // quality 失败：三件整体回滚（§13.2-5 不允许半恢复；LS 未提交不动）
      val c = mutableListOf<String>()
      assertEquals("质量 sidecar 恢复失败；已尝试回滚，但并发操作可能影响结果，请核对数据", Backup.commitImport(data, listOf("台"), q, io(c, true, false), ls))
      assertEquals(listOf("store", "my", "q", "store-rb", "my-rb", "q-rb"), c)
    }
    run {                                                   // listenStats 失败：四件整体回滚（B4 四件事务收官位）
      val c = mutableListOf<String>()
      assertEquals("收听统计 sidecar 恢复失败；已尝试回滚，但并发操作可能影响结果，请核对数据", Backup.commitImport(data, listOf("台"), q, io(c, true, true, false), ls))
      assertEquals(listOf("store", "my", "q", "ls", "store-rb", "my-rb", "q-rb", "ls-rb"), c)
    }
    run {                                                   // Store 落盘失败（AIbot 三轮 P1-2）：中止 + 回滚 Store，my/quality 根本不动
      val c = mutableListOf<String>()
      assertEquals("主数据持久化失败（store.json 写入失败或异常）；已尝试回滚，但并发操作可能影响结果，请核对数据", Backup.commitImport(data, listOf("台,http://x/1"), q,
        Backup.ImportIO({ c.add("store"); false }, { c.add("store-rb"); true }, { c.add("my"); true }, { true }, { c.add("q"); true }, { true })))
      assertEquals(listOf("store", "store-rb"), c)
    }
    run {                                                   // 回滚也失败：文案如实点名（重启后请重新导入）
      val c = mutableListOf<String>()
      val err = Backup.commitImport(data, null, q,
        Backup.ImportIO({ false }, { false }, { true }, { true }, { true }, { true }))
      assertEquals("主数据持久化失败（store.json 写入失败或异常）；回滚失败或结果未知：主数据，请核对数据并考虑重新导入", err)
      assertEquals(0, c.size)
    }
  }

  @Test fun rollbackFailuresAndExceptionsAreReportedAndDoNotStopCompensation() {
    val calls = mutableListOf<String>()
    val io = Backup.ImportIO(
      { true }, { calls.add("store"); throw IllegalStateException("disk") },
      { true }, { calls.add("my"); false },
      { true }, { calls.add("quality"); throw IllegalStateException("disk") },
      { throw IllegalStateException("apply") }, { calls.add("listen"); false })
    val err = Backup.commitImport(emptyMap(), listOf("台"), JSONObject(), io, JSONObject())!!
    assertEquals(listOf("store", "my", "quality", "listen"), calls)
    assertTrue(err.contains("收听统计 sidecar 恢复失败"))
    assertTrue(err.contains("主数据、个人电台、质量 sidecar、收听统计 sidecar"))
  }
  @Test fun unselectedStepsAreNeverAppliedOrRolledBack() {
    val calls = mutableListOf<String>()
    val io = Backup.ImportIO(
      { calls.add("store"); true }, { calls.add("store-rb"); true },
      { calls.add("my"); true }, { calls.add("my-rb"); false },
      { calls.add("quality"); true }, { calls.add("quality-rb"); false },
      { calls.add("listen"); false }, { calls.add("listen-rb"); true })
    val err = Backup.commitImport(emptyMap(), null, null, io, JSONObject())!!
    assertEquals(listOf("store", "listen", "store-rb", "listen-rb"), calls)
    assertFalse(err.contains("个人电台")); assertFalse(err.contains("质量 sidecar"))
  }

  @Test fun attemptedFailureStillRollsBackEvenOnException() {
    val calls = mutableListOf<String>()
    val io = Backup.ImportIO(
      { true }, { calls.add("store-rb"); true },
      { calls.add("my"); throw IllegalStateException("partial write") }, { calls.add("my-rb"); true },
      { calls.add("quality"); true }, { calls.add("quality-rb"); true })
    assertNotNull(Backup.commitImport(emptyMap(), listOf("台"), JSONObject(), io))
    assertEquals(listOf("my", "store-rb", "my-rb"), calls)
  }
  @Test fun realMyRadioRollbackWriteFailureIsReported() {
    val blocker = File.createTempFile("vradio-rollback-blocker", ".tmp")
    try {
      val my = MyRadio(File(blocker, "sub"))
      val calls = mutableListOf<String>()
      val err = Backup.commitImport(emptyMap(), listOf("台"), JSONObject(), Backup.ImportIO(
        { true }, { calls.add("store"); true },
        { true }, { calls.add("my"); my.replace("旧台,http://example.com/live") },
        { false }, { calls.add("quality"); true }))!!
      assertEquals(listOf("store", "my", "quality"), calls)
      assertTrue(err.contains("回滚失败或结果未知：个人电台"))
    } finally { blocker.delete() }
  }
  @Test fun storeApplyAllCheckedRealWriteFailure() { // 真实写失败（AIbot 三轮 P1-2）：init 到不可建目录 → 落盘必败且可感知
    val blocker = File.createTempFile("vradio-blocker", ".tmp"); blocker.deleteOnExit()
    Store.init(File(blocker, "sub"))                       // 父路径是文件：mkdirs 失败 → 写入必失败
    Store.set(C.K_VOL, "30")                               // set 吞失败路径不受影响（内存态仍在）
    assertFalse(Store.applyAllChecked(mapOf(C.K_VOL to "90")))
    assertEquals("90", Store.get(C.K_VOL))                 // 内存已应用（内存态 = 全部）——false 只是把磁盘写失败上报给事务
    Store.init(dir)                                        // 恢复正常目录（不污染其它用例）
    assertTrue(Store.applyAllChecked(mapOf(C.K_VOL to "90")))
  }

  @Test fun exportAllOptionalSidecar() { // 「包含本机 sidecar」（AIbot 三轮 P1-3；B4 双 sidecar）：勾选写 extensions.sidecars.*，默认恒空
    val plain = JSONObject(Backup.exportAll(lib, "我的,#genre#", 1L))
    assertEquals(0, plain.getJSONObject("extensions").length())
    val qd = Backup.qualityTrim(qData("https://main.example/live", 7))
    val withQ = JSONObject(Backup.exportAll(lib, "我的,#genre#", 1L, JSONObject().put("v", 1).put("data", qd)))
    assertEquals(qd.length(), withQ.getJSONObject("extensions").getJSONObject("sidecars").getJSONObject("quality").getJSONObject("data").length())
    assertEquals("android", withQ.getString("app")); assertEquals(3, withQ.getInt("version"))
    val ld = Backup.lsTrim(JSONObject().put("2026-11-14", JSONObject().put("ms", 1000).put("sessions", 1)))
    val withBoth = JSONObject(Backup.exportAll(lib, "我的,#genre#", 1L,
      JSONObject().put("v", 1).put("data", qd), JSONObject().put("v", 1).put("data", ld)))
    val sc = withBoth.getJSONObject("extensions").getJSONObject("sidecars")
    assertEquals(2, sc.length())                                    // 双 sidecar 并存
    assertEquals(1, sc.getJSONObject("listenStats").getJSONObject("data").length())
  }

  // —— B4 listenStats sidecar：lsTrim 白名单裁剪 + ListenSidecar 真落盘 round-trip（AppVm.applyConfirmed 同款凭据） ——

  @Test fun lsTrimValidationAndCaps() { // 坏日期键/非法键剔除、数值归一、空日丢弃、90 日与 64 条封顶
    val data = JSONObject()
      .put("2026-02-30", JSONObject().put("ms", 999))               // 非历法日：丢弃
      .put("2026-02-29", JSONObject().put("ms", 999))               // 2026 非闰年：丢弃
      .put("2024-02-29", JSONObject().put("ms", 888))               // 闰年：保留
      .put("2026-01-01", JSONObject().put("ms", -5))                // 全空日：丢弃
      .put("2026-01-02", JSONObject().put("ms", "3600").put("sessions", 2.9)
        .put("stations", JSONObject().put("ftp://x", 5).put("https://a/live", "7000.9").put("https://b/live", -1))
        .put("categories", JSONObject().put("长".repeat(25), 1).put("华语音乐", 3)))
    val t = Backup.lsTrim(data)
    assertEquals(2, t.length())
    assertEquals(888L, t.getJSONObject("2024-02-29").getLong("ms"))
    val d2 = t.getJSONObject("2026-01-02")
    assertEquals(3600L, d2.getLong("ms")); assertEquals(2, d2.getInt("sessions")) // 字符串数字收敛、小数取整
    assertEquals(1, d2.getJSONObject("stations").length())          // 非台键/负值剔除（只留 https://a/live=7000）
    assertEquals(7000L, d2.getJSONObject("stations").getLong("https://a/live"))
    assertEquals(1, d2.getJSONObject("categories").length())        // 超 24 字符分类剔除
    // 90 日封顶：91 个连续合法日 → 保留最新 90
    val many = JSONObject()
    val cal = java.util.Calendar.getInstance()
    for (i in 0 until 91) {
      cal.clear(); cal.set(2025, java.util.Calendar.JANUARY, 1 + i)
      many.put(ListenStats.dayKey(cal.timeInMillis), JSONObject().put("ms", 1).put("sessions", 1))
    }
    val t2 = Backup.lsTrim(many)
    assertEquals(90, t2.length())
    // 每日台/分类 64 条封顶
    val big = JSONObject()
    for (i in 0 until 80) big.put("https://s$i.example/live", 100)
    val t3 = Backup.lsTrim(JSONObject().put("2026-01-01", JSONObject().put("ms", 1).put("sessions", 1).put("stations", big)))
    assertEquals(64, t3.getJSONObject("2026-01-01").getJSONObject("stations").length())
  }

  @Test fun listenStatsReplaceImportViaSidecar() { // 四件事务收官位真落盘：days → 白名单解码 + trim → ListenSidecar 覆盖写 + 回滚恢复旧快照
    val sidecar = ListenSidecar(dir)
    val old = StatsState(v = 1)
    old.days["2026-10-01"] = StatsDay(ms = 60000, sessions = 1)
    assertTrue(sidecar.save(old))                                   // 导入前旧快照（AppVm.applyConfirmed 同款凭据）
    val lsData = Backup.lsTrim(JSONObject().put("2026-11-14",
      JSONObject().put("ms", 1800000).put("sessions", 2)
        .put("stations", JSONObject().put("https://new.example/live", 1800000))
        .put("categories", JSONObject().put("华语音乐", 1800000))))
    fun lsApply(): Boolean {                                        // AppVm.applyConfirmed 注入的同款 apply
      val st = ListenStatsCodec.parse(JSONObject().put("v", 1).put("days", lsData).toString())
      return sidecar.save(ListenStats.trim(st))
    }
    assertTrue(lsApply())                                           // 提交：覆盖写成功
    val cur = sidecar.load()
    assertEquals(1800000L, cur.days["2026-11-14"]!!.ms)             // 盘上是导入数据
    assertEquals(1, cur.days.size)                                  // 旧日被覆盖语义清除
    assertTrue(sidecar.save(old))                                   // 回滚：旧快照回写（失败位兜底）
    assertEquals(60000L, sidecar.load().days["2026-10-01"]!!.ms)
    assertNull(sidecar.load().days["2026-11-14"])
  }
}
