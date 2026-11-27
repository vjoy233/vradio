package io.github.vjoy233.vradio.ui

import org.junit.Assert.*
import org.junit.Test

class DetailRequestTest {
  @Test fun 旧请求不得覆盖新台或清新请求忙碌态() {
    val gate = DetailRequestGate()
    val old = gate.invalidate()
    assertTrue(gate.valid(old, true, "a", "a", listOf("u1"), listOf("u1")))
    gate.invalidate() // 关闭或重开，即使同台也不能复用旧请求
    val latest = gate.invalidate()
    assertFalse(gate.owns(old))
    assertFalse(gate.valid(old, true, "a", "a", listOf("u1"), listOf("u1")))
    assertTrue(gate.owns(latest))
    assertFalse(gate.valid(latest, false, "a", "a", listOf("u1"), listOf("u1")))
    assertFalse(gate.valid(latest, true, "b", "a", listOf("u1"), listOf("u1")))
    assertFalse(gate.valid(latest, true, "a", "a", listOf("u2"), listOf("u1")))
    assertFalse(gate.valid(latest, true, "a", "a", listOf("u2", "u1"), listOf("u1", "u2")))
    assertTrue(gate.valid(latest, true, "a", "a", listOf("u1"), listOf("u1")))
  }
}
