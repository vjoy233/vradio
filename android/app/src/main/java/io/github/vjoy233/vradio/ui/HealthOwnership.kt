package io.github.vjoy233.vradio.ui

/** 仅仲裁体检通道；不隔离备份导入或其他存储写入。 */
internal class HealthOwnership(private val busy: (Boolean) -> Unit = {}) {
  private var owner: Any? = null
  private var manualPending = false

  @Synchronized fun requestManual(): Boolean {
    if (manualPending) return false
    manualPending = true
    return true
  }
  @Synchronized fun tryBackground(): Any? {
    if (manualPending || owner != null) return null
    return Any().also { owner = it; busy(true) }
  }
  @Synchronized fun tryManual(): Any? {
    if (!manualPending || owner != null) return null
    return Any().also { owner = it; busy(true) }
  }
  @Synchronized fun release(token: Any?) {
    if (token != null && owner === token) { owner = null; busy(false) }
  }
  @Synchronized fun finishManual(token: Any?) {
    if (token != null && owner === token) { owner = null; busy(false) }
    manualPending = false
  }
}
