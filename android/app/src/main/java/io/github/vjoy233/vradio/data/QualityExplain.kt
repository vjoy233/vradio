package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.consts.C

/** 无状态机器值；展示文案由调用方映射，不修改 sidecar 或 health。 */
data class QualityExplanation(val level: String, val action: String, val reason: String)

fun qExplain(summary: QualityStore.QualityAggregate?, now: Long): QualityExplanation {
  fun unknown(reason: String) = QualityExplanation("unknown", "retest", reason)
  if (summary == null || summary.okCount < 0 || summary.failCount < 0 ||
    summary.okCount.toLong() + summary.failCount == 0L) return unknown("no_samples")
  if (summary.lastObservedAt <= 0) return unknown("missing_observation")
  if (summary.lastObservedAt > now) return unknown("future_observation")
  if (now - summary.lastObservedAt >= C.QUALITY_WINDOW_MS) return unknown("stale")
  if (summary.okCount.toLong() + summary.failCount < C.QUALITY_MIN_SAMPLES) return unknown("insufficient_samples")
  return when (summary.stability) {
    "good" -> QualityExplanation("good", "none", "stable")
    "fair" -> QualityExplanation("fair", "retest", "variable")
    "poor" -> QualityExplanation("poor", "retest", "unstable")
    else -> unknown("unknown_stability")
  }
}

fun diagnosticAction(code: String?, httpStatus: Int?): QualityExplanation {
  if (code == "OK") return QualityExplanation("good", "none", "ok")
  if (httpStatus == 401 || httpStatus == 403) return QualityExplanation("unknown", "configure", "service_refused")
  val (action, reason) = when (code) {
    "NETWORK" -> "retry" to "network"
    "HTML" -> "check_source" to "html"
    "HTTP" -> "retry" to "http"
    "EMPTY_PLAYLIST" -> "check_source" to "empty_playlist"
    "NO_SEGMENT" -> "retry" to "no_segment"
    "SHORT_BODY" -> "check_source" to "short_body"
    "REDIRECT_REJECTED" -> "check_source" to "redirect_rejected"
    "INVALID_URL" -> "check_source" to "invalid_url"
    else -> "retest" to "unknown_code"
  }
  return QualityExplanation("unknown", action, reason)
}
