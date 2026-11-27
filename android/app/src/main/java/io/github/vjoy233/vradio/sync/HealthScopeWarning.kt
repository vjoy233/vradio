package io.github.vjoy233.vradio.sync

import io.github.vjoy233.vradio.data.writeTextAtomic
import java.io.File
import java.util.UUID
import kotlinx.coroutines.sync.withLock

/** 仅提示体检范围可能不完整，不代表恢复或完成；所有读写由 SyncBarrier 串行。 */
internal object HealthScopeWarning {
  data class Snapshot(val token: String?, val legacyBarrier: Boolean)
  private fun marker(dir: File) = File(dir, "health-scope-warning.pending")
  private fun snapshotLocked(dir: File): Snapshot {
    val f = marker(dir)
    // 损坏/不可读取的提示仍须保守显示，且不可通过空 token 删除。
    val token = if (f.exists()) runCatching { f.readText().takeIf { it.isNotBlank() } ?: "?" }.getOrDefault("?") else null
    return Snapshot(token, SyncBarrier.active(dir))
  }
  fun markLocked(dir: File) { writeTextAtomic(marker(dir), UUID.randomUUID().toString()) }
  suspend fun snapshot(dir: File): Snapshot = SyncBarrier.mutex.withLock { snapshotLocked(dir) }
  /** 只清用户实际看到的同一代提示；不得清理同步屏障或后来产生的提示。 */
  suspend fun acknowledge(dir: File, seen: Snapshot): Snapshot = SyncBarrier.mutex.withLock {
    val now = snapshotLocked(dir)
    if (seen.token != null && seen.token != "?" && seen.token == now.token) marker(dir).delete()
    snapshotLocked(dir)
  }
}
