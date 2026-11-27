package io.github.vjoy233.vradio.sync

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** 串行化读/确认及状态发布；内部操作可以获取 SyncBarrier，但反向获取禁止。 */
internal class HealthScopeUiCoordinator(
  private val read: suspend () -> HealthScopeWarning.Snapshot,
  private val ack: suspend (HealthScopeWarning.Snapshot) -> HealthScopeWarning.Snapshot,
  private val publish: (Boolean) -> Unit,
  private val publishMessage: (String?) -> Unit = {}
) {
  private val mutex = Mutex()
  private var seen: HealthScopeWarning.Snapshot? = null
  private var dismissed: HealthScopeWarning.Snapshot? = null
  private fun apply(state: HealthScopeWarning.Snapshot) {
    seen = state
    publish((state.token != null || state.legacyBarrier) && state != dismissed)
  }
  // 旧屏障没有持久代号，任何重新读取都重新提醒，不能用布尔值掩盖外部替换。
  suspend fun refresh() = mutex.withLock { dismissed = null; apply(read()) }
  suspend fun acknowledge() = mutex.withLock {
    val old = seen ?: return@withLock
    val state = ack(old)
    // 即使删除失败，也允许本次明确关闭；state 未变化代表未持久保存，下一次 refresh 会重报。
    // 只有与本次看到的同一代完全一致才可暂时隐藏；新 generation 绝不能被旧确认吞掉。
    val unchanged = state == old
    val message = when {
      unchanged && old.token == "?" -> "无法确认提示状态，本次仅关闭；下次启动仍会提醒，可重试。"
      unchanged && old.token != null -> "提示未持久保存，本次仅关闭；下次启动仍会提醒，可重试。"
      else -> null
    }
    dismissed = if (unchanged) state else null
    publishMessage(message)
    apply(state)
  }
  suspend fun resetAndRefresh() = mutex.withLock { dismissed = null; apply(read()) }
}
