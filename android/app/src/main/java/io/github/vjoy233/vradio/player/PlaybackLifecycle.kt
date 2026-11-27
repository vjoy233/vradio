package io.github.vjoy233.vradio.player

/** PlayerHolder 的真实可变播放身份；与 Android/Exo 副作用分开，仍只允许主线程访问。 */
internal class PlaybackLifecycle<S : Any, P : Any> {
  var token = 0
  var pctx: P? = null
  var station: S? = null
  var connecting: S? = null
  var selectionGeneration = 0L
  var retried = false
  var curSi = -1
  var curPlay = ""
  var lastKbps = 0

  fun selectIfEmpty(s: S, expected: Long): Boolean {
    if (station != null || selectionGeneration != expected) return false
    station = s
    return true
  }

  fun resumeRequiresPlay(): Boolean = curPlay.isEmpty()

  fun exhaustIfNeeded(context: P, contextToken: Int, index: Int, size: Int): Boolean {
    if (pctx !== context || contextToken != token || index < size) return false
    selectionGeneration++
    token++
    pctx = null
    curSi = -1; curPlay = ""; retried = false; lastKbps = 0
    station = null; connecting = null
    return true
  }
}
