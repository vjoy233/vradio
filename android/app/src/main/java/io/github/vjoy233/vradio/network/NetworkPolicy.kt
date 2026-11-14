package io.github.vjoy233.vradio.network

/* 网络策略（plan-expansion-r4 §9.2）：纯 JVM 可测——ConnectivityManager 经 NetProbe 接口注入，
   本文件不 import android.*。默认矩阵按 §9.2 表：
   | 操作            | 移动数据默认      | Wi-Fi 默认 |
   | 播放            | 允许             | 允许        |  ← 播放永远不被静默阻断（离线也不拦，让流层自然失败）
   | 单台探活        | 允许但提示       | 允许        |
   | 全量体检        | 按用户设置（默认需确认）| 允许  |
   | 主库同步        | 按用户设置（默认需确认）| 允许  |
   | 台标补全        | 跳过（Wi-Fi 优先）| 允许        |
   | Widget 状态     | 不主动联网       | 不主动联网  |
   接入点：AppVm 发起全量体检/同步前查策略（CONFIRM → 弹确认对话框，拒绝则不发）。 */

/** 网络形态探测（安卓侧由 ui 层用 ConnectivityManager 实现；null = 查不到 → UNKNOWN 宽松） */
interface NetProbe {
  fun online(): Boolean?      // 当前是否有可用网络（null=未知）
  fun metered(): Boolean?     // 当前网络是否计量（移动数据 true；null=未知）
}

class NetworkPolicy(private val probe: NetProbe) {

  enum class State { WIFI, CELLULAR, OFFLINE, UNKNOWN }

  enum class Op { PLAY, SINGLE_CHECK, FULL_CHECK, SYNC, LOGO_PREFETCH, WIDGET }

  /** 决策三态：允许 / 需确认（移动数据大流量操作的门槛）/ 拒绝 */
  enum class Kind { ALLOW, CONFIRM, DENY }

  /** 移动数据三态策略（设置页「网络与流量」，SharedPreferences 本地态非 radio.*） */
  enum class CellularRule { ALLOW, CONFIRM, DENY }

  /** 用户设置集（默认值 = §9.2 表移动数据列） */
  data class Rules(
    val cellFullCheck: CellularRule = CellularRule.CONFIRM,   // 全量体检（默认：需确认）
    val cellSync: CellularRule = CellularRule.CONFIRM,        // 主库同步（默认：需确认）
    val logoWifiOnly: Boolean = true,                         // 台标补全 Wi-Fi 优先（关=移动数据也补）
    val overrideCellular: Boolean = false,                    // 「移动数据也允许」总开关（覆盖台标等 Wi-Fi 优先项）
  )

  data class Decision(val kind: Kind, val why: String) {
    val ok get() = kind == Kind.ALLOW
    val confirm get() = kind == Kind.CONFIRM
  }

  fun state(): State { // online 判定优先：无网时系统常把计量报 true（AppVm.unmetered 同坑），先 OFFLINE 再分档
    val on = probe.online() ?: return State.UNKNOWN
    if (!on) return State.OFFLINE
    return when (probe.metered() ?: return State.UNKNOWN) {
      true -> State.CELLULAR
      false -> State.WIFI
    }
  }

  /** 简式（契约签名形态）：只有总开关 overrideCellular，其余默认矩阵 */
  fun allow(op: Op, overrideCellular: Boolean): Decision = allow(op, Rules(overrideCellular = overrideCellular))

  fun allow(op: Op, rules: Rules = Rules()): Decision = when (op) {
    Op.WIDGET -> Decision(Kind.DENY, "Widget 不主动联网")   // §9.2 表两列同值：防 Widget 链路夹带网络请求的护栏
    Op.PLAY -> Decision(Kind.ALLOW, when (state()) {        // 播放永远不被策略静默阻断（含离线：流层自然失败重试）
      State.OFFLINE -> "当前离线，播放将自动重试"
      State.CELLULAR -> "移动数据播放中"
      else -> ""
    })
    Op.SINGLE_CHECK -> when (state()) {
      State.OFFLINE -> Decision(Kind.DENY, "当前离线，无法探活")
      State.CELLULAR -> Decision(Kind.ALLOW, "移动数据下单台探活，流量很小")   // 允许但提示
      else -> Decision(Kind.ALLOW, "")
    }
    Op.FULL_CHECK, Op.SYNC -> when (state()) {
      State.OFFLINE -> Decision(Kind.DENY, "当前离线")
      State.CELLULAR -> {
        val rule = if (op == Op.FULL_CHECK) rules.cellFullCheck else rules.cellSync
        when {
          rules.overrideCellular -> Decision(Kind.ALLOW, "已按设置允许移动数据")
          rule == CellularRule.ALLOW -> Decision(Kind.ALLOW, "已按设置允许移动数据")
          rule == CellularRule.DENY -> Decision(Kind.DENY, "已按设置禁止移动数据${opName(op)}（设置 → 网络与流量可改）")
          else -> Decision(Kind.CONFIRM, "移动数据下${opName(op)}流量较大，是否继续？")
        }
      }
      else -> Decision(Kind.ALLOW, "")
    }
    Op.LOGO_PREFETCH -> when (state()) {
      State.OFFLINE -> Decision(Kind.DENY, "当前离线")
      State.CELLULAR -> if (rules.overrideCellular || !rules.logoWifiOnly) Decision(Kind.ALLOW, "移动数据下补台标")
                        else Decision(Kind.DENY, "台标补全仅 Wi-Fi（设置可开移动数据也补）")
      else -> Decision(Kind.ALLOW, "")
    }
  }

  private fun opName(op: Op) = if (op == Op.FULL_CHECK) "全量体检" else "主库同步"
}
