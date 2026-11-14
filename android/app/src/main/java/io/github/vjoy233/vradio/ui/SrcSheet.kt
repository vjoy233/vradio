@file:OptIn(ExperimentalMaterial3Api::class)
package io.github.vjoy233.vradio.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.DiagnosticResult
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* 选源浮层（web footer #srcMenu 平移，②a/grill 拍板）：正在听的多源台一键切源——
   整行点选立即切播（一律立即起播，暂停态同）、徽标（默认/正在用/追加）、底部「↺ 恢复默认源」
   （forgetSrc + 重播；记忆源=默认源时按钮自指不渲染）+「源详情」入口（B1）。
   B1 起默认徽标/顺序 = PlayerHolder.srcOrder（人工序+禁用+启发式，与决策链同源不漂移）。 */
@Composable
fun SrcSheet(vm: AppVm, ui: PlayerUiState) {
  val pal = LocalVrPalette.current
  val s = ui.station
  val openKey by vm.srcKey.collectAsState()
  // 切台（⏮⏭/线控/浮层外操作）或清台即收起（Web srcPopK 失配即关，app.js:563）——浮层内容须始终对应打开时的台
  if (s == null || (openKey != null && s.key != openKey)) {
    LaunchedEffect(Unit) { vm.showSrc.value = false; vm.srcKey.value = null }
    return
  }
  val dft = vm.srcDefault(s)
  val mem = PlayerHolder.srcmemOf(s)
  ModalBottomSheet(onDismissRequest = { vm.showSrc.value = false; vm.srcKey.value = null }) {
    Column(Modifier.padding(horizontal = 16.dp).navigationBarsPadding()) {
      Text(
        "${s.n} · ${s.u.size} 个源，点行切换（失败自动顺延）",
        fontSize = 12.sp, color = pal.dim,
        modifier = Modifier.padding(bottom = 6.dp),
      )
      s.u.forEachIndexed { i, u ->
        val cur = ui.station?.key == s.key && ui.srcIdx == i
        val off = i in s.dis   // B1：禁用源仍在列但置灰不可点（禁用源不播；启用入口在源详情浮层）
        Row(
          Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
            .clickable(enabled = !off) { vm.showSrc.value = false; vm.srcKey.value = null; vm.startPlay(s, i) }
            .padding(vertical = 10.dp, horizontal = 4.dp),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          Text("${i + 1}", color = pal.dim, fontSize = 12.sp, modifier = Modifier.width(20.dp))
          Text(
            u, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
            fontSize = 12.sp, color = if (cur) pal.acc else pal.tx.copy(alpha = if (off) .4f else .85f),
          )
          if (off) VrBadge("已禁用", 2)
          if (i == dft) VrBadge("默认")
          if (cur) VrBadge("正在用", 1)
          if (!s.dU.contains(u)) VrBadge("追加")
        }
      }
      if (mem in s.u.indices && mem != dft) {                             // 记忆=默认时清了又记回同源，不渲染（AIbot P3-1）
        Row(
          Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
            .clickable { vm.showSrc.value = false; vm.srcKey.value = null; vm.srcReset() }
            .padding(vertical = 10.dp, horizontal = 4.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) { Text("↺ 恢复默认源（忘掉源 ${mem + 1} 的记忆）", fontSize = 13.sp, color = pal.acc, fontWeight = FontWeight.Medium) }
      }
      Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
          .clickable { vm.showSrc.value = false; vm.srcKey.value = null; vm.openDetail(s) }
          .padding(vertical = 10.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) { Text("ⓘ 源详情 · 逐源诊断 · 排序与禁用", fontSize = 13.sp, color = pal.acc, fontWeight = FontWeight.Medium) }
      Spacer(Modifier.height(16.dp))
    }
  }
}

/* ---------- B1 源详情浮层（plan-expansion-r4 §5.5，扩展 SrcSheet 不新建维护后台） ---------- */

/** 源动作载荷（onEdit 携带 u 空间索引；浮层只报动作，编排/落盘归 AppVm.srcEdit → Library）。 */
sealed class SourceAction {
  data class Move(val index: Int, val up: Boolean) : SourceAction() // 人工排序：上移/下移
  data class ToggleDisable(val index: Int) : SourceAction()         // 启用/禁用切换（主源也可禁，只标记不换身份）
  object RestoreDefault : SourceAction()                            // 恢复默认播放源（清 srcmem2，保留人工序/禁用）
  object ResetOrder : SourceAction()                                // 撤销人工源排序（删该台 srcManualOrder）
}

/** 诊断 code 徽标文案（code 是程序分支唯一依据；文案仅展示） */
private fun codeBadge(r: DiagnosticResult): Pair<String, Int> = when (r.code) {
  "OK" -> "✓ 可用" to 1
  "NETWORK" -> "网络失败" to 2
  "HTML" -> "HTML 错误页" to 2
  "HTTP" -> "HTTP ${r.httpStatus}" to 2
  "EMPTY_PLAYLIST" -> "清单无分片" to 2
  "NO_SEGMENT" -> "无可用分片" to 2
  "SHORT_BODY" -> "字节不足" to 2
  "REDIRECT_REJECTED" -> "重定向被拒" to 2
  else -> "地址不合法" to 2
}

/** 源详情：台名/分类/台标/收藏态 + 每源探活结果（code 徽标/why/延迟/字节/模式）+ 复制/播放此源/
 *  人工排序/启用禁用 + 恢复默认两动作 + 歌史入口。诊断经 CheckStream 直连（Android 无 /api）；
 *  手动禁用的源不发请求，显示「不能诊断」+「取消禁用」。fav/checking/onSongs 为可选扩展参数
 *  （默认值保 §5.5 签名兼容），由 AppRoot 接线时注入。 */
@Composable
fun SourceDetailSheet(
  station: Station,
  player: PlayerUiState,
  diagnostics: List<DiagnosticResult>,
  onCheck: () -> Unit,
  onPlay: (Int) -> Unit,
  onEdit: (SourceAction) -> Unit,
  fav: Boolean = false,
  checking: Boolean = false,
  onSongs: (() -> Unit)? = null,
  logo: String = "",
  onDismiss: () -> Unit = {},
) {
  val pal = LocalVrPalette.current
  val ctx = LocalContext.current
  val playing = player.station?.key == station.key && player.srcIdx >= 0
  ModalBottomSheet(onDismissRequest = onDismiss) {
    Column(
      Modifier.padding(horizontal = 16.dp).navigationBarsPadding().verticalScroll(rememberScrollState()),
    ) {
      // 头部：台标 + 台名/分类 + 收藏态
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StationLogo(logo, station.n, station.key, 36.dp)   // 台标由调用方注入（vm.logoOf 同步窥探口径）
        Column(Modifier.weight(1f)) {
          Text(station.n, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, color = pal.tx,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text(station.c, fontSize = 12.sp, color = pal.dim)
        }
        if (fav) VrBadge("★ 收藏")
        if (station.u.size > 1) VrBadge("${station.u.size} 源")
      }
      // 当前源/播放态行
      Text(
        if (playing) "正在用：源 ${player.srcIdx + 1} · ${if (player.mode == "hls") "HLS" else "直连"}"
        else if (player.noSrc && player.station?.key == station.key) "未播放（全部源已手动禁用）" else "未在播放",
        fontSize = 12.sp, color = if (player.noSrc && player.station?.key == station.key) pal.warn else pal.dim,
        modifier = Modifier.padding(top = 6.dp, bottom = 2.dp),
      )
      if (station.effOrder().isEmpty())   // NO_ENABLED_SOURCE 明示（B1 硬文案）
        Text("该台所有源都已手动禁用，请先启用一个源", fontSize = 13.sp, color = pal.warn,
          modifier = Modifier.padding(vertical = 4.dp))
      // 逐源列表（顺序 = 人工有效序 mo，含禁用位；序号显示 u 空间原序号+1）
      val order = station.mo ?: station.u.indices.toList()
      Text("源诊断（诊断顺序 = 人工顺序；禁用源不诊断）", fontSize = 12.sp, color = pal.dim,
        modifier = Modifier.padding(top = 4.dp, bottom = 2.dp))
      order.forEach { i ->
        val u = station.u[i]
        val off = i in station.dis
        val diag = diagnostics.firstOrNull { it.url == u }
        val cur = playing && player.srcIdx == i
        Column(
          Modifier.fillMaxWidth().padding(vertical = 6.dp),
        ) {
          Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("${i + 1}", color = pal.dim, fontSize = 12.sp, modifier = Modifier.width(18.dp))
            Text(u, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
              fontSize = 12.sp, color = if (cur) pal.acc else pal.tx.copy(alpha = if (off) .4f else .85f))
            station.lbl[u]?.let { VrBadge(it) }
            if (cur) VrBadge("正在用", 1)
            if (off) VrBadge("已禁用", 2) else if (diag != null) { val (t, k) = codeBadge(diag); VrBadge(t, k) }
          }
          // 结果行：why + 延迟/字节/模式（HLS 分片验收 or 直流字节验收）；禁用源 = 硬文案 + 取消禁用入口
          if (off) {
            Text("该源已被手动禁用，不能诊断", fontSize = 11.sp, color = pal.warn, modifier = Modifier.padding(start = 24.dp))
          } else if (diag != null) {
            Text(
              "${diag.why} · ${diag.bytes}B · ${diag.latencyMs}ms · ${if (diag.hls) "HLS 分片验收" else "直流字节验收"}"
                + (if (diag.httpStatus > 0) " · HTTP ${diag.httpStatus}" else "")
                + (if (diag.contentType.isNotEmpty()) " · ${diag.contentType}" else ""),
              fontSize = 11.sp, color = pal.dim, maxLines = 2, overflow = TextOverflow.Ellipsis,
              modifier = Modifier.padding(start = 24.dp),
            )
          } else {
            Text("未诊断（点下方「诊断全部源」）", fontSize = 11.sp, color = pal.dim, modifier = Modifier.padding(start = 24.dp))
          }
          // 动作行：播放此源 / 复制 / 禁用（取消禁用）/ 上移 / 下移
          Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(start = 24.dp, top = 2.dp)) {
            ActText(if (cur) "重播" else "播放") { onPlay(i) }
            ActText("复制") {
              (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)
                ?.setPrimaryClip(ClipData.newPlainText("vradio", u))
              Toast.makeText(ctx, "已复制源地址", Toast.LENGTH_SHORT).show()
            }
            ActText(if (off) "取消禁用" else "禁用", warn = !off) { onEdit(SourceAction.ToggleDisable(i)) }
            ActText("↑") { onEdit(SourceAction.Move(i, true)) }
            ActText("↓") { onEdit(SourceAction.Move(i, false)) }
          }
        }
      }
      // 诊断按钮（进行中置灰）
      Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
          .clickable(enabled = !checking && station.effOrder().isNotEmpty()) { onCheck() }
          .padding(vertical = 10.dp, horizontal = 4.dp),
      ) { Text(if (checking) "诊断中…（最长约 5 秒/源）" else "诊断全部源（${station.effOrder().size} 条启用）",
        fontSize = 13.sp, color = pal.acc, fontWeight = FontWeight.Medium) }
      // 恢复默认两动作（B1 拆分，彼此独立）
      Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
          .clickable { onEdit(SourceAction.RestoreDefault) }
          .padding(vertical = 8.dp, horizontal = 4.dp),
      ) { Text("↺ 恢复默认播放源（清源记忆，保留人工顺序与禁用）", fontSize = 13.sp, color = pal.dim) }
      if (station.mo != null) Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
          .clickable { onEdit(SourceAction.ResetOrder) }
          .padding(vertical = 8.dp, horizontal = 4.dp),
      ) { Text("↺ 撤销人工源排序（恢复同步原始顺序）", fontSize = 13.sp, color = pal.dim) }
      // 歌史入口（仅正在听的台——SongsSheet 展示的是当前台）
      if (onSongs != null && player.station?.key == station.key) Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
          .clickable { onSongs() }
          .padding(vertical = 8.dp, horizontal = 4.dp),
      ) { Text("♪ 本台歌曲历史", fontSize = 13.sp, color = pal.dim) }
      Spacer(Modifier.height(16.dp))
    }
  }
}

/** 小动作字（详情浮层动作行；命中区靠 padding 撑到接近 32dp，比 TextButton 紧凑） */
@Composable
private fun ActText(t: String, warn: Boolean = false, onClick: () -> Unit) {
  val pal = LocalVrPalette.current
  Text(t, fontSize = 12.sp, color = if (warn) pal.warn else pal.acc,
    modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable(onClick = onClick)
      .padding(horizontal = 8.dp, vertical = 5.dp))
}
