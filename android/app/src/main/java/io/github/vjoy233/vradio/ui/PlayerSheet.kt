package io.github.vjoy233.vradio.ui

/* Full player（P2，方案 §5.3）：ModalBottomSheet 半屏起步可拖全屏（Q10——展开层级交给 SheetState
   PartiallyExpanded/FullyExpanded 承载，不再造第三套布尔；P0 sheet 唯一所有者口径，容器层级归集成方
   AppRoot 挂载）。**sheet 状态一次打开生命周期内有效：关闭即移除、重开回半屏**（review#47 P2 两个
   候选方案里取显式声明口径；BackHandler 关闭路径同样瞬时摘除，可接受）。内容顺序 §5.3 逐条：台标/台名/分类/收藏 → 状态行（组合映射 playerVisual，
   **不新增 PState.ERROR/NO_ENABLED_SOURCE——P1-1 修订硬门，映射是 PlayerUiState 字段组合**）→
   错误恢复动作行（Q22）→ 曲讯码率（HLS 结构性无 ICY 显示「暂无曲讯」不是异常，Web 同口径）→
   主控制（⏮ 收藏切台 / 主动作按 playerVisual.action 分派 / ⏭）→ 次操作行（选源/刷新/睡眠/分享/
   歌史/详情/回到电台页）→ 时移（组件自判显隐，B7 开关不动）→ 音量。
   全部动作只走现有 AppVm/PlayerHolder API，UI 不直接新建播放链、不碰 ExoPlayer。
   集成挂载（AppRoot，本批次不接线）：if (playerExpanded) PlayerSheet(vm, ui)。 */

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberStandardBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.timeshift.TimeshiftRewindButton
import io.github.vjoy233.vradio.ui.theme.LocalVrDimens
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette
import kotlinx.coroutines.launch

/* ---------- 组合映射（方案 §5.3 原样落地；顶层纯函数，JVM 可直测 → PlayerUiMappingTest） ---------- */

enum class PlayerAction { PLAY, PAUSE, RETRY, OPEN_DETAIL }
enum class PlayerTone { NORMAL, ACCENT, WARN }

data class PlayerVisual(val title: String, val action: PlayerAction, val tone: PlayerTone)

/** 播放器状态组合映射：PlayerUiState（st × noSrc × status）→ (标题, 主动作, 色调)。
 *  错误/全禁是既有字段的组合态，不新增 PState（P1-1 修订硬门）。 */
fun playerVisual(ui: PlayerUiState): PlayerVisual = when {
  ui.noSrc -> PlayerVisual("全部源已禁用", PlayerAction.OPEN_DETAIL, PlayerTone.WARN)
  ui.st == PState.CONNECTING -> PlayerVisual(ui.status.ifEmpty { "连接中…" }, PlayerAction.PAUSE, PlayerTone.ACCENT)
  ui.st == PState.PLAYING -> PlayerVisual("正在播放", PlayerAction.PAUSE, PlayerTone.ACCENT)
  ui.st == PState.PAUSED -> PlayerVisual("已暂停", PlayerAction.PLAY, PlayerTone.NORMAL)
  ui.status.isNotBlank() -> PlayerVisual(ui.status, PlayerAction.RETRY, PlayerTone.WARN)
  else -> PlayerVisual("未播放", PlayerAction.PLAY, PlayerTone.NORMAL)
}

/* 动作徽标文案：提示主动作点按后的效果（纯展示，跟随 playerVisual.action） */
private fun actionHint(a: PlayerAction) = when (a) {
  PlayerAction.PLAY -> "点按播放"
  PlayerAction.PAUSE -> "点按暂停"
  PlayerAction.RETRY -> "点按重试"
  PlayerAction.OPEN_DETAIL -> "查看详情"
}

/* ---------- Full player sheet ---------- */

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun PlayerSheet(vm: AppVm, ui: PlayerUiState) {
  val pal = LocalVrPalette.current
  val dim = LocalVrDimens.current
  val vstatus by vm.status.collectAsState()
  val favKeys by vm.favKeys.collectAsState()   // 收藏态源（StationContent 同款订阅——不行内直读）
  // review#47 P1：UI 层不再自清 status——AppVm.setStatus 是单一所有者（每次写入自带 6s TTL），本 sheet 只读
  val st = ui.station
  val visual = playerVisual(ui)
  // sheet 状态一次打开生命周期内有效（文件头口径）：closePlayer 即移除 Composable，重开重新 remember
  val sheetState = rememberStandardBottomSheetState(initialValue = SheetValue.PartiallyExpanded)  // Q10 半屏起步可拖全屏
  val scope = rememberCoroutineScope()

  ModalBottomSheet(
    // review#47 P1 收口：hide() 完成后再摘（滑下动画保留），避免 scrim/返回瞬时摘除 Composable
    onDismissRequest = { scope.launch { sheetState.hide(); vm.closePlayer() } },
    sheetState = sheetState,
  ) {
    Column(
      Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
        .padding(horizontal = dim.page).padding(bottom = 24.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      // 1. 台标 72dp + 台名（displayParts 剥 [国别]）+ 分类徽标 + 收藏星 48dp
      Row(verticalAlignment = Alignment.CenterVertically) {
        if (st != null) StationLogo(vm.logoOf(st), st.n, st.key, 72.dp)
        Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
          val (dn, cn) = displayParts(st?.n ?: vm.lastLine())
          Text(dn, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, color = pal.tx)
          if (st != null) Row(
            Modifier.padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
          ) {
            VrBadge(st.c)
            if (cn != null) VrBadge(cn)
            if (st.u.size > 1) VrBadge("${st.u.size}源")
          }
        }
        if (st != null) SheetFavStar(favKeys.contains(st.key)) { vm.toggleFav(st) }
      }

      // 2. 播放状态行：title 按 tone 着色（ACCENT=acc / WARN=warn / NORMAL=dim）+ 主动作提示徽标
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
          visual.title, fontSize = 14.sp, fontWeight = FontWeight.Medium,
          color = when (visual.tone) {
            PlayerTone.ACCENT -> pal.acc
            PlayerTone.WARN -> pal.warn
            PlayerTone.NORMAL -> pal.dim
          },
        )
        VrBadge(actionHint(visual.action))
      }

      // 错误恢复动作行（Q22）：WARN 态在状态行下给可执行动作——重试=refresh / 换源=openSrc（仅多源台，
      // review#47 P2：单源台不开选源层）/ 详情=openDetailOf；noSrc（OPEN_DETAIL）只给详情。UI 不直接新建播放链（复用现有 API）。
      if (visual.tone == PlayerTone.WARN) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
          when (visual.action) {
            PlayerAction.RETRY -> {
              ActText("重试", color = pal.warn) { PlayerHolder.refresh() }
              if (ui.station?.u?.let { it.size > 1 } == true) ActText("换源", color = pal.warn) { vm.openSrc() }
              ActText("打开详情", color = pal.warn) { vm.openDetailOf(ui.station?.key) }
            }
            PlayerAction.OPEN_DETAIL -> ActText("打开详情", color = pal.warn) { vm.openDetailOf(ui.station?.key) }
            else -> {}
          }
        }
      }

      // 3. 曲名和码率：song 非空 ♪ song · Nkbps（kbps>0 才显示码率段）；song 空 →「暂无曲讯」
      //    ——HLS 结构性无 ICY（央广系全 m3u8），显示空不是 bug，不暗示异常（Web 同口径）
      Text(
        if (ui.song.isNotEmpty()) "♪ ${ui.song}" + (if (ui.kbps > 0) " · ${ui.kbps}kbps" else "") else "暂无曲讯",
        fontSize = 14.sp, color = if (ui.song.isNotEmpty()) pal.tx else pal.dim,
        maxLines = 2, overflow = TextOverflow.Ellipsis,
      )

      // 4. 主控制行：⏮ 上一收藏 / 主动作（按 playerVisual.action 分派）/ ⏭ 下一收藏（48dp 命中区）
      //    P4 a11y：⏮⏭ 与重试/详情态主动作补 contentDescription + role（§8.2.9）
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
        Box(
          Modifier.size(48.dp).clip(RoundedCornerShape(8.dp)).clickable { vm.stepFav(-1) }
            .semantics { role = Role.Button; contentDescription = "上一收藏台" },
          contentAlignment = Alignment.Center,
        ) {
          SkipIcon(true, pal.tx, Modifier.size(26.dp))
        }
        when (visual.action) {
          PlayerAction.PLAY -> PlayPauseBtn(ui, 72.dp) { if (ui.station == null) vm.resumeLast() else PlayerHolder.toggle() }
          PlayerAction.PAUSE -> PlayPauseBtn(ui, 72.dp) { PlayerHolder.toggle() }
          PlayerAction.RETRY -> GlyphBtn("↻", pal.warn, "重试") { PlayerHolder.refresh() }
          PlayerAction.OPEN_DETAIL -> GlyphBtn("ⓘ", pal.warn, "打开详情") { vm.openDetailOf(ui.station?.key) }
        }
        Box(
          Modifier.size(48.dp).clip(RoundedCornerShape(8.dp)).clickable { vm.stepFav(1) }
            .semantics { role = Role.Button; contentDescription = "下一收藏台" },
          contentAlignment = Alignment.Center,
        ) {
          SkipIcon(false, pal.tx, Modifier.size(26.dp))
        }
      }

      // 5. 次操作行（FlowRow 可换行）：选源（多源台才亮，PlayerBar 现口径）/ 刷新回直播头（有台才显）/
      //    睡眠（15/30/60 或取消，含倒计时）/ 分享 / 歌史 / 详情 / 回到电台页
      FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (st != null && st.u.size > 1) ActText("选源") { vm.openSrc() }
        if (st != null) ActText("刷新") { PlayerHolder.refresh() }        // 手动刷新回直播头（plan-refresh-live）
        SleepControl(ui)
        if (st != null) ActText("分享") { vm.shareStation(st) }
        if (st != null) ActText("歌史") { vm.showSongs.value = true }
        if (st != null) ActText("详情") { vm.openDetailOf(st.key) }
        // 回到电台页 = locatePlaying（旧 PlayerBar 台名点击语义，P1 迁出后在此保留）；
        // sheet 全屏遮挡，需自行收起才能看到列表定位高亮——随行 closePlayer
        ActText("回到电台页") { vm.locatePlaying(); vm.closePlayer() }
      }

      // 用户操作反馈行（vm.status：「还没有收藏电台…」/「已静音」等——引擎态在状态行，两通道不混写）
      if (vstatus.isNotEmpty()) Text(vstatus, fontSize = 12.sp, color = pal.dim)

      // 6. 时移回听入口（B7）：组件自判显隐（实验开关 + CAPTURING ≥3s 缓冲），条件不动
      TimeshiftRewindButton()

      // 7. 音量：静音文案点击切换 + 滑杆（VolumeControl 复用层 dragVol 防回环）
      VolumeControl(vm, ui)
    }
  }
}

/* 收藏星 48dp（StationContent.FavStar 同款：combinedClickable 自吞长按——长按星 = 恰好一次切换，
   纯 clickable 会外层长按 + 抬指 onClick 双翻。fav 态由调用方经 favKeys 订阅传入，不在此直读） */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SheetFavStar(on: Boolean, onToggle: () -> Unit) {
  val pal = LocalVrPalette.current
  val haptic = LocalHapticFeedback.current
  Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
    Text(
      if (on) "★" else "☆", fontSize = 26.sp,
      color = if (on) pal.star else pal.dim,
      modifier = Modifier.clip(RoundedCornerShape(8.dp)).combinedClickable(
        onClick = onToggle,
        onLongClick = { haptic.performHapticFeedback(HapticFeedbackType.LongPress); onToggle() },
      ).semantics {   // P4 a11y：收藏态切换语义（§8.2.9）——sheet 头部无外层可点容器，本星独立成 TalkBack 节点
        role = Role.Button; contentDescription = if (on) "已收藏" else "收藏"
      }.padding(6.dp),
    )
  }
}

/* WARN 态主动作钮（重试 ↻ / 详情 ⓘ）：圆形 72dp 与 PlayPauseBtn 同形，字形色随 warn 色调；
   P4 a11y：自绘字形 TalkBack 读不出，desc 必填（§8.2.9） */
@Composable
private fun GlyphBtn(glyph: String, tint: Color, desc: String, onClick: () -> Unit) {
  val pal = LocalVrPalette.current
  Box(
    Modifier.size(72.dp).clip(CircleShape).background(pal.bg).clickable(onClick = onClick)
      .semantics { role = Role.Button; contentDescription = desc },
    contentAlignment = Alignment.Center,
  ) { Text(glyph, fontSize = 30.sp, color = tint) }
}

/* 收藏切台 ⏮/⏭（媒体步进语义，自绘三角+竖线——不引图标库，Common.kt 同约定；back=true 左向） */
@Composable
private fun SkipIcon(back: Boolean, tint: Color, modifier: Modifier = Modifier) = Canvas(modifier) {
  val w = size.width; val h = size.height
  if (back) {
    drawRoundRect(tint, topLeft = Offset(w * .16f, h * .22f), size = Size(w * .10f, h * .56f), cornerRadius = CornerRadius(2f, 2f))
    drawPath(Path().apply { moveTo(w * .84f, h * .22f); lineTo(w * .34f, h * .5f); lineTo(w * .84f, h * .78f); close() }, tint)
  } else {
    drawPath(Path().apply { moveTo(w * .16f, h * .22f); lineTo(w * .66f, h * .5f); lineTo(w * .16f, h * .78f); close() }, tint)
    drawRoundRect(tint, topLeft = Offset(w * .74f, h * .22f), size = Size(w * .10f, h * .56f), cornerRadius = CornerRadius(2f, 2f))
  }
}
