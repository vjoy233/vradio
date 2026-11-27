package io.github.vjoy233.vradio

import android.app.NotificationManager
import androidx.test.core.app.ActivityScenario
import android.content.ComponentName
import android.content.Context
import android.os.SystemClock
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.player.PlaybackService
import io.github.vjoy233.vradio.player.PlayerHolder
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 本地fixture，测试真实产品会话和通知；不模拟系统断连、任务移除或锁屏。 */
@RunWith(AndroidJUnit4::class)
class B3PlaybackAcceptanceTest {
  @get:Rule val guard = TestUtil.dataGuard()
  @Test fun notificationAndExplicitControllerStop() {
    val base = AndroidSmokeTest.assumeFixture()
    AndroidSmokeTest.assumeFixtureReachable(base)
    val inst = InstrumentationRegistry.getInstrumentation()
    val ctx = inst.targetContext
    inst.runOnMainSync { PlayerHolder.play(Station("smoke", "B3本地流", mutableListOf(base + "/direct.mp3"))) }
    assertTrue("本地流未播放", await(12000) { PlayerHolder.ui.value.st == PState.PLAYING })
    val notifications = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    assertTrue("播放时未发现应用通知", await(10000) { notifications.activeNotifications.isNotEmpty() })
    val future = MediaController.Builder(ctx, SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))).buildAsync()
    try {
      val ctl = future.get(10, TimeUnit.SECONDS)
      inst.runOnMainSync { ctl.stop() }
      assertTrue("媒体控制器 stop 未到达播放器", await(5000) { PlayerHolder.ui.value.st == PState.IDLE })
      val until = SystemClock.elapsedRealtime() + 15000
      while (SystemClock.elapsedRealtime() < until) {
        inst.runOnMainSync {
          assertEquals(PState.IDLE, PlayerHolder.ui.value.st)
          assertFalse("显式停止后不得自动播放", PlayerHolder.player.isPlaying)
          assertNull("显式停止后不应恢复电台", PlayerHolder.ui.value.station)
        }
        SystemClock.sleep(200)
      }
    } finally { inst.runOnMainSync { MediaController.releaseFuture(future) } }
  }
  @Test fun taskRemovalObservesPlayback() {
    val base = AndroidSmokeTest.assumeFixture()
    AndroidSmokeTest.assumeFixtureReachable(base)
    val inst = InstrumentationRegistry.getInstrumentation()
    val ctx = inst.targetContext
    val scenario = ActivityScenario.launch(MainActivity::class.java)
    try {
      inst.runOnMainSync { PlayerHolder.play(Station("smoke", "B3任务移除", mutableListOf(base + "/direct.mp3"))) }
      assertTrue("本地流未播放", await(12000) { PlayerHolder.ui.value.st == PState.PLAYING })
      scenario.onActivity { activity -> activity.finishAndRemoveTask() }
      SystemClock.sleep(2000)
      assertEquals("任务移除后播放状态", PState.PLAYING, PlayerHolder.ui.value.st)
    } finally {
      scenario.close()
    }
  }
  private fun await(ms: Long, check: () -> Boolean): Boolean {
    val end = SystemClock.elapsedRealtime() + ms
    while (SystemClock.elapsedRealtime() < end) { if (check()) return true; SystemClock.sleep(100) }
    return check()
  }
}
