package io.github.vjoy233.vradio.player

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C as M3C
import androidx.media3.common.TrackSelectionParameters.AudioOffloadPreferences
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Metadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Player.PositionInfo
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.extractor.metadata.icy.IcyHeaders
import androidx.media3.extractor.metadata.icy.IcyInfo
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaController
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import io.github.vjoy233.vradio.R
import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.timeshift.Timeshift
import io.github.vjoy233.vradio.metadata.MetadataNormalizer
import io.github.vjoy233.vradio.model.MetadataEvent
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.model.SrcMem
import io.github.vjoy233.vradio.model.Station
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import okhttp3.OkHttpClient
import org.json.JSONObject

/* 播放层唯一所有者（CONTRACTS.md「Agent B」）：ExoPlayer/MediaSession/级联决策链/看门狗自愈/
   每台音量/睡眠渐弱/ICY 曲讯。语义平移自 Web player.js（304 行），注释标 Web 行号出处，行为以 Web 为准。
   - 三级策略塌缩为一级：Media3 统一识别直流/HLS（安卓无 /proxy，plan 5.3 映射表）。
   - 模块契约照抄 Web：不伸手进列表/台标，UI 只读 ui StateFlow + 注入 on* 回调。
   - 全部调用须在主线程（ExoPlayer 要求）；VRadioApp.onCreate 先 Store.init 再 ensure(ctx) 一次。 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
object PlayerHolder {

  private const val ACTION_REFRESH = "io.github.vjoy233.vradio.REFRESH" // 通知栏「刷新」自定义 action（plan-refresh-live §4.3）
  const val ACT_W_TOGGLE = "io.github.vjoy233.vradio.WIDGET_TOGGLE"    // 桌面 Widget 播放/暂停（B5 §9.1：经 SessionCommand 送进本层）
  const val ACT_W_STEP = "io.github.vjoy233.vradio.WIDGET_STEP"        // 桌面 Widget 收藏间切台（dir 见 EXTRA_W_DIR）
  const val EXTRA_W_DIR = "dir"                                        // 切台方向（1=下一收藏 -1=上一收藏）
  private const val TICK_MS = 2000L         // 看门狗巡检粒度（阈值 C.WATCHDOG_MS=12s）
  private const val VOL_DEBOUNCE_MS = 300L  // volperst 攒批落盘（player.js:100-103 写放大护栏同款）
  private const val SLEEP_TICK_MS = 1000L   // 睡眠定时秒级心跳（player.js:284）
  private const val FADE_MS = 30000L        // 到点前 30s 线性渐弱（player.js:293）

  private val main = Handler(Looper.getMainLooper())
  private val m3u8Re = Regex("\\.m3u8(\\?|$)", RegexOption.IGNORE_CASE) // player.js:125/178
  private val qtRe = Regex("ls\\.qingting\\.fm/live/(\\d+)\\.m3u8")     // player.js:115
  private val urlRe = Regex("^https?://")                               // player.js:84 键须 URL

  private var inited = false
  private lateinit var appCtx: Context
  private lateinit var exo: ExoPlayer
  private lateinit var fwd: Fwd // ⏮⏭/play/pause/stop 媒体键转发壳（见文件尾 Fwd）
  private lateinit var sess: MediaSession
  private var selfCtl: MediaController? = null // 自连控制器（见 ensure 尾注）

  private val uiMut = MutableStateFlow(PlayerUiState())
  val ui: StateFlow<PlayerUiState> get() = uiMut   // UI 唯一读口
  val player: ExoPlayer get() = exo
  val session: MediaSession get() = sess
  // 只读诊断：仅在主线程查询产品自身的 controller；不触发连接或改变播放。
  internal fun isSelfControllerConnected(): Boolean = selfCtl?.isConnected == true

  var onStepFav: ((Int) -> Unit)? = null                     // ⏮⏭ 收藏间切台（player.js:71-72）
  var onPlayLast: (() -> Unit)? = null                       // 媒体键 play 无台 → 续播上次（player.js:66）
  // B3-A（plan-expansion-r4 §7.1）：ICY 曲讯只产事件（normalize 后的 MetadataEvent），消费（当前曲讯
  // 显示/歌史/统计）在 AppVm 侧 Legacy/MetadataV2 sink——播放层不直接操作 radio.songs（模块边界）
  var onMetadata: ((MetadataEvent) -> Unit)? = null
  var logoProvider: ((Station) -> String)? = null            // 锁屏 artwork 同步窥探（player.js:30 onlogo）

  private val lifecycle = PlaybackLifecycle<Station, Pctx>()
  private var token by lifecycle::token
  private var pctx by lifecycle::pctx
  private var station by lifecycle::station
  private var connecting by lifecycle::connecting
  private var halt = false                 // 有意暂停守卫（player.js:17-18）
  private var heldNext = false             // 暂停期级联搁浅标记（player.js:19）
  private var retried by lifecycle::retried
  private var curSi by lifecycle::curSi
  private var curPlay by lifecycle::curPlay
  private var lastKbps by lifecycle::lastKbps
  private var lastPos = 0L                 // 上次采样位置（进展检测）
  private var wdAt = 0L                    // 最近进展时刻（看门狗基准）
  private var vol = 0.9f                   // 逻辑音量（渐弱/取消的恢复基准，player.js:8）
  private var gvol = 0.9f                  // 全局默认音量 radio.vol（player.js:9）
  private var volMem = LinkedHashMap<String, Int>()     // radio.volperst（player.js:10）
  private var srcMem = LinkedHashMap<String, SrcMem>()  // radio.srcmem2（player.js:12）
  private var volTOn = false
  private var sleepEnd = 0L
  private var sleepOn = false

  /* ---------- 生命周期 ---------- */

  fun ensure(ctx: Context) { // VRadioApp.onCreate 调一次（player.js init 33-75 的安卓形态）
    if (inited) return
    inited = true
    appCtx = ctx.applicationContext
    // okhttp DataSource：ICY 200 OK 非标状态行必须走 okhttp（D6 破例的唯一理由）；
    // DefaultMediaSourceFactory 按 URI 形态自动识别直流/HLS（三级塌缩为一级）
    val ds = OkHttpDataSource.Factory(OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).build())
      .setDefaultRequestProperties(mapOf("Icy-MetaData" to "1")) // 主动要 ICY 元数据（Icecast 需请求头）
    val msf = DefaultMediaSourceFactory(Timeshift.factory(ds))   // B7 Spike 挂点①：时移 tee 工厂包装
      .setLoadErrorHandlingPolicy(FastFailPolicy())              // （开关关闭/非直流时纯透传，零行为变化）
    val pb = ExoPlayer.Builder(appCtx)
      .setMediaSourceFactory(msf)
      .setAudioAttributes(AudioAttributes.Builder().setUsage(M3C.USAGE_MEDIA)
        .setContentType(M3C.AUDIO_CONTENT_TYPE_MUSIC).build(), true) // 焦点自动处理：transient 暂停/can_duck 降音量/永久停止，全默认不自研
      .setHandleAudioBecomingNoisy(true)  // 拔耳机自动暂停（Web 无此问题域）
      .setWakeMode(M3C.WAKE_MODE_NETWORK) // 锁屏继续拉流
    exo = pb.build()
    if (io.github.vjoy233.vradio.Prefs.get(appCtx, io.github.vjoy233.vradio.Prefs.OFFLOAD, false)) {
      // E5 音频卸载（batch1，默认关的实验开关）：Media3 1.11.1 单开关即全链路——AudioOffloadPreferences
      //   由 DefaultTrackSelector.maybeConfigureRendererForOffload 写进 RendererConfiguration.offloadModePreferred
      //   → audioSink.setOffloadMode → AudioTrack setEnableOffload（1.11.1 源码实证；ExoPlayer 2.x 时代的
      //   DefaultRenderersFactory.setEnableAudioOffload 双开关在本版 API 不存在，勿按旧博客加回）。
      //   开关在 ensure() 读一次，改开关须重启应用生效；ENABLED 模式下不支持的流自动回退软解（非 REQUIRED）
      exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
        .setAudioOffloadPreferences(AudioOffloadPreferences.Builder()
          .setAudioOffloadMode(AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED).build())
        .build()
    }
    Timeshift.attach(ctx, exo) // B7 Spike 挂点②：回听控制器（读实验开关 + ENDED/error 监听；先于 listener
                               // 注册——ENDED 先到才能判「快照播完」转 CATCHING_UP）
    exo.addListener(listener)
    fwd = Fwd(exo, this)
    val launch = appCtx.packageManager.getLaunchIntentForPackage(appCtx.packageName)
    val pi = launch?.let { PendingIntent.getActivity(appCtx, 0, it, PendingIntent.FLAG_IMMUTABLE) }
    val sb = MediaSession.Builder(appCtx, fwd)
    if (pi != null) sb.setSessionActivity(pi)
    sb.setCallback(sessionCb) // 通知栏「刷新」自定义 action（plan-refresh-live §4.3）：onConnect 放行 + onCustomCommand 派发
    sess = sb.build()
    sess.setCustomLayout(listOf(refreshBtn())) // 标准媒体键后追加「刷新」（锁屏/通知栏直达）
    reloadMems() // player.js:35（Store 收敛层出口；调用前 Store.init 已由 VRadioApp 完成）
    vol = gvol; exo.volume = gvol
    uiMut.update { it.copy(volPct = (gvol * 100).roundToInt()) }
    // 自连控制器（保守实现）：MediaSessionService 在「有控制器连上」后才接手通知/前台生命周期，
    // 本应用 UI 直读 StateFlow 不建控制器——这里自连一次把会话挂进服务（media3 常规形态）。
    // 失败不阻断播放（大不了缺通知，主线实机收口验证）
    runCatching {
      val fut: ListenableFuture<MediaController> = MediaController.Builder(appCtx,
        SessionToken(appCtx, ComponentName(appCtx, PlaybackService::class.java))).buildAsync()
      fut.addListener({ selfCtl = runCatching { fut.get() }.getOrNull() }, Executor { it.run() })
    }
    main.postDelayed(ticker, TICK_MS)
  }

  /* ---------- 播放决策链 ---------- */

  /** 冷启动仅选择：不建流、不更改播放记忆；已有播放意图优先。 */
  private var selectionGeneration by lifecycle::selectionGeneration
  fun selectionToken(): Long = selectionGeneration
  fun selectIfEmpty(s: Station, expected: Long): Boolean {
    if (!inited || !lifecycle.selectIfEmpty(s, expected)) return false
    uiMut.update { it.copy(st = PState.IDLE, station = s, status = "") }
    return true
  }

  fun play(s: Station, prefer: Int = -1) { // 总入口（player.js:128-150 的 B1 扩展：基座换人工序+禁用剔除）
    if (!inited) return
    selectionGeneration++
    markProgress()
    halt = false; heldNext = false // 清上一轮守卫标记（player.js:130）
    val order = srcOrder(s).toMutableList() // ④ 启发式对 mo 序遍历：直流形态优先（player.js:131；禁用已剔除）
    if (order.isEmpty()) { noEnabledSrc(s); return } // B1：全部源已手动禁用——不建流不建 pctx
    val mem = srcMem[s.u0]
    if (mem != null && mem.i in order) { order.remove(mem.i); order.add(0, mem.i) } // ③ 记忆须在有效序内；禁用源忽略（player.js:133）
    if (prefer in order) { order.remove(prefer); order.add(0, prefer) }             // ② 手动当次最高（禁用源不播，player.js:134）
    val urls = ArrayList<Variant>(order.size * 2)
    for (si in order) for (v in variants(s.u[si])) urls.add(Variant(v, si)) // 三级展开序（player.js:135-136）
    pctx = Pctx(urls, ++token)
    station = s; connecting = s
    lastKbps = 0 // 换台旧码率/曲讯随 ui 清零（app.js:569 切台防串台；曲讯管线 reset 在消费侧看 CONNECTING+空 song）
    val pv = volMem[s.u0]
    val want = if (pv != null) pv / 100f else gvol // 有记忆用记忆、无记忆用全局（player.js:141-142）
    if (vol > 0f) { vol = want; exo.volume = want } // 静音态切台保持静音（player.js:143-144）
    pushMeta(s.n) // 锁屏台名（player.js:145-147）
    uiMut.update { it.copy(st = PState.CONNECTING, station = s, song = "", kbps = 0, srcIdx = -1, mode = "", noSrc = false,
      volPct = (vol * 100).roundToInt()) }
    next()
  }

  /** NO_ENABLED_SOURCE（B1，plan-expansion-r4 §5.4）：该台所有源都已手动禁用——不建流不建 pctx、
   *  保持停播；不写 radio.health、不自动复活、不换 identityUrl；UI 经 ui.noSrc + status 文案可区分。 */
  private fun noEnabledSrc(s: Station) {
    token++ // 作废在飞链（切换意图生效：原台停播，本台保持停播）
    halt = false; heldNext = false
    exo.stop(); exo.clearMediaItems()
    station = s; connecting = null
    curSi = -1; curPlay = ""; retried = false; lastKbps = 0
    markProgress()
    uiMut.update { it.copy(st = PState.IDLE, station = s, song = "", kbps = 0, srcIdx = -1, mode = "", noSrc = true,
      status = "该台所有源都已手动禁用，请先启用一个源") }
  }

  fun pause() { // 有意暂停（player.js:272-277）
    if (!inited) return
    markProgress() // 撤看门狗：连续监测口径下=续命（player.js:273 stopWatchdog 等价面）
    halt = true    // 挡住在飞 error 级联续摊（player.js:274）
    exo.pause()
  }

  fun resume() { // player.js:264-271
    if (!inited) return
    val s = station ?: return // 无台可续：媒体键路径已转 onPlayLast（player.js:265）
    if (lifecycle.resumeRequiresPlay()) { play(s); return } // 仅选中态首次播放走完整选源链
    if (s.effOrder().isEmpty()) { play(s); return } // B1：全禁台恢复 = 仍 NO_ENABLED_SOURCE（重进提示路径，不复活）
    halt = false
    connecting = s; say("连接中…"); syncState()
    if (heldNext) { heldNext = false; retryOrNext(); return } // 暂停期级联搁浅接回（player.js:269）
    if (exo.playbackState == Player.STATE_IDLE) { // 停止/错误态恢复：重连当前源（Web audio.play() 浏览器自重取的等价面）
      markProgress(); loadVariant(curPlay)
    } else exo.play()
  }

  fun toggle() { // pp 语义（app.js:1187）：isPaused≈!playWhenReady（BUFFERING 期视为未暂停）
    if (!inited) return
    if (station == null) { onPlayLast?.invoke(); return }
    if (exo.playWhenReady) pause() else resume()
  }

  fun refresh() { // 手动刷新回直播头（docs/plan-refresh-live.md §2，Web player.js refresh 同语义）：当前赢家源
    // 整链重开——play 自带 token 作废在飞链/清 halt·heldNext/prefer 提首/台记忆音量/锁屏元数据/连接中指示；
    // 暂停态直接起播（刷新=要听最新的，直播流停在直播头不是稳定态）；空台无响应；不写 srcmem（onAir 未变早退）
    val s = station ?: return
    play(s, if (curSi in s.u.indices) curSi else -1)
  }

  fun stop() { // player.js:214-220
    if (!inited) return
    selectionGeneration++
    token++
    halt = false; heldNext = false
    exo.stop(); exo.clearMediaItems()
    Timeshift.reset() // B7 Spike 挂点④：停播彻底复位
    station = null; connecting = null
    cancelSleep()
    curSi = -1; curPlay = ""; lastKbps = 0
    markProgress()
    uiMut.update { it.copy(st = PState.IDLE, station = null, song = "", kbps = 0, srcIdx = -1, mode = "", noSrc = false,
      status = "") } // 清引擎文案：无台时 PlayerBar 第二行会永久残留「已暂停」等旧状态（G P3）
  }

  /* ---------- 音量（每台记忆 volperst + 全局锚点 radio.vol） ---------- */

  fun setVolPct(pct: Int) { // 调音量分流（player.js rememberVol 90-104）：正在播写台记忆（首调全局锚点随行）、无台写全局
    if (!inited) return
    val p = pct.coerceIn(0, 100)
    vol = p / 100f
    exo.volume = vol
    uiMut.update { it.copy(volPct = p) }
    if (p <= 0) return // 0 与静音同为瞬态不入记忆（player.js:92）
    val s = station
    if (s == null) { gvol = p / 100f; Store.set(C.K_VOL, p.toString()); return } // player.js:94
    val fresh = volMem[s.u0] == null
    volMem[s.u0] = p
    if (fresh) { gvol = p / 100f; Store.set(C.K_VOL, p.toString()) } // 台首调锚点随行（player.js:96-97）
    trimVolmem()
    main.removeCallbacks(volPersist) // 300ms 攒批一写（player.js:100-103）：崩溃最多丢最后一段拖动
    volTOn = true
    main.postDelayed(volPersist, VOL_DEBOUNCE_MS)
  }

  fun restoreVolPct(): Int { // 取消静音恢复值（player.js restoreVol 105-108）：当前台记忆 → 全局 → 默认
    val pv = station?.let { volMem[it.u0] }
    return when {
      pv != null && pv > 0 -> pv
      gvol > 0f -> (gvol * 100).roundToInt()
      else -> C.DEFAULT_VOL
    }
  }

  /* ---------- 成功源记忆 srcmem2 ---------- */

  fun forgetSrc(): Boolean = station?.let { forgetSrcOf(it) } ?: false // 「恢复默认源」旧入口：当前台（选源浮层）

  /** 「恢复默认播放源」（B1 恢复两动作之一，player.js:255-261）：清指定台 srcmem2；人工顺序/禁用表
   *  保留（与「撤销人工源排序」独立）。true=真清了，重播由调用方发起。 */
  fun forgetSrcOf(s: Station): Boolean {
    if (srcMem[s.u0] == null) return false
    srcMem.remove(s.u0)
    persistSrcmem()
    return true
  }

  fun srcmemOf(s: Station): Int = srcMem[s.u0]?.i?.takeIf { it in s.u.indices } ?: -1 // 选源浮层「记忆」徽标

  /** 决策链基座（B1 扩展 + review P1-6）：有人工序（moManual，mo 来自 cfg.srcManualOrder）保留用户原序
     压过启发式（player.js:131「moManual ? mo : mo.sort(srcRank)」同款）；仅无人工序时按直流优先稳定排序；
     UI「默认」徽标共用——人工序/禁用后徽标随决策链同步，不会漂移。 */
  fun srcOrder(s: Station): List<Int> = playSourceOrder(s.effOrder(), s.u, s.moManual) { srcRank(it) } // player.js:126

  /* ---------- 睡眠定时 ---------- */

  fun sleep(min: Int) { // player.js:280-297
    if (!inited) return
    cancelSleep()
    if (min <= 0) return
    sleepEnd = SystemClock.elapsedRealtime() + min * 60000L
    sleepOn = true
    uiMut.update { it.copy(sleepLeftMs = min * 60000L) }
    main.postDelayed(sleepTick, SLEEP_TICK_MS)
  }

  fun cancelSleep() { // player.js:298-301：中途取消也恢复音量
    if (sleepOn) { sleepOn = false; main.removeCallbacks(sleepTick); uiMut.update { it.copy(sleepLeftMs = 0L) } }
    if (this::exo.isInitialized) exo.volume = vol
  }

  fun setSong(t: String) { // 曲讯写锁屏 + ui（player.js setSong 208-212；台标后解析补刷共用；B3 起由 AppVm sink 调）
    val s = station ?: return
    uiMut.update { it.copy(song = t) }
    pushMeta(t.ifEmpty { s.n }) // 空串回退台名
  }

  /* ---------- 变体与启发式 ---------- */

  private fun variants(u: String): List<String> { // player.js:113-120：蜻蜓换算前置 + 原 URL（安卓无 /proxy 级）
    val vs = ArrayList<String>(2)
    val qt = qtRe.find(u)
    if (qt != null) vs.add("http://lhttp.qingting.fm/live/" + qt.groupValues[1] + "/64k.mp3")
    vs.add(u)
    return vs
  }

  private fun srcRank(u: String): Int = if (m3u8Re.containsMatchIn(variants(u)[0])) 1 else 0 // player.js:125

  /* ---------- 级联与自愈 ---------- */

  private fun next() { // error 级联：换下一个 variant（player.js:151-170）
    val p = pctx ?: return
    if (p.my != token) return
    if (lifecycle.exhaustIfNeeded(p, p.my, p.i, p.urls.size)) { // 全部耗尽善后（player.js:154-159）；清 song/kbps——PlayerBar 第二行 song 优先，残留旧曲讯会永久掩盖 ⚠ 提示
      // 终结本次播放世代：新 VM 可能在耗尽后复用旧 boot token；若不递增，selectIfEmpty 会把
      // 已失败台当成仅选择态，而 resume() 又会沿用旧 curPlay/pctx 重连旧流（真实旧流误播）。
      markProgress()
      exo.stop(); exo.clearMediaItems()
      uiMut.update { it.copy(st = PState.IDLE, station = null, srcIdx = -1, mode = "", noSrc = false, song = "", kbps = 0,
        status = "⚠ 全部源失败，建议点「体检」或「同步源」") }
      return
    }
    if (halt && p.i > 0) { heldNext = true; return } // 有意暂停挡级联续摊（player.js:164）
    val cur = p.urls[p.i++]
    curSi = cur.si; curPlay = cur.u; retried = false
    connecting = station // 换源重试期间保持连接中指示（player.js:167）
    uiMut.update { it.copy(st = PState.CONNECTING, srcIdx = cur.si, noSrc = false,
      mode = if (m3u8Re.containsMatchIn(cur.u)) "hls" else "direct", // B1：源详情面板的播放模式展示
      kbps = 0, status = "连接中… 源" + p.i + "/" + p.urls.size) } // AIbot P3：换源清旧码率（无 ICY 的源残留上一源 kbps）
    lastKbps = 0
    markProgress() // 看门狗计时起点：建流期连接挂死同覆盖（player.js:224-225 口径）
    loadVariant(cur.u)
  }

  private fun loadVariant(u: String) { // player.js load 172-200 的 media3 形态：单级、HLS 自动识别、错误经 onPlayerError 回流
    if (u.isEmpty()) { next(); return } // 兜底：无当前源可重连（理论不可达）直接续摊
    Timeshift.onNewStream(u) // B7 Spike 挂点③：每条新连接重置时移会话（切台/刷新/自愈重连/换源全汇于此）
    lastPos = -1L
    val b = MediaItem.Builder().setUri(u)
    curMeta?.let { b.setMediaMetadata(it) } // 锁屏元数据随装载（pushMeta 先于装载的建流前调用路径）
    exo.setMediaItem(b.build())
    exo.prepare()
    exo.play()
  }

  private fun retryOrNext() { // stall/ended 自愈：先重连当前源一次再顺延（player.js:236-244）
    val p = pctx ?: return
    val s = station ?: return
    if (p.my != token) return
    if (halt && p.i > 0) { heldNext = true; return } // 契约硬点 6：暂停后 error/ended 一并不许自愈复活（ended 路径收严）
    markProgress()
    if (!retried) {
      retried = true
      connecting = s
      say("重连当前源…")
      syncState()
      loadVariant(curPlay)
    } else next()
  }

  private fun onAir() { // 建流成功（≈Web 'playing'，player.js:37 + 245-254）
    connecting = null
    markProgress()
    Timeshift.onLiveAir() // B7 Spike 挂点⑤：回放播完重连直播起播 → CATCHING_UP → CAPTURING
    val s = station
    if (s != null && pctx?.my == token) {
      // B7 Spike（AIbot P2-2）：回放期状态明示「回听中」——快照起播也走 onAir（复用既有事件），
      // 若照旧说「直播中」用户会误以为仍在实时收听；回放结束重连起播时 isReplaying 已翻 false，自然恢复「直播中」
      say(if (Timeshift.isReplaying()) "回听中…" else "直播中")
      if (s.u.size >= 2 && curSi in s.u.indices) { // 成功源记忆写回（仅多源台）
        val prev = srcMem[s.u0]
        if (prev == null || prev.i != curSi) { // 未变不写（resume 也触发，player.js:249）
          srcMem[s.u0] = SrcMem(curSi, System.currentTimeMillis())
          trimSrcmem()
          persistSrcmem()
        }
      }
    }
    syncState()
  }

  /* ---------- 锁屏元数据 ---------- */

  private var curMeta: MediaMetadata? = null // 最近一次组装的锁屏元数据（loadVariant 装载时带上；Player 无 setMediaMetadata）

  private fun pushMeta(title: String) { // player.js meta 203-207：title=歌名||台名、artist=VRadio·分类、artwork=台标 URL
    val s = station ?: return
    val b = MediaMetadata.Builder().setTitle(title.ifEmpty { s.n }).setArtist("VRadio · " + s.c)
    logoProvider?.invoke(s)?.takeIf { it.isNotEmpty() }?.let { b.setArtworkUri(Uri.parse(it)) }
    curMeta = b.build()
    // 已在播的 item 用 replaceMediaItem 原位换元数据（同 URI 不触发重载，ICY 换歌不重启流）
    if (curPlay.isNotEmpty() && !Timeshift.isReplaying()) runCatching { // B7：回放中替换会顶掉快照 item，拦掉
      exo.replaceMediaItem(0, MediaItem.Builder().setUri(curPlay).setMediaMetadata(curMeta!!).build())
    }
  }

  /* ---------- ExoPlayer 事件回流 ---------- */

  private val listener = object : Player.Listener {
    override fun onPlaybackStateChanged(playbackState: Int) {
      when (playbackState) {
        Player.STATE_READY -> markProgress()
        Player.STATE_ENDED -> { // 直播不该 ended → 自愈（player.js:47；halt 守卫在 retryOrNext 入口）
          if (station != null && connecting == null && pctx?.my == token) retryOrNext()
        }
        Player.STATE_IDLE -> Unit // 错误路径由 onPlayerError 处理；焦点永久丢失 stop 落 syncState=可续播
      }
      syncState()
    }
    override fun onIsPlayingChanged(isPlaying: Boolean) {
      if (isPlaying) onAir()
      else {
        // READY 才说「已暂停」：播放中再缓冲（BUFFERING）不是暂停——Web 只在 pause 事件说（player.js:41，waiting 不说）
        if (station != null && connecting == null && exo.playbackState == Player.STATE_READY) say("已暂停")
        syncState()
      }
    }
    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      if (!playWhenReady && reason != Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST) {
        halt = true; markProgress() // 让位（焦点丢失/拔耳机）同有意暂停守卫——Web 让位走 pause()（player.js:58）
      }
      // 瞬时焦点丢失（来电/语音助手）结束 media3 自动恢复播放——必须复位 halt，否则粘滞为 true 会让
      // 看门狗停摆（tickOnce 早退）+ 后续 error 级联被 heldNext 静默搁浅（Web 无此面：halt 只在显式 pause 置位）
      if (playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS) {
        halt = false
        if (heldNext) { heldNext = false; retryOrNext() } // 暂停期搁浅接回（resume() 同款）
      }
      syncState()
    }
    override fun onPlayerError(error: PlaybackException) { // error 级联（player.js:169/193 onFail→next）
      val p = pctx ?: return
      if (p.my != token) return
      if (halt && p.i > 0) { heldNext = true; return } // player.js:164
      next()
    }
    override fun onPositionDiscontinuity(oldPosition: PositionInfo, newPosition: PositionInfo, reason: Int) {
      markProgress() // 有实际进展即撤看门狗（player.js:44）
    }
    override fun onMetadata(metadata: Metadata) { // ICY 曲讯/码率（B-6/B-7）；HLS 结构性无 ICY 显示空不是 bug
      val s = station ?: return
      if (pctx?.my != token) return
      for (i in 0 until metadata.length()) {
        when (val e = metadata.get(i)) {
          is IcyInfo -> {
            val t = e.title?.trim().orEmpty()
            if (t.isEmpty()) continue // 空曲讯不覆盖有效曲名（契约 normalizeRules；HLS 不猜歌名）——事件都不发
            // B3-A：只产事件不消费——normalize（清洗/台名前缀/拆分/置信度）后回调，当前曲讯/歌史/统计
            // 归 AppVm 侧 sink（dedup 也在那）；世代令牌已在上面验过，迟到事件由管线 identityUrl/at 再拦
            onMetadata?.invoke(MetadataNormalizer.normalize(
              MetadataNormalizer.IcyRaw(t, "", lastKbps, "icy", System.currentTimeMillis()),
              MetadataNormalizer.IcyCtx(s.u0, s.n)))
          }
          is IcyHeaders -> {
            val br = e.bitrate
            if (br > 0) { lastKbps = br / 1000; uiMut.update { it.copy(kbps = lastKbps) } } // media3 bitrate 是 bps（icy-br×1000，源码实证），显示口径 = 原始 icy-br kbps（app.js:614 同款）
          }
        }
      }
    }
  }

  /* ---------- 看门狗（连续监测式，A-1 的安卓等价面） ---------- */

  private val ticker = object : Runnable { // 2s 巡进展；12s 无进展按断流（player.js:223-235 事件武装的等价实现）
    override fun run() {
      try { tickOnce() } finally { main.postDelayed(this, TICK_MS) }
    }
  }

  private fun tickOnce() {
    if (!inited) return
    station ?: return // 级联已终结：残留看门狗不说话不动作（player.js:230）
    val p = pctx ?: return
    if (p.my != token || halt) return // 武装后用户按了暂停：不强制起播（player.js:231）
    val pos = exo.currentPosition
    if (pos != lastPos) { lastPos = pos; markProgress() } // 进展即续命（player.js:44 timeupdate）
    if (!exo.isPlaying && exo.playbackState != Player.STATE_BUFFERING) { markProgress(); return }
    if (SystemClock.elapsedRealtime() - wdAt >= C.WATCHDOG_MS) {
      say("流卡住，自动恢复…") // player.js:232
      retryOrNext()
    }
  }

  private val sleepTick = object : Runnable { // player.js:284-296
    override fun run() {
      if (!sleepOn) return
      val left = sleepEnd - SystemClock.elapsedRealtime()
      if (left <= 0) {
        sleepOn = false
        pause()
        exo.volume = vol // 停止后音量按逻辑值恢复（player.js:288）
        uiMut.update { it.copy(sleepLeftMs = 0L) }
        say("😴 睡眠定时已到，已停止播放")
        return
      }
      if (left <= FADE_MS && exo.isPlaying) exo.volume = vol * left / FADE_MS // 线性渐弱（player.js:293）
      uiMut.update { it.copy(sleepLeftMs = left) }
      main.postDelayed(this, SLEEP_TICK_MS)
    }
  }

  /* ---------- 记忆装载与落盘（radio.volperst/radio.srcmem2/radio.vol 经 Store） ---------- */

  fun reloadMems() { // player.js:79-88：容错读取 + 形状清洗。公开入口（AIbot P1-2）：备份导入 Store 整体替换后
                     // 必须重载——否则旧内存 Map 会在下次调音量（300ms 攒批）/换源成功时回写冲掉新导入的值
    if (volTOn) { volTOn = false; main.removeCallbacks(volPersist); volPersist.run() } // 先落未攒完的音量（player.js:80）
    volMem = LinkedHashMap()
    runCatching { JSONObject(Store.get(C.K_VOLPERST) ?: "{}") }.getOrNull()?.let { o ->
      for (k in o.keys()) { val v = o.optInt(k, -1); if (urlRe.matches(k) && v in 0..100) volMem[k] = v }
    }
    srcMem = LinkedHashMap()
    runCatching { JSONObject(Store.get(C.K_SRCMEM) ?: "{}") }.getOrNull()?.let { o ->
      for (k in o.keys()) {
        val e = o.optJSONObject(k) ?: continue
        val i = e.optInt("i", -1)
        if (i >= 0) srcMem[k] = SrcMem(i, e.optLong("t", 0L))
      }
    }
    val g = Store.get(C.K_VOL)?.toIntOrNull()
    if (g != null && g in 0..100) gvol = g / 100f // 全局锚点随行重载（player.js:86-87）
  }

  private val volPersist = Runnable { // player.js:103
    volTOn = false
    val o = JSONObject()
    for ((k, v) in volMem) o.put(k, v)
    Store.set(C.K_VOLPERST, o.toString())
  }

  private fun persistSrcmem() {
    val o = JSONObject()
    for ((k, m) in srcMem) o.put(k, JSONObject().put("i", m.i).put("t", m.t))
    Store.set(C.K_SRCMEM, o.toString())
  }

  private fun trimVolmem() { // FIFO 300 插入序（player.js:98-99；重赋值不换位，与 JS 对象键序一致）
    val it = volMem.entries.iterator()
    while (volMem.size > C.MEM_FIFO && it.hasNext()) { it.next(); it.remove() }
  }

  private fun trimSrcmem() { // FIFO 300 按 t 最旧先挤（player.js:251-252）
    while (srcMem.size > C.MEM_FIFO) {
      val old = srcMem.entries.minByOrNull { it.value.t } ?: break
      srcMem.remove(old.key)
    }
  }

  /* ---------- 小工具 ---------- */

  private fun say(t: String) { uiMut.update { it.copy(status = t) } } // player.js:77

  private fun markProgress() { wdAt = SystemClock.elapsedRealtime() }

  private fun syncState() { // 状态映射：BUFFERING→CONNECTING、READY+播→PLAYING、READY+停→PAUSED、留台 IDLE=可续播
    val st = when {
      station == null -> PState.IDLE
      connecting != null -> PState.CONNECTING
      exo.playbackState == Player.STATE_BUFFERING -> PState.CONNECTING
      exo.playbackState == Player.STATE_READY && exo.isPlaying -> PState.PLAYING
      exo.playbackState == Player.STATE_READY -> PState.PAUSED
      else -> PState.PAUSED // STATE_IDLE 留台（焦点永久丢失 stop/错误善后）：可续播视作暂停，resume 会重连当前源
    }
    val si = if (station != null) curSi else -1
    uiMut.update { it.copy(st = st, station = station, srcIdx = si) }
  }

  /* ---------- 媒体键转发壳（player.js:62-74 MediaSession action 的 media3 形态） ---------- */

  /* ⏮⏭ 占用 seekToPrevious/Next 转收藏切台——直播无 seek 语义，占用安全；
     SEEK_BACK/FORWARD 等快退快进命令关掉（直播不可拖）；play 无台转续播上次。 */
  private class Fwd(p: ExoPlayer, val h: PlayerHolder) : ForwardingPlayer(p) {
    override fun isCommandAvailable(command: Int): Boolean = when (command) {
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_NEXT,
      Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> true // ⏮⏭ 亮出（通知栏按钮）
      Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD,
      Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_SEEK_TO_DEFAULT_POSITION -> false
      else -> super.isCommandAvailable(command)
    }
    override fun getAvailableCommands(): Player.Commands {
      val b = Player.Commands.Builder() // 以底层可用集为基（Builder 拷贝构造私有，逐条 add）
      val base = super.getAvailableCommands()
      for (i in 0 until base.size()) b.add(base.get(i))
      b.add(Player.COMMAND_SEEK_TO_PREVIOUS); b.add(Player.COMMAND_SEEK_TO_NEXT)
      b.add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM); b.add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
      b.remove(Player.COMMAND_SEEK_BACK); b.remove(Player.COMMAND_SEEK_FORWARD)
      b.remove(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM); b.remove(Player.COMMAND_SEEK_TO_DEFAULT_POSITION)
      return b.build()
    }
    override fun seekToPrevious() { h.onStepFav?.invoke(-1) }        // player.js:71
    override fun seekToPreviousMediaItem() { h.onStepFav?.invoke(-1) }
    override fun seekToNext() { h.onStepFav?.invoke(1) }             // player.js:72
    override fun seekToNextMediaItem() { h.onStepFav?.invoke(1) }
    override fun play() { if (h.station == null) h.onPlayLast?.invoke() else h.resume() } // player.js:66
    override fun pause() { h.pause() } // 经持有者走 halt 守卫（不直接透传底层）
    override fun stop() { h.stop() }   // player.js:68
  }

  /* 通知栏「刷新」自定义 action（plan-refresh-live §4.3）：Fwd 先例是占标准命令位（⏮⏭），但标准位语义不合
     （seek 系已禁用、stop 是停播）——custom command 是 CONTRACTS 硬点 9 预留的另一条合规路 */
  private fun refreshBtn() = CommandButton.Builder()
    .setDisplayName("刷新")
    .setIconResId(R.drawable.ic_refresh)
    .setSessionCommand(SessionCommand(ACTION_REFRESH, Bundle.EMPTY))
    .build()

  private val sessionCb = object : MediaSession.Callback {
    override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo) =
      MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailableSessionCommands( // 自定义 sessionCommand 必须显式放行，否则通知栏按钮静默不渲染（方案审计 R1-9）
          MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
            .add(SessionCommand(ACTION_REFRESH, Bundle.EMPTY))
            .add(SessionCommand(ACT_W_TOGGLE, Bundle.EMPTY))   // Widget 控制面（B5 §9.1，refresh 同款接线）
            .add(SessionCommand(ACT_W_STEP, Bundle.EMPTY)).build())
        .build()
    override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
      when (customCommand.customAction) {
        ACTION_REFRESH -> refresh() // 回调在主线程（ExoPlayer 要求面）；暂停态直接起播，与播放栏按钮同语义
        ACT_W_TOGGLE -> toggle()    // Widget 播放/暂停：空台走 onPlayLast（VRadioApp 装配的兜底或 AppVm 的续播）
        ACT_W_STEP -> onStepFav?.invoke(args.getInt(EXTRA_W_DIR, 1))   // ⏮⏭ 收藏间切台（同通知栏线控语义）
        else -> return super.onCustomCommand(session, controller, customCommand, args)
      }
      return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
    }
  }

  /* 快速失败：库内重试压到 hls.js 同款小档（player.js:185），让错误尽早回 onPlayerError 走应用层级联；
     media3 默认重试会让死源拖半分钟。errorCount 从 1 计：<3 即最多重试 2 次、1s 间隔 */
  private class FastFailPolicy : DefaultLoadErrorHandlingPolicy() {
    override fun getRetryDelayMsFor(info: LoadErrorHandlingPolicy.LoadErrorInfo): Long =
      if (info.errorCount < 3) 1000L else M3C.TIME_UNSET
    override fun getMinimumLoadableRetryCount(dataType: Int): Int = 0
  }

  private class Variant(val u: String, val si: Int)
  private class Pctx(val urls: List<Variant>, val my: Int) { var i = 0 } // player.js:14
}

/** 播放源顺序决策（B1 review P1-6，player.js srcOrder 纯逻辑镜像）：manual=true 保留用户序（启发式让位，
    同级保持行序）；manual=false 按直流优先稳定排序。Top-level 纯函数 JVM 直测；PlayerHolder.srcOrder 委派至此。 */
fun playSourceOrder(eff: List<Int>, u: List<String>, manual: Boolean, rank: (String) -> Int): List<Int> =
  if (manual) eff.toList() else eff.sortedBy { rank(u[it]) }
