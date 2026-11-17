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

/* 根布局（P0，方案 §6.2 + §3.3）：mini player 常驻——slot 注入（决策记录 §1.3）。
   COMPACT（手机）：mini player + 底栏叠放于 Scaffold bottomBar（现状口径，pad 承载两者实高）。
   EXPANDED（平板/横屏）：按 §3.3「播放条横跨内容区底部，不覆盖 rail」——rail 全高在左，
   mini player 只放内容列底部（review#49 P1 修订：§6.2 骨架的底栏横跨全宽与 §3.3 冲突，采纳 §3.3），
   内容区与 mini player 用布局层叠（Column 压栈）而非 padding 补偿。
   contentWindowInsets 沿用 (0,0,0,0)：各 Screen 自理状态栏 padding——不写固定底部 padding。 */
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
      if (window == VrWindow.COMPACT) {
        Column {
          miniPlayer()
          VrBottomNav(destination, onNavigate)
        }
      }
    },
  ) { pad ->
    Row(Modifier.fillMaxSize()) {
      if (window == VrWindow.EXPANDED) VrNavigationRail(destination, onNavigate)
      if (window == VrWindow.EXPANDED) {
        // §3.3：mini player 只在内容列底部（rail 不被覆盖）；navigationBarsPadding 防三键导航遮挡（MiniPlayer 自身 EXPANDED 档口径延续）
        Column(Modifier.weight(1f).fillMaxHeight()) {
          Box(Modifier.weight(1f).fillMaxHeight()) { content(pad) }
          Box { miniPlayer() }
        }
      } else {
        Box(Modifier.weight(1f).fillMaxHeight()) { content(pad) }
      }
    }
  }
}
