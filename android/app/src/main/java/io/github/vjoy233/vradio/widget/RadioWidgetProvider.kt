package io.github.vjoy233.vradio.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import io.github.vjoy233.vradio.MainActivity
import io.github.vjoy233.vradio.Prefs
import io.github.vjoy233.vradio.R
import io.github.vjoy233.vradio.data.Library
import io.github.vjoy233.vradio.data.MyRadio
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.player.PlaybackService
import io.github.vjoy233.vradio.player.PlayerHolder
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/* 桌面 Widget（plan-expansion-r4 §9.1，RemoteViews 第一版：台名/首字母块/曲讯一行/
   播放暂停/上下收藏/点空白打开应用）。台标 URL 在 RemoteViews 里 setImageViewUri 不可靠——
   首版用首字母色块，台标接入留 TODO（后续版本考虑 widget 专属小图落盘 + setImageViewBitmap）。
   TODO(B6 前置)：台标位图化（现首字母色块）。
   纪律：Widget 不主动联网（NetworkPolicy.Op.WIDGET 恒拒是护栏）；widget.* 键只存 Android 私有
   Prefs，不进 radio.* 契约、不进 v3 备份；点击 action 只携带固定 action 字符串（无 URL/可执行内容）。 */

class RadioWidgetProvider : AppWidgetProvider() {

  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    ids.forEach { WidgetPush.render(context, manager, it) }   // 快照渲染（进程回收后 onUpdate 走同一路径）
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)   // APPWIDGET_UPDATE/DELETED 等系统面走默认分发
    when (intent.action) {
      ACTION_PLAY_PAUSE -> WidgetCommands.toggle(context)
      ACTION_NEXT -> WidgetCommands.stepFav(context, 1)
      ACTION_PREV -> WidgetCommands.stepFav(context, -1)
      else -> return
    }
    WidgetPush.updateAll(context)      // 点击后立即刷一帧（真实新态随后由 ui 收集器再推）
  }

  companion object {
    const val ACTION_PLAY_PAUSE = "io.github.vjoy233.vradio.widget.PLAY_PAUSE"
    const val ACTION_NEXT = "io.github.vjoy233.vradio.widget.NEXT"
    const val ACTION_PREV = "io.github.vjoy233.vradio.widget.PREV"
  }
}

/* ---------- 控制面：widget 点击 → 现有 PlaybackService/MediaSession（refresh 的 SessionCommand 同款接线） ---------- */

object WidgetCommands {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  fun toggle(ctx: Context) = send(ctx, PlayerHolder.ACT_W_TOGGLE, 0)
  fun stepFav(ctx: Context, dir: Int) = send(ctx, PlayerHolder.ACT_W_STEP, dir)

  /** 不直接假设 PlayerHolder 已初始化：经 SessionToken 绑定 PlaybackService 送自定义 SessionCommand——
   *  进程死时绑定即唤醒（Application.onCreate 先跑 Store.init + PlayerHolder.ensure，回调到达时会话已就绪）；
   *  命令在服务进程主线程执行（ExoPlayer 要求面）。等待链路整体 5s 兜底，失败静默（下次点击/打开 app 自愈）。 */
  private fun send(ctx: Context, action: String, dir: Int) {
    val app = ctx.applicationContext
    scope.launch {
      runCatching {
        val fut = MediaController.Builder(app,
          SessionToken(app, ComponentName(app, PlaybackService::class.java))).buildAsync()
        val ctl = fut.get(5, TimeUnit.SECONDS) ?: return@runCatching
        try {
          // args Bundle 承载切台方向（服务端 onCustomCommand 的 args 参数即此 Bundle）
          ctl.sendCustomCommand(SessionCommand(action, Bundle.EMPTY),
            Bundle().apply { putInt(PlayerHolder.EXTRA_W_DIR, dir) }).get(3, TimeUnit.SECONDS)
        } finally { ctl.release() }
      }
    }
  }

  /* —— 进程冷启兜底（VRadioApp.onCreate 装配；AppVm 存活时其 init 覆盖、onCleared 时回装）——
     ⏮⏭/空台续播需要电台库解析（收藏/最近回绑），UI 不在时用文件侧自建的 Library 兜底：
     只读解析 + 播放，不写最近/收藏（避免与 AppVm 的 Library 实例双写互踩，recents 少记 widget 起播属可接受）。 */
  @Volatile private var bootLib: Library? = null

  fun wireFallback(ctx: Context) {   // VRadioApp.onCreate 调一次；回调闭包只捕获 context，重活全部延迟到点击
    PlayerHolder.onStepFav = { d -> stepFavFallback(ctx.applicationContext, d) }
    PlayerHolder.onPlayLast = { resumeLastFallback(ctx.applicationContext) }
  }

  private fun lib(app: Context): Library? = synchronized(this) {
    bootLib?.let { return it }
    runCatching {   // 装配口径 ≈ AppVm.boot：D7 filesDir 副本优先、assets 兜底；失败下次点击再试（不缓存失败）
      val radio = File(app.filesDir, "radio.txt").takeIf { it.exists() }?.readText()
        ?: app.assets.open("radio.txt").bufferedReader().use { it.readText() }
      Library(Store, app.filesDir).apply { mainText = radio; myText = MyRadio(app.filesDir).readText(); reload() }
    }.getOrNull()?.also { bootLib = it }
  }

  private fun stepFavFallback(app: Context, dir: Int) = scope.launch(Dispatchers.IO) {
    val l = lib(app) ?: return@launch
    val u = PlayerHolder.ui.value
    val pk = if (u.st == PState.PLAYING || u.st == PState.PAUSED) u.station?.key else null
    val ck = if (u.st == PState.CONNECTING) u.station?.key else null
    // 口径 ≈ AppVm.stepFav：可见台筛收藏（widget 无分类/关键词视图态，取全量可见）
    val favs = runCatching { l.visible(false, pk, ck).filter { l.isFav(it) } }.getOrDefault(emptyList())
    if (favs.isEmpty()) return@launch
    val curIdx = pk?.let { k -> favs.indexOfFirst { it.key == k } } ?: -1
    val nx = WidgetState.stepIdx(curIdx, favs.size, dir)
    if (nx < 0) return@launch
    playOnMain(favs[nx])
  }

  private fun resumeLastFallback(app: Context) = scope.launch(Dispatchers.IO) {
    val l = lib(app) ?: return@launch
    val r = l.recents.firstOrNull() ?: return@launch
    val s = runCatching { l.resolve(r.k) }.getOrNull() ?: return@launch
    playOnMain(s)
  }

  private suspend fun playOnMain(s: Station) = withContext(Dispatchers.Main) { PlayerHolder.play(s) }
}

/* ---------- 展示面：快照（widget.* Prefs）+ 渲染 + ui 收集推送 ---------- */

object WidgetPush {

  fun onUi(ctx: Context, ui: PlayerUiState) {   // AppVm 与 PlaybackService 两处收集（生命周期互补），幂等
    val next = WidgetState(ui.station?.n ?: "", ui.song, ui.st, System.currentTimeMillis(),
      hueKey = ui.station?.key ?: "")
    val prev = WidgetState.parse(Prefs.get(ctx, Prefs.WIDGET_SNAP, ""))
    if (!WidgetState.shouldPush(prev, next, next.at)) return
    Prefs.set(ctx, Prefs.WIDGET_SNAP, next.toJson())
    updateAll(ctx)
  }

  fun updateAll(ctx: Context) {
    val mgr = AppWidgetManager.getInstance(ctx)
    val ids = mgr.getAppWidgetIds(ComponentName(ctx, RadioWidgetProvider::class.java))
    if (ids.isEmpty()) return
    val snap = WidgetState.parse(Prefs.get(ctx, Prefs.WIDGET_SNAP, ""))
    for (id in ids) render(ctx, mgr, id, snap)
  }

  fun render(ctx: Context, mgr: AppWidgetManager, id: Int, snapIn: WidgetState? = null) {
    val snap = snapIn ?: WidgetState.parse(Prefs.get(ctx, Prefs.WIDGET_SNAP, ""))
    val v = RemoteViewsBuilder.build(ctx, snap ?: WidgetState())
    mgr.updateAppWidget(id, v)
  }
}

/* RemoteViews 组装单收口（provider 的 onUpdate/onUi 推送/点击后即刷共用） */
private object RemoteViewsBuilder {

  fun build(ctx: Context, s: WidgetState): android.widget.RemoteViews {
    val v = android.widget.RemoteViews(ctx.packageName, R.layout.widget_radio)
    v.setTextViewText(R.id.w_name, WidgetState.title(s))
    v.setTextViewText(R.id.w_song, WidgetState.line2(s))
    v.setTextViewText(R.id.w_letter, WidgetState.letter(s))
    v.setInt(R.id.w_letter, "setBackgroundColor", blockColor(s))   // 首字母色块（phParams 同款色相 hash，同台同色）
    v.setImageViewResource(R.id.w_play, if (s.st == PState.PLAYING) R.drawable.ic_widget_pause else R.drawable.ic_widget_play)
    // 点击面：根容器（非按钮区）= 打开应用；三按钮 = 固定 action 广播（FLAG_IMMUTABLE，无外部内容）
    v.setOnClickPendingIntent(R.id.w_root, openApp(ctx))
    v.setOnClickPendingIntent(R.id.w_play, broadcast(ctx, RadioWidgetProvider.ACTION_PLAY_PAUSE, 1))
    v.setOnClickPendingIntent(R.id.w_next, broadcast(ctx, RadioWidgetProvider.ACTION_NEXT, 2))
    v.setOnClickPendingIntent(R.id.w_prev, broadcast(ctx, RadioWidgetProvider.ACTION_PREV, 3))
    return v
  }

  private fun openApp(ctx: Context): PendingIntent {
    val i = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      ?: Intent(ctx, MainActivity::class.java)   // 理论兜底：无 launcher intent（不发生）
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(ctx, 10, i, PendingIntent.FLAG_IMMUTABLE)
  }

  private fun broadcast(ctx: Context, action: String, code: Int): PendingIntent =
    PendingIntent.getBroadcast(ctx, code,
      Intent(ctx, RadioWidgetProvider::class.java).setAction(action),
      PendingIntent.FLAG_IMMUTABLE)

  /** 首字母块底色：hsl(hue, .42, .44)（ui/Common.kt phParams 同公式：串 hash×31，%360） */
  private fun blockColor(s: WidgetState): Int {
    var h = 0
    for (c in s.hueKey.ifEmpty { s.name }) h = h * 31 + c.code
    val hue = ((h % 360) + 360) % 360
    return Color.HSVToColor(floatArrayOf(hue.toFloat(), 0.42f, 0.44f))
  }
}
