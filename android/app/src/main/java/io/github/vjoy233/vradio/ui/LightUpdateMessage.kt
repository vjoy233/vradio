package io.github.vjoy233.vradio.ui

import io.github.vjoy233.vradio.sync.LightUpdate

/** 主库已写入不代表其他资产提交成功；逐项报告，避免把部分成功描述成回滚。 */
fun lightUpdateMessage(r: LightUpdate.Result, metaBound: Boolean): String {
  val logoState = when (r.logosFileState) {
    LightUpdate.FileState.UNCHANGED -> "旧文件保留"
    LightUpdate.FileState.ABSENT -> "本地无文件"
    LightUpdate.FileState.CHANGED_OR_UNKNOWN -> "本地文件状态变化或无法确认"
  }
  val logos = when (r.logosStatus) {
    LightUpdate.LogosStatus.WRITTEN -> "台标已写入"
    LightUpdate.LogosStatus.DOWNLOAD_FAILED -> "台标下载失败，$logoState"
    LightUpdate.LogosStatus.WRITE_FAILED -> "台标写入失败，$logoState"
  }
  val meta = when (r.metaStatus) {
    LightUpdate.MetaStatus.WRITTEN -> "元数据已写入"
    else -> {
      val why = when (r.metaStatus) {
        LightUpdate.MetaStatus.DOWNLOAD_FAILED -> "下载失败或未提供"
        LightUpdate.MetaStatus.INVALID -> "校验失败"
        LightUpdate.MetaStatus.WRITE_FAILED -> "写入失败"
        else -> ""
      }
      val cleanup = when (r.metaCleanup) {
        LightUpdate.CleanupStatus.DELETED -> "旧文件已删除"
        LightUpdate.CleanupStatus.ABSENT -> "无旧文件"
        LightUpdate.CleanupStatus.FAILED -> "旧文件删除失败，是否绑定由见证校验决定"
        LightUpdate.CleanupStatus.NOT_NEEDED -> "未清理"
      }
      "元数据${why}，${cleanup}"
    }
  }
  val stamp = if (r.stampWritten) "更新标记已写入" else {
    val state = when (r.stampFileState) {
      LightUpdate.FileState.UNCHANGED -> "旧标记保留"
      LightUpdate.FileState.ABSENT -> "本地无标记"
      LightUpdate.FileState.CHANGED_OR_UNKNOWN -> "标记状态变化或无法确认"
    }
    "更新标记写入失败，$state，主库不会回滚"
  }
  val binding = if (metaBound) "元数据同批见证通过" else "元数据未通过同批见证，最近新增不可用"
  val retry = if (r.retryPending) "；下次检查将重试未完成的更新" else ""
  return "主库已写入（${r.commitIso.take(10)}）· 台数 +${r.added}/-${r.removed}；$logos；$meta；$stamp；$binding$retry"
}

/** 仅存在同步屏障时提示可能的内存/磁盘差异和恢复路径。 */
fun syncFailureMessage(why: String, barrier: Boolean): String =
  "同步未完成：$why" + if (barrier) "；数据可能已部分写入，请重启应用以载入磁盘数据，再重新执行端内同步" else ""

fun logoRetryNotice(pending: Boolean): String =
  if (pending) "台标可能仍需更新；可重新执行端内同步修复台标" else ""

fun metadataUnavailable(parsed: Boolean, bound: Boolean): Boolean = !parsed || !bound
