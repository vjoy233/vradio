package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.ui.theme.LocalVrDimens
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* 收藏页（P0 最小投影版，方案 §5.5 的 P0 子集；P1 按 §5.5 全量升级：独立搜索/收藏内分类 chips/
   撤销 Snackbar/复用 StationContent）。数据 = vm.favorites（AppVm 按 fav 序解析投影，行内不直读 lib）；
   行交互与电台列表同款：整行点击 = 播放、右侧星标 = 取消收藏（48dp 命中区），台名剥 [国别] 后缀。 */
@Composable
fun FavoritesScreen(vm: AppVm) {
  val pal = LocalVrPalette.current
  val dims = LocalVrDimens.current
  val favs by vm.favorites.collectAsState()
  val favKeys by vm.favKeys.collectAsState()   // 行级收藏星状态源（items 外层捕获，改收藏才能逐行重渲）
  val ui by PlayerHolder.ui.collectAsState()
  Column(Modifier.fillMaxSize().background(pal.bg).statusBarsPadding()) {
    Text("收藏", color = pal.tx, fontWeight = FontWeight.Bold, fontSize = 17.sp,
      modifier = Modifier.padding(start = dims.page, top = 8.dp, bottom = 4.dp))
    if (favs.isEmpty()) {
      Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text("还没有收藏电台，去电台页长按或点星标收藏吧", color = pal.dim, modifier = Modifier.padding(24.dp))
      }
    } else {
      LazyColumn(
        Modifier.weight(1f).fillMaxWidth().padding(horizontal = dims.section),
        contentPadding = PaddingValues(bottom = 12.dp),
      ) { items(favs, key = { it.key }) { s -> FavRow(vm, s, ui, favKeys.contains(s.key)) } }
    }
  }
}

/* 收藏行：正在播底色高亮 + ▶ 前缀；fav 由外层响应式传入（勿在行内直读 lib，同电台列表纪律）；
   星标独立 48dp 命中区（点星不触发整行点播） */
@Composable
private fun FavRow(vm: AppVm, s: Station, ui: PlayerUiState, fav: Boolean) {
  val pal = LocalVrPalette.current
  val dims = LocalVrDimens.current
  val k = s.key
  val playing = ui.station?.key == k && ui.st != PState.IDLE && ui.st != PState.CONNECTING
  val (dn, _) = displayParts(s.n)
  Row(
    Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
      .background(if (playing) pal.panel else Color.Transparent)
      .clickable { vm.togglePlay(k) }.padding(vertical = 2.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    StationLogo(vm.logoOf(s), s.n, s.key, dims.control / 2)
    Column(Modifier.weight(1f).padding(start = 8.dp)) {
      Text(
        (if (playing) "▶ " else "") + dn,
        color = if (playing) pal.acc else pal.tx,
        fontWeight = if (playing) FontWeight.SemiBold else FontWeight.Medium,
        fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
      )
      Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        VrBadge(s.c)
        val (_, cn) = displayParts(s.n)
        if (cn != null) VrBadge(cn)
      }
    }
    StarBtn(fav) { vm.toggleFav(s) }
  }
}

/** 收藏星（命中区 = token control 48dp；星色双主题分档，与电台列表 FavStar 同款视觉） */
@Composable
private fun StarBtn(on: Boolean, onToggle: () -> Unit) {
  val pal = LocalVrPalette.current
  val dims = LocalVrDimens.current
  Box(Modifier.size(dims.control).clickable(onClick = onToggle), contentAlignment = Alignment.Center) {
    Text(if (on) "★" else "☆", fontSize = 22.sp, color = if (on) pal.star else pal.dim)
  }
}
