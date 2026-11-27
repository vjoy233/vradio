package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.player.PlaybackLifecycle
import org.junit.Assert.*
import org.junit.Test

class PlaybackLifecycleTest {
  @Test fun exhaustionInvalidatesBootAndClearsActualPlaybackIdentity() {
    val state = PlaybackLifecycle<String, Any>()
    val boot = state.selectionGeneration
    val context = Any()
    state.selectionGeneration++ // play intent
    state.token = 4; state.pctx = context
    state.station = "old"; state.connecting = "old"
    state.curSi = 1; state.curPlay = "https://old"; state.retried = true; state.lastKbps = 128
    val staleBoot = state.selectionGeneration // 新 VM 在耗尽前捕获
    assertFalse(state.exhaustIfNeeded(context, 4, 1, 2))
    assertEquals("https://old", state.curPlay)
    assertTrue(state.exhaustIfNeeded(context, 4, 2, 2))
    assertEquals(staleBoot + 1, state.selectionGeneration)
    assertEquals(5, state.token)
    assertNull(state.pctx); assertNull(state.station); assertNull(state.connecting)
    assertEquals(-1, state.curSi); assertEquals("", state.curPlay)
    assertFalse(state.retried); assertEquals(0, state.lastKbps)
    assertFalse(state.selectIfEmpty("old", staleBoot))
    assertFalse(state.selectIfEmpty("old", boot))
    assertFalse(state.exhaustIfNeeded(context, 4, 2, 2))
    assertTrue(state.selectIfEmpty("new", state.selectionGeneration))
    assertTrue(state.resumeRequiresPlay())
    assertEquals("new", state.station)
  }

  @Test fun staleContextCannotEndCurrentGeneration() {
    val state = PlaybackLifecycle<String, Any>()
    val old = Any(); val current = Any()
    state.token = 8; state.pctx = current; state.station = "current"; state.curPlay = "new-url"
    assertFalse(state.exhaustIfNeeded(old, 7, 1, 1))
    assertFalse(state.exhaustIfNeeded(current, 7, 1, 1))
    assertEquals("current", state.station); assertEquals("new-url", state.curPlay)
    assertFalse(state.resumeRequiresPlay())
  }
}
