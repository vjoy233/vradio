package io.github.vjoy233.vradio.player

import org.junit.Assert.*
import org.junit.Test

/** 实验模型：仅存在于 test 源集，既非 Media3 adapter，也不连接 PlayerHolder。所有事件须串行。
 *  Begin/Close 是给未来 adapter 的意图，不是实际连接或释放；Close 的资源归属是一整次尝试
 *  （包括尚未完成的 future），adapter 必须以本版本 Media3 API 实现并验证恰好一次清理。 */
private class SelfConnectionModel {
  sealed class Effect {
    data class Begin(val id: Long) : Effect()
    data class Close(val id: Long) : Effect()
  }
  private enum class Phase { CONNECTING, CONNECTED }
  private var serial = 0L
  private var current: Long? = null
  private var phase: Phase? = null

  /** 仅调用方已证实是明确用户播放意图时调用；不推断任何 UI 或自动续播入口。 */
  fun authorized(): List<Effect> {
    if (current != null) return emptyList()
    check(serial != Long.MAX_VALUE)
    val id = ++serial
    current = id; phase = Phase.CONNECTING
    return listOf(Effect.Begin(id))
  }

  fun connected(id: Long): List<Effect> {
    if (id == current && phase == Phase.CONNECTING) phase = Phase.CONNECTED
    // 旧尝试已在失效时关闭；不再关闭一次，以免 release 的回调递归。
    return emptyList()
  }

  fun failed(id: Long): List<Effect> = end(id)
  fun disconnected(id: Long): List<Effect> = end(id)
  fun cancel(): List<Effect> = current?.let(::end) ?: emptyList()

  private fun end(id: Long): List<Effect> {
    if (id != current) return emptyList()
    // 先清除状态，再交付 Close，保证同步重入时旧回调不能作废后继尝试。
    current = null; phase = null
    return listOf(Effect.Close(id))
  }
}

class SelfConnectionModelTest {
  private fun begin(m: SelfConnectionModel): Long {
    val effects = m.authorized()
    assertEquals(1, effects.size)
    return (effects.single() as SelfConnectionModel.Effect.Begin).id
  }
  private fun close(id: Long) = listOf(SelfConnectionModel.Effect.Close(id))

  @Test fun logicalSingleFlightAndConnectedIdempotence() {
    val m = SelfConnectionModel(); val a = begin(m)
    repeat(3) { assertTrue(m.authorized().isEmpty()) }
    assertTrue(m.connected(a).isEmpty())
    assertTrue(m.connected(a).isEmpty())
    assertTrue(m.authorized().isEmpty())
  }

  @Test fun failureAndDisconnectNeverRetryWithoutNewAuthorization() {
    val m = SelfConnectionModel(); val a = begin(m)
    assertEquals(close(a), m.failed(a))
    assertTrue(m.failed(a).isEmpty())
    val b = begin(m); assertNotEquals(a, b)
    m.connected(b)
    assertEquals(close(b), m.disconnected(b))
    assertTrue(m.disconnected(b).isEmpty())
    assertNotEquals(b, begin(m))
  }

  @Test fun disconnectedBeforeCompletionAndStaleEventsCannotDamageNewAttempt() {
    val m = SelfConnectionModel(); val a = begin(m)
    assertEquals(close(a), m.disconnected(a))
    val b = begin(m)
    assertTrue(m.connected(a).isEmpty())
    assertTrue(m.failed(a).isEmpty())
    assertTrue(m.disconnected(a).isEmpty())
    assertTrue(m.authorized().isEmpty())
    m.connected(b)
    assertEquals(close(b), m.disconnected(b))
  }

  @Test fun manuallyDeliveredCancellationAndOldDisconnectAreIdempotent() {
    val m = SelfConnectionModel(); val a = begin(m)
    assertEquals(close(a), m.cancel())
    // 手动模拟旧断连事件；此处没有执行 Close 或真实回调。
    val b = begin(m)
    assertTrue(m.disconnected(a).isEmpty())
    assertTrue(m.connected(a).isEmpty())
    assertTrue(m.authorized().isEmpty())
    assertEquals(close(b), m.cancel())
    assertTrue(m.cancel().isEmpty())
    assertTrue(m.disconnected(b).isEmpty())
  }

  @Test fun manuallyReportedBeginFailureWaitsForAuthorization() {
    val m = SelfConnectionModel(); val a = begin(m)
    // adapter 若在 Begin 执行中同步抛错，必须反馈 failed(a)，不能吞掉在飞状态。
    assertEquals(close(a), m.failed(a))
    assertTrue(m.failed(a).isEmpty())
    assertNotEquals(a, begin(m))
  }
}
