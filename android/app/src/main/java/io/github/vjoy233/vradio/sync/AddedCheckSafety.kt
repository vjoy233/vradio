package io.github.vjoy233.vradio.sync

/** 增量体检批次尚无崩溃安全恢复协议；禁止发布入口改写主库，不能假装已恢复。 */
object AddedCheckSafety {
  const val BLOCK_REASON = "暂不可更新或同步：新增电台体检的崩溃恢复尚未就绪，原数据及待处理任务均未改动"
  fun blockReason(): String? = BLOCK_REASON
}
