@file:OptIn(ExperimentalMaterial3Api::class)

package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette
import kotlinx.coroutines.delay

/* 电台库页壳（P1，方案 §5.1）：TopAppBar（标题「电台」+ 搜索展开 + 更多菜单：设置/视图切换/
   显示无效源/添加电台）+ 既有头部（范围/分类 chips、网格列表 SegBtn、✗ 无效源）原样搬移；
   搜索 120ms 防抖随行迁移（§7 P1 硬点）；滚动位进程内保存/恢复（Q15/Q18 destinationUi 快照，
   不在滚动帧回调写 StateFlow）。旧「设置」TextButton/旧首行搜索框已删（入口进 TopAppBar/更多菜单）。
   列表主体 = StationContent 纯投影渲染（收藏页 §5.5 复用）。 */
@Composable
fun StationScreen(vm: AppVm, pad: PaddingValues) {
  val pal = LocalVrPalette.current
  val lu by vm.listUi.collectAsState()
  val cat by vm.cat.collectAsState()
  val view by vm.view.collectAsState()
  val showDead by vm.showDead.collectAsState()
  val searchOpen by vm.searchExpanded.collectAsState()
  val locate by vm.locate.collectAsState()
  var menuOpen by remember { mutableStateOf(false) }

  // 搜索：120ms 防抖（1600+ 台整表过滤不逐键跑）；外部清空（回到正在播）同步回输入框（自旧 StationList 随行迁移）
  var q by rememberSaveable { mutableStateOf(vm.keyword.value) }
  LaunchedEffect(Unit) { vm.keyword.collect { k -> if (k != q.trim()) q = k } }
  LaunchedEffect(q) { delay(120); val t = q.trim(); if (t != vm.keyword.value) vm.keyword.value = t }
  // 回台页恢复：有关键词即展开搜索行（searchExpanded 进程内初始 false，keyword 仍在）
  LaunchedEffect(Unit) { if (vm.keyword.value.isNotBlank() && !vm.searchExpanded.value) vm.searchExpanded.value = true }

  // 滚动保存/恢复（Q15/Q18，进程内）：恢复一次且等列表非空（boot 未就绪先挂起，effect 重跑再对齐，
  // restored 防搜索结果翻转时重复回拉）；离开页 DisposableEffect 快照（rememberUpdatedState 读最新值）
  val gridState = rememberLazyGridState()
  val listState = rememberLazyListState()
  val savedUi = remember { vm.destinationUi.value[Destination.LIBRARY] }
  var restored by remember { mutableStateOf(false) }
  LaunchedEffect(lu.list.isNotEmpty()) {
    val sv = savedUi ?: return@LaunchedEffect
    if (restored) return@LaunchedEffect
    if (sv.firstVisibleItem <= 0 && sv.firstVisibleOffset <= 0) { restored = true; return@LaunchedEffect }
    if (lu.list.isEmpty()) return@LaunchedEffect
    restored = true
    gridState.scrollToItem(sv.firstVisibleItem, sv.firstVisibleOffset)
    listState.scrollToItem(sv.firstVisibleItem, sv.firstVisibleOffset)
  }
  val gsRef = rememberUpdatedState(gridState)
  val lsRef = rememberUpdatedState(listState)
  val kwRef = rememberUpdatedState(vm.keyword.value)
  val catRef = rememberUpdatedState(vm.cat.value)
  val viewRef = rememberUpdatedState(view)
  DisposableEffect(Unit) {
    onDispose {
      val g = viewRef.value == "grid"
      val (item, offset) = if (g) gsRef.value.firstVisibleItemIndex to gsRef.value.firstVisibleItemScrollOffset
      else lsRef.value.firstVisibleItemIndex to lsRef.value.firstVisibleItemScrollOffset
      vm.saveDestinationUi(Destination.LIBRARY, DestinationUiState(
        query = kwRef.value, category = catRef.value, grid = g,
        firstVisibleItem = item, firstVisibleOffset = offset,
      ))
    }
  }

  Column(Modifier.fillMaxSize().background(pal.bg)) {
    // TopAppBar：标题 + 搜索开关 + 更多菜单（自绘 Canvas 图标，白名单无图标库）
    TopAppBar(
      title = { Text("电台", fontWeight = FontWeight.Bold, fontSize = 16.sp) },
      colors = TopAppBarDefaults.topAppBarColors(containerColor = pal.bg),
      actions = {
        // P4 a11y：自绘 Canvas 图标必须补 contentDescription + role（§8.2.9）
        Box(
          Modifier.size(48.dp).clickable { vm.searchExpanded.value = !vm.searchExpanded.value }
            .semantics { role = Role.Button; contentDescription = "搜索" },
          contentAlignment = Alignment.Center,
        ) {
          SearchIcon(if (searchOpen) pal.acc else pal.dim)
        }
        Box(contentAlignment = Alignment.Center) {
          Box(
            Modifier.size(48.dp).clickable { menuOpen = true }
              .semantics { role = Role.Button; contentDescription = "更多" },
            contentAlignment = Alignment.Center,
          ) { MoreIcon(pal.dim) }
          DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(text = { Text("设置") }, onClick = { menuOpen = false; vm.openSettings() })
            DropdownMenuItem(text = { Text(if (view == "grid") "切换为列表视图" else "切换为网格视图") },
              onClick = { menuOpen = false; vm.setView(if (view == "grid") "list" else "grid") })
            DropdownMenuItem(   // 开关不收菜单：勾选态翻面可见；P4 a11y：显示态走 stateDescription（§8.2.9）
              text = { Text("显示无效源") },
              trailingIcon = { Text(if (showDead) "✓" else "", color = pal.acc, fontSize = 14.sp) },
              modifier = Modifier.semantics { stateDescription = if (showDead) "已显示" else "已隐藏" },
              onClick = { vm.toggleDead() },
            )
            DropdownMenuItem(text = { Text("添加电台") }, onClick = { menuOpen = false; vm.openAddStation() })
          }
        }
      },
    )
    // 搜索展开行：TextField + 清除/收起（防抖链在上方，输入即 120ms 后进 vm.keyword）
    if (searchOpen) {
      Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
          value = q, onValueChange = { q = it },
          modifier = Modifier.weight(1f),
          singleLine = true,
          placeholder = { Text("搜索电台名", fontSize = 13.sp) },
        )
        if (q.isNotEmpty()) {
          Box(Modifier.size(48.dp).clickable { q = "" }, contentAlignment = Alignment.Center) {
            Text("✕", color = pal.dim, fontSize = 15.sp)
          }
        }
        Box(Modifier.size(48.dp).clickable { vm.searchExpanded.value = false }, contentAlignment = Alignment.Center) {
          Text("收起", color = pal.dim, fontSize = 13.sp)
        }
      }
    }
    // 次行：双视图切换 + 无效源开关（出现过死台才亮，app.js deadBtn 同款）——原样搬移
    // （✦ 发现入口 P3 已删：发现升格正式目的地 DiscoveryScreen，走底栏/rail 导航，不留旧浮层混合态）
    Row(Modifier.padding(horizontal = 12.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      SegBtn("网格", view == "grid") { vm.setView("grid") }
      SegBtn("列表", view == "list") { vm.setView("list") }
      if (lu.hasDead) SegBtn("✗ 无效源", showDead) { vm.toggleDead() }
    }
    // 分类条（数量角标与列表同口径刷新，P3-5；范围/分类 chip 口径保持 listUi 既有双轨）——原样搬移
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
    // 列表主体：纯投影（收藏页 §5.5 复用）；pad 透传给内容区——底栏（mini player + bottom nav）不遮最后一行
    StationContent(
      vm, pad, lu.list, lu.empty, lu.hasDead, view == "grid", gridState, listState, locate,
      inCat = cat != "全部" && cat != "★收藏" && cat != "最近",   // 分类视图下徽标里分类名 100% 冗余不显
      modifier = Modifier.weight(1f),
    )
  }
}

/* 自绘图标（白名单无图标库，Canvas 同 Navigation.DestinationIcon 口径）：放大镜 + 竖三点 */
@Composable
private fun SearchIcon(tint: Color, modifier: Modifier = Modifier) = Canvas(modifier.size(22.dp)) {
  val r = size.minDimension * 0.30f
  val c = Offset(size.width * 0.42f, size.height * 0.42f)
  drawCircle(tint, radius = r, center = c, style = Stroke(width = size.minDimension * 0.09f))
  drawLine(tint, Offset(c.x + r * 0.72f, c.y + r * 0.72f), Offset(size.width * 0.85f, size.height * 0.85f),
    strokeWidth = size.minDimension * 0.09f, cap = StrokeCap.Round)
}

@Composable
private fun MoreIcon(tint: Color, modifier: Modifier = Modifier) = Canvas(modifier.size(22.dp)) {
  listOf(0.20f, 0.50f, 0.80f).forEach { y ->
    drawCircle(tint, radius = size.width * 0.075f, center = Offset(size.width / 2, size.height * y))
  }
}
