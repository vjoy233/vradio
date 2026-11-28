package io.github.vjoy233.vradio.ui

/** 仅主线程调用：解析世代、显示文案和实际载荷始终绑定。 */
internal class ImportConfirm<T> {
  data class Request<T>(val id: Long, val payload: T, val message: String, val hasSidecar: Boolean, val sidecar: Boolean = false)
  private var generation = 0L
  var current: Request<T>? = null
    private set

  fun start(): Long { current = null; return ++generation }
  fun publish(id: Long, payload: T, message: String, hasSidecar: Boolean = false): Boolean {
    if (id != generation) return false
    current = Request(id, payload, message, hasSidecar)
    return true
  }
  fun fail(id: Long, notify: () -> Unit): Boolean {
    if (id != generation) return false
    current = null; generation++
    notify()
    return true
  }
  fun choose(id: Long, checked: Boolean) {
    val r = current ?: return
    if (r.id == id && r.hasSidecar) current = r.copy(sidecar = checked)
  }
  fun cancel(id: Long) {
    if (current?.id != id) return
    current = null; generation++
  }
  fun consume(id: Long): Request<T>? {
    val r = current ?: return null
    if (r.id != id) return null
    current = null; generation++
    return r
  }
}
