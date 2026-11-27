package io.github.vjoy233.vradio.sync

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.withLock
import org.junit.Assert.*
import org.junit.Test

class HealthScopeUiCoordinatorTest {
  @Test fun boundedAndUnreadableMarkersAreConservative() {
    val dir = java.nio.file.Files.createTempDirectory("scope-test").toFile()
    try {
      val f = java.io.File(dir, "marker")
      assertNull(HealthScopeWarning.readMarker(f))
      f.writeText("a".repeat(128)); assertEquals("a".repeat(128), HealthScopeWarning.readMarker(f))
      f.writeText("a".repeat(129)); assertEquals("?", HealthScopeWarning.readMarker(f))
      assertEquals("?", HealthScopeWarning.readMarker(f) { throw java.io.IOException("injected") })
      assertTrue(HealthScopeWarning.barrierPresent(f) { throw java.io.IOException("injected") })
      assertFalse(HealthScopeWarning.barrierPresent(java.io.File(dir, "missing")))
    } finally { dir.deleteRecursively() }
  }
  @Test fun acknowledgementAndRefreshAreSerialized() = runBlocking {
    var disk = HealthScopeWarning.Snapshot("a", false)
    var shown = false
    val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
    val ui = HealthScopeUiCoordinator({ disk }, { entered.complete(Unit); release.await(); disk = HealthScopeWarning.Snapshot(null, false); disk }, { shown = it })
    ui.refresh(); assertTrue(shown)
    val ack = async { ui.acknowledge() }; entered.await()
    val refresh = async { ui.refresh() }
    release.complete(Unit); ack.await(); refresh.await()
    assertFalse(shown)
  }
  @Test fun actualNewMarkCannotBeHiddenByOldUnknownAcknowledgement() = runBlocking {
    val dir = java.nio.file.Files.createTempDirectory("scope-race").toFile()
    try {
      val marker = java.io.File(dir, "health-scope-warning.pending")
      marker.writeText("")
      val old = HealthScopeWarning.snapshot(dir); assertEquals("?", old.token)
      SyncBarrier.mutex.withLock { HealthScopeWarning.markLocked(dir) }
      marker.writeText("") // 模拟新代读取异常：值仍为未知
      val now = HealthScopeWarning.acknowledge(dir, old)
      assertEquals("?", now.token); assertNotEquals(old.markerGeneration, now.markerGeneration)
      var shown = false
      val ui = HealthScopeUiCoordinator({ old }, { now }, { shown = it })
      ui.refresh(); ui.acknowledge(); assertTrue(shown)
    } finally { dir.deleteRecursively() }
  }
  @Test fun deleteFailureIsExplicitAndOnlyDismissesThisDisplay() = runBlocking {
    val dir = java.nio.file.Files.createTempDirectory("scope-delete-failure").toFile()
    try {
      val marker = java.io.File(dir, "health-scope-warning.pending")
      marker.writeText("token-a")
      val old = HealthScopeWarning.snapshot(dir)
      val state = HealthScopeWarning.acknowledge(dir, old) { false }
      assertEquals(old.token, state.token)
      assertTrue(marker.exists())
      var shown = false; val messages = mutableListOf<String>()
      val ui = HealthScopeUiCoordinator({ HealthScopeWarning.snapshot(dir) }, { state }, { shown = it }, { it?.let(messages::add) })
      ui.refresh(); assertTrue(shown); ui.acknowledge(); assertFalse(shown)
      assertTrue(messages.single().contains("未持久保存"))
      ui.refresh(); assertTrue(shown)
      val thrown = HealthScopeWarning.acknowledge(dir, old) { throw SecurityException("denied") }
      assertEquals(old.token, thrown.token)
      assertTrue(marker.exists())
    } finally { dir.deleteRecursively() }
  }

  @Test fun unknownMarkerDismissesOnlyUntilNextRefresh() = runBlocking {
    val disk = HealthScopeWarning.Snapshot("?", false)
    var shown = false; val messages = mutableListOf<String>()
    val ui = HealthScopeUiCoordinator({ disk }, { disk }, { shown = it }, { it?.let(messages::add) })
    ui.refresh(); assertTrue(shown); ui.acknowledge(); assertFalse(shown)
    assertTrue(messages.single().contains("无法确认提示状态"))
    ui.refresh(); assertTrue(shown)
  }
  @Test fun newLegacyBarrierGenerationIsNotDismissed() = runBlocking {
    var disk = HealthScopeWarning.Snapshot(null, true, 1)
    var shown = false
    val ui = HealthScopeUiCoordinator({ disk }, { disk }, { shown = it })
    ui.refresh(); assertTrue(shown); ui.acknowledge(); assertFalse(shown)
    disk = HealthScopeWarning.Snapshot(null, true, 2)
    ui.refresh(); assertTrue(shown)
  }
}
