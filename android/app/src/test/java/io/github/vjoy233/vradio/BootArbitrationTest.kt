package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.ui.BootArbitration
import org.junit.Assert.assertEquals
import org.junit.Test

class BootArbitrationTest {
  @Test fun shortcutBeatsPresetAndResume() {
    assertEquals(BootArbitration.Action.SHORTCUT, BootArbitration.decide("b", true))
  }
  @Test fun presetBeatsResume() {
    assertEquals(BootArbitration.Action.PRESET, BootArbitration.decide(null, true))
  }
  @Test fun noExplicitIntentKeepsResumePath() {
    assertEquals(BootArbitration.Action.RESUME, BootArbitration.decide(null, false))
  }
}
