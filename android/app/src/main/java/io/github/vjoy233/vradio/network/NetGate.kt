package io.github.vjoy233.vradio.network

/* 大流量操作入口门（AIbot PR#21 P1 回执）：AppVm 三入口（manualHealth/fullSyncNow/checkUpdate）同构门控——
   DENY→拒绝文案、CONFIRM→挂起弹确认、ALLOW→直跑 runner。轻更新（checkUpdate 的检查+下载+应用整链）
   与全量同步同属 Op.SYNC（§9.2「主库同步」列，同一操作类别），无「仅查版本免门」暗道。
   纯 JVM 可测：调用层（NetGateTest）注入 fake light 断言门未过时 runner（light.check/apply 唯一调用路径）不被调。 */

class NetGate(private val policy: NetworkPolicy) {

  /** 挂起后待恢复的动作（netGate 状态载荷）：Op.SYNC 有两个入口（全量同步/轻更新），恢复目标必须可区分 */
  enum class Act { FULL_CHECK, SYNC, LIGHT_UPDATE }

  /** 入口三态：放行直跑 / 拒绝（why 给用户看）/ 需确认（挂起 act，用户确认后 proceedGate 才真跑） */
  sealed interface Next {
    object Run : Next
    data class Deny(val why: String, val cellularPolicy: Boolean = false) : Next
    data class Confirm(val act: Act, val why: String) : Next
  }

  fun enter(op: NetworkPolicy.Op, act: Act, rules: NetworkPolicy.Rules = NetworkPolicy.Rules()): Next {
    val d = policy.allow(op, rules)
    return when {
      d.kind == NetworkPolicy.Kind.DENY -> Next.Deny(d.why, d.cellularPolicy)
      d.confirm -> Next.Confirm(act, d.why)
      else -> Next.Run
    }
  }
}
