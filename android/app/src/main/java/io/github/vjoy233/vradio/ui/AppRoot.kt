package io.github.vjoy233.vradio.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStoreOwner
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette
import io.github.vjoy233.vradio.ui.theme.VrTheme

/* 根组件（P0 导航迁移，方案 §6.2/§6.4）：VrScaffold 承载三目的地（电台/发现/收藏）+ mini player 常驻
   bottomBar 顶部（手机追加底栏、平板挂 rail，断点在契约内）；设置/添加电台是次级页全屏覆盖层
   （secondary?.let 挂载在 VrScaffold 之后，自带不透明 bg 盖住目的地，不占顶层目的地）。
   浮层（选源/歌曲/发现/源详情）仍由 root 统一挂载——切目的地/进出次级页不丢播放上下文；
   toast 走 SnackbarHost，与 status（用户主动操作，PlayerBar 内）分工不双写。
   返回键走契约纯函数 backTarget：次级页开着才消费返回（收回次级页回来源目的地）；
   确认弹窗/浮层由各自窗口自收，先序于本 BackHandler。发现关（FeatureFlags.DISCOVERY=false）时
   navigateGuard 使发现目的地不可达。vm 经 ViewModelProvider 直取（不引 lifecycle-viewmodel-compose）。 */
@Composable
fun AppRoot() {
  val owner = LocalContext.current as ViewModelStoreOwner
  val vm = remember(owner) { ViewModelProvider(owner)[AppVm::class.java] }
  val theme by vm.theme.collectAsState()
  VrTheme(theme) {
    val pal = LocalVrPalette.current
    val destination by vm.destination.collectAsState()
    val secondary by vm.secondary.collectAsState()
    val showSrc by vm.showSrc.collectAsState()
    val showSongs by vm.showSongs.collectAsState()
    val showDetail by vm.showDetail.collectAsState()
    val detailDiag by vm.detailDiag.collectAsState()
    val detailBusy by vm.detailBusy.collectAsState()
    val ui by PlayerHolder.ui.collectAsState()
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { vm.toasts.collect { snack.showSnackbar(it) } }
    VrScaffold(destination, vm::navigate, miniPlayer = { MiniPlayer(vm, ui) }, snackbarHost = { SnackbarHost(snack) }) { pad ->
      when (destination) {
        Destination.LIBRARY -> Box(Modifier.fillMaxSize().background(pal.bg)) { StationScreen(vm, pad) }
        Destination.FAVORITES -> Box(Modifier.fillMaxSize().background(pal.bg).padding(pad)) { FavoritesScreen(vm) }
        Destination.DISCOVER -> Box(Modifier.fillMaxSize().background(pal.bg).padding(pad)) { }   // P3 填 DiscoveryScreen（§7）；flag 关时 navigateGuard 使其不可达
      }
    }
    // 次级页全屏覆盖层：SettingsScreen/AddStationScreen 自带不透明 bg + statusBarsPadding，直接盖在目的地之上
    secondary?.let { r ->
      when (r) {
        SecondaryRoute.SETTINGS -> SettingsScreen(vm)
        SecondaryRoute.ADD_STATION -> AddStationScreen(vm)
      }
    }
    if (showSrc) SrcSheet(vm, ui)
    if (showSongs) SongsSheet(vm, ui)
    // B3-C 发现浮层：开关控制入口（StationList 的「✦ 发现」按钮）与浮层挂载
    if (io.github.vjoy233.vradio.FeatureFlags.DISCOVERY) {
      val showDisc by vm.showDiscovery.collectAsState()
      if (showDisc) DiscoverySheet(vm)
    }
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
    // 返回裁决（契约纯函数 §6.4）：次级页开着才消费返回——收回次级页；无次级页不消费（系统默认行为）
    val back = backTarget(secondary, destination)
    BackHandler(enabled = back != null) { vm.closeSecondary() }
  }
}
