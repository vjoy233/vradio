package io.github.vjoy233.vradio.ui

/* 播放器控制件复用层（P2，方案 §7）：MiniPlayer/PlayerSheet 共用；bar 容器已由 MiniPlayer 取代
   （旧 fun PlayerBar 整条 bar 删除——P1 起 AppRoot 已换装 MiniPlayer，grep 确认无人调用）。
   sleepMenu/dragVol 等重复逻辑以本文件为准收编成单份（PlayerSheet 引用而非复制）；
   MiniPlayer 行内自清/播放钮与本文件同款实现是 P1 已知幂等双写，后续批次收敛（P2 不改 MiniPlayer.kt）。 */

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/** 主动作按钮：播放/暂停/连接中 spinner（≥48dp 命中区，size 52/72 档）。图标按 ui.st 映射——
 *  与 playerVisual 组合映射天然对齐（CONNECTING/PLAYING→action=PAUSE，PAUSED/IDLE→action=PLAY）。 */
@Composable
fun PlayPauseBtn(ui: PlayerUiState, size: Dp = 52.dp, onClick: () -> Unit) {
  val pal = LocalVrPalette.current
  Box(
    Modifier.size(size).clip(CircleShape).background(pal.bg).clickable(onClick = onClick)
      .semantics {   // P4 a11y：主钮按 playerVisual.action 同口径读「播放/暂停」（CONNECTING/PLAYING→暂停，PAUSED/IDLE→播放，§8.2.9）
        role = Role.Button
        contentDescription = if (ui.st == PState.PLAYING || ui.st == PState.CONNECTING) "暂停" else "播放"
      },
    contentAlignment = Alignment.Center,
  ) {
    when (ui.st) {
      PState.CONNECTING -> CircularProgressIndicator(modifier = Modifier.size(size * .42f), strokeWidth = 2.dp, color = pal.acc)
      PState.PLAYING -> PauseIcon(pal.acc, Modifier.size(size * .46f))
      else -> PlayIcon(pal.acc, Modifier.size(size * .46f))
    }
  }
}

/** 睡眠定时控件（E2 + P3-7，照抄旧 PlayerBar sleepMenu）：菜单一次点选 15/30/60；进行中点击直接取消；
 *  文案带 fmtLeft 倒计时（sleepLeftMs 由 PlayerHolder 每秒推进）。 */
@Composable
fun SleepControl(ui: PlayerUiState) {
  val pal = LocalVrPalette.current
  var menu by remember { mutableStateOf(false) }
  Box {
    TextButton(
      onClick = { if (ui.sleepLeftMs > 0) PlayerHolder.cancelSleep() else menu = !menu },
      modifier = Modifier.semantics { contentDescription = "睡眠定时" },   // P4 a11y（§8.2.9；剩余时长仍以可见文本为准）
    ) {
      Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(if (ui.sleepLeftMs > 0) fmtLeft(ui.sleepLeftMs) else "定时", fontSize = 13.sp)
        if (ui.sleepLeftMs > 0) Text("点击取消", fontSize = 9.sp, color = pal.dim)
      }
    }
    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
      listOf(15, 30, 60).forEach { m ->
        DropdownMenuItem(text = { Text("$m 分钟") }, onClick = { menu = false; PlayerHolder.sleep(m) })
      }
    }
  }
}

/** 音量行（联动 volperst 每台音量记忆）：静音文案点击切换 + 滑杆。
 *  dragVol 本地态防回环抖动——setVol→引擎回写 volPct 有延迟，拖动期用本地值渲染（旧 PlayerBar 同款）。 */
@Composable
fun VolumeControl(vm: AppVm, ui: PlayerUiState) {
  val pal = LocalVrPalette.current
  var dragVol by remember { mutableStateOf<Float?>(null) }
  Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
    Text(
      if (ui.volPct > 0) "音量" else "已静音", fontSize = 12.sp, color = pal.dim,
      modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable { vm.toggleMute() }.padding(4.dp),
    )
    Slider(
      value = dragVol ?: ui.volPct.toFloat(),
      onValueChange = { dragVol = it; vm.setVol(it.toInt()) },
      onValueChangeFinished = { dragVol = null },
      valueRange = 0f..100f,
      modifier = Modifier.weight(1f).padding(start = 6.dp, end = 6.dp).height(30.dp)
        .semantics { stateDescription = "音量 ${ui.volPct}%" },   // P4 a11y：音量百分比 state（§8.2.9）
    )
    Text("${ui.volPct}%", fontSize = 12.sp, color = pal.dim, modifier = Modifier.width(36.dp))
  }
}

/** 小型文字动作钮（次操作行/错误恢复行共用；color 缺省主题灰 dim）。 */
@Composable
fun ActText(text: String, modifier: Modifier = Modifier, color: Color? = null, onClick: () -> Unit) {
  val pal = LocalVrPalette.current
  TextButton(onClick = onClick, modifier = modifier) { Text(text, fontSize = 13.sp, color = color ?: pal.dim) }
}
