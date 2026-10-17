@file:OptIn(ExperimentalMaterial3Api::class)
package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* 本台最近播放浮层（web toggleSongHist 平移，B-7）：点 PlayerBar 曲名行呼出；
   当前曲显示在曲名行本身不入列，这里只有历史（每台 12 首 FIFO）。导出入口在设置页。 */
@Composable
fun SongsSheet(vm: AppVm, ui: PlayerUiState) {
  val pal = LocalVrPalette.current
  val s = ui.station
  val songs = if (s == null || s.u.isEmpty()) emptyList() else vm.songsOf(s.u0)
  ModalBottomSheet(onDismissRequest = { vm.showSongs.value = false }) {
    Column(Modifier.padding(horizontal = 16.dp).navigationBarsPadding()) {
      Text("本台最近播放", fontSize = 13.sp, color = pal.dim, modifier = Modifier.padding(bottom = 6.dp))
      if (songs.isEmpty()) {
        Text("暂无历史（换歌后自动记录）", fontSize = 13.sp, color = pal.dim, modifier = Modifier.padding(bottom = 16.dp))
      } else {
        songs.forEach { r ->
          Text(
            r.t, fontSize = 14.sp, color = pal.tx,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp),
          )
        }
      }
      Spacer(Modifier.height(16.dp))
    }
  }
}
