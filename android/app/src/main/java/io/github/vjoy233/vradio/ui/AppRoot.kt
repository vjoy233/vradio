package io.github.vjoy233.vradio.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
   bottomBar 顶部（手机追加底栏、平板挂 rail，断点在契约内）；设置/添加电台是次级页，进同一 Scaffold
   content 槽渲染（review#45-1/#49-2 修订：不再全屏覆盖层——mini player/底栏/rail 全局常驻 §3.2/Q20，
   页面消费 pad 防遮挡；期间显式切目的地经 vm.navigate 自动收次级页）。
   浮层（选源/歌曲/源详情）仍由 root 统一挂载——切目的地/进出次级页不丢播放上下文；
   toast 走 SnackbarHost，与 status（用户主动操作，PlayerBar 内）分工不双写。
   返回键层级（Q21）：确认弹窗/浮层自收 → Full player（P2）→ 次级页（契约纯函数 backTarget）→ 系统默认；
   次级页开着才消费返回（收回次级页——期间目的地不可变，= 回到打开时的页，Q11）。
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
    val gate by vm.netGate.collectAsState()
    val scopeWarning by vm.healthScopeWarning.collectAsState()
    gate?.takeUnless { scopeWarning }?.let { (act, msg) ->
      ConfirmDialog(when (act) {
        io.github.vjoy233.vradio.network.NetGate.Act.SYNC -> "移动数据同步确认"
        io.github.vjoy233.vradio.network.NetGate.Act.LIGHT_UPDATE -> "移动数据更新确认"
        else -> "移动数据体检确认"
      }, msg, onOk = vm::proceedGate, onDismiss = vm::cancelGate)
    }
    if (scopeWarning) AlertDialog(onDismissRequest = {},
      title = { Text("电台体检范围可能不完整") },
      text = { Text("同步后的新增电台可能未全部体检；若同步曾中断，范围未知。建议手动进行全量体检。确认仅关闭提示，不代表体检已完成。") },
      confirmButton = { TextButton(onClick = vm::acknowledgeHealthScopeWarning) { Text("知道了") } })
    val freshPrompt by vm.freshnessPrompt.collectAsState()
    val freshAge by vm.freshnessAge.collectAsState()
    if (freshPrompt && !scopeWarning && gate == null) AlertDialog(onDismissRequest = vm::dismissFreshness,
      title = { Text(if (freshAge == "unknown") "电台数据更新时间未知" else "电台数据已有一段时间未同步") }, text = { Text("可手动同步检查最新数据。") },
      confirmButton = { TextButton(onClick = vm::syncFromFreshness) { Text("立即同步") } },
      dismissButton = { TextButton(onClick = vm::dismissFreshness) { Text("稍后") } })
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
        // P4 §7「内容最大宽度」：EXPANDED（rail）档列表内容限宽 720dp 居中（阅读宽度上限，拍板值 owner 可调）；
        // 发现页横滚卡片行保持全宽不设限；手机 COMPACT 无感（约束不生效）
        Destination.LIBRARY -> Box(Modifier.fillMaxSize().background(pal.bg), contentAlignment = Alignment.TopCenter) {
          Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) { StationScreen(vm, pad) }
        }
        Destination.FAVORITES -> Box(Modifier.fillMaxSize().background(pal.bg), contentAlignment = Alignment.TopCenter) {   // pad 收敛进屏内（与 LIBRARY 同构）：头部自理状态栏、StationContent/空态吃 bottomBar 让位
          Box(Modifier.widthIn(max = 720.dp).fillMaxSize()) { FavoritesScreen(vm, pad) }
        }
        Destination.DISCOVER -> DiscoveryScreen(vm, pad)   // P3 正式目的地（§5.4）：bg/pad/状态栏自理；flag 关时 navigateGuard 使其不可达
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
