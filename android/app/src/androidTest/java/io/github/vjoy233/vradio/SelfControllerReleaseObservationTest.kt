package io.github.vjoy233.vradio

import android.os.SystemClock
import androidx.media3.session.MediaController
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.vjoy233.vradio.player.PlayerHolder
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** 隔离设备专用：主动释放真正的产品自连，不等同服务故障，不证明服务重建。 */
@RunWith(AndroidJUnit4::class)
class SelfControllerReleaseObservationTest {
  @get:Rule val guard = TestUtil.dataGuard()

  @Test fun productControllerReleaseDoesNotRebuildWithoutAuthorization() {
    val instr = InstrumentationRegistry.getInstrumentation()
    assumeTrue("仅允许显式启用的隔离设备运行破坏性自连探针",
      InstrumentationRegistry.getArguments().getString("observeSelfRelease") == "true")
    val field = PlayerHolder::class.java.getDeclaredField("selfCtl").apply { isAccessible = true }
    val deadline = SystemClock.elapsedRealtime() + 10000
    var ctl: MediaController? = null
    while (ctl == null && SystemClock.elapsedRealtime() < deadline) {
      instr.runOnMainSync { ctl = (field.get(PlayerHolder) as? MediaController)?.takeIf { it.isConnected } }
      if (ctl == null) SystemClock.sleep(100)
    }
    assertNotNull("前置条件：产品自连必须已连接", ctl)
    val original = ctl!!
    instr.runOnMainSync {
      assertTrue(original.isConnected)
      original.release()
      assertFalse("主动释放后原产品自连应断开", original.isConnected)
    }
    val end = SystemClock.elapsedRealtime() + 5000
    while (SystemClock.elapsedRealtime() < end) {
      instr.runOnMainSync {
        assertSame("无新授权时不应替换产品自连", original, field.get(PlayerHolder))
        assertFalse("释放后的产品自连不应重新连接", original.isConnected)
      }
      SystemClock.sleep(100)
    }
  }
}
