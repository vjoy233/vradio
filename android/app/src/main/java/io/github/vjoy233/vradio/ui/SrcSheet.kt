@file:OptIn(ExperimentalMaterial3Api::class)
package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* 选源浮层（web footer #srcMenu 平移，②a/grill 拍板）：正在听的多源台一键切源——
   整行点选立即切播（一律立即起播，暂停态同）、徽标（默认/正在用/追加）、底部「↺ 恢复默认源」
   （forgetSrc + 重播；记忆源=默认源时按钮自指不渲染）。 */
@Composable
fun SrcSheet(vm: AppVm, ui: PlayerUiState) {
  val pal = LocalVrPalette.current
  val s = ui.station
  if (s == null) {                                                        // 切台后浮层过期即收起（防 stale 引用）
    LaunchedEffect(Unit) { vm.showSrc.value = false }
    return
  }
  val dft = vm.srcDefault(s)
  val mem = PlayerHolder.srcmemOf(s)
  ModalBottomSheet(onDismissRequest = { vm.showSrc.value = false }) {
    Column(Modifier.padding(horizontal = 16.dp).navigationBarsPadding()) {
      Text(
        "${s.n} · ${s.u.size} 个源，点行切换（失败自动顺延）",
        fontSize = 12.sp, color = pal.dim,
        modifier = Modifier.padding(bottom = 6.dp),
      )
      s.u.forEachIndexed { i, u ->
        val cur = ui.station?.key == s.key && ui.srcIdx == i
        Row(
          Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
            .clickable { vm.showSrc.value = false; vm.startPlay(s, i) }
            .padding(vertical = 10.dp, horizontal = 4.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          Text("${i + 1}", color = pal.dim, fontSize = 12.sp, modifier = Modifier.width(20.dp))
          Text(
            u, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
            fontSize = 12.sp, color = if (cur) pal.acc else pal.tx.copy(alpha = .85f),
          )
          if (i == dft) VrBadge("默认")
          if (cur) VrBadge("正在用", 1)
          if (!s.dU.contains(u)) VrBadge("追加")
        }
      }
      if (mem in s.u.indices && mem != dft) {                             // 记忆=默认时清了又记回同源，不渲染（AIbot P3-1）
        Row(
          Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
            .clickable { vm.showSrc.value = false; vm.srcReset() }
            .padding(vertical = 10.dp, horizontal = 4.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) { Text("↺ 恢复默认源（忘掉源 ${mem + 1} 的记忆）", fontSize = 13.sp, color = pal.acc, fontWeight = FontWeight.Medium) }
      }
      Spacer(Modifier.height(16.dp))
    }
  }
}
