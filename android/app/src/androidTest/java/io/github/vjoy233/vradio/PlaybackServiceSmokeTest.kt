package io.github.vjoy233.vradio

import android.os.SystemClock
import com.google.common.util.concurrent.SettableFuture
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.vjoy233.vradio.player.PlaybackService
import io.github.vjoy233.vradio.player.PlayerHolder
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** B.3 黑盒生命周期探针：只观察 Media3 服务现状，不触发播放或后台重连。 */
@RunWith(AndroidJUnit4::class)
class PlaybackServiceSmokeTest {
  @get:Rule val guard = TestUtil.dataGuard()

  @Test
  fun releaseFutureCancelsPendingConnection() {
    val future = SettableFuture.create<MediaController>()
    try {
      try {
        future.get(1, TimeUnit.MILLISECONDS)
        throw AssertionError("未完成的 future 不应返回")
      } catch (_: java.util.concurrent.TimeoutException) {
        // 模拟 get 超时：finally 必须取消尚在飞的 future。
      }
    } finally {
      InstrumentationRegistry.getInstrumentation().runOnMainSync { MediaController.releaseFuture(future) }
    }
    assertTrue("超时后 future 应取消", future.isCancelled)
  }

  @Test
  fun productSelfControllerConnects() {
    val instr = InstrumentationRegistry.getInstrumentation()
    val deadline = SystemClock.elapsedRealtime() + 10_000
    var connected = false
    while (!connected && SystemClock.elapsedRealtime() < deadline) {
      instr.runOnMainSync { connected = PlayerHolder.isSelfControllerConnected() }
      if (!connected) SystemClock.sleep(100)
    }
    assertTrue("产品自连未在 10 秒内连接", connected)
  }

  @Test
  fun serviceSessionConnectsWithoutAutoplay() {
    val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    val token = SessionToken(ctx, android.content.ComponentName(ctx, PlaybackService::class.java))
    val future = MediaController.Builder(ctx, token).buildAsync()
    val instr = InstrumentationRegistry.getInstrumentation()
    try {
      val controller = future.get(5, TimeUnit.SECONDS)
      assertNotNull("MediaSessionService 应返回共享 session", controller)
      instr.runOnMainSync {
        assertFalse("MediaController 应已连接", !controller.isConnected)
        assertFalse("无用户播放意图时不应自动播放", PlayerHolder.ui.value.st == io.github.vjoy233.vradio.model.PState.PLAYING)
      }
    } finally {
      instr.runOnMainSync { MediaController.releaseFuture(future) }
    }
  }
}
