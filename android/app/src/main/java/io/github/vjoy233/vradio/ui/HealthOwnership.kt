package io.github.vjoy233.vradio.ui

/** 仅仲裁体检通道；不隔离备份导入或其他存储写入。 */
internal class HealthOwnership(private val busy: (Boolean) -> Unit = {}) {
  private var owner: Any? = null
  private var manualPending = false
  private var backgroundValid = false

  @Synchronized fun requestManual(): Boolean {
    if (manualPending) return false
    manualPending = true
    backgroundValid = false // 一旦让位，取消手动等待也不复活旧结果
    return true
  }
  @Synchronized fun tryBackground(): Any? {
    if (manualPending || owner != null) return null
    backgroundValid = true
    return Any().also { owner = it; busy(true) }
  }
  @Synchronized fun backgroundIsValid(token: Any): Boolean = owner === token && backgroundValid

  /** 线性化点：检查与内存标记应用不可与手动请求交错。调用者必须在 Main。 */
  @Synchronized fun <T> applyBackground(token: Any, apply: () -> T): T? {
    if (owner !== token || !backgroundValid) return null
    return apply()
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
