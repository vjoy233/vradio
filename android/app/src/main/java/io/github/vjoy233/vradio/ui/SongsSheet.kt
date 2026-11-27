@file:OptIn(ExperimentalMaterial3Api::class)
package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/* 本台歌曲历史浮层（web toggleSongHist 平移，B-7；§7 P2 容器标准化：标题「歌曲历史」+ 台名副标）：
   点 PlayerBar 曲名行/源详情「♪ 本台歌曲历史」呼出；数据源 vm.songsOf(s.u0) 不动（每台 12 首 FIFO）；
   当前曲显示在曲名行本身不入列，这里只有历史。导出入口在设置页。 */
@Composable
fun SongsSheet(vm: AppVm, ui: PlayerUiState) {
  val pal = LocalVrPalette.current
  val s = ui.station
  val songs = if (s == null || s.u.isEmpty()) emptyList() else vm.songsOf(s.u0)
  ModalBottomSheet(onDismissRequest = { vm.showSongs.value = false }) {
    Column(Modifier.padding(horizontal = 16.dp).navigationBarsPadding()) {
      Text("歌曲历史", fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = pal.tx)
      if (s != null) Text(s.n, fontSize = 12.sp, color = pal.dim, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(top = 2.dp))
      Spacer(Modifier.height(8.dp))
      if (songs.isEmpty()) {
        Text("暂无历史（换歌后自动记录）", fontSize = 13.sp, color = pal.dim, modifier = Modifier.padding(bottom = 16.dp))
      } else {
        songs.forEach { r ->
          Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(r.t, Modifier.weight(1f), fontSize = 14.sp, color = pal.tx,
              maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(songTime(r.at), fontSize = 11.sp, color = pal.dim)
          }
        }
      }
      Spacer(Modifier.height(16.dp))
    }
  }
}

/** 历史时间显示（§7 P2 可读性微调）：SongRec.at 原样 epoch 只在展示层格式化——今天=HH:mm、跨天=MM-dd HH:mm
 *  （存储格式不动， Locale.US 同 ListenStats.kt 先例）。 */
private fun songTime(at: Long, now: Long = System.currentTimeMillis()): String {
  val day = SimpleDateFormat("yyyyMMdd", Locale.US)
  val f = if (day.format(Date(at)) == day.format(Date(now))) SimpleDateFormat("HH:mm", Locale.US)
          else SimpleDateFormat("MM-dd HH:mm", Locale.US)
  return f.format(Date(at))
}
