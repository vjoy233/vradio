package io.github.vjoy233.vradio.ui

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class HealthWorkersTest {
  @Test fun manualCancelDrainsInFlightButDoesNotStartQueuedWork() {
    val stop = AtomicBoolean(false)
    val entered = CountDownLatch(5); val release = CountDownLatch(1)
    val started = Collections.synchronizedList(mutableListOf<Int>())
    val progress = Collections.synchronizedList(mutableListOf<Int>())
    val pool = Executors.newSingleThreadExecutor()
    try {
      val result = pool.submit<List<Pair<Int, Int>>> { runBlocking {
        runHealthWorkers((0 until 12).toList(), 5, stop::get, { d, _ -> progress.add(d) }) {
          started.add(it); entered.countDown(); check(release.await(10, TimeUnit.SECONDS)); it
        }
      } }
      assertTrue(entered.await(10, TimeUnit.SECONDS))
      stop.set(true); release.countDown()
      val completed = result.get(10, TimeUnit.SECONDS)
      assertEquals(5, started.size)
      assertEquals(started.toSet(), completed.map { it.first }.toSet())
      assertEquals((1..5).toSet(), progress.toSet())
    } finally { release.countDown(); pool.shutdownNow() }
  }

  @Test fun cancelledWaitingManualStillInvalidatesBackgroundWorkersAndCommit() {
    val gate = HealthOwnership()
    val owner = gate.tryBackground()!!
    val entered = CountDownLatch(2); val release = CountDownLatch(1)
    val started = Collections.synchronizedList(mutableListOf<Int>())
    val pool = Executors.newSingleThreadExecutor()
    try {
      val result = pool.submit<List<Pair<Int, Int>>> { runBlocking {
        runHealthWorkers((0 until 8).toList(), 2, { !gate.backgroundIsValid(owner) }, { _, _ -> }) {
          started.add(it); entered.countDown(); check(release.await(10, TimeUnit.SECONDS)); it
        }
      } }
      assertTrue(entered.await(10, TimeUnit.SECONDS))
      assertTrue(gate.requestManual())
      assertNull(gate.tryManual())
      gate.finishManual(null)
      assertFalse(gate.backgroundIsValid(owner))
      assertNull(gate.tryBackground())
      release.countDown()
      val completed = result.get(10, TimeUnit.SECONDS)
      assertEquals(2, started.size)
      assertEquals(started.toSet(), completed.map { it.first }.toSet())
      var committed = false
      assertNull(gate.applyBackground(owner) { committed = true; true })
      assertFalse(committed)
      gate.release(owner)
      assertNotNull(gate.tryBackground())
    } finally { release.countDown(); pool.shutdownNow() }
  }
}
