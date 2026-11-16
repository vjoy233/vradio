package io.github.vjoy233.vradio.ui

import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.PlayerUiState
import org.junit.Assert.assertEquals
import org.junit.Test

/* 播放器组合映射契约测试（docs/ui-android-redesign-plan-2026-11.md §8.1 硬门）：
   playerVisual 是 PlayerUiState 字段（st × noSrc × status）的纯组合函数——
   **不得新增 PState.ERROR / PState.NO_ENABLED_SOURCE**（P1-1 修订硬门：错误与全部源已禁用
   都是既有字段的组合态，不是新状态机分支）。断言 (title, action, tone) 三元组；
   PlayerUiState 全字段有默认值，逐字段覆写构造，不触碰 PlayerHolder/AppVm。 */
class PlayerUiMappingTest {

  /** 只覆写映射读的字段（st/noSrc/status），其余保持默认（station=null 等） */
  private fun mk(st: PState = PState.IDLE, noSrc: Boolean = false, status: String = "") =
    PlayerUiState(st = st, noSrc = noSrc, status = status)

  @Test fun 全部源已禁用优先于其它分支() {
    // noSrc=true 是首分支：status 同给、甚至 CONNECTING 态，都 noSrc 赢（B1 NO_ENABLED_SOURCE 可区分态）
    val v = playerVisual(mk(noSrc = true, status = "连接中… 源1/3"))
    assertEquals("全部源已禁用", v.title)
    assertEquals(PlayerAction.OPEN_DETAIL, v.action)
    assertEquals(PlayerTone.WARN, v.tone)
  }

  @Test fun 全部源已禁用在连接中也优先() {
    val v = playerVisual(mk(st = PState.CONNECTING, noSrc = true, status = "连接中… 源1/3"))
    assertEquals("全部源已禁用", v.title)
    assertEquals(PlayerAction.OPEN_DETAIL, v.action)
    assertEquals(PlayerTone.WARN, v.tone)
  }

  @Test fun 连接中无文案兜底连接中省略号() {
    val v = playerVisual(mk(st = PState.CONNECTING))
    assertEquals("连接中…", v.title)          // status 空给默认文案（蜻蜓建流 5-10s 属正常）
    assertEquals(PlayerAction.PAUSE, v.action)
    assertEquals(PlayerTone.ACCENT, v.tone)
  }

  @Test fun 连接中带源进度透传文案() {
    val v = playerVisual(mk(st = PState.CONNECTING, status = "连接中… 源2/3"))
    assertEquals("连接中… 源2/3", v.title)     // status 非空原样透传（级联自愈进度可见）
    assertEquals(PlayerAction.PAUSE, v.action)
    assertEquals(PlayerTone.ACCENT, v.tone)
  }

  @Test fun 播放中映射() {
    val v = playerVisual(mk(st = PState.PLAYING, status = "直播中"))
    assertEquals("正在播放", v.title)          // PLAYING 不透传 status（引擎态固定文案）
    assertEquals(PlayerAction.PAUSE, v.action)
    assertEquals(PlayerTone.ACCENT, v.tone)
  }

  @Test fun 暂停映射() {
    val v = playerVisual(mk(st = PState.PAUSED))
    assertEquals("已暂停", v.title)
    assertEquals(PlayerAction.PLAY, v.action)
    assertEquals(PlayerTone.NORMAL, v.tone)
  }

  @Test fun 空闲带错误文案给重试() {
    val v = playerVisual(mk(st = PState.IDLE, status = "连接失败：源全部耗尽"))
    assertEquals("连接失败：源全部耗尽", v.title)   // IDLE + status 非空 = 失败态：文案透传 + WARN
    assertEquals(PlayerAction.RETRY, v.action)
    assertEquals(PlayerTone.WARN, v.tone)
  }

  @Test fun 空闲无状态未播放() {
    val v = playerVisual(mk(st = PState.IDLE))
    assertEquals("未播放", v.title)
    assertEquals(PlayerAction.PLAY, v.action)
    assertEquals(PlayerTone.NORMAL, v.tone)
  }
}
