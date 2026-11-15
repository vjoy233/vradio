package io.github.vjoy233.vradio

import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.player.PlayerHolder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 固定流播放 Smoke（P2，docs/testing-strategy-2026-11.md §3 L4 Smoke 矩阵「播放控制」行）：
 * fixture 直流 MP3 点播 → playing（带超时）→ 暂停/恢复 → 切台 → 停止归位。
 *
 * 走服务层入口 [PlayerHolder]（单例，VRadioApp.onCreate 已 ensure——instrumentation 与宿主 app 同进程，
 * 无需 UI 驱动；ExoPlayer 要求主线程的操作经 runOnMainSync 送入）。不依赖 Compose 语义、
 * 不新增测试依赖（compose-ui-test 未在白名单）。未接 fixture（fixtureBaseUrl 缺省/哨兵）时
 * [requireFixture] 即 Assume 跳过，骨架保持绿；全程只连本地 Node fixture（模拟器经 10.0.2.2 访问宿主），
 * 禁止公网。音频焦点让位/恢复属发布前设备层，不在本批。
 */
@RunWith(AndroidJUnit4::class)
class PlaybackSmokeTest {

  private lateinit var base: String

  @Before
  fun requireFixture() {
    AndroidSmokeTest.logFixtureEnv(TAG) // fixture 版本/URL/设备 API/APK 版本进 instrumentation 日志（报告在案）
    base = AndroidSmokeTest.assumeFixture() // 未接 fixture：assume 失败 = 本类用例全跳过（骨架保持绿）
  }

  @Test
  fun directMp3PlayPauseResumeSwitchStop() {
    val instr = InstrumentationRegistry.getInstrumentation()
    val a = Station("smoke", "fixture 直流A", mutableListOf(base + "/direct.mp3"))
    val b = Station("smoke", "fixture 直流B", mutableListOf(base + "/direct-b.mp3"))
    // 点播直流 A：CONNECTING → PLAYING（fixture 本机可达，12s 超时已含慢环境余量；真实慢源 5-10s 口径见 AGENTS.md）
    instr.runOnMainSync { PlayerHolder.play(a) }
    assertTrue("12s 内未进入 PLAYING（fixture=$base）", awaitSt(PState.PLAYING, 12_000))
    // 暂停 → 恢复（有意暂停守卫 halt 挡在飞级联；resume 清守卫续播）
    instr.runOnMainSync { PlayerHolder.pause() }
    assertTrue("pause 后未进入 PAUSED", awaitSt(PState.PAUSED, 5_000))
    instr.runOnMainSync { PlayerHolder.resume() }
    assertTrue("resume 后未回到 PLAYING", awaitSt(PState.PLAYING, 8_000))
    // 切台：世代令牌作废在飞链，B 台重新建流（player.js play 决策链的安卓面）
    instr.runOnMainSync { PlayerHolder.play(b) }
    assertTrue("切台后 12s 内未进入 PLAYING", awaitSt(PState.PLAYING, 12_000))
    assertEquals("切台后当前台应为直流B", b.key, PlayerHolder.ui.value.station?.key)
    // 收尾归位（不留连接/通知态，避免污染同进程后续用例）
    instr.runOnMainSync { PlayerHolder.stop() }
    assertTrue("stop 后未回到 IDLE", awaitSt(PState.IDLE, 5_000))
    Log.i(TAG, "播放链全程通过 fixture=$base")
  }

  /** 轮询播放状态到目标（PlayerHolder.ui StateFlow 跨线程读安全；100ms 步进，超时按最后一次判定） */
  private fun awaitSt(want: PState, timeoutMs: Long): Boolean {
    val t0 = SystemClock.elapsedRealtime()
    while (SystemClock.elapsedRealtime() - t0 < timeoutMs) {
      if (PlayerHolder.ui.value.st == want) return true
      SystemClock.sleep(100)
    }
    return PlayerHolder.ui.value.st == want
  }

  companion object {
    private const val TAG = "VRadioSmoke"
  }
}
