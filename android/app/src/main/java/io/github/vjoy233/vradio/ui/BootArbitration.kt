package io.github.vjoy233.vradio.ui

/** 冷启动入口优先级纯决策；resumeLastIfWanted 保留在 AppVm 内作为既有真实逻辑。 */
object BootArbitration {
  enum class Action { SHORTCUT, PRESET, RESUME }

  fun decide(shortcut: String?, preset: Boolean): Action = when {
    shortcut != null -> Action.SHORTCUT
    preset -> Action.PRESET
    else -> Action.RESUME
  }
}
