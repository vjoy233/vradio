package io.github.vjoy233.vradio

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.Backup
import io.github.vjoy233.vradio.data.Store
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 备份导入 Smoke（P2，docs/testing-strategy-2026-11.md §3 L4 Smoke 矩阵「备份导入」行）：
 * 预览（[Backup.parseImport]）→ 确认 → 提交（[Backup.commitImport]，真实 Store 落盘 + 快照恢复）。
 * 走服务层入口（AppVm.applyConfirmed 的同一批构件），不依赖 UI。
 *
 * ⚠ 如实标注范围（review#40 P2-5）：本类是 **parser + Store 适配 smoke**——只验 v1/v2/v3 版本识别、
 * 13 键白名单、个人台数组、双 sidecar 解析，与 commitImport 走真实 Store 落盘这一条「提交面」；
 * **不含**个人台真文件落盘（my-radio.txt）、双 sidecar 真文件落盘（quality.json/listen-stats.json）、
 * 失败回滚事务链、真实确认入口（AppVm.applyConfirmed UI 链）——这些由 JVM 层 BackupV3Test（真文件
 * 覆盖）与后续设备验收批次兜住，勿据本类全绿推断设备边界已完成（挂账见 §10 附录）。
 *
 * fixture 来源（review#40 P2-5 contracts 接线）：黄金样本从构建期拷进 androidTest assets 的
 * contracts/fixtures **原件**读取（android/app/build.gradle.kts copyContractsFixtures，与 JVM test
 * resources 同源同份），不再逐字内联——拷贝漂移被根治；两侧同步义务见 android/CONTRACTS.md 与
 * AGENTS.md 契约节。本类不依赖网络与 fixtureBaseUrl，离线可跑。
 */
@RunWith(AndroidJUnit4::class)
class BackupRestoreSmokeTest {

  @get:Rule
  val guard = TestUtil.dataGuard() // review#40 P1：commitImport 写真实 Store——快照 + try/finally 恢复必挂

  /** 构建期从仓库 contracts/fixtures 原样拷贝的黄金样本（androidTest assets，防内联漂移） */
  private fun contractFixture(name: String): String =
    InstrumentationRegistry.getInstrumentation().context.assets.open("contracts/$name")
      .use { it.readBytes().decodeToString() }

  @Before
  fun logEnv() {
    AndroidSmokeTest.logFixtureEnv(TAG) // 环境在案（本类不用 fixture，也如实记「未注入」）
  }

  @Test
  fun v3PreviewAndCommitRealStore() {
    // —— 预览段（确认框的数据来源，AppVm.applyConfirmed 前置）：版本/白名单/个人台/双 sidecar ——
    val p = Backup.parseImport(contractFixture("backup-v3.json"))
    assertNotNull("v3 黄金样本应可解析", p)
    assertEquals(3, p!!.ver)
    assertEquals(13, p.data.size)
    for (k in p.data.keys) assertTrue("非白名单键 $k", C.KEYS.contains(k))
    assertEquals(listOf("自建,#genre#", "我的电台,https://example.test/live"), p.my)
    assertNotNull(p.quality)
    assertNotNull(p.listenStats)
    // —— 提交段：真实 Store 落盘（VRadioApp.onCreate 已 init 到 app filesDir），my/sidecar 传 no-op
    //      不动真实个人文件（范围见类头注「如实标注」）；提交后快照恢复（guard @After 另有兜底） ——
    val snap = Store.snapshot()
    val err = Backup.commitImport(p.data, null, p.quality, Backup.ImportIO(
      { Store.applyAllChecked(p.data) }, { Store.applyAllChecked(snap) },
      { true }, { true },                            // my==null 语义 = 不动 my-radio.txt
      { true }, { true }, { true }, { true }),        // 质量/收听统计 sidecar no-op（真文件落盘由 JVM 层覆盖）
      p.listenStats)
    assertNull("提交段不应失败：$err", err)
    assertEquals("fixture 收藏快照应已落 Store（提交面）",
      p.data[C.K_FAVS], Store.get(C.K_FAVS))
    assertEquals("90", Store.get(C.K_VOL))
    assertTrue("导入后快照恢复", Store.applyAllChecked(snap))
    assertEquals("Store 应回到导入前快照", snap, Store.snapshot())
  }

  @Test
  fun v2PreviewAndV1Fallback() { // v2 读 my 数组；v1（无版本字段/无 my）回退预览
    val p2 = Backup.parseImport(contractFixture("backup-v2.json"))
    assertNotNull(p2)
    assertEquals(2, p2!!.ver)
    assertEquals(13, p2.data.size)
    assertEquals(listOf("自建,#genre#", "我的电台,https://example.test/live"), p2.my)
    assertNull(p2.quality)                       // v2 无 sidecar 段
    // v1 形态无黄金 fixture（contracts/fixtures 只有 v2/v3），样本内联仅验版本回退，不涉契约同步
    val p1 = Backup.parseImport("""{"v":1,"at":1731500000000,"data":{"radio.vol":"88"}}""")
    assertEquals(1, p1!!.ver)
    assertNull(p1.my)                            // v1 不带个人台字段 = 不动 my-radio.txt
    assertEquals("88", p1.data[C.K_VOL])
  }

  companion object {
    private const val TAG = "VRadioSmoke"
  }
}
