package io.github.vjoy233.vradio.ui

import org.junit.Assert.*
import org.junit.Test

class ImportConfirmTest {
  @Test fun outOfOrderResultsAndOldCallbacksCannotApplyAnotherImport() {
    val c = ImportConfirm<String>()
    val a = c.start()
    assertTrue(c.publish(a, "备份A", "确认A", true))
    c.choose(a, true)
    val b = c.start()
    assertTrue(c.publish(b, "配置B", "确认B"))
    assertFalse(c.publish(a, "备份A迟到", "旧文案", true))
    c.cancel(a); c.choose(a, true)
    assertNull(c.consume(a))
    assertEquals("确认B", c.current?.message)
    val accepted = c.consume(b)!!
    assertEquals("配置B", accepted.payload)
    assertFalse(accepted.sidecar)
    assertNull(c.consume(b))
  }

  @Test fun latestStartWinsAndCancelInvalidatesLateResult() {
    val c = ImportConfirm<String>()
    val a = c.start(); val b = c.start()
    assertFalse(c.publish(a, "歌单A", "A"))
    assertTrue(c.publish(b, "备份B", "B", true))
    assertFalse(c.current!!.sidecar)
    c.choose(b, true)
    assertTrue(c.current!!.sidecar)
    c.cancel(b)
    assertFalse(c.publish(b, "备份B", "迟到", true))
    assertNull(c.current)
  }

  @Test fun failedNewReadDoesNotReviveOldConfirmation() {
    val c = ImportConfirm<String>()
    val a = c.start(); c.publish(a, "A", "A")
    c.start() // 新读取失败，不发布结果
    assertNull(c.current)
    assertNull(c.consume(a))
    assertFalse(c.publish(a, "A", "迟到"))
  }
}
