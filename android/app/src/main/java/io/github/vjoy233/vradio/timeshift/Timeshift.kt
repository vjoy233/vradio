package io.github.vjoy233.vradio.timeshift

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.ExoPlayer
import io.github.vjoy233.vradio.Prefs
import io.github.vjoy233.vradio.player.PlayerHolder
import java.util.concurrent.Executors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/* 时移回听（B7 Spike，plan-expansion-r4 §11）。全部实验代码封闭在 timeshift/ 包内，PlayerHolder
   只留 5 个一行挂点（factory 包装/attach/onNewStream/reset/onLiveAir）+ onAir 文案一行（P2-2），
   删包+挂点即完全回退。
   会话生命周期 = 一条网络连接：切台/刷新/源切换/自愈重连都经 loadVariant → onNewStream 重置。
   回放播完（快照 item STATE_ENDED）→ CATCHING_UP，复用 PlayerHolder 既有 ended 自愈重连当前源，
   起播 onAir → onLiveAir 收口回 CAPTURING——不为 Spike 新增回直播通路。
   分层（AIbot review P1-2/P2-3 测试缝）：TsController=纯 JVM 控制器核心（状态/快照/监听/回退），
   TsHost=宿主环境抽象（真播放器/线程模型注入），Timeshift object=Android 装配壳。 */

/* 宿主环境抽象（最小测试缝，JVM 测试注入 FakeHost 断言回放结束链路顺序——AIbot P1-2）：
   - addListener：挂点②注册序保证（PlayerHolder.ensure 里 Timeshift.attach 先于自身 listener——
     ENDED 事件先到控制器、后到自愈，链路顺序测试锚定此契约）
   - runOffMain：P2-3 快照字节拷贝移出主线程（Android=后台单线程；测试可手动泵送断言异步结构）
   - playSnapshot：起播快照 item（实现须内部回主线程——ExoPlayer 全调用须主线程）
   - stationName：快照标题台名（PlayerHolder.ui） */
internal interface TsHost {
  fun addListener(l: Player.Listener)
  fun runOffMain(r: Runnable)
  fun playSnapshot(title: String)
  fun stationName(): String
}

internal class TsController(host: TsHost) {

  companion object {
    const val REPLAY_URL = "vradiots://replay/snapshot.mp3"   // 回放占位 URI（.mp3 后缀 → progressive 源）
    private const val UI_REFRESH_MS = 1000L                   // bufferedMs 节流（loading 线程高频 feed）
  }

  data class TsUi(val on: Boolean = false, val state: TsState = TsState.OFF,
    val bufferedMs: Long = 0, val reject: Boolean = false)    // reject=P2-1：classify 拒绝明示进 UI

  val ui: StateFlow<TsUi> get() = uiMut
  private val uiMut = MutableStateFlow(TsUi())

  private val lock = Any()
  private val core = TimeshiftCore()
  private var host = host
  private var enabled = false
  private var attached = false
  private var snapshot: ByteArray? = null     // 一次性回放快照（route.open 时取走即清）
  private var pendingSnap = false             // P2-3：后台拷贝在飞（防重入 + 等待期变卦丢弃口径）
  private var lastUiMs = -1L

  /** 装配（Timeshift.attach 唯一入口）：绑真宿主 + 实验开关初值 + 注册监听，仅一次。
      listener 注册序 = 宿主保证先于 PlayerHolder 自身 listener（挂点②注释/TsHost.addListener）。 */
  fun attach(host: TsHost, enabled: Boolean) {
    synchronized(lock) {
      if (attached) return
      attached = true
      this.host = host
      this.enabled = enabled
      pushUi(true)
    }
    this.host.addListener(ctrl)
  }

  /** 实验开关（设置页；SharedPreferences 本地态，非 radio.*）。开启即时生效（read 时动态绑 sink）。 */
  fun setEnabled(b: Boolean) {
    synchronized(lock) {
      enabled = b
      if (!b) { core.hardReset(); snapshot = null }
      pushUi(true)
    }
  }

  /** 每条新连接重置会话（挂点③ loadVariant）；CATCHING_UP 同源重连保状态等起播。 */
  fun onNewStream(url: String) {
    synchronized(lock) {
      if (!enabled) { core.hardReset(); pushUi(true); return }
      val keep = core.state == TsState.CATCHING_UP && url == core.curUrl
      core.start(url, keep)
      snapshot = null
      pushUi(true)
    }
  }

  /** 彻底复位（挂点④ stop）。 */
  fun reset() { synchronized(lock) { core.hardReset(); snapshot = null; pushUi(true) } }

  /** 回放播完重连直播起播（挂点⑤ onAir）：CATCHING_UP → CAPTURING。 */
  fun onLiveAir() {
    synchronized(lock) {
      if (core.state == TsState.CATCHING_UP) { core.apply(TsEvent.LIVE_AIR); pushUi(true) }
    }
  }

  /* —— DataSource 回调（ExoPlayer loading 线程）—— */
  fun onOpen(url: String, metaint: Int) { synchronized(lock) { core.onOpen(url, metaint) } }

  fun feedCapture(url: String, b: ByteArray, off: Int, len: Int) {
    synchronized(lock) {
      if (!enabled || core.state != TsState.CAPTURING) return
      core.feed(url, b, off, len)
      pushUi(false)
    }
  }

  fun takeSnapshot(): ByteArray? = synchronized(lock) { val s = snapshot; snapshot = null; s }

  fun isReplaying(): Boolean = synchronized(lock) {
    core.state == TsState.REPLAYING || core.state == TsState.CATCHING_UP
  }

  /** 回退 15 秒（PlayerBar 实验按钮；仅 CAPTURING 可用，缓冲不足退到最旧存活帧）。
      P2-3（AIbot review）：锁内只做帧定位（纯指针遍历），≤2.4MB 字节快照拷贝移出主线程——
      后台线程拷完才回主线程 setMediaItem/prepare/play；等待期切台/关开关/RESET 则丢弃不起播。
      拷贝期间与 loading 线程（feedCapture）经同一把锁串行（ms 级 arraycopy，仅迟滞一个读周期，
      不触 ExoPlayer 主线程）；低端真机 GC/卡顿测量属实机验收清单 §6.6。 */
  fun rewind15() {
    val target: Mp3Frame
    val title: String
    synchronized(lock) {
      if (!enabled || core.state != TsState.CAPTURING || pendingSnap) return
      val t = core.rewindTarget(TimeshiftCore.REWIND_MS)
      if (t == null) { core.apply(TsEvent.REWIND_FAIL); pushUi(true); return }
      target = t
      pendingSnap = true                     // 在飞防重入：拷贝期间重复点按不并发拷
      title = "↩ 回听 · " + host.stationName()
    }
    host.runOffMain {
      val snap = synchronized(lock) { core.snapshot(target) }
      val go = synchronized(lock) {
        pendingSnap = false
        when {
          snap == null || snap.isEmpty() ->
            { core.apply(TsEvent.REWIND_FAIL); pushUi(true); false }
          core.state != TsState.CAPTURING || !enabled -> false   // 等待期切台/关开关：丢弃（快照不悬挂）
          else -> { snapshot = snap; core.apply(TsEvent.REWIND_OK); pushUi(true); true }
        }
      }
      if (go) host.playSnapshot(title)       // 实现须内部回主线程（TsHost 注释）
    }
  }

  /* 快照 item 播完（直播不应 ENDED → 此信号只可能来自回放）→ CATCHING_UP；
     随后 PlayerHolder 既有 ended 自愈重连当前源（loadVariant→onNewStream keep 语义）——
     顺序契约（先控制器后自愈/原源重连/halt·heldNext 组合）由 TimeshiftChainTest 锚定（AIbot P1-2）。 */
  internal val ctrl = object : Player.Listener {
    override fun onPlaybackStateChanged(playbackState: Int) {
      synchronized(lock) {
        if (playbackState == Player.STATE_ENDED && core.state == TsState.REPLAYING) {
          core.apply(TsEvent.SNAPSHOT_END); pushUi(true)
        }
      }
    }
    override fun onPlayerError(error: PlaybackException) {
      synchronized(lock) {
        if (core.state == TsState.REPLAYING || core.state == TsState.CATCHING_UP) {
          core.apply(TsEvent.ERROR); pushUi(true)
        }
      }
    }
  }

  private fun pushUi(force: Boolean) {
    val ms = core.bufferedMs()
    if (!force && ms / UI_REFRESH_MS == lastUiMs / UI_REFRESH_MS) return
    lastUiMs = ms
    uiMut.value = TsUi(enabled, core.state, ms, core.reject != null)
  }
}

/* attach 前的空宿主（ensure 里 factory→attach 同步序，理论不可达；防误用 NPE）。 */
private object NoopHost : TsHost {
  override fun addListener(l: Player.Listener) {}
  override fun runOffMain(r: Runnable) {}
  override fun playSnapshot(title: String) {}
  override fun stationName(): String = ""
}

/* Android 宿主：真 ExoPlayer + 主线程 Handler + 后台单线程（P2-3 快照拷贝）。 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
private class AndroidHost(private val player: ExoPlayer) : TsHost {
  private val main = Handler(Looper.getMainLooper())
  private val bg = Executors.newSingleThreadExecutor { r ->
    Thread(r, "vradio-timeshift").apply { isDaemon = true }
  }
  override fun addListener(l: Player.Listener) { player.addListener(l) }
  override fun runOffMain(r: Runnable) { bg.execute(r) }
  override fun playSnapshot(title: String) { main.post {  // 后台拷贝完成 → 主线程起播（ExoPlayer 须主线程）
    val item = MediaItem.Builder().setUri(TsController.REPLAY_URL)
      .setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
      .build()
    player.setMediaItem(item)   // 原位换快照 item；curPlay/srcmem/级联上下文不动，ENDED 自愈链自然接管
    player.prepare()
    player.play()
    } }
  override fun stationName(): String = PlayerHolder.ui.value.station?.n ?: ""
}

/* —— Android 装配壳（PlayerHolder/AppVm/UI 的唯一入口面，全部一行转发到 ctl） —— */
object Timeshift {
  internal val ctl = TsController(NoopHost)

  internal val ui: StateFlow<TsController.TsUi> get() = ctl.ui   // 仅 timeshift/ 包内 UI 消费（同模块 internal 口径）

  /* 挂点①（ensure）：包 okhttp 工厂；开关关闭/范围外时 TsDataSource 纯透传 */
  fun factory(base: DataSource.Factory): DataSource.Factory =
    DataSource.Factory { TsDataSource(base.createDataSource()) }

  /* 挂点②（ensure，须先于 PlayerHolder.addListener 注册：ENDED 先到才能判「快照播完」） */
  fun attach(ctx: Context, player: ExoPlayer) =
    ctl.attach(AndroidHost(player), Prefs.get(ctx, Prefs.TIMESHIFT, false))

  fun setEnabled(b: Boolean) = ctl.setEnabled(b)
  fun onNewStream(url: String) = ctl.onNewStream(url)
  fun reset() = ctl.reset()
  fun onLiveAir() = ctl.onLiveAir()
  fun isReplaying(): Boolean = ctl.isReplaying()
  fun rewind15() = ctl.rewind15()
}
