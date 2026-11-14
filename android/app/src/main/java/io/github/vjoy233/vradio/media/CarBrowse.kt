package io.github.vjoy233.vradio.media

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import io.github.vjoy233.vradio.BootLib
import io.github.vjoy233.vradio.data.Library
import io.github.vjoy233.vradio.data.RadioTxt
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.player.PlayerHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/* 车机浏览宿主（B6）：MediaLibrarySession 库回调的提供者侧实现——数据源 = AppVm 活 Library
 * （attach 注入），UI 不在时退文件侧兜底（BootLib，B5 WidgetCommands 同款冷启模式）。
 * 线律：活 Library 的读快照收敛主线程（AppVm 审计 P2 口径——非线程安全集合与 Main 变异并发 CME），
 * 兜底库构建在 IO（发布后只读、无共享写者）；查询异步经 SettableFuture 回 ListenableFuture。
 * 不在车机提供维护、导入、体检、源地址和复杂搜索（§10 边界）。 */
object CarBrowse {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  @Volatile var live: Library? = null                      // AppVm 存活期注入
  @Volatile private var liveLogo: ((Station) -> String)? = null

  /** AppVm 装配（init）：活数据源 + 台标窥探（logos.get 同步口径） */
  fun attach(lib: Library, logoOf: (Station) -> String) { live = lib; liveLogo = logoOf }

  /** 车机点播解析兜底（VRadioApp.onCreate / AppVm.onCleared 装回）：文件侧库，只读、不写最近
   *  （与 AppVm 活实例双写互踩，widget 起播同款取舍——车机起播少记最近属可接受） */
  fun wireFallback(ctx: Context) {
    val app = ctx.applicationContext
    PlayerHolder.onCarStation = { u0 -> stationFallback(app, u0) }
  }

  /** 兜底解析（carPlay 在主线程调）：活库优先；文件侧库冷首点同步建（一次性，PlaybackService.onCreate 已预热） */
  private fun stationFallback(app: Context, u0: String): Station? = runCatching {
    val lib = live ?: BootLib.get(app) ?: return@runCatching null
    treeOf(lib).stationByU0(u0)
  }.getOrNull()

  /* ---------- MediaLibrarySession.Callback 三入口（PlayerHolder 委托至此） ---------- */

  fun root(app: Context, params: MediaLibraryService.LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> {
    val f = SettableFuture.create<LibraryResult<MediaItem>>()
    scope.launch {
      val lib = live ?: BootLib.get(app)
      withContext(Dispatchers.Main) {   // 固定 root：无数据也可浏览（空树呈现）
        f.set(if (lib == null) LibraryResult.ofError(LibraryResult.RESULT_ERROR_IO)
              else LibraryResult.ofItem(toItem(dirNode()), params))
      }
    }
    return f
  }

  fun children(app: Context, parentId: String, page: Int, pageSize: Int,
               params: MediaLibraryService.LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    val f = SettableFuture.create<LibraryResult<ImmutableList<MediaItem>>>()
    scope.launch {
      val lib = live ?: BootLib.get(app)
      withContext(Dispatchers.Main) {
        f.set(if (lib == null) LibraryResult.ofError(LibraryResult.RESULT_ERROR_IO) else run {
          val nodes = runCatching { treeOf(lib).children(parentId, page, pageSize) }.getOrDefault(emptyList())
          LibraryResult.ofItemList(nodes.map { toItem(it) }, params)
        })
      }
    }
    return f
  }

  fun item(app: Context, mediaId: String, params: MediaLibraryService.LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> {
    val f = SettableFuture.create<LibraryResult<MediaItem>>()
    scope.launch {
      val lib = live ?: BootLib.get(app)
      withContext(Dispatchers.Main) {
        f.set(if (lib == null) LibraryResult.ofError(LibraryResult.RESULT_ERROR_IO) else run {
          val n = runCatching { treeOf(lib).item(mediaId) }.getOrNull()
          if (n == null) LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE)   // 未知 id：查不到即错——车机不接受任意 URL
          else LibraryResult.ofItem(toItem(n), params)
        })
      }
    }
    return f
  }

  /* ---------- 内部 ---------- */

  /** 树快照（主线程读活库；正在播/连接中死台例外口径 = AppVm.playKey/connKey 同判） */
  private fun treeOf(lib: Library): MediaTree {
    val ui = PlayerHolder.ui.value
    val pk = if (ui.st == PState.PLAYING || ui.st == PState.PAUSED) ui.station?.key else null
    val ck = if (ui.st == PState.CONNECTING) ui.station?.key else null
    val myUrls = HashSet<String>()
    runCatching { for (s in RadioTxt.parse(lib.myText)) myUrls.addAll(s.u) }   // 个人台判定（≤500 行，毫秒级）
    val logo = liveLogo
    val isLive = lib === live
    return MediaTree.of(lib.stations, lib.favs.map { it.k }, lib.recents.map { it.k }, lib.cats(), myUrls,
      runCatching { lib.cfg.hideC.keys }.getOrDefault(emptySet()), pk, ck,
      logoOf = { s -> if (isLive && logo != null) runCatching { logo(s) }.getOrDefault("") else s.l })
  }

  private fun dirNode() = MNode(MediaTree.ID_ROOT, "VRadio")

  /** MNode → MediaItem：title=台名、artist=分类、artworkUri=台标（有则填）；叶子带 URI 供客户端展示，
   *  点播路径由 Fwd.carPlay 按 mediaId 拦截重定向 play() 决策链（onAddMediaItems 把 URI 一律改写库内
   *  u0、未知/非法 id 明确拒绝——AIbot P1，见 CarGate） */
  private fun toItem(n: MNode): MediaItem {
    val mb = MediaMetadata.Builder().setTitle(n.title)
      .setIsBrowsable(!n.playable).setIsPlayable(n.playable)
    if (n.sub.isNotEmpty()) mb.setArtist(n.sub)
    if (n.art.isNotEmpty()) mb.setArtworkUri(Uri.parse(n.art))
    val b = MediaItem.Builder().setMediaId(n.id).setMediaMetadata(mb.build())
    if (n.playable && n.uri.isNotEmpty()) b.setUri(n.uri)
    return b.build()
  }
}
