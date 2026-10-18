package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.PlayerUiState
import kotlinx.coroutines.delay
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* 底部常驻播放条（index.html footer 平移）：台名（点击回到正在播）/曲名行「♪ 歌名 · Nkbps」（点击看本台歌史）/
   播放/暂停（≥48dp 命中区，连接中出 spinner）/睡眠定时菜单（15/30/60，进行中再点取消）/选源入口（多源台）/
   音量滑杆（联动每台音量记忆）。status 行 = 用户主动操作反馈（vm.status）优先、引擎状态文案兜底。 */
@Composable
fun PlayerBar(vm: AppVm, ui: PlayerUiState) {
  val pal = LocalVrPalette.current
  val vstatus by vm.status.collectAsState()
  // AIbot P2-2：用户操作反馈（「已静音」等）6s 自清——否则永久压住引擎的「直播中/连接中…」文案
  LaunchedEffect(vstatus) { if (vstatus.isNotEmpty()) { delay(6000); vm.status.value = "" } }
  var sleepMenu by remember { mutableStateOf(false) }
  var dragVol by remember { mutableStateOf<Float?>(null) }

  Column(
    Modifier.fillMaxWidth().background(pal.panel).imePadding().navigationBarsPadding(),
  ) {
    HorizontalDivider(color = pal.line)
    Row(Modifier.padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
      // 播放/暂停/连接中（未播放时 ▶ = 续播上次收听）
      Box(
        Modifier.size(52.dp).clip(CircleShape).background(pal.bg).clickable {
          if (ui.station == null) vm.resumeLast() else PlayerHolder.toggle()
        },
        contentAlignment = Alignment.Center,
      ) {
        when (ui.st) {
          PState.CONNECTING -> CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp, color = pal.acc)
          PState.PLAYING -> PauseIcon(pal.acc, Modifier.size(24.dp))
          else -> PlayIcon(pal.acc, Modifier.size(24.dp))
        }
      }
      // 台名 + 曲名/状态（台名可点定位列表行，N5）
      Column(
        Modifier.weight(1f).padding(horizontal = 6.dp)
          .clickable(enabled = ui.station != null) { vm.locatePlaying() },
      ) {
        Text(
          ui.station?.n ?: vm.lastLine(),
          maxLines = 1, overflow = TextOverflow.Ellipsis,
          fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = pal.tx,
        )
        val song = if (ui.song.isNotEmpty()) "♪ ${ui.song}" + (if (ui.kbps > 0) " · ${ui.kbps}kbps" else "") else ""
        val line2 = song.ifEmpty { vstatus.ifEmpty { ui.status } }
          .ifEmpty { ui.station?.let { "VRadio · ${it.c}" } ?: "" }        // 无曲讯/状态时露出分类（HLS 结构性无 ICY 显示空不是 bug）
        Box(Modifier.height(17.dp)) {
          Text(
            line2,
            maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp, color = pal.dim,
            modifier = if (song.isNotEmpty()) Modifier.clickable { vm.showSongs.value = true } else Modifier,   // 点曲名行看本台歌史（B-7）
          )
        }
      }
      // 睡眠定时（E2 + P3-7）：菜单一次点选 15/30/60；进行中点击直接取消
      Box {
        TextButton(onClick = {
          if (ui.sleepLeftMs > 0) PlayerHolder.cancelSleep() else sleepMenu = !sleepMenu
        }) {
          Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(if (ui.sleepLeftMs > 0) fmtLeft(ui.sleepLeftMs) else "定时", fontSize = 13.sp)
            if (ui.sleepLeftMs > 0) Text("点击取消", fontSize = 9.sp, color = pal.dim)
          }
        }
        DropdownMenu(expanded = sleepMenu, onDismissRequest = { sleepMenu = false }) {
          listOf(15, 30, 60).forEach { m ->
            DropdownMenuItem(text = { Text("$m 分钟") }, onClick = { sleepMenu = false; PlayerHolder.sleep(m) })
          }
        }
      }
      // 选源入口（②a）：多源台且播/暂停中才亮（按次渲染动态判定）
      val st = ui.station
      if (st != null && st.u.size > 1) {
        TextButton(onClick = { vm.openSrc() }) { Text("源") }
      }
      // 手动刷新回直播头（plan-refresh-live §4.2）：有台即亮；当前源整链重开，连接中指示由 play 链自带
      if (st != null) {
        TextButton(onClick = { PlayerHolder.refresh() }) { Text("刷新") }
      }
      // N8 分享电台（batch1）：ACTION_SEND 台名+主源 URL，任何播放器可开
      if (st != null) {
        TextButton(onClick = { vm.shareStation(st) }) { Text("分享") }
      }
    }
    // 音量行：静音切换 + 滑杆（联动 volperst；拖动本地态防回环抖动）
    Row(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
      Text(
        if (ui.volPct > 0) "音量" else "已静音", fontSize = 12.sp, color = pal.dim,
        modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable { vm.toggleMute() }.padding(4.dp),
      )
      Slider(
        value = dragVol ?: ui.volPct.toFloat(),
        onValueChange = { dragVol = it; vm.setVol(it.toInt()) },
        onValueChangeFinished = { dragVol = null },
        valueRange = 0f..100f,
        modifier = Modifier.weight(1f).padding(start = 6.dp, end = 6.dp).height(30.dp),
      )
      Text("${ui.volPct}%", fontSize = 12.sp, color = pal.dim, modifier = Modifier.width(36.dp))
    }
  }
}
