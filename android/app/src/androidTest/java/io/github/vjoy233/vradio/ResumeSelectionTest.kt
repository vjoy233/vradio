package io.github.vjoy233.vradio

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.player.PlayerHolder
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ResumeSelectionTest {
  @get:Rule val guard = TestUtil.dataGuard()

  @Test fun selectionDoesNotConnectAndStaleBootCannotOverrideUser() {
    val instr = InstrumentationRegistry.getInstrumentation()
    instr.runOnMainSync {
      PlayerHolder.stop()
      val before = Store.get("radio.srcmem2")
      val s = Station("测试", "最近", mutableListOf("http://127.0.0.1:1/test.mp3"))
      val token = PlayerHolder.selectionToken()
      assertTrue(PlayerHolder.selectIfEmpty(s, token))
      assertEquals(PState.IDLE, PlayerHolder.ui.value.st)
      assertEquals(s.key, PlayerHolder.ui.value.station?.key)
      assertEquals(0, PlayerHolder.player.mediaItemCount)
      assertFalse(PlayerHolder.player.playWhenReady)
      assertEquals(before, Store.get("radio.srcmem2"))
      PlayerHolder.stop()
      assertFalse(PlayerHolder.selectIfEmpty(s, token))
      assertNull(PlayerHolder.ui.value.station)
    }
  }
}
