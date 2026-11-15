package io.github.vjoy233.vradio.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
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

/* 根组件：单 Activity Compose、无导航库（手写 Nav 枚举：列表/设置/添加电台；浮层 = ModalBottomSheet）。
   toast（后台任务通告）走 SnackbarHost，与 status（用户主动操作，PlayerBar 内）分工不双写。
   返回键：设置/添加页回列表；浮层由 ModalBottomSheet 自收（onDismissRequest 同步 vm 态）。
   vm 经 ViewModelProvider 直取（不引 lifecycle-viewmodel-compose——依赖白名单封闭清单制）。 */
@Composable
fun AppRoot() {
  val owner = LocalContext.current as ViewModelStoreOwner
  val vm = remember(owner) { ViewModelProvider(owner)[AppVm::class.java] }
  val theme by vm.theme.collectAsState()
  VrTheme(theme) {
    val pal = LocalVrPalette.current
    val nav by vm.nav.collectAsState()
    val showSrc by vm.showSrc.collectAsState()
    val showSongs by vm.showSongs.collectAsState()
    val showDetail by vm.showDetail.collectAsState()
    val detailDiag by vm.detailDiag.collectAsState()
    val detailBusy by vm.detailBusy.collectAsState()
    val ui by PlayerHolder.ui.collectAsState()
    val snack = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { vm.toasts.collect { snack.showSnackbar(it) } }
    Scaffold(
      containerColor = pal.bg,
      contentWindowInsets = WindowInsets(0, 0, 0, 0),   // 手动 pad（edge-to-edge 下防双重内边距）
      snackbarHost = { SnackbarHost(snack) },
      bottomBar = { PlayerBar(vm, ui) },
    ) { pad ->
      Box(Modifier.fillMaxSize().background(pal.bg).padding(pad)) {
        when (nav) {
          Nav.LIST -> StationList(vm)
          Nav.SETTINGS -> SettingsScreen(vm)
          Nav.ADD -> AddStationScreen(vm)
        }
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
    BackHandler(enabled = nav != Nav.LIST) { vm.nav.value = Nav.LIST }
  }
}
