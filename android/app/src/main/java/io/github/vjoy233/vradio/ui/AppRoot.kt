package io.github.vjoy233.vradio.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStoreOwner
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette
import io.github.vjoy233.vradio.ui.theme.VrTheme

/* 根组件（P0 导航迁移，方案 §6.2/§6.4）：VrScaffold 承载三目的地（电台/发现/收藏）+ mini player 常驻
   bottomBar 顶部（手机追加底栏、平板挂 rail，断点在契约内）；设置/添加电台是次级页全屏覆盖层
   （secondary?.let 挂载在 VrScaffold 之后，自带不透明 bg 盖住目的地，不占顶层目的地）。
   浮层（选源/歌曲/源详情）仍由 root 统一挂载——切目的地/进出次级页不丢播放上下文；
   toast 走 SnackbarHost，与 status（用户主动操作，PlayerBar 内）分工不双写。
   返回键层级（Q21）：确认弹窗/浮层自收 → Full player（P2）→ 次级页（契约纯函数 backTarget）→ 系统默认；
   发现自 P3 起为正式目的地（DiscoveryScreen，§5.4），旧浮层与「✦ 发现」入口已删——不允许
   「新导航+旧浮层」混合态；flag 关（开发态改 false）时 navigateGuard 使发现目的地不可达。
   vm 经 ViewModelProvider 直取（不引 lifecycle-viewmodel-compose）。 */
@Composable
fun AppRoot() {
  val owner = LocalContext.current as ViewModelStoreOwner
  val vm = remember(owner) { ViewModelProvider(owner)[AppVm::class.java] }
  val theme by vm.theme.collectAsState()
  VrTheme(theme) {
    val pal = LocalVrPalette.current
    val destination by vm.destination.collectAsState()
    val secondary by vm.secondary.collectAsState()
    val showPlayer by vm.playerExpanded.collectAsState()
    val showSrc by vm.showSrc.collectAsState()
    val showSongs by vm.showSongs.collectAsState()
    val showDetail by vm.showDetail.collectAsState()
    val detailDiag by vm.detailDiag.collectAsState()
    val detailBusy by vm.detailBusy.collectAsState()
    val ui by PlayerHolder.ui.collectAsState()
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { vm.toasts.collect { snack.showSnackbar(it) } }
    // 撤销 Snackbar（Q17，§5.5）：favUndoReq 非空即弹「已取消收藏」+ 撤销动作；Long≈10s（Material3
    // 无 8s 档，取 Long ≈「约 8 秒」口径）；点撤销走 undoUnfav（URL 身份回绑）；结束清载荷
    // （守卫：期间又发了新星标请求则不清——请求被更新值覆盖，旧 effect 不得误清）
    val favUndoReq by vm.favUndoReq.collectAsState()
    LaunchedEffect(favUndoReq) {
      val st = favUndoReq ?: return@LaunchedEffect
      val r = snack.showSnackbar("已取消收藏：${displayParts(st.n).first}", actionLabel = "撤销", duration = SnackbarDuration.Long)
      if (r == SnackbarResult.ActionPerformed) vm.undoUnfav(st)
      if (vm.favUndoReq.value == st) vm.favUndoReq.value = null
    }
    // Q15 切目的地收起搜索（搜索词保留、展开态收起，回台页有词自动再展开是 StationScreen 既有逻辑）；
    // 离开收藏页撤销作废（§5.5）：dismiss 在飞 Snackbar + 清载荷——到站即失效，不留「幽灵撤销」
    LaunchedEffect(destination) {
      vm.searchExpanded.value = false
      if (destination != Destination.FAVORITES) {
        snack.currentSnackbarData?.dismiss()
        vm.favUndoReq.value = null
      }
    }
    VrScaffold(destination, vm::navigate, miniPlayer = { MiniPlayer(vm, ui) }, snackbarHost = { SnackbarHost(snack) }) { pad ->
      // P4 §7「内容最大宽度」：EXPANDED（rail）档列表内容限宽 720dp 居中（阅读宽度上限，拍板值 owner 可调）；
      // 发现页横滚卡片行保持全宽不设限；手机 COMPACT 无感（约束不生效）
      when (destination) {
        Destination.LIBRARY -> Box(Modifier.fillMaxSize().background(pal.bg), contentAlignment = Alignment.TopCenter) {
          Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) { StationScreen(vm, pad) }
        }
        Destination.FAVORITES -> Box(Modifier.fillMaxSize().background(pal.bg), contentAlignment = Alignment.TopCenter) {   // pad 收敛进屏内（与 LIBRARY 同构）：头部自理状态栏、StationContent/空态吃 bottomBar 让位
          Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) { FavoritesScreen(vm, pad) }
        }
        Destination.DISCOVER -> DiscoveryScreen(vm, pad)   // P3 正式目的地（§5.4）：bg/pad/状态栏自理；flag 关时 navigateGuard 使其不可达
      }
    }
    // 次级页全屏覆盖层：SettingsScreen/AddStationScreen 自带不透明 bg + statusBarsPadding，直接盖在目的地之上
    secondary?.let { r ->
      when (r) {
        SecondaryRoute.SETTINGS -> SettingsScreen(vm)
        SecondaryRoute.ADD_STATION -> AddStationScreen(vm)
      }
    }
    // Full player（P2 §5.3）：先于选源/歌史 sheet 挂载——从 full player 开选源时后组合者浮在上层
    if (showPlayer) PlayerSheet(vm, ui)
    if (showSrc) SrcSheet(vm, ui)
    if (showSongs) SongsSheet(vm, ui)
    // B1 源详情浮层：台消失（同步/导入重建）即自动收起；fav/logo 经 vm 注入（浮层本身不持 vm）
    if (showDetail) {
      val ds = vm.detailStation()
      if (ds == null) LaunchedEffect(Unit) { vm.closeDetail() }
      else SourceDetailSheet(
        station = ds, player = ui, diagnostics = detailDiag,
        onCheck = { vm.checkDetailSources(ds) },
        onPlay = { i -> vm.startPlay(ds, i) },
        onEdit = { vm.srcEdit(ds, it) },
        fav = vm.favKeys.value.contains(ds.key),
        checking = detailBusy,
        onSongs = { vm.closeDetail(); vm.showSongs.value = true },
        logo = vm.logoOf(ds),
        quality = vm.qualitySummaryOf(ds),   // B2 稳定性徽标行（无样本 null 不渲染）
        onDismiss = { vm.closeDetail() },
      )
    }
    // 返回层级（Q21：确认弹窗→Full Player/详情 sheet→设置/添加页→原顶层页）：确认弹窗与各 ModalBottomSheet
    // 自收（scrim/对话框窗口自消费返回，先序于此）；这里按「Full player → 次级页」顺序消费
    BackHandler(enabled = showPlayer) { vm.closePlayer() }
    val back = backTarget(secondary, destination)
    BackHandler(enabled = !showPlayer && back != null) { vm.closeSecondary() }
  }
}
