package io.github.vjoy233.vradio.network

/* 流量估算（plan-expansion-r4 §9.2）：纯 JVM。kbps×时长 → 字节数，估算口径非精确计费——
   无码率（ICY 缺失，HLS 结构性没有）时按 128kbps 假设并明示「估算」，不冒充精确。 */
object TrafficEstimator {

  /** 公式：kbps（下限 32，防 0/负值算出 0 流量误导）→ 字节/秒 × 秒数。溢出防护：乘前判界，
   *  超界饱和 Long.MAX（真实场景 128kbps 连播百年也远不及界，防护只为极端入参不出负数）。 */
  fun bytesFor(kbps: Int, durationMs: Long): Long {
    if (durationMs <= 0L) return 0L
    val perSec = kbps.coerceAtLeast(32).toLong() * 1000L / 8L
    return if (perSec > 0L && durationMs > Long.MAX_VALUE / perSec) Long.MAX_VALUE
           else perSec * durationMs / 1000L
  }

  /** 估算文案：设置页/播放条展示（mbits 参数 = 无真实码率时按 128kbps 假设并标注「估算」） */
  fun estimateText(kbps: Int, durationMs: Long, minutes: Long): String {
    val assumed = kbps <= 0
    val bytes = bytesFor(if (assumed) 128 else kbps, durationMs)
    return "本次收听 $minutes 分钟 · 约 ${fmt(bytes)}" +
      (if (assumed) "（无码率，按 128kbps 估算）" else "") + "——估算值，非精确计费"
  }

  fun fmt(bytes: Long): String = when {   // Locale.US：小数点恒为「.」，防系统语言出「56,3 MB」
    bytes < 0L -> "0 B"
    bytes < 1024L -> "$bytes B"
    bytes < 1024L * 1024L -> String.format(java.util.Locale.US, "%.0f KB", bytes / 1024.0)
    bytes < 1024L * 1024L * 1024L -> String.format(java.util.Locale.US, "%.1f MB", bytes / 1048576.0)
    else -> String.format(java.util.Locale.US, "%.2f GB", bytes / 1073741824.0)
  }
}
