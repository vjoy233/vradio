package io.github.vjoy233.vradio

import android.app.Notification
import android.app.NotificationManager
import org.junit.Assume.assumeTrue
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runners.model.Statement
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
  // 默认跳过；须人工确认专用隔离模拟器，参数本身不能验证设备身份。
  // Application 会在 rule 之前启动并可能自连；dataGuard 也会停止现有播放。
  private val isolated = TestRule { base, _ -> object : Statement() {
    override fun evaluate() {
      assumeTrue("仅允许专用设备和指定测试类", InstrumentationRegistry.getArguments().getString("b3Isolated") == "true" &&
        InstrumentationRegistry.getArguments().getString("class") == B3PlaybackAcceptanceTest::class.java.name &&
        android.os.Build.VERSION.SDK_INT == 34 && android.os.Build.HARDWARE == "ranchu" && android.os.Build.FINGERPRINT.contains("sdk_gphone"))
      base.evaluate()
    }
  } }
  @get:Rule val guard: RuleChain = RuleChain.outerRule(isolated).around(TestUtil.dataGuard())
  @Test fun notificationAndExplicitControllerStop() {
    val base = AndroidSmokeTest.assumeFixture()
    AndroidSmokeTest.assumeFixtureReachable(base)
    val inst = InstrumentationRegistry.getInstrumentation()
    val ctx = inst.targetContext
    val notifications = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val before = notifications.activeNotifications.associate { n -> n.key to Pair(
      n.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
      n.notification.extras.getParcelable<android.media.session.MediaSession.Token>(Notification.EXTRA_MEDIA_SESSION)) }
    val expectedToken = PlayerHolder.session.platformToken
    inst.runOnMainSync { PlayerHolder.play(Station("smoke", "B3本地流", mutableListOf(base + "/direct.mp3"))) }
    assertTrue("本地流未播放", await(12000) { PlayerHolder.ui.value.st == PState.PLAYING })
    assertTrue("播放时未发现本次新增应用通知", await(10000) {
      notifications.activeNotifications.any { n ->
        val title = n.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val token = n.notification.extras.getParcelable<android.media.session.MediaSession.Token>(Notification.EXTRA_MEDIA_SESSION)
        n.packageName == ctx.packageName && n.notification.category == Notification.CATEGORY_TRANSPORT &&
          title == "B3本地流" && token == expectedToken && before[n.key] != Pair(title, token)
      }
    })
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
  // 熄屏不等于 keyguard；这里只观察交互关闭与后台播放，不声明锁屏验收。
  @Test fun backgroundAndScreenOffPlayback() {
    val base = AndroidSmokeTest.assumeFixture()
    AndroidSmokeTest.assumeFixtureReachable(base)
    val inst = InstrumentationRegistry.getInstrumentation()
    val ctx = inst.targetContext
    val power = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
    val wasInteractive = power.isInteractive
    assumeTrue("须人工确认专用模拟器且初始屏幕亮起", wasInteractive)
    val scenario = ActivityScenario.launch(MainActivity::class.java)
    var screenChanged = false
    try {
      inst.runOnMainSync { PlayerHolder.play(Station("smoke", "B3后台", mutableListOf(base + "/direct.mp3"))) }
      assertTrue("本地流未播放", await(12000) { PlayerHolder.ui.value.st == PState.PLAYING })
      inst.uiAutomation.executeShellCommand("input keyevent KEYCODE_HOME").close()
      SystemClock.sleep(2000)
      inst.runOnMainSync { assertTrue("后台未播放", PlayerHolder.player.isPlaying) }
      assertTrue("熄屏前屏幕状态已改变", power.isInteractive)
      inst.uiAutomation.executeShellCommand("input keyevent KEYCODE_POWER").close()
      screenChanged = await(5000) { !power.isInteractive }
      assertTrue("未熄屏", screenChanged)
      val end = SystemClock.elapsedRealtime() + 15000
      while (SystemClock.elapsedRealtime() < end) {
        assertFalse("观察期间屏幕亮起", power.isInteractive)
        inst.runOnMainSync { assertTrue("熄屏时未播放", PlayerHolder.player.isPlaying) }
        SystemClock.sleep(250)
      }
    } finally {
      try {
        inst.runOnMainSync { PlayerHolder.stop() }
      } finally {
        try {
          if (screenChanged && !power.isInteractive) {
            inst.uiAutomation.executeShellCommand("input keyevent KEYCODE_WAKEUP").close()
            assertTrue("未恢复初始亮屏状态", await(5000) { power.isInteractive })
          }
        } finally { scenario.close() }
      }
    }
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
