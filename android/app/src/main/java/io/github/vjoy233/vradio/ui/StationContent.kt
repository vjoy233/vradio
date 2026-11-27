package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette
import kotlinx.coroutines.delay

/* 列表主体纯投影（P1，方案 §5.1/§5.5）：只按入参渲染，不读页面级筛选态（收藏页复用——传另一个
   list/inCat 即可）。空态沿用旧文案；LazyVerticalGrid(GridCells.Adaptive(160.dp))/LazyColumn 双主体
   + 稳定 key；StationCard/StationRow/FavStar/metaBadges 私有件自旧 StationList 原样搬移；
   locate 滚动定位 + 高亮一闪也在此（G P3：(locate, list) 联合触发）。
   onFavToggle 注入（review#46 P1）：收藏动作分派——收藏页传 vm.unfavWithUndo（取消收藏+撤销载荷
   由 AppVm 单一产生），默认 null = 电台页原 vm.toggleFav 语义；星标 onClick 与行/卡长按统一走此分派。
   详情入口（§5.1「详情图标」，review#46 P2）：卡/行各挂 48dp 命中区「ⓘ」钮 = vm.openDetailOf(key)。
   pad = 根导航 bottomBar 实高（VrScaffold contentWindowInsets 0 口径）——根部吃掉，最后一行不被遮。 */
@Composable
fun StationContent(
  vm: AppVm, pad: PaddingValues, list: List<Station>, empty: String?, hasDead: Boolean,   // hasDead 投影位（收藏页复用；空态暂只沿用旧文案）
  grid: Boolean, gridState: LazyGridState, listState: LazyListState, locate: String?,
  inCat: Boolean = false, onFavToggle: ((Station) -> Unit)? = null, modifier: Modifier = Modifier,
) {
  val pal = LocalVrPalette.current
  val ui by PlayerHolder.ui.collectAsState()   // 全局播放态（与 PlayerBar 同源，PlayerHolder.ui）
  val favKeys by vm.favKeys.collectAsState()   // 行级收藏星状态源（在 items 外层捕获，改收藏才能逐行重渲）
  val favToggle: (Station) -> Unit = onFavToggle ?: { vm.toggleFav(it) }   // 收藏动作分派（review#46 P1）：注入优先，默认原 toggleFav
  var flash by remember { mutableStateOf<String?>(null) }

  // 回到正在播（N5）：滚动定位 + 高亮一闪（1s 后消退）
  // G P3：(locate, list) 联合触发——locatePlaying 同刻设 cat/keyword，list 传播异步，单看 locate 可能
  // 读到旧过滤结果 i=-1 静默跳过；列表更新会重试，目标不在列表则保留 locate 待后续（无循环无副作用）
  LaunchedEffect(locate, list) {
    val k = locate ?: return@LaunchedEffect
    val i = list.indexOfFirst { it.key == k }
    if (i < 0) return@LaunchedEffect
    vm.locate.value = null
    if (grid) gridState.animateScrollToItem(i) else listState.animateScrollToItem(i)
    flash = k
  }
  LaunchedEffect(flash) { if (flash != null) { delay(1000); flash = null } }

  Box(modifier.fillMaxSize().padding(pad)) {
    if (list.isEmpty()) {
      Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(empty ?: "该分类暂无电台", color = pal.dim, modifier = Modifier.padding(24.dp))
      }
    } else if (grid) {
      LazyVerticalGrid(
        columns = GridCells.Adaptive(160.dp), state = gridState,
        modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
        contentPadding = PaddingValues(bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp),
      ) { gridItems(list, key = { it.key }) { s -> StationCard(vm, s, ui, flash, favKeys.contains(s.key), inCat, favToggle) } }
    } else {
      LazyColumn(
        state = listState, modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
        contentPadding = PaddingValues(bottom = 12.dp),
      ) { items(list, key = { it.key }) { s -> StationRow(vm, s, ui, flash, favKeys.contains(s.key), inCat, favToggle) } }
    }
  }
}

/* 收藏星（命中区 ≥48dp；星色双主题分档）。combinedClickable 自吞长按（AIbot P2-6）：星若是纯
   clickable，长按星 = 外层长按切换一次 + 抬指时星 onClick 再切一次（净效果状态不变但有震动，
   体感「长按没生效」）——星自身消费长按后外层手势即取消，长按星 = 恰好一次切换（星内自带震动）。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun FavStar(on: Boolean, onToggle: () -> Unit) {
  val pal = LocalVrPalette.current
  val haptic = LocalHapticFeedback.current
  Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
    Text(
      if (on) "★" else "☆", fontSize = 22.sp,
      color = if (on) pal.star else pal.dim,
      modifier = Modifier.clip(RoundedCornerShape(8.dp)).combinedClickable(
        onClick = onToggle,
        onLongClick = { haptic.performHapticFeedback(HapticFeedbackType.LongPress); onToggle() },
      ).semantics {   // P4 a11y 契约串（review#49 P2：子件保 role Button，父卡/行不赋 role 防嵌套）
        role = Role.Button; contentDescription = if (on) "已收藏" else "收藏"
      }.padding(6.dp),
    )
  }
}

/* 详情钮（§5.1「详情图标」，review#46 P2）：48dp 命中区「ⓘ」文字钮（照 FavStar 独立按钮样式），
   onClick = vm.openDetailOf(key)。combinedClickable 自吞长按同 FavStar 机理（AIbot P2-6——纯
   clickable 长按透传外层卡/行收藏长按），长按同开详情。role Button + cd「电台详情」。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DetailBtn(vm: AppVm, k: String, glyph: TextUnit = 18.sp) {
  val pal = LocalVrPalette.current
  val haptic = LocalHapticFeedback.current
  Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
    Text(
      "ⓘ", fontSize = glyph,
      color = pal.dim,
      modifier = Modifier.clip(RoundedCornerShape(8.dp)).combinedClickable(
        onClick = { vm.openDetailOf(k) },
        onLongClick = { haptic.performHapticFeedback(HapticFeedbackType.LongPress); vm.openDetailOf(k) },
      ).semantics {
        role = Role.Button; contentDescription = "电台详情"
      }.padding(6.dp),
    )
  }
}

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

/* 网格卡片：精简两行（台名+星 / 徽标行+详情钮），正在播边框高亮 + ▶ 前缀；fav 由外层响应式传入（勿在行内直读 lib）。
   N7：长按整卡 = 收藏切换（震动反馈；时长取系统默认长按超时，Web 侧是 500ms 定时，手感近似）。
   详情钮（review#46 P2）放徽标行行尾（星标正下方）：160dp 最小卡宽下行首放不下第二个 48dp 钮
   （40 logo+8+48 星+48 钮 > 142 内容宽，台名会被挤没——§5.1「不挤压主信息」优先于「星标旁」）。
   P4 a11y：父语义 cd「台名，分类，点按播放，长按收藏」（review#49 P2：父节点不赋 role Button——
   combinedClickable 自身 clickable 语义即可，避免父 Button 套子 Button 嵌套）。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun StationCard(vm: AppVm, s: Station, ui: PlayerUiState, flash: String?, fav: Boolean, inCat: Boolean, onFavToggle: (Station) -> Unit) {
  val pal = LocalVrPalette.current
  val haptic = LocalHapticFeedback.current
  val k = s.key
  val playing = ui.station?.key == k && ui.st != PState.IDLE && ui.st != PState.CONNECTING
  val connecting = ui.station?.key == k && ui.st == PState.CONNECTING
  val selected = ui.station?.key == k && ui.st == PState.IDLE
  val (dn, _) = displayParts(s.n)
  val dead = s.health == "dead"
  val shape = RoundedCornerShape(10.dp)
  Column(
    Modifier.fillMaxWidth().clip(shape)
      .background(if (playing) pal.panel else Color.Transparent)
      .border(1.dp, when { flash == k || playing || selected -> pal.acc; else -> pal.line }, shape)
      .combinedClickable(
        onClick = { vm.togglePlay(k) },
        onLongClick = { haptic.performHapticFeedback(HapticFeedbackType.LongPress); onFavToggle(s) },
      ).semantics {
        contentDescription = "$dn，${s.c}，点按播放，长按收藏"
      }.padding(10.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      StationLogo(vm.logoOf(s), s.n, s.key, 40.dp)
      Text(
        (if (playing) "▶ " else "") + dn,
        modifier = Modifier.weight(1f).padding(start = 8.dp),
        color = if (playing) pal.acc else pal.tx,
        fontWeight = if (playing) FontWeight.SemiBold else FontWeight.Medium,
        textDecoration = if (dead) TextDecoration.LineThrough else null,
        fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
      )
      if (dead) Text(" ✗", color = pal.warn, fontSize = 13.sp)
      FavStar(fav) { onFavToggle(s) }
    }
    Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
      metaBadges(vm, s, inCat)
      if (connecting) { PulseDot(pal.acc); Text("连接中", fontSize = 11.sp, color = pal.dim) }
      Spacer(Modifier.weight(1f))
      DetailBtn(vm, k, 16.sp)
    }
  }
}

/* 列表行：两行详情（台名/徽标），正在播底色高亮；fav 由外层响应式传入；长按整行 = 收藏（N7，同卡片）。
   详情钮（review#46 P2）紧贴星标行首（§5.1「星标旁」；整行宽度充裕不挤台名），徽标行缩进 30→78dp
   随行首双钮（48+48）保持与台名首字的既有错位 26dp。父语义 cd 同 StationCard（无 role，防嵌套）。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun StationRow(vm: AppVm, s: Station, ui: PlayerUiState, flash: String?, fav: Boolean, inCat: Boolean, onFavToggle: (Station) -> Unit) {
  val pal = LocalVrPalette.current
  val haptic = LocalHapticFeedback.current
  val k = s.key
  val playing = ui.station?.key == k && ui.st != PState.IDLE && ui.st != PState.CONNECTING
  val connecting = ui.station?.key == k && ui.st == PState.CONNECTING
  val selected = ui.station?.key == k && ui.st == PState.IDLE
  val (dn, _) = displayParts(s.n)
  val dead = s.health == "dead"
  Row(
    Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
      .background(when { flash == k || selected -> pal.acc.copy(alpha = .12f); playing -> pal.panel; else -> Color.Transparent })
      .combinedClickable(
        onClick = { vm.togglePlay(k) },
        onLongClick = { haptic.performHapticFeedback(HapticFeedbackType.LongPress); onFavToggle(s) },
      ).semantics {
        contentDescription = "$dn，${s.c}，点按播放，长按收藏"
      }.padding(vertical = 2.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    DetailBtn(vm, k)
    FavStar(fav) { onFavToggle(s) }
    Column(Modifier.weight(1f)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        StationLogo(vm.logoOf(s), s.n, s.key, 22.dp)
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
      Row(Modifier.padding(start = 78.dp, top = 1.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        metaBadges(vm, s, inCat)
      }
    }
  }
}
