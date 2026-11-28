package io.github.vjoy233.vradio.ui

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class HealthOwnershipTest {
  @Test fun cancellingWaitingManualCannotReleaseBackground() {
    var busy = false
    val gate = HealthOwnership { busy = it }
    val background = gate.tryBackground()!!
    assertTrue(gate.requestManual())
    assertNull(gate.tryManual())
    gate.finishManual(null)
    assertTrue(busy)
    assertNull(gate.tryBackground())
    gate.release(background)
    assertFalse(busy)
    assertNotNull(gate.tryBackground())
  }

  @Test fun manualPendingBlocksNewBackgroundUntilOwnerExits() {
    val gate = HealthOwnership()
    val background = gate.tryBackground()!!
    assertTrue(gate.requestManual())
    assertNull(gate.tryBackground())
    assertNull(gate.tryManual())
    gate.release(background)
    assertNull(gate.tryBackground())
    val manual = gate.tryManual()!!
    gate.release(background) // 陈旧 token 无权释放手动任务
    assertNull(gate.tryBackground())
    gate.finishManual(manual)
    assertNotNull(gate.tryBackground())
  }

  @Test fun cancelledManualStillInvalidatesPausedBackgroundCommit() {
    val gate = HealthOwnership()
    val owner = gate.tryBackground()!!
    val paused = CountDownLatch(1)
    val resume = CountDownLatch(1)
    val pool = Executors.newSingleThreadExecutor()
    try {
      val result = pool.submit<Boolean> {
        paused.countDown(); check(resume.await(5, TimeUnit.SECONDS))
        gate.applyBackground(owner) { true } ?: false
      }
      assertTrue(paused.await(5, TimeUnit.SECONDS))
      assertTrue(gate.requestManual())
      gate.finishManual(null)
      resume.countDown()
      assertFalse(result.get(5, TimeUnit.SECONDS))
      assertNull(gate.tryBackground()) // 旧任务尚未释放所有权
      gate.release(owner)
      assertNotNull(gate.tryBackground())
    } finally { resume.countDown(); pool.shutdownNow() }
  }

  @Test fun simultaneousBackgroundClaimsHaveOneWinner() {
    val gate = HealthOwnership()
    val start = CountDownLatch(1)
    val pool = Executors.newFixedThreadPool(2)
    try {
      val jobs = (1..2).map { pool.submit<Any?> { start.await(); gate.tryBackground() } }
      start.countDown()
      val results = jobs.map { it.get(5, TimeUnit.SECONDS) }
      assertEquals(1, results.count { it != null })
    } finally { pool.shutdownNow() }
  }
}
