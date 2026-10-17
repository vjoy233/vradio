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
    BackHandler(enabled = nav != Nav.LIST) { vm.nav.value = Nav.LIST }
  }
}
