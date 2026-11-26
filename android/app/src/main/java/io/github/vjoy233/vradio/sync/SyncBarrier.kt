package io.github.vjoy233.vradio.sync

import io.github.vjoy233.vradio.data.writeTextAtomic
import java.io.File
import java.io.IOException
import kotlinx.coroutines.sync.Mutex

/** 端内同步写入前持久封锁轻更新；中断后重新执行端内同步可完成并解除屏障。 */
internal object SyncBarrier {
  // 所有实例共用，覆盖网络下载与整个落盘过程，防检查屏障后交错写入。
  val mutex = Mutex()
  val generation = java.util.concurrent.atomic.AtomicLong()
  fun active(dir: File): Boolean = File(dir, "full-sync.pending").exists()
  fun begin(dir: File) {
    generation.incrementAndGet()
    val marker = File(dir, "full-sync.pending")
    if (!marker.isFile) writeTextAtomic(marker, "pending")
    if (!marker.isFile) throw IOException("端内同步屏障写入失败")
  }
  fun logoRetryPending(dir: File): Boolean = File(dir, "full-sync-logo-retry").exists()
  fun prepareLogoRetry(dir: File, logosWritten: Boolean, delete: (File) -> Boolean = { it.delete() }) {
    val retry = File(dir, "full-sync-logo-retry")
    val light = File(dir, "light-update.pending")
    if (logosWritten) {
      if (retry.exists() && (!delete(retry) || retry.exists())) throw IOException("台标待复核标记清理失败，请重试端内同步")
    } else if (light.exists() && !retry.isFile) {
      writeTextAtomic(retry, "pending")
      if (!retry.isFile) throw IOException("台标待复核标记写入失败，请重试端内同步")
    }
  }
  fun finish(dir: File, delete: (File) -> Boolean = { it.delete() }) {
    val light = File(dir, "light-update.pending")
    if (light.exists() && (!delete(light) || light.exists())) throw IOException("旧轻更新标记清理失败，请重试端内同步")
    val barrier = File(dir, "full-sync.pending")
    if (barrier.exists() && (!delete(barrier) || barrier.exists())) throw IOException("端内同步屏障清理失败，请重试端内同步")
  }
}
