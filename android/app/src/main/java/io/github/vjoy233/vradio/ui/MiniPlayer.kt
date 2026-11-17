package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.ui.theme.LocalVrDimens
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* Mini player 常驻槽（P1，方案 §5.2）：PlayerBar「所有动作平铺」收敛为「一个主动作 + 两个上下文动作」——
   左台标 40dp / 中列台名+曲讯副行（单击展开 full player（P2 接 PlayerSheet，先开 playerExpanded flow 位）/
   长按源详情入口保留）/ 右播放暂停 48dp（连接中 spinner；空台 ▶ = 续播上次收听）。
   睡眠/选源/刷新/分享/收藏切台全部上收 full player 动作区（P2 落），本条只留主动作（§5.2 Q9）。
   状态映射与 PlayerBar 同源（PlayerHolder.ui），P2 抽公共 playerVisual 映射；
   status 只读（review#46/#47 P1：6s TTL 单一所有者在 AppVm.setStatus，UI 层自清协程已删）。
   COMPACT 档 mini player 上叠在底栏之上、下方 NavigationBar 自理导航条 inset；EXPANDED 档
   mini player 即屏幕底缘，补 navigationBarsPadding（三键导航不遮播放钮）。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MiniPlayer(vm: AppVm, ui: PlayerUiState) {
  val pal = LocalVrPalette.current
  val dim = LocalVrDimens.current
  val vstatus by vm.status.collectAsState()   // 只读兜底链展示（TTL 自清在 AppVm.setStatus，UI 不写）
  val window = rememberVrWindow()
  Column(
    Modifier.fillMaxWidth().background(pal.panel)
      .then(if (window == VrWindow.EXPANDED) Modifier.navigationBarsPadding() else Modifier)
      .height(dim.miniPlayer),
  ) {
    HorizontalDivider(color = pal.line)   // 顶部 1dp 分隔线
    Row(Modifier.fillMaxSize().padding(horizontal = dim.page), verticalAlignment = Alignment.CenterVertically) {
      val st = ui.station
      // 左：台标 40dp（无台不渲染）
      if (st != null) StationLogo(vm.logoOf(st), st.n, st.key, 40.dp)
      // 中列：台名 + 曲讯/状态兜底链（fillMaxHeight = 全行命中区 ≥48dp；单击展开 full player / 长按源详情）
      Column(
        Modifier.weight(1f).fillMaxHeight().padding(horizontal = 8.dp)
          .combinedClickable(
            enabled = st != null,
            onClick = { vm.openPlayer() },
            onLongClick = { vm.openDetailOf(ui.station?.key) },
          ),
        verticalArrangement = Arrangement.Center,
      ) {
        val (dn, _) = displayParts(st?.n ?: vm.lastLine())
        Text(
          dn, maxLines = 1, overflow = TextOverflow.Ellipsis,
          fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = pal.tx,
        )
        val song = if (ui.song.isNotEmpty()) "♪ ${ui.song}" + (if (ui.kbps > 0) " · ${ui.kbps}kbps" else "") else ""
        val line2 = song.ifEmpty { vstatus.ifEmpty { ui.status } }
          .ifEmpty { st?.let { "VRadio · ${it.c}" } ?: "" }        // 无曲讯/状态时露出分类（HLS 结构性无 ICY 显示空不是 bug）
        Box(Modifier.height(17.dp)) {
          Text(line2, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 12.sp, color = pal.dim)
        }
      }
      // 右：播放/暂停 48dp（连接中 spinner；未播放时 ▶ = 续播上次收听）
      Box(
        Modifier.size(48.dp).clip(CircleShape).background(pal.bg).clickable {
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
    }
  }
}
