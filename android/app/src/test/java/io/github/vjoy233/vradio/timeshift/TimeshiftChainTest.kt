package io.github.vjoy233.vradio.timeshift

import androidx.media3.common.Player
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/* B7 回放结束链路与边界验证（AIbot review P1-2/P2-1/P2-2/P2-3 + 非阻塞建议）：
   - P1-2：REPLAYING→SNAPSHOT_END→loadVariant(原源)→LIVE_AIR 顺序 + halt/heldNext 组合 +
     connecting 未清空停滞显影 + 直播态误触发 ENDED 守卫（经 TsHost 注入伪 Player/事件驱动真 TsController）
   - P2-1：classify 拒绝原因进 TsUi；P2-2：isReplaying 区间（「回听中」文案映射）；P2-3：快照拷贝异步化结构
   - 非阻塞：TsRoute 伪 DataSource 的 open/close/重复回退/切台/暂停边界 + 开关关闭透传回归。
   PlayerHolder.listener 相关路径以 HolderSide 投影锚定（改 PlayerHolder ENDED/retryOrNext/loadVariant/
   onAir 须同步本投影——行号注释标出处）。 */

class TimeshiftChainTest {

  /* —— fixture（与 TimeshiftIndexTest 同款程序化合成）—— */

  private fun hdr(ver: Int, layer: Int, brIdx: Int, srIdx: Int): ByteArray {
    val b1 = (0xE0 or (ver shl 3) or (layer shl 1) or 1).toByte()
    val b2 = ((brIdx shl 4) or (srIdx shl 2)).toByte()
    return byteArrayOf(0xFF.toByte(), b1, b2, 0xC0.toByte())
  }

  private fun frame(brIdx: Int, srIdx: Int): ByteArray {
    val h = hdr(3, 1, brIdx, srIdx)
    return ByteArray(Mp3Header.parse(h, 0)!!.len).also { h.copyInto(it) }
  }

  private val f128 = { frame(9, 0) }   // MPEG1 L3 128kbps 44100 → 417B/帧、26.122ms

  private fun concat(vararg parts: ByteArray): ByteArray {
    val out = ByteArray(parts.sumOf { it.size })
    var p = 0
    for (b in parts) { b.copyInto(out, p); p += b.size }
    return out
  }

  private fun feed(ctl: TsController, url: String, bytes: ByteArray, chunk: Int = 8192) {
    var i = 0
    while (i < bytes.size) { val n = minOf(chunk, bytes.size - i); ctl.feedCapture(url, bytes, i, n); i += n }
  }

  /* —— 伪宿主（P2-3 异步结构断言点：runOffMain 不立即执行，测试手动泵送）—— */

  private class FakeHost(val log: MutableList<String>) : TsHost {
    var listener: Player.Listener? = null; private set
    var posted: Runnable? = null; private set
    var playedTitle: String? = null; private set
    override fun addListener(l: Player.Listener) { listener = l }
    override fun runOffMain(r: Runnable) { posted = r; log += "posted" }
    override fun playSnapshot(title: String) { playedTitle = title; log += "playSnapshot:$title" }
    override fun stationName(): String = "测试台"
    fun runPosted() { val r = posted; posted = null; r?.run() }
  }

  /* PlayerHolder.listener 回放结束相关路径的忠实投影（锚 PlayerHolder.kt 行号；改那边须同步这里）：
     - STATE_ENDED 自愈条件 :402（station!=null && connecting==null && token 匹配）
     - retryOrNext 暂停搁浅 :350（halt && p.i>0 → heldNext）/ 重连当前源一次 :352-357
     - loadVariant 挂点③ :337；onAir 挂点⑤ :361-364 + P2-2 文案 :367 */
  private class HolderSide(private val ctl: TsController, private val log: MutableList<String>) {
    var halt = false; var heldNext = false; var retried = false
    var connecting = true; var hasStation = true; private var i = 1
    var curPlay = ""; private set
    fun play(url: String) { curPlay = url; ctl.onNewStream(url); log += "loadVariant:$url" }   // :337
    fun onEnded() { if (hasStation && !connecting) retryOrNext() }                             // :402
    fun retryOrNext() {
      if (halt && i > 0) { heldNext = true; log += "heldNext"; return }                        // :350
      if (!retried) { retried = true; connecting = true; log += "say:重连当前源…"; loadVariant(curPlay) } // :352-357
    }
    fun loadVariant(u: String) = play(u)
    fun resume() { halt = false; if (heldNext) { heldNext = false; retryOrNext() } }           // :201
    fun onAir() { connecting = false; ctl.onLiveAir(); log += "onAir" }                        // :361-364
    fun status(): String = if (ctl.isReplaying()) "回听中…" else "直播中"                        // :367（P2-2 形态）
  }

  /** 装配到 REPLAYING（含 ≥3s 缓冲、快照已拷出并起播）。inner：复用外层 fixture 助手。 */
  private inner class Rig {
    val log = ArrayList<String>()
    val host = FakeHost(log)
    val ctl = TsController(host)
    val holder = HolderSide(ctl, log)
    val url = "http://x/live/a.mp3"
    init {
      ctl.attach(host, true)
      holder.play(url)
      feed(ctl, url, concat(*(1..250).map { f128() }.toTypedArray()))   // ≈6.5s 缓冲
      holder.onAir()                                                     // 直播起播 → CAPTURING
      ctl.rewind15(); host.runPosted()                                   // 回退：后台拷贝 + 起播快照
    }
  }

  /* —— P1-2：回放结束链路顺序（含 P2-2/P2-3 联动断言）—— */

  @Test fun 回放结束链路顺序与原源重连() {
    val r = Rig()
    assertEquals(TsState.REPLAYING, r.ctl.ui.value.state)
    assertTrue(r.ctl.isReplaying())
    assertEquals("↩ 回听 · 测试台", r.host.playedTitle)                   // 快照标题（通知/MediaSession 携带「回听」）
    assertEquals("回听中…", r.holder.status())                           // P2-2：回放期文案
    // Media3 按注册序派发 STATE_ENDED：Timeshift.ctrl 先（挂点②先于 PlayerHolder.listener，ensure 序）
    r.host.listener!!.onPlaybackStateChanged(Player.STATE_ENDED)
    assertEquals(TsState.CATCHING_UP, r.ctl.ui.value.state)              // 先于自愈：SNAPSHOT_END 已生效
    assertTrue(r.log.none { it == "say:重连当前源…" })                   // 控制器迁移在前、holder 自愈未动
    assertTrue(r.ctl.isReplaying())                                     // CATCHING_UP 仍在回听区间（P2-2）
    // 随后 PlayerHolder 既有 ended 自愈：重连当前源（原源 URL 不变）
    r.holder.onEnded()
    assertEquals(TsState.CATCHING_UP, r.ctl.ui.value.state)             // keep 语义：重连期间不回 CAPTURING
    assertEquals("loadVariant:${r.url}", r.log.last { it.startsWith("loadVariant:") })   // 原源
    // 直流重连起播 → onAir → LIVE_AIR 收口 CAPTURING
    r.holder.onAir()
    assertEquals(TsState.CAPTURING, r.ctl.ui.value.state)
    assertFalse(r.ctl.isReplaying())
    assertEquals("直播中", r.holder.status())                            // P2-2：结束后恢复直播文案
    // 总顺序：装载→直播起播→回退 posted→起播快照→重连提示→原源重连→直播起播
    assertEquals(listOf("loadVariant:${r.url}", "onAir", "posted",
      "playSnapshot:↩ 回听 · 测试台", "say:重连当前源…", "loadVariant:${r.url}", "onAir"), r.log)
  }

  @Test fun 回放结束暂停搁浅halt与heldNext() {
    val r = Rig()
    r.holder.halt = true                                                // 用户在回放中暂停（:193 halt=true）
    r.host.listener!!.onPlaybackStateChanged(Player.STATE_ENDED)
    r.holder.onEnded()
    assertEquals(TsState.CATCHING_UP, r.ctl.ui.value.state)             // 搁浅：不自愈、停在追赶间隙
    assertTrue(r.holder.heldNext)
    assertEquals("heldNext", r.log.last())
    assertTrue(r.log.none { it == "say:重连当前源…" })                   // 没有重连（暂停挡级联 :350）
    // resume 接回搁浅级联（:201）：重连原源 → 起播 → LIVE_AIR 收口
    r.holder.resume()
    assertEquals("loadVariant:${r.url}", r.log.last { it.startsWith("loadVariant:") })
    assertEquals(TsState.CATCHING_UP, r.ctl.ui.value.state)
    r.holder.onAir()
    assertEquals(TsState.CAPTURING, r.ctl.ui.value.state)
  }

  @Test fun connecting未清空快照停在CATCHING_UP() {
    val r = Rig()
    r.host.listener!!.onPlaybackStateChanged(Player.STATE_ENDED)
    r.holder.connecting = true                                          // 异常态：级联在飞/焦点时序使 connecting 未清
    r.holder.onEnded()                                                  // :402 条件不过 → 无自愈
    assertEquals(TsState.CATCHING_UP, r.ctl.ui.value.state)
    assertTrue(r.log.none { it == "say:重连当前源…" })
    // 已知残留风险显影（review P1-2 原文）：STATE_ENDED 后看门狗不武装（非 BUFFERING 不自愈），
    // 无自动重触发面——归实机验收 §6.2 观察项；Spike 不为它新增通路
    r.holder.connecting = false                                         // connecting 归位后由下一次 onAir 收口
    r.holder.onAir()
    assertEquals(TsState.CAPTURING, r.ctl.ui.value.state)
  }

  @Test fun 直播态误触发ENDED不误迁移() {
    val r = Rig()
    r.holder.play(r.url)                                                // 直播 CAPTURING（未回放）
    r.host.listener!!.onPlaybackStateChanged(Player.STATE_ENDED)        // 普通直播错误路径误触发同一监听
    assertEquals(TsState.CAPTURING, r.ctl.ui.value.state)               // SNAPSHOT_END 仅 REPLAYING 生效，不误迁移
    r.holder.onEnded()                                                  // 走既有直播自愈：重连当前源
    assertEquals(TsState.CAPTURING, r.ctl.ui.value.state)
    assertEquals(0L, r.ctl.ui.value.bufferedMs)                         // keep=false：新会话清环（§5 断流重建口径）
  }

  /* —— P2-1：拒绝原因进 UI 状态 —— */

  @Test fun 拒绝原因明示进UI() {
    val r = Rig(); r.holder.play(r.url)                                 // 复位到干净态
    r.ctl.onNewStream("https://x.com/listen")                           // 无扩展名旁路流 → 拒收
    assertEquals(TsState.OFF, r.ctl.ui.value.state)
    assertTrue(r.ctl.ui.value.reject)                                   // UI 侧据此显示「本台不支持回听」
    r.ctl.onNewStream("https://x.com/stream.aac")
    assertTrue(r.ctl.ui.value.reject)
    r.ctl.onNewStream("http://lhttp.qingting.fm/live/1234/64k.mp3")
    assertFalse(r.ctl.ui.value.reject)
    r.ctl.reset()
    assertFalse(r.ctl.ui.value.reject)                                  // 停播清提示
  }

  /* —— P2-3：快照拷贝异步化结构 + 防重入 —— */

  @Test fun 回退拷贝异步化与防重入() {
    val log = ArrayList<String>()
    val host = FakeHost(log)
    val ctl = TsController(host)
    ctl.attach(host, true)
    val url = "http://x/a.mp3"
    ctl.onNewStream(url)
    feed(ctl, url, concat(*(1..250).map { f128() }.toTypedArray()))
    val endBefore = ctl.ui.value.bufferedMs
    assertTrue(endBefore >= 3000)
    ctl.rewind15()
    val posted = host.posted
    assertTrue(posted != null)                                          // 拷贝已转交宿主后台
    assertNull(host.playedTitle)                                        // 未同步起播：拷贝不在调用线程内联完成
    assertEquals(TsState.CAPTURING, ctl.ui.value.state)                 // 拷贝在飞：状态未迁移
    ctl.rewind15()
    assertSame(posted, host.posted)                                     // 在飞防重入：重复点按不并发拷
    host.runPosted()                                                    // 后台线程执行拷贝 → 起播
    assertEquals(TsState.REPLAYING, ctl.ui.value.state)
    assertEquals("↩ 回听 · 测试台", host.playedTitle)
    ctl.rewind15()
    assertNull(host.posted)                                             // 非 CAPTURING：回退入口直接挡
  }

  @Test fun 无帧回退失败入FAILED() {
    val log = ArrayList<String>()
    val host = FakeHost(log)
    val ctl = TsController(host)
    ctl.attach(host, true)
    ctl.onNewStream("http://x/a.mp3")                                   // 未喂任何字节（无已确认帧）
    ctl.rewind15()
    assertNull(host.posted)                                             // 定位失败：不进入后台拷贝
    assertEquals(TsState.FAILED, ctl.ui.value.state)
    ctl.onNewStream("http://x/a.mp3")                                   // FAILED → 下一连接 START 复活
    assertEquals(TsState.CAPTURING, ctl.ui.value.state)
  }

  /* —— 非阻塞建议：TsRoute 伪 DataSource 边界 + 开关关闭透传回归 —— */

  @Test fun 回放open取走一次性快照与读尽() {
    val r = Rig()                                                       // REPLAYING，快照已武装
    val route = TsRoute(r.ctl)
    assertTrue(route.openReplay(TsController.REPLAY_URL))
    assertTrue(route.replayLen > 0)
    val out = ByteArray(4096)
    var first = -1; var total = 0
    while (true) {
      val n = route.replayRead(out, 0, out.size)
      if (n < 0) break
      if (first < 0) first = out[0].toInt() and 0xFF
      total += n
    }
    assertEquals(route.replayLen, total)
    assertEquals(0xFF, first)                                           // 快照首字节 = 帧头同步字
    assertEquals(-1, route.replayRead(out, 0, out.size))                // 读尽 -1（DataSource 惯例）
    route.close()
    assertFalse(route.isReplay)
    assertFalse(route.openReplay(TsController.REPLAY_URL))              // 一次性：无新快照重开即失败（→IOException 自愈）
  }

  @Test fun 直播open上报metaint与旁路读() {
    val log = ArrayList<String>()
    val host = FakeHost(log)
    val ctl = TsController(host)
    ctl.attach(host, true)
    val url = "http://x/a.mp3"
    ctl.onNewStream(url)
    val route = TsRoute(ctl)
    route.openLive(url, 0)
    assertFalse(route.isReplay)
    val bytes = concat(*(1..200).map { f128() }.toTypedArray())
    route.onLiveRead(bytes, 0, bytes.size)
    route.onLiveRead(bytes, 0, 0)                                       // n=0 不喂（read 返回 0 旁路空转）
    assertTrue(ctl.ui.value.bufferedMs > 4000)
    route.close()
    assertEquals("", route.url)                                         // close 复位：形态互斥切换的复位点
  }

  @Test fun 重复回退第二次快照可用() {
    val r = Rig()
    val route = TsRoute(r.ctl)
    assertTrue(route.openReplay(TsController.REPLAY_URL))               // 第一次回放消费快照
    route.close()
    r.host.listener!!.onPlaybackStateChanged(Player.STATE_ENDED)        // 播完 → 自愈 → 回直播 CAPTURING
    r.holder.onEnded(); r.holder.onAir()
    assertEquals(TsState.CAPTURING, r.ctl.ui.value.state)
    feed(r.ctl, r.url, concat(*(1..100).map { f128() }.toTypedArray())) // keep 会话续攒
    r.ctl.rewind15(); r.host.runPosted()                                // 第二次回退
    assertEquals(TsState.REPLAYING, r.ctl.ui.value.state)
    assertTrue(route.openReplay(TsController.REPLAY_URL))               // 新快照可用
  }

  @Test fun 回放期切台快照作废() {
    val r = Rig()
    val route = TsRoute(r.ctl)
    r.holder.play("http://x/b.mp3")                                     // 回放中切台：onNewStream 清快照+RESET
    assertEquals(TsState.CAPTURING, r.ctl.ui.value.state)               // 新台直流 → 新会话直接 CAPTURING
    assertFalse(route.openReplay(TsController.REPLAY_URL))              // 旧快照作废：重开失败走 IOException 自愈
    // 刷新边界同口径：refresh → play() → loadVariant → onNewStream（RESET→OFF→新会话）
    feed(r.ctl, "http://x/b.mp3", concat(*(1..100).map { f128() }.toTypedArray()))
    r.ctl.rewind15(); r.host.runPosted()                                // b 台攒够缓冲再回退 → REPLAYING
    assertEquals(TsState.REPLAYING, r.ctl.ui.value.state)
    r.ctl.onNewStream("http://x/live/a.mp3")                            // 模拟刷新重开当前台
    assertEquals(TsState.CAPTURING, r.ctl.ui.value.state)
  }

  @Test fun 回放期直播feed冻结与暂停边界() {
    val r = Rig()
    val before = r.ctl.ui.value.bufferedMs
    feed(r.ctl, r.url, concat(*(1..50).map { f128() }.toTypedArray()))  // REPLAYING 态旁路到达（暂停同理停拉流）
    assertEquals(before, r.ctl.ui.value.bufferedMs)                     // 不入环：缓冲冻结不破坏
  }

  @Test fun 开关关闭透传回归() {
    val log = ArrayList<String>()
    val host = FakeHost(log)
    val ctl = TsController(host)
    ctl.attach(host, true)
    ctl.setEnabled(false)                                               // 关开关：硬复位 + feedCapture 空转
    val url = "http://x/a.mp3"
    ctl.onNewStream(url)
    assertEquals(TsState.OFF, ctl.ui.value.state)
    assertFalse(ctl.ui.value.on)
    val route = TsRoute(ctl)
    route.openLive(url, 0)
    route.onLiveRead(concat(*(1..100).map { f128() }.toTypedArray()), 0, 100 * 417)
    assertEquals(0L, ctl.ui.value.bufferedMs)                           // 零字节入环：TsDataSource 纯透传
    assertFalse(route.isReplay)
    route.close()
  }
}
