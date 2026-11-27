package io.github.vjoy233.vradio.ui

import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.vjoy233.vradio.MainActivity
import io.github.vjoy233.vradio.TestUtil
import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HealthScopeDeviceTest {
  @get:Rule val guard = TestUtil.dataGuard()
  @get:Rule val compose = createEmptyComposeRule()
  @Test fun startupRestartAndAcknowledgement() {
    val dir = InstrumentationRegistry.getInstrumentation().targetContext.filesDir
    val marker = File(dir, "health-scope-warning.pending")
    val original = if (marker.exists()) marker.readBytes() else null
    var activity: ActivityScenario<MainActivity>? = null
    try {
      marker.writeText("device-test-token")
      activity = ActivityScenario.launch(MainActivity::class.java)
      compose.waitUntil(15000) { compose.onAllNodesWithText("电台体检范围可能不完整").fetchSemanticsNodes().isNotEmpty() }
      activity.close(); activity = null
      activity = ActivityScenario.launch(MainActivity::class.java)
      compose.waitUntil(15000) { compose.onAllNodesWithText("电台体检范围可能不完整").fetchSemanticsNodes().isNotEmpty() }
      compose.onNodeWithText("知道了").performClick()
      compose.waitUntil(10000) { !marker.exists() }
      activity.close(); activity = null
      activity = ActivityScenario.launch(MainActivity::class.java)
      compose.waitForIdle()
      assertFalse(marker.exists())
    } finally {
      activity?.close()
      if (original == null) marker.delete() else marker.writeBytes(original)
    }
  }
}
