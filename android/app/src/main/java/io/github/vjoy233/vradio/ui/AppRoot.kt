package io.github.vjoy233.vradio.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
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
   bottomBar 顶部（手机追加底栏、平板挂 rail，断点在契约内）；设置/添加电台是次级页，进同一 Scaffold
   content 槽渲染（review#45-1/#49-2 修订：不再全屏覆盖层——mini player/底栏/rail 全局常驻 §3.2/Q20，
   页面消费 pad 防遮挡；期间显式切目的地经 vm.navigate 自动收次级页）。
   浮层（选源/歌曲/发现/源详情）仍由 root 统一挂载——切目的地/进出次级页不丢播放上下文；
   toast 走 SnackbarHost，与 status（用户主动操作，PlayerBar 内）分工不双写。
   返回键走契约纯函数 backTarget：次级页开着才消费返回（收回次级页——期间目的地不可变，= 回到打开时的页，Q11）；
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
    // 撤销 Snackbar（Q17，§5.5）：撤销事件队列顺序消费——每条独立弹「已取消收藏」+ 撤销动作（review#46
    // 二轮 P2：带 operationId 逐操作入队，快速连续取消不互相覆盖）；Long≈10s（Material3 无 8s 档，
    // 取 Long ≈「约 8 秒」口径）；点撤销走 undoUnfav（URL 身份回绑）；消费完一条再收下一条
    LaunchedEffect(Unit) {
      vm.favUndoEvents.collect { ev ->
        val r = snack.showSnackbar("已取消收藏：${displayParts(ev.station.n).first}", actionLabel = "撤销", duration = SnackbarDuration.Long)
        if (r == SnackbarResult.ActionPerformed) vm.undoUnfav(ev.station)
      }
    }
    // Q15 切目的地收起搜索（搜索词保留、展开态收起，回台页有词自动再展开是 StationScreen 既有逻辑）；
    // 离开收藏页撤销作废（§5.5）：dismiss 在飞 Snackbar + 清载荷——到站即失效，不留「幽灵撤销」
    LaunchedEffect(destination) {
      vm.searchExpanded.value = false
      if (destination != Destination.FAVORITES) {
        snack.currentSnackbarData?.dismiss()   // 在飞 Snackbar 作废
        vm.clearFavUndo()                       // 未消费事件排空（Q17 离开收藏页失效）
      }
    }
    VrScaffold(destination, vm::navigate, miniPlayer = { MiniPlayer(vm, ui) }, snackbarHost = { SnackbarHost(snack) }) { pad ->
      val sec = secondary
      if (sec != null) {
        // 次级页进 content 槽（review#45-1/#49-2）：自带不透明 bg + statusBarsPadding，消费 pad 防底栏遮挡
        when (sec) {
          SecondaryRoute.SETTINGS -> Box(Modifier.fillMaxSize().background(pal.bg)) { SettingsScreen(vm, pad) }
          SecondaryRoute.ADD_STATION -> Box(Modifier.fillMaxSize().background(pal.bg)) { AddStationScreen(vm, pad) }
        }
      } else when (destination) {
        Destination.LIBRARY -> Box(Modifier.fillMaxSize().background(pal.bg)) { StationScreen(vm, pad) }
        Destination.FAVORITES -> Box(Modifier.fillMaxSize().background(pal.bg)) { FavoritesScreen(vm, pad) }   // pad 收敛进屏内（与 LIBRARY 同构）：头部自理状态栏、StationContent/空态吃 bottomBar 让位
        Destination.DISCOVER -> Box(Modifier.fillMaxSize().background(pal.bg).padding(pad)) { }   // P3 填 DiscoveryScreen（§7）；flag 关时 navigateGuard 使其不可达
      }
    }
    if (showSrc) SrcSheet(vm, ui)
    if (showSongs) SongsSheet(vm, ui)
    // B3-C 发现浮层：开关控制入口（StationScreen 的「✦ 发现」按钮）与浮层挂载
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
