package io.github.vjoy233.vradio.sync

import io.github.vjoy233.vradio.data.writeTextAtomic
import java.io.File
import java.util.UUID
import kotlinx.coroutines.sync.withLock

/** 仅提示体检范围可能不完整，不代表恢复或完成；所有读写由 SyncBarrier 串行。 */
internal object HealthScopeWarning {
  data class Snapshot(val token: String?, val legacyBarrier: Boolean, val barrierGeneration: Long = 0, val markerGeneration: Long = 0)
  private var markerGeneration = 0L
  private fun marker(dir: File) = File(dir, "health-scope-warning.pending")
  internal fun readMarker(f: File, open: (File) -> java.io.InputStream = { java.nio.file.Files.newInputStream(it.toPath()) }): String? = try {
    open(f).use { input ->
      val bytes = ByteArray(129); var used = 0
      while (used < bytes.size) { val n = input.read(bytes, used, bytes.size - used); if (n < 0) break; if (n == 0) break; used += n }
      if (used > 128) "?" else String(bytes, 0, used, Charsets.UTF_8).takeIf { it.isNotBlank() } ?: "?"
    }
  } catch (_: java.nio.file.NoSuchFileException) { null } catch (_: Exception) { "?" }
  internal fun barrierPresent(f: File, inspect: (File) -> Unit = { java.nio.file.Files.readAttributes(it.toPath(), java.nio.file.attribute.BasicFileAttributes::class.java) }): Boolean = try {
    inspect(f); true
  } catch (_: java.nio.file.NoSuchFileException) { false } catch (_: Exception) { true }
  private fun snapshotLocked(dir: File): Snapshot {
    val token = readMarker(marker(dir))
    val active = barrierPresent(File(dir, "full-sync.pending"))
    return Snapshot(token, active, if (active) SyncBarrier.generation.get() else 0, markerGeneration)
  }
  fun markLocked(dir: File) { markerGeneration++; writeTextAtomic(marker(dir), UUID.randomUUID().toString()) }
  suspend fun snapshot(dir: File): Snapshot = SyncBarrier.mutex.withLock { snapshotLocked(dir) }
  /** 只清用户实际看到的同一代提示；不得清理同步屏障或后来产生的提示。 */
  suspend fun acknowledge(
    dir: File,
    seen: Snapshot,
    delete: (File) -> Boolean = { it.delete() }
  ): Snapshot = SyncBarrier.mutex.withLock {
    val now = snapshotLocked(dir)
    if (seen.token != null && seen.token != "?" && seen.token == now.token && seen.markerGeneration == now.markerGeneration) {
      // 删除失败不改变事实：返回的 snapshot 仍带 token，UI 只能本次明确关闭，后续 refresh 必须重报。
      runCatching { delete(marker(dir)) } // SecurityException/IO 异常均按未持久保存处理
    }
    snapshotLocked(dir)
  }
}
