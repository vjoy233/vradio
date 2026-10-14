package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette
import kotlinx.coroutines.delay

/* 电台列表（app.js render 面）：搜索（120ms 防抖）/分类条 chip+数量角标/网格+列表双视图/
   行内 ☆ 收藏/死台删除线+分档徽标/正在播高亮/连接中指示；LazyColumn/LazyVerticalGrid + key。 */
@Composable
fun StationList(vm: AppVm) {
  val pal = LocalVrPalette.current
  val lu by vm.listUi.collectAsState()
  val ui by PlayerHolder.ui.collectAsState()
  val cat by vm.cat.collectAsState()
  val view by vm.view.collectAsState()
  val showDead by vm.showDead.collectAsState()
  val favKeys by vm.favKeys.collectAsState()   // 行级收藏星状态源（在 items 外层捕获，改收藏才能逐行重渲）
  val locate by vm.locate.collectAsState()
  var flash by remember { mutableStateOf<String?>(null) }

  // 搜索：120ms 防抖（1600+ 台整表过滤不逐键跑）；外部清空（回到正在播）同步回输入框
  var q by rememberSaveable { mutableStateOf(vm.keyword.value) }
  LaunchedEffect(Unit) { vm.keyword.collect { k -> if (k != q.trim()) q = k } }
  LaunchedEffect(q) { delay(120); val t = q.trim(); if (t != vm.keyword.value) vm.keyword.value = t }

  // 回到正在播（N5）：滚动定位 + 高亮一闪（1s 后消退）
  val gridState = rememberLazyGridState()
  val listState = rememberLazyListState()
  LaunchedEffect(locate) {
    val k = locate ?: return@LaunchedEffect
    vm.locate.value = null
    val i = lu.list.indexOfFirst { it.key == k }
    if (i >= 0) {
      if (view == "grid") gridState.animateScrollToItem(i) else listState.animateScrollToItem(i)
      flash = k
    }
  }
  LaunchedEffect(flash) { if (flash != null) { delay(1000); flash = null } }

  Column(Modifier.fillMaxSize().background(pal.bg).statusBarsPadding()) {
    // 头部：标题 + 搜索 + 设置入口
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
      Text("VRadio", color = pal.acc, fontWeight = FontWeight.Bold, fontSize = 16.sp)
      OutlinedTextField(
        value = q, onValueChange = { q = it },
        modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
        singleLine = true,
        placeholder = { Text("搜索电台名", fontSize = 13.sp) },
      )
      TextButton(onClick = { vm.nav.value = Nav.SETTINGS }) { Text("设置") }
    }
    // 次行：双视图切换 + 无效源开关（出现过死台才亮，app.js deadBtn 同款）
    Row(Modifier.padding(horizontal = 12.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      SegBtn("网格", view == "grid") { vm.setView("grid") }
      SegBtn("列表", view == "list") { vm.setView("list") }
      if (lu.hasDead) SegBtn("✗ 无效源", showDead) { vm.toggleDead() }
    }
    // 分类条（数量角标与列表同口径刷新，P3-5）
    LazyRow(
      Modifier.fillMaxWidth().padding(vertical = 4.dp),
      contentPadding = PaddingValues(horizontal = 12.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      items(lu.chips, key = { it.first }) { (c, n) ->
        FilterChip(
          selected = c == cat, onClick = { vm.setCat(c) },
          label = { Row(verticalAlignment = Alignment.CenterVertically) { Text(c); Text(" $n", fontSize = 10.sp, color = pal.dim) } },
        )
      }
    }
    // 列表主体
    if (lu.list.isEmpty()) {
      Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text(lu.empty ?: "该分类暂无电台", color = pal.dim, modifier = Modifier.padding(24.dp))
      }
    } else if (view == "grid") {
      LazyVerticalGrid(
        columns = GridCells.Adaptive(160.dp), state = gridState,
        modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
        contentPadding = PaddingValues(bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp),
      ) { gridItems(lu.list, key = { it.key }) { s -> StationCard(vm, s, ui, flash, favKeys.contains(s.key), inCat(cat)) } }
    } else {
      LazyColumn(
        state = listState, modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
        contentPadding = PaddingValues(bottom = 12.dp),
      ) { items(lu.list, key = { it.key }) { s -> StationRow(vm, s, ui, flash, favKeys.contains(s.key), inCat(cat)) } }
    }
  }
}

/* 收藏星（命中区 ≥48dp；星色双主题分档） */
@Composable
private fun FavStar(on: Boolean, onClick: () -> Unit) {
  val pal = LocalVrPalette.current
  Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
    Text(
      if (on) "★" else "☆", fontSize = 22.sp,
      color = if (on) pal.star else pal.dim,
      modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(6.dp),
    )
  }
}

@Composable
private fun inCat(cat: String) = cat != "全部" && cat != "★收藏" && cat != "最近" // 分类视图（徽标里分类名 100% 冗余不显）

@Composable
private fun metaBadges(vm: AppVm, s: Station, inCat: Boolean) {
  val pal = LocalVrPalette.current
  Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
    if (s.health == "dead") VrBadge(if (vm.permOf(s)) "已停运" else "疑似不可达", 2)   // R1 分档分文案
    if (!inCat) VrBadge(s.c)                                            // 分类视图下 100% 冗余不显（P2-2）
    val (_, cn) = displayParts(s.n)
    if (cn != null) VrBadge(cn)
    if (s.u.size > 1) VrBadge("${s.u.size}源")
  }
}

/* 网格卡片：精简两行（台名+星 / 徽标行），正在播边框高亮 + ▶ 前缀；fav 由外层响应式传入（勿在行内直读 lib） */
@Composable
private fun StationCard(vm: AppVm, s: Station, ui: PlayerUiState, flash: String?, fav: Boolean, inCat: Boolean) {
  val pal = LocalVrPalette.current
  val k = s.key
  val playing = ui.station?.key == k && ui.st != PState.IDLE && ui.st != PState.CONNECTING
  val connecting = ui.station?.key == k && ui.st == PState.CONNECTING
  val (dn, _) = displayParts(s.n)
  val dead = s.health == "dead"
  val shape = RoundedCornerShape(10.dp)
  Column(
    Modifier.fillMaxWidth().clip(shape)
      .background(if (playing) pal.panel else Color.Transparent)
      .border(1.dp, when { flash == k || playing -> pal.acc; else -> pal.line }, shape)
      .clickable { vm.togglePlay(k) }.padding(10.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      StationLogo(vm.logoOf(s), s.n, 40.dp)
      Text(
        (if (playing) "▶ " else "") + dn,
        modifier = Modifier.weight(1f).padding(start = 8.dp),
        color = if (playing) pal.acc else pal.tx,
        fontWeight = if (playing) FontWeight.SemiBold else FontWeight.Medium,
        textDecoration = if (dead) TextDecoration.LineThrough else null,
        fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
      )
      if (dead) Text(" ✗", color = pal.warn, fontSize = 13.sp)
      FavStar(fav) { vm.toggleFav(s) }
    }
    Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
      metaBadges(vm, s, inCat)
      if (connecting) { PulseDot(pal.acc); Text("连接中", fontSize = 11.sp, color = pal.dim) }
    }
  }
}

/* 列表行：两行详情（台名/徽标），正在播底色高亮；fav 由外层响应式传入 */
@Composable
private fun StationRow(vm: AppVm, s: Station, ui: PlayerUiState, flash: String?, fav: Boolean, inCat: Boolean) {
  val pal = LocalVrPalette.current
  val k = s.key
  val playing = ui.station?.key == k && ui.st != PState.IDLE && ui.st != PState.CONNECTING
  val connecting = ui.station?.key == k && ui.st == PState.CONNECTING
  val (dn, _) = displayParts(s.n)
  val dead = s.health == "dead"
  Row(
    Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
      .background(when { flash == k -> pal.acc.copy(alpha = .12f); playing -> pal.panel; else -> Color.Transparent })
      .clickable { vm.togglePlay(k) }.padding(vertical = 2.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    FavStar(fav) { vm.toggleFav(s) }
    Column(Modifier.weight(1f)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        StationLogo(vm.logoOf(s), s.n, 22.dp)
        Text(
          (if (playing) "▶ " else "") + dn,
          modifier = Modifier.weight(1f).padding(start = 8.dp),
          color = if (playing) pal.acc else pal.tx.copy(alpha = if (dead) .45f else 1f),
          fontWeight = if (playing) FontWeight.SemiBold else FontWeight.Medium,
          textDecoration = if (dead) TextDecoration.LineThrough else null,
          fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        if (connecting) { PulseDot(pal.acc); Text(" 连接中", fontSize = 11.sp, color = pal.dim) }
      }
      Row(Modifier.padding(start = 30.dp, top = 1.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        metaBadges(vm, s, inCat)
      }
    }
  }
}
