package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* 根布局（P0，方案 §6.2）：mini player 常驻 bottomBar 顶部——slot 注入（决策记录 §1.3/§1.4：
   P0 过渡期由 AppRoot 注入现有 PlayerBar 零行为回归，P1 换 MiniPlayer 替换点单一）。
   手机 <600dp 追加底栏；平板/横屏 >=600dp 内容区左缘挂 rail（§6.2 骨架口径）。
   contentWindowInsets 沿用 (0,0,0,0)：各 Screen 自理状态栏 padding，pad 只承载 bottomBar 实高——不写固定底部 padding。 */
@Composable
fun VrScaffold(
  destination: Destination,
  onNavigate: (Destination) -> Unit,
  miniPlayer: @Composable () -> Unit,
  snackbarHost: @Composable () -> Unit = {},
  content: @Composable (PaddingValues) -> Unit,
) {
  val pal = LocalVrPalette.current
  val window = rememberVrWindow()
  Scaffold(
    containerColor = pal.bg,
    contentWindowInsets = WindowInsets(0, 0, 0, 0),
    snackbarHost = { snackbarHost() },
    bottomBar = {
      Column {
        miniPlayer()
        if (window == VrWindow.COMPACT) VrBottomNav(destination, onNavigate)
      }
    },
  ) { pad ->
    Row(Modifier.fillMaxSize()) {
      if (window == VrWindow.EXPANDED) VrNavigationRail(destination, onNavigate)
      Box(Modifier.weight(1f).fillMaxHeight()) { content(pad) }
    }
  }
}
