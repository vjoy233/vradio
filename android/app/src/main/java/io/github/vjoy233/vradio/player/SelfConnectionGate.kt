package io.github.vjoy233.vradio.player

/**
 * 自连控制器的保守协调器：只在明确授权的入口申请一次连接。
 * 断连/失败不会自行重试，也不触碰播放器、台或播放意图。
 *
 * 该类暂不接入 Media3 adapter；先冻结并测试生命周期语义，避免把
 * onDisconnected 误当成用户意图而后台盲重连。
 */
class SelfConnectionGate<C> {
  enum class State { IDLE, CONNECTING, CONNECTED }
  data class Attempt(val generation: Long)

  var state: State = State.IDLE
    private set
  private var generation = 0L
  private var connectedGeneration: Long? = null

  /** 明确用户/系统授权入口调用；在途或已连接时幂等返回 null。 */
  fun authorize(): Attempt? {
    if (state != State.IDLE) return null
    generation += 1
    state = State.CONNECTING
    return Attempt(generation)
  }

  /** 仅接受当前一代的成功；迟到结果由调用方释放。 */
  fun connected(attempt: Attempt): Boolean {
    if (state != State.CONNECTING || attempt.generation != generation) return false
    state = State.CONNECTED
    connectedGeneration = attempt.generation
    return true
  }

  /** 断连只收敛为空闲，不触发下一次连接。 */
  fun disconnected(attempt: Attempt): Boolean {
    if (attempt.generation != connectedGeneration &&
      !(state == State.CONNECTING && attempt.generation == generation)) return false
    state = State.IDLE
    connectedGeneration = null
    return true
  }

  /** 显式释放使所有旧回调失效。 */
  fun release() {
    generation += 1
    state = State.IDLE
    connectedGeneration = null
  }
}
