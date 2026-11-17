@file:OptIn(ExperimentalMaterial3Api::class)

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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.ui.theme.LocalVrDimens
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette
import kotlinx.coroutines.delay

/* 收藏页（P1 全量，方案 §5.5）：头部标题 + 收藏内独立搜索（读写 vm.favoriteQuery，120ms 防抖同电台页）
   + 收藏内分类 chips（flui.chips 首项「全部」+ 收藏内实际出现分类，FilterChip 同 StationScreen 样式）；
   列表主体复用 StationContent 纯投影（视图跟全局 radio.view 走；绝不写电台页 cat/keyword——
   收藏页是收藏集合唯一主入口，§5.5 硬点）。空态两档：收藏全空 = 自绘引导块 +「去电台库」按钮
   （StationContent 空态是纯文案位放不了按钮，故收藏全空时自绘）；有收藏但过滤无命中 = empty 文案位。
   取消收藏撤销（Q13/Q17，review#46 P1）：行内星标/长按经 onFavToggle 注入直调 vm.unfavWithUndo
   （守卫非收藏态不翻转 + toggle 取消 + favUndoReq=s 单一产生点在 AppVm；AppRoot collect 弹 Snackbar，
   点撤销走 undoUnfav 按 URL 身份回绑）——旧「监听收藏投影差分补发 favUndoReq」桥接已删：
   维护隐藏/同步重建/回绑先后都会被差分误判成用户取消收藏（误报路径），事件不得由 UI 差分合成。
   滚动/筛选快照同 StationScreen 模式（destinationUi[FAVORITES]：离页 DisposableEffect 快照 +
   恢复护栏 list.isNotEmpty() + 一次性 restored 标志；恢复回写 vm.favoriteQuery/favoriteCategory）。 */
@Composable
fun FavoritesScreen(vm: AppVm, pad: PaddingValues) {
  val pal = LocalVrPalette.current
  val dims = LocalVrDimens.current
  val flui by vm.favoriteListUi.collectAsState()
  val cat by vm.favoriteCategory.collectAsState()
  val view by vm.view.collectAsState()
  val favsAll by vm.favorites.collectAsState()   // 收藏总数（空态分档判据；过滤命中看 flui.list）

  // 搜索：120ms 防抖（同 StationScreen 模式：本地字段延迟写回 + vm 反向同步；多词 AND 在投影函数内）
  var q by rememberSaveable { mutableStateOf(vm.favoriteQuery.value) }
  LaunchedEffect(Unit) { vm.favoriteQuery.collect { k -> if (k != q.trim()) q = k } }
  LaunchedEffect(q) { delay(120); val t = q.trim(); if (t != vm.favoriteQuery.value) vm.favoriteQuery.value = t }

  // 滚动保存/恢复（Q15/Q18 同 StationScreen 模式）：恢复一次且等列表非空（boot 未就绪先挂起，
  // effect 重跑再对齐，restored 防搜索结果翻转时重复回拉）；筛选态恢复 = 回写 vm 独立收藏态
  val gridState = rememberLazyGridState()
  val listState = rememberLazyListState()
  val savedUi = remember { vm.destinationUi.value[Destination.FAVORITES] }
  var restored by remember { mutableStateOf(false) }
  LaunchedEffect(Unit) {
    val sv = savedUi ?: return@LaunchedEffect
    if (sv.query.isNotBlank() && sv.query != vm.favoriteQuery.value) vm.favoriteQuery.value = sv.query
    if (vm.favoriteCategory.value != sv.category) vm.favoriteCategory.value = sv.category
  }
  LaunchedEffect(flui.list.isNotEmpty()) {
    val sv = savedUi ?: return@LaunchedEffect
    if (restored) return@LaunchedEffect
    if (sv.firstVisibleItem <= 0 && sv.firstVisibleOffset <= 0) { restored = true; return@LaunchedEffect }
    if (flui.list.isEmpty()) return@LaunchedEffect
    restored = true
    gridState.scrollToItem(sv.firstVisibleItem, sv.firstVisibleOffset)
    listState.scrollToItem(sv.firstVisibleItem, sv.firstVisibleOffset)
  }
  val gsRef = rememberUpdatedState(gridState)
  val lsRef = rememberUpdatedState(listState)
  val qRef = rememberUpdatedState(vm.favoriteQuery.value)
  val catRef = rememberUpdatedState(cat)
  val viewRef = rememberUpdatedState(view)
  DisposableEffect(Unit) {
    onDispose {
      val g = viewRef.value == "grid"
      val (item, offset) = if (g) gsRef.value.firstVisibleItemIndex to gsRef.value.firstVisibleItemScrollOffset
      else lsRef.value.firstVisibleItemIndex to lsRef.value.firstVisibleItemScrollOffset
      vm.saveDestinationUi(Destination.FAVORITES, DestinationUiState(
        query = qRef.value, category = catRef.value, grid = g,
        firstVisibleItem = item, firstVisibleOffset = offset,
      ))
    }
  }

  Column(Modifier.fillMaxSize().background(pal.bg).statusBarsPadding()) {
    Text("收藏", color = pal.tx, fontWeight = FontWeight.Bold, fontSize = 17.sp,
      modifier = Modifier.padding(start = dims.page, top = 8.dp, bottom = 4.dp))
    if (favsAll.isNotEmpty()) {
      // 收藏内独立搜索行（常驻不折叠；✕ 清空 48dp 命中区，同 StationScreen 搜索行样式）
      Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
          value = q, onValueChange = { q = it },
          modifier = Modifier.weight(1f),
          singleLine = true,
          placeholder = { Text("搜索收藏", fontSize = 13.sp) },
        )
        if (q.isNotEmpty()) {
          Box(Modifier.size(48.dp).clickable { q = "" }, contentAlignment = Alignment.Center) {
            Text("✕", color = pal.dim, fontSize = 15.sp)
          }
        }
      }
      // 收藏内分类 chips（计数 = 收藏集合口径；选中分类时列表徽标里分类名冗余不显，同电台页口径）
      LazyRow(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        contentPadding = PaddingValues(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        items(flui.chips, key = { it.first }) { (c, n) ->
          FilterChip(
            selected = c == cat, onClick = { vm.favoriteCategory.value = c },
            label = { Row(verticalAlignment = Alignment.CenterVertically) { Text(c); Text(" $n", fontSize = 10.sp, color = pal.dim) } },
          )
        }
      }
      // 列表主体：纯投影复用（locate=null 收藏页无「回到正在播」；hasDead=false 死台分档是电台页口径）
      // onFavToggle 注入（review#46 P1）：收藏页星标/长按 = unfavWithUndo（撤销事件由 AppVm 单一产生）
      StationContent(
        vm, pad, flui.list, flui.empty, false, view == "grid", gridState, listState, null,
        inCat = cat != "全部",
        onFavToggle = { vm.unfavWithUndo(it) },
        modifier = Modifier.weight(1f),
      )
    } else {
      // 收藏全空：自绘空态块（引导文案 + 去电台库入口，§5.5；bottomBar 让位自理同 StationContent 口径）
      Box(Modifier.weight(1f).fillMaxWidth().padding(bottom = pad.calculateBottomPadding()), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
          Text(flui.empty ?: "还没有收藏电台，去电台页长按或点星标收藏吧", color = pal.dim, modifier = Modifier.padding(24.dp))
          Button(onClick = { vm.navigate(Destination.LIBRARY) }, modifier = Modifier.padding(top = 8.dp)) { Text("去电台库") }
        }
      }
    }
  }
}
