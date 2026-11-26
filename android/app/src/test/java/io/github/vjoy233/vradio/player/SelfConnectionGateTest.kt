package io.github.vjoy233.vradio.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SelfConnectionGateTest {
  @Test fun `授权单飞且已连接幂等`() {
    val g = SelfConnectionGate<Any>()
    val a = g.authorize()
    assertNotNull(a)
    assertNull(g.authorize())
    assertEquals(SelfConnectionGate.State.CONNECTING, g.state)
    assertTrue(g.connected(a!!))
    assertNull(g.authorize())
    assertEquals(SelfConnectionGate.State.CONNECTED, g.state)
  }

  @Test fun `断连不自动重试`() {
    val g = SelfConnectionGate<Any>()
    val a = g.authorize()!!
    assertTrue(g.connected(a))
    assertTrue(g.disconnected(a))
    assertEquals(SelfConnectionGate.State.IDLE, g.state)
    // 断连本身不触发重连；显式的新授权才允许下一代连接
    val b = g.authorize()
    assertNotNull(b)
    assertEquals(SelfConnectionGate.State.CONNECTING, g.state)
  }

  @Test fun `旧代迟到成功被拒绝`() {
    val g = SelfConnectionGate<Any>()
    val a = g.authorize()!!
    g.release()
    assertFalse(g.connected(a))
    assertEquals(SelfConnectionGate.State.IDLE, g.state)
  }

  @Test fun `重复或过期断连无副作用`() {
    val g = SelfConnectionGate<Any>()
    val a = g.authorize()!!
    assertFalse(g.disconnected(SelfConnectionGate.Attempt(a.generation + 1)))
    assertEquals(SelfConnectionGate.State.CONNECTING, g.state)
    assertTrue(g.disconnected(a))
    assertFalse(g.disconnected(a))
  }
}
