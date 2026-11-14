package io.github.vjoy233.vradio.timeshift

/* B7 时移状态机（纯函数）+ 范围判定。状态图（plan-expansion-r4 §11）：
     OFF → CAPTURING → REPLAYING → CATCHING_UP → CAPTURING
                          ├→ FAILED
     切台/刷新/源切换 → OFF（任何态收到 RESET）
   CATCHING_UP = 快照播完后重连直播的追赶间隙（同源重连保状态，起播 LIVE_AIR 收口回 CAPTURING）。 */

enum class TsState { OFF, CAPTURING, REPLAYING, CATCHING_UP, FAILED }
enum class TsEvent { START, REWIND_OK, REWIND_FAIL, SNAPSHOT_END, LIVE_AIR, ERROR, RESET }

object TimeshiftStateMachine {

  const val REJECTED_NOT_SUPPORTED = "REJECTED_NOT_SUPPORTED"   // HLS / 非 .mp3 直流：Spike 范围外

  private val m3u8Re = Regex("\\.m3u8(\\?|#|$)", RegexOption.IGNORE_CASE)
  private val mp3Re = Regex("\\.mp3(\\?|#|$)", RegexOption.IGNORE_CASE)

  /** 单 MP3 直流判定（B7 范围）：非 m3u8 且路径以 .mp3 直达（含蜻蜓换算的 lhttp …/64k.mp3）。
      仅按 URL 后缀——无扩展名 mp3 直流会被拒（UI 明示拒绝原因，AIbot P2-1）；
      产品化前置项：按 Content-Type/字节探测识别无扩展名流（报告 §8.2），Spike 不做。 */
  fun classify(url: String): String? = when {
    m3u8Re.containsMatchIn(url) -> REJECTED_NOT_SUPPORTED    // HLS 结构性不支持
    !mp3Re.containsMatchIn(url) -> REJECTED_NOT_SUPPORTED    // AAC/无扩展名旁路流：范围外
    else -> null
  }

  /** 纯迁移函数；未定义的 (状态,事件) 组合保持原态。 */
  fun next(s: TsState, e: TsEvent): TsState = when (e) {
    TsEvent.RESET -> TsState.OFF                             // 切台/刷新/源切换/停播
    TsEvent.START -> when (s) {
      TsState.OFF, TsState.FAILED, TsState.CAPTURING, TsState.REPLAYING -> TsState.CAPTURING
      TsState.CATCHING_UP -> s                               // 追赶中同源重连：保状态等 LIVE_AIR
    }
    TsEvent.REWIND_OK -> if (s == TsState.CAPTURING) TsState.REPLAYING else s
    TsEvent.REWIND_FAIL -> if (s == TsState.CAPTURING) TsState.FAILED else s
    TsEvent.SNAPSHOT_END -> if (s == TsState.REPLAYING) TsState.CATCHING_UP else s
    TsEvent.LIVE_AIR -> if (s == TsState.CATCHING_UP) TsState.CAPTURING else s
    TsEvent.ERROR -> if (s == TsState.REPLAYING || s == TsState.CATCHING_UP) TsState.FAILED else s
  }
}
