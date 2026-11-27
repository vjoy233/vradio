package io.github.vjoy233.vradio.sync

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** 串行化读/确认及状态发布；内部操作可以获取 SyncBarrier，但反向获取禁止。 */
internal class HealthScopeUiCoordinator(
  private val read: suspend () -> HealthScopeWarning.Snapshot,
  private val ack: suspend (HealthScopeWarning.Snapshot) -> HealthScopeWarning.Snapshot,
  private val publish: (Boolean) -> Unit
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
    dismissed = if ((state.token == "?" || (state.token == null && state.legacyBarrier)) && state == old) state else null
    apply(state)
  }
  suspend fun resetAndRefresh() = mutex.withLock { dismissed = null; apply(read()) }
}
