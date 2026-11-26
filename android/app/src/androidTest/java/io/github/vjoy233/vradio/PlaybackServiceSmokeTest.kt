package io.github.vjoy233.vradio

import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.vjoy233.vradio.player.PlaybackService
import io.github.vjoy233.vradio.player.PlayerHolder
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** B.3 黑盒生命周期探针：只观察 Media3 服务现状，不触发播放或后台重连。 */
@RunWith(AndroidJUnit4::class)
class PlaybackServiceSmokeTest {
  @get:Rule val guard = TestUtil.dataGuard()

  @Test
  fun `service session可连接且默认不自动播放`() {
    val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    val token = SessionToken(ctx, android.content.ComponentName(ctx, PlaybackService::class.java))
    val future = MediaController.Builder(ctx, token).buildAsync()
    val controller = future.get(5, TimeUnit.SECONDS)
    try {
      assertNotNull("MediaSessionService 应返回共享 session", controller)
      assertFalse("无用户播放意图时不应自动播放", PlayerHolder.ui.value.st == io.github.vjoy233.vradio.model.PState.PLAYING)
    } finally {
      controller.release()
    }
  }
}
