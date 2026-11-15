package io.github.vjoy233.vradio

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.vjoy233.vradio.MainActivity
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Android 关键路径 Smoke 骨架。
 *
 * 本批只接入启动与共享资产两条确定性断言；固定流播放、音频焦点、进程回收、Widget、
 * 备份导入会在模拟器 API 稳定后逐项接入。测试输入统一走本地 Node fixture，禁止依赖公网。
 */
@RunWith(AndroidJUnit4::class)
class AndroidSmokeTest {
  @Test
  fun launchesMainActivity() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.onActivity { activity -> assertTrue(activity.isFinishing.not()) }
    }
  }

  @Test
  fun sharedRadioAssetsArePackaged() {
    val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    ctx.assets.open("radio.txt").use { input -> assertTrue(input.read() >= 0) }
    ctx.assets.open("logos.txt").use { input -> assertTrue(input.read() >= 0) }
  }
}
