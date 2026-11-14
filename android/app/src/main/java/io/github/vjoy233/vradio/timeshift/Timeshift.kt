package io.github.vjoy233.vradio.timeshift

import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.ExoPlayer
import io.github.vjoy233.vradio.Prefs
import io.github.vjoy233.vradio.player.PlayerHolder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/* 时移回听控制器（B7 Spike，plan-expansion-r4 §11）。全部实验代码封闭在 timeshift/ 包内，
   PlayerHolder 只留 5 个一行挂点（factory 包装/attach/onNewStream/reset/onLiveAir），删包+挂点即完全回退。
   会话生命周期 = 一条网络连接：切台/刷新/源切换/自愈重连都经 loadVariant → onNewStream 重置。
   回放播完（快照 item STATE_ENDED）→ CATCHING_UP，复用 PlayerHolder 既有 ended 自愈重连当前源，
   起播 onAir → onLiveAir 收口回 CAPTURING——不为 Spike 新增回直播通路。 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
object Timeshift {

  const val REPLAY_URL = "vradiots://replay/snapshot.mp3"   // 回放占位 URI（.mp3 后缀 → progressive 源）
  private const val UI_REFRESH_MS = 1000L                   // bufferedMs 节流（loading 线程高频 feed）
  private const val SHOW_MIN_MS = 3000L                     // 按钮≥3s 缓冲才亮（免死按钮）

  data class TsUi(val on: Boolean = false, val state: TsState = TsState.OFF, val bufferedMs: Long = 0)
  val ui: StateFlow<TsUi> get() = uiMut
  private val uiMut = MutableStateFlow(TsUi())

  private val lock = Any()
  private val core = TimeshiftCore()
  private var enabled = false
  private var exo: ExoPlayer? = null
  private var snapshot: ByteArray? = null     // 一次性回放快照（open 时取走即清）
  private var lastUiMs = -1L

  /* —— 挂点①（ensure）：包 okhttp 工厂；开关关闭/范围外时 TsDataSource 纯透传 —— */
  fun factory(base: DataSource.Factory): DataSource.Factory =
    DataSource.Factory { TsDataSource(base.createDataSource()) }

  /* —— 挂点②（ensure，须先于 PlayerHolder.addListener 注册：ENDED 先到才能判「快照播完」）—— */
  fun attach(ctx: Context, player: ExoPlayer) {
    exo = player
    enabled = Prefs.get(ctx, Prefs.TIMESHIFT, false)
    uiMut.value = TsUi(on = enabled)
    player.addListener(ctrl)
  }

  /** 实验开关（设置页；SharedPreferences 本地态，非 radio.*）。开启即时生效（read 时动态绑 sink）。 */
  fun setEnabled(b: Boolean) {
    synchronized(lock) {
      enabled = b
      if (!b) { core.hardReset(); snapshot = null }
      pushUi(true)
    }
  }

  /* —— 挂点③（loadVariant）：每条新连接重置会话；CATCHING_UP 同源重连保状态等起播 —— */
  fun onNewStream(url: String) {
    synchronized(lock) {
      if (!enabled) { core.hardReset(); pushUi(true); return }
      val keep = core.state == TsState.CATCHING_UP && url == core.curUrl
      core.start(url, keep)
      snapshot = null
      pushUi(true)
    }
  }

  /* —— 挂点④（stop）：彻底复位 —— */
  fun reset() { synchronized(lock) { core.hardReset(); snapshot = null; pushUi(true) } }

  /* —— 挂点⑤（onAir）：回放播完重连直播起播 → CATCHING_UP → CAPTURING —— */
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

  /** 回退 15 秒（PlayerBar 实验按钮；仅 CAPTURING 可用，缓冲不足退到最旧存活帧）。 */
  fun rewind15() {
    val p = exo ?: return
    synchronized(lock) {
      if (!enabled || core.state != TsState.CAPTURING) return
      val t = core.rewindTarget(TimeshiftCore.REWIND_MS)
      val snap = t?.let { core.snapshot(it) }
      if (snap == null || snap.isEmpty()) { core.apply(TsEvent.REWIND_FAIL); pushUi(true); return }
      snapshot = snap
      core.apply(TsEvent.REWIND_OK)
      pushUi(true)
    }
    val name = PlayerHolder.ui.value.station?.n ?: ""
    val item = MediaItem.Builder().setUri(REPLAY_URL)
      .setMediaMetadata(MediaMetadata.Builder().setTitle("↩ 回听 · $name").build())
      .build()
    p.setMediaItem(item)   // 原位换快照 item；curPlay/srcmem/级联上下文不动，ENDED 自愈链自然接管
    p.prepare()
    p.play()
  }

  /* 快照 item 播完（直播不应 ENDED → 此信号只可能来自回放）→ CATCHING_UP；
     随后 PlayerHolder 既有 ended 自愈重连当前源（loadVariant→onNewStream keep 语义） */
  private val ctrl = object : Player.Listener {
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
    uiMut.value = TsUi(enabled, core.state, ms)
  }
}
