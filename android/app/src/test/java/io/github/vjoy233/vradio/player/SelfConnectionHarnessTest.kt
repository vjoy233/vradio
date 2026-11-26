package io.github.vjoy233.vradio.player

import org.junit.Assert.*
import org.junit.Test

/** 完全独立的 fake 实验：close 只发出取消请求，不假设实际资源即时消失。 */
private class FakeConnector {
  data class Handle(val id: Long, var closeCalls: Int = 0, var physicalAlive: Boolean = true)
  val handles = mutableMapOf<Long, Handle>()
  var throwBegin = false
  var onClose: ((Long) -> Unit)? = null
  fun begin(id: Long) {
    if (throwBegin) throw IllegalStateException("fake begin failed") // 抛出前未分配资源
    handles[id] = Handle(id)
  }
  fun close(id: Long) {
    val h = handles[id] ?: return
    h.closeCalls++
    onClose?.invoke(id) // 模拟 release 同步回调重入
  }
  fun settle(id: Long) { handles.getValue(id).physicalAlive = false }
  fun aliveCount() = handles.values.count { it.physicalAlive }
}

/** 为测试调度 effect 而写的独立简化协调器，不是产品实现或 Media3 适配器。 */
private class Harness(private val connector: FakeConnector) {
  private var serial = 0L
  private var current: Long? = null
  fun authorized(): Long? {
    if (current != null) return null
    val id = ++serial; current = id
    try { connector.begin(id) } catch (_: IllegalStateException) { end(id) }
    return id
  }
  fun cancel() { current?.let(::end) }
  fun disconnected(id: Long) { end(id) }
  fun connected(id: Long) { if (current != id) return }
  private fun end(id: Long) {
    if (current != id) return
    current = null
    connector.close(id)
  }
}

class SelfConnectionHarnessTest {
  @Test fun fakeCloseActuallyReentersAndDoesNotCloseNewGeneration() {
    val c = FakeConnector(); val h = Harness(c)
    val a = h.authorized()!!
    var b: Long? = null
    c.onClose = { old -> b = h.authorized(); h.disconnected(old) }
    h.cancel()
    assertNotNull(b)
    assertEquals(1, c.handles.getValue(a).closeCalls)
    assertEquals(0, c.handles.getValue(b!!).closeCalls)
    assertNull(h.authorized())
  }

  @Test fun fakeBeginThrowsBeforeAllocationAndNextAuthorizationCanRetry() {
    val c = FakeConnector(); val h = Harness(c)
    c.throwBegin = true
    val a = h.authorized()!!
    assertTrue(c.handles.isEmpty())
    c.throwBegin = false
    val b = h.authorized()!!
    assertNotEquals(a, b)
    assertEquals(1, c.aliveCount())
  }

  @Test fun cancellationAndLateCompletionExposePhysicalOverlapGap() {
    val c = FakeConnector(); val h = Harness(c)
    val a = h.authorized()!!
    h.cancel()
    val b = h.authorized()!!
    assertEquals(1, c.handles.getValue(a).closeCalls)
    assertEquals(2, c.aliveCount()) // 请求取消不保证物理关闭，逻辑单飞不能证明物理单飞
    h.connected(a); h.disconnected(a)
    assertEquals(0, c.handles.getValue(b).closeCalls)
    assertNull(h.authorized())
    c.settle(a)
    assertEquals(1, c.aliveCount())
  }
}
