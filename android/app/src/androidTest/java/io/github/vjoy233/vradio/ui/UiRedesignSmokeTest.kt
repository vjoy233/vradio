package io.github.vjoy233.vradio.ui

import android.os.SystemClock
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.lifecycle.ViewModelProvider
import io.github.vjoy233.vradio.AndroidSmokeTest
import io.github.vjoy233.vradio.MainActivity
import io.github.vjoy233.vradio.TestUtil
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.player.PlayerHolder
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/* UI 重设计 Instrumented Smoke（P4，docs/ui-android-redesign-plan-2026-11.md §8.2 增量——
   在测试链 #36/#40 的 AndroidSmokeTest/PlaybackSmokeTest/TestUtil 基建之上增加的 UI 交互用例集）。
   ⚠ 依赖声明：本文件引用 TestUtil/AndroidSmokeTest（测试链 PR #36/#40，未进 main）；本分支不编译
   androidTest 源集（主源集门 = compileDebugKotlin/test/assembleDebug 不受影响），androidTest 的交叉
   编译验证由 orchestrator 在「本分支 × 测试链」临时合并 worktree 做（P4 决策记录 §0，已知且接受）。
   Compose 测试规则组合：createEmptyComposeRule()（空规则，不自带 Activity 生命周期管理）+
   ActivityScenario.launch(MainActivity) 手动启动——官方 ui-test 文档对「非默认 Activity」的标准组合
   （createAndroidComposeRule 只适用于 EmptyActivity/注解默认 Activity，且与本类自管 scenario.close()
   的逐用例隔离口径冲突），每个用例 @Before 起新 Activity、@After 收尾 = 干净的目的地/搜索/收藏态。
   数据纪律：@get:Rule = TestUtil.dataGuard()（快照 + try/finally 恢复，照 AndroidSmokeTest 先例——
   boot/播放/收藏注入都会写真实应用数据）。
   fixture 协议：播放类用例照 PlaybackSmokeTest 模式（AndroidSmokeTest.assumeFixture →
   assumeFixtureReachable → logFixtureEnv），未接 fixtureBaseUrl 时 Assume 跳过、CI required 模式 fail。
   §8.2.9 语义契约串（搜索/更多/播放/暂停/已收藏/收藏）由并行 a11y 批次落地——本文件按钉死契约串断言，
   契约未落地前红脸是预期行为（防语义串漂移）。
   §8.2 逐项去向：
   · 1→「设置往返保留搜索词」 · 2→「fixture播放跨目的地不中断」 · 3→「fullPlayer动作入口」
   · 4→「双形态导航分档」（简化口径：节点存在性+几何分档；「列表最后一项滚到屏内不遮挡」与
     320dp/800dp 全覆盖挂账真机矩阵手测——模拟器矩阵属设备接入批次）
   · 5 挂账：无网络态（列表/收藏/最近/备份入口可用 + 探活/同步错误恢复动作）需 NetGate/B5 网络策略
     注入面，超本批范围——去向方案 §10 附录（设备接入批次随网络策略面落地）
   · 6→「收藏页搜索与撤销」 · 8→「目的地状态保留」 · 9→「talkBack语义契约」
   · 7 挂账：编译期双态（DISCOVERY=false 两次构建）不能以运行时开关测试替代——已由主源集 JVM 直测
     NavigationStateTest/WindowClassTest 覆盖纯函数层，instrumented 不重复（§8.2.7 明文）。 */
@RunWith(AndroidJUnit4::class)
class UiRedesignSmokeTest {

  @get:Rule
  val guard = TestUtil.dataGuard() // review#40 P1 先例：boot/播放/收藏写入真实数据，快照兜底

  @get:Rule
  val composeRule = createEmptyComposeRule() // 空规则：Activity 由 ActivityScenario 自管（见类注释）

  private var scenario: ActivityScenario<MainActivity>? = null
  private var vmRef: AppVm? = null // ViewModelProvider 直取（与 AppRoot 同一实例）；StateFlow 跨线程读安全

  @Before
  fun launchApp() {
    scenario = ActivityScenario.launch(MainActivity::class.java)
    scenario!!.onActivity { a -> vmRef = ViewModelProvider(a)[AppVm::class.java] }
  }

  @After
  fun closeApp() {
    runCatching { scenario?.close() } // 活动收尾后 dataGuard 才做恢复（onStop flush 落在恢复之前）
    scenario = null; vmRef = null
  }

  /* ---------- §8.2.1 设置往返保留：搜索词在「更多→设置→返回」后仍在 ---------- */
  @Test
  fun `设置往返保留搜索词`() {
    composeRule.waitForIdle()
    // 默认在电台页：vm 目的地直读 + 「电台」标题在屏（nav tab 也有「电台」label，故用 allNodes 容双命中）
    assertEquals(Destination.LIBRARY, vmRef!!.destination.value)
    assertTrue("「电台」节点应在屏", composeRule.onAllNodesWithText("电台").fetchSemanticsNodes().isNotEmpty())
    // 展开搜索输入「爵士」（语义串「搜索」= §8.2.9 契约串）
    composeRule.onNodeWithContentDescription("搜索").performClick()
    composeRule.onNode(hasText("搜索电台名")).performTextInput("爵士")
    // 打开设置：点「更多」→ 菜单项「设置」（次级页全屏覆盖，目的地不变）
    composeRule.onNodeWithContentDescription("更多").performClick()
    composeRule.onNodeWithText("设置").performClick()
    composeRule.waitForIdle()
    // 返回（系统返回；AppRoot BackHandler 消费：次级页 → 来源目的地）
    scenario!!.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    composeRule.waitForIdle()
    // 搜索词仍在（EditableText 直查字段值，避开列表行同名文本的歧义）
    composeRule.waitUntil(5_000) {
      composeRule.onAllNodes(hasEditableText("爵士")).fetchSemanticsNodes().isNotEmpty()
    }
    assertTrue("设置往返后搜索词应保留",
      composeRule.onAllNodes(hasEditableText("爵士")).fetchSemanticsNodes().isNotEmpty())
  }

  /* ---------- §8.2.2 fixture 播放跨目的地不中断 ---------- */
  @Test
  fun `fixture播放跨目的地不中断`() {
    AndroidSmokeTest.logFixtureEnv(TAG)
    val base = AndroidSmokeTest.assumeFixture() // 未接 fixture：本地 Assume 跳过；ciRequired=1 直接 fail
    AndroidSmokeTest.assumeFixtureReachable(base)
    val s = Station("smoke", "fixture 直流A", mutableListOf("$base/direct.mp3"))
    InstrumentationRegistry.getInstrumentation().runOnMainSync { PlayerHolder.play(s) }
    assertTrue("12s 内未进入 PLAYING（fixture=$base）", awaitSt(PState.PLAYING, 12_000))
    // 播放中语义契约：mini player 主动作 cd「暂停」（§8.2.9 契约串之一，随本用例自然状态核对）
    assertTrue("播放中应有 cd「暂停」", composeRule.onAllNodesWithContentDescription("暂停").fetchSemanticsNodes().isNotEmpty())
    // 切「收藏」（mini 台名随行更新）→ 回电台 → 更多→设置 → 返回
    composeRule.waitForIdle()
    tab("收藏").performClick()
    composeRule.waitForIdle()
    assertTrue("跨目的地后 mini 台名应持续在屏", composeRule.onAllNodesWithText("fixture 直流A").fetchSemanticsNodes().isNotEmpty())
    tab("电台").performClick()
    composeRule.waitForIdle()
    composeRule.onNodeWithContentDescription("更多").performClick()
    composeRule.onNodeWithText("设置").performClick()
    composeRule.waitForIdle()
    scenario!!.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    composeRule.waitForIdle()
    // 直读状态断言（ActivityScenario.onActivity 主线程直读 PlayerHolder.ui，避免 UI 轮询竞态）+ 原目的地
    scenario!!.onActivity { _ ->
      assertEquals("跨目的地播放不应中断", PState.PLAYING, PlayerHolder.ui.value.st)
      assertEquals("设置返回应回到原目的地（电台）", Destination.LIBRARY, vmRef!!.destination.value)
    }
    InstrumentationRegistry.getInstrumentation().runOnMainSync { PlayerHolder.stop() }
  }

  /* ---------- §8.2.3 Full player 动作：展开 + 刷新/选源入口（动作回现有 API，不深驱播放链）---------- */
  @Test
  fun `fullPlayer动作入口`() {
    AndroidSmokeTest.logFixtureEnv(TAG)
    val base = AndroidSmokeTest.assumeFixture()
    AndroidSmokeTest.assumeFixtureReachable(base)
    // 双源台（u.size>1）才渲染「选源」入口——fixture 直流 A/B 双源
    val s = Station("smoke", "fixture 直流A", mutableListOf("$base/direct.mp3", "$base/direct-b.mp3"))
    InstrumentationRegistry.getInstrumentation().runOnMainSync { PlayerHolder.play(s) }
    assertTrue("12s 内未进入 PLAYING（fixture=$base）", awaitSt(PState.PLAYING, 12_000))
    // 展开：点 mini player 中列（合并语义 = 台名文本节点；displayParts 对无国别名原样返回）
    composeRule.onNodeWithText("fixture 直流A").performClick()
    composeRule.waitUntil(10_000) { composeRule.onAllNodesWithText("正在播放").fetchSemanticsNodes().isNotEmpty() } // sheet 状态行
    // 动作入口存在性（存在即代表接线在位；点按效果由 §8.2.2 播放链与既有 JVM 用例覆盖，不深驱）
    assertTrue("full player 应有「刷新」入口", composeRule.onAllNodesWithText("刷新").fetchSemanticsNodes().isNotEmpty())
    assertTrue("多源台 full player 应有「选源」入口", composeRule.onAllNodesWithText("选源").fetchSemanticsNodes().isNotEmpty())
    composeRule.onNodeWithText("刷新").performClick() // 动作回 PlayerHolder.refresh（回直播头整链重开）
    assertTrue("刷新后应回到 PLAYING", awaitSt(PState.PLAYING, 15_000))
    scenario!!.onActivity { it.onBackPressedDispatcher.onBackPressed() } // BackHandler(showPlayer) → closePlayer
    composeRule.waitForIdle()
    InstrumentationRegistry.getInstrumentation().runOnMainSync { PlayerHolder.stop() }
  }

  /* ---------- §8.2.4 双形态分档：窗口档位决定底栏/rail，目的地节点存在且位置分档 ----------
     简化口径（本批）：节点存在性 + 几何位置分档；「底栏/rail 不遮挡列表最后一项」与 320dp/800dp
     真机矩阵挂账手测（模拟器矩阵属设备接入批次，见类注释）。窗口档位复用生产纯函数 windowClassOf，
     档位输入与生产一致（configuration.screenWidthDp，LocalConfiguration 同源）。 */
  @Test
  fun `双形态导航分档`() {
    composeRule.waitForIdle()
    val cfg = InstrumentationRegistry.getInstrumentation().targetContext.resources.configuration
    val root: Rect = composeRule.onRoot().fetchSemanticsNode().boundsInRoot
    val tab: Rect = tab("收藏").fetchSemanticsNode().boundsInRoot
    when (windowClassOf(cfg.screenWidthDp)) {
      VrWindow.EXPANDED -> assertTrue(">=600dp 应为左缘 rail（tab centerX=${tab.center.x}，屏宽=${root.width}）",
        tab.center.x.toDouble() < root.width / 4.0)
      VrWindow.COMPACT -> assertTrue("<600dp 应为底栏（tab centerY=${tab.center.y}，屏高=${root.height}）",
        tab.center.y.toDouble() > root.height * 0.7)
    }
  }

  /* ---------- §8.2.6 收藏页搜索/撤销：搜索只作用收藏集合；星标取消 → Snackbar「已取消收藏」→ 撤销按 URL 恢复 ---------- */
  @Test
  fun `收藏页搜索与撤销`() {
    assertTrue("boot 应就绪（列表装载）", awaitBoot())
    // 选台名不含「[]」的台：displayParts 剥国别后行名与查询词一致（避免回绑名漂移）
    val s = vmRef!!.lib.stations.firstOrNull { !it.n.contains("[") && it.n.length >= 2 }
      ?: throw AssertionError("boot 后应有可用台")
    // 状态注入收藏（经 AppVm.toggleFav 走生产写回路径 saveFavs→Store；不用 UI 长按避免手势触达概率性）
    InstrumentationRegistry.getInstrumentation().runOnMainSync { vmRef!!.toggleFav(s) }
    composeRule.waitUntil(10_000) { vmRef!!.favorites.value.any { it.key == s.key } }
    tab("收藏").performClick()
    composeRule.waitUntil(10_000) { composeRule.onAllNodesWithText("搜索收藏").fetchSemanticsNodes().isNotEmpty() }
    // 收藏内独立搜索（只作用收藏集合：全库其余台不因本词进收藏页列表）
    composeRule.onNodeWithText("搜索收藏").performTextInput(s.n)
    composeRule.waitForIdle()
    assertTrue("过滤后收藏行应在屏", composeRule.onAllNodesWithText(s.n).fetchSemanticsNodes().isNotEmpty())
    // 行内星标取消收藏 → 收藏页桥接发撤销载荷 → Snackbar「已取消收藏：台名」
    composeRule.onNodeWithText("★").performClick()
    composeRule.waitUntil(10_000) {
      composeRule.onAllNodes(hasText("已取消收藏", substring = true)).fetchSemanticsNodes().isNotEmpty()
    }
    composeRule.onNodeWithText("撤销").performClick()
    composeRule.waitUntil(10_000) { vmRef!!.favorites.value.any { it.key == s.key } } // undoUnfav 按 URL 回绑恢复
    assertTrue("撤销后收藏应恢复", vmRef!!.favorites.value.any { it.key == s.key })
    composeRule.waitUntil(10_000) {
      composeRule.onAllNodesWithContentDescription("已收藏").fetchSemanticsNodes().isNotEmpty() // §8.2.9 契约串
    }
  }

  /* ---------- §8.2.8 目的地状态保留：电台页搜索「fm」→ 收藏 → 回电台，搜索词仍在 ---------- */
  @Test
  fun `目的地状态保留`() {
    composeRule.waitForIdle()
    composeRule.onNodeWithContentDescription("搜索").performClick()
    composeRule.onNode(hasText("搜索电台名")).performTextInput("fm")
    // 等防抖落 vm.keyword（Q15 语义：切目的地收起展开态但词保留，回台页有词自动再展开）
    composeRule.waitUntil(5_000) { vmRef!!.keyword.value == "fm" }
    tab("收藏").performClick()
    composeRule.waitForIdle()
    tab("电台").performClick()
    composeRule.waitUntil(10_000) {
      composeRule.onAllNodes(hasEditableText("fm")).fetchSemanticsNodes().isNotEmpty()
    }
    assertTrue("切目的地往返后电台页搜索词应保留",
      composeRule.onAllNodes(hasEditableText("fm")).fetchSemanticsNodes().isNotEmpty())
    assertEquals(Destination.LIBRARY, vmRef!!.destination.value)
  }

  /* ---------- §8.2.9 TalkBack 语义契约：钉死串 搜索/更多/播放/收藏（boot 态；暂停/已收藏随 §8.2.2/§8.2.6 用例核对）----------
     存在性断言（allNodes 容双命中：如「收藏」cd 可能同时出现在行星标与 tab），不锁单节点防契约扩位。 */
  @Test
  fun `talkBack语义契约`() {
    assertTrue("boot 应就绪（列表装载）", awaitBoot())
    composeRule.waitForIdle()
    for (cd in listOf("搜索", "更多", "播放", "收藏")) {
      assertTrue("内容描述「$cd」应存在（§8.2.9 语义契约）",
        composeRule.onAllNodesWithContentDescription(cd).fetchSemanticsNodes().isNotEmpty())
    }
  }

  /* ---------- helpers ---------- */

  /** 底栏/rail 目的地节点：M3 NavigationBarItem/NavigationRailItem 均挂 Role.Tab，用它把 nav 项与
      页内同名文本（TopAppBar 标题/收藏页头部）区分开 */
  private fun tab(title: String) = composeRule.onNode(hasText(title).and(hasRole(Role.Tab)))

  /** EditableText 专查（hasText 连 Text+EditableText 双查会撞列表行同名文本） */
  private fun hasEditableText(v: String) = SemanticsMatcher("editableText=\"$v\"") { node ->
    node.config.contains(SemanticsProperties.EditableText) && node.config[SemanticsProperties.EditableText].text == v
  }

  /** Role 匹配（本 BOM ui-test 无顶层 hasRole——本地拼装，contains+[] 双保险防缺属性抛错） */
  private fun hasRole(r: Role) = SemanticsMatcher("role=$r") { node ->
    node.config.contains(SemanticsProperties.Role) && node.config[SemanticsProperties.Role] == r
  }

  /** 轮询播放状态到目标（PlayerHolder.ui StateFlow 跨线程读安全；100ms 步进，PlaybackSmokeTest 同款） */
  private fun awaitSt(want: PState, timeoutMs: Long): Boolean {
    val t0 = SystemClock.elapsedRealtime()
    while (SystemClock.elapsedRealtime() - t0 < timeoutMs) {
      if (PlayerHolder.ui.value.st == want) return true
      SystemClock.sleep(100)
    }
    return PlayerHolder.ui.value.st == want
  }

  /** boot 就绪有界等待（AppVm.booted private——以 lib.stations 装载为代理信号） */
  private fun awaitBoot(timeoutMs: Long = 20_000): Boolean {
    val t0 = SystemClock.elapsedRealtime()
    while (SystemClock.elapsedRealtime() - t0 < timeoutMs) {
      if (vmRef?.lib?.stations?.isNotEmpty() == true) return true
      SystemClock.sleep(100)
    }
    return vmRef?.lib?.stations?.isNotEmpty() == true
  }

  companion object {
    private const val TAG = "VRadioUiSmoke"
  }
}
