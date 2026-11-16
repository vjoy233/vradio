package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* 发现页（P3，方案 §5.4）：浮层（DiscoverySheet）平移为正式目的地——同批完成 Screen/导航项/
   旧浮层与 ✦ 入口删除 + DISCOVERY 翻 true（不允许「新导航+旧浮层」混合态，发布决策门）。
   数据源 = AppVm.discovery（派生逻辑不复制，§9 风险表：继续消费既有 StateFlow）；
   六分组 = 横向可滚动卡片行，卡片宽 min(120dp, 可用宽/3)——手机一行约 3 张、平板自适应更多
   但单卡不超 120dp（BoxWithConstraints 取行宽）；空组不显标题；稳定直连组保留「暂无质量数据」
   提示行、radio-meta 未绑定时「最近新增」给原因说明（AIbot P1-4：混态整组置空不猜数据）；
   点击卡片统一 vm.startPlay（既有播放通道），不再写 showDiscovery（该流已随浮层删除）。 */
@Composable
fun DiscoveryScreen(vm: AppVm, pad: PaddingValues) {
  val pal = LocalVrPalette.current
  val d by vm.discovery.collectAsState()
  val favKeys by vm.favKeys.collectAsState()
  // pad = bottomBar 实高（VrScaffold contentWindowInsets 0）——整页吃 bottomBar 让位，状态栏自理（对照 StationScreen/FavoritesScreen 头部）
  Box(Modifier.fillMaxSize().background(pal.bg).padding(pad)) {
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
      Text("发现", fontSize = 17.sp, fontWeight = FontWeight.Bold, color = pal.tx,
        modifier = Modifier.padding(start = 16.dp, top = 8.dp, bottom = 2.dp))
      Text("本地派生，点击即播", fontSize = 12.sp, color = pal.dim,
        modifier = Modifier.padding(start = 16.dp, bottom = 8.dp))
      LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
        val g = d.groups
        val sections = listOf(
          "稳定直连" to g.stableDirect, "最近新增" to g.recentlyAdded, "最近恢复" to g.recentlyRecovered,
          "有曲讯" to g.withMetadata, "未听过" to g.unlistened, "精选" to g.featured,
        )
        for ((idx, sec) in sections.withIndex()) {
          val (title, list) = sec
          // 空组不显标题；两例外照旧显标题给说明行：稳定直连带「暂无质量数据」、最近新增因 meta 未绑定整组置空
          val showHint = (title == "稳定直连" && g.noQualityData.isNotEmpty()) || (title == "最近新增" && !vm.metaBound)
          if (list.isEmpty() && !showHint) continue
          item("t$idx") {
            Text(title, fontSize = 13.sp, color = pal.acc, fontWeight = FontWeight.SemiBold,
              modifier = Modifier.padding(start = 16.dp, top = 10.dp, bottom = 4.dp))
          }
          if (title == "稳定直连" && g.noQualityData.isNotEmpty()) {
            item("uq") {   // 无质量记录的台不进质量分组——组头给「暂无质量数据」提示行（双端口径，原 sheet 平移）
              Text("另有 ${g.noQualityData.size} 台暂无质量数据（样本不足，未纳入分组）", fontSize = 12.sp, color = pal.dim,
                modifier = Modifier.padding(start = 16.dp, bottom = 4.dp))
            }
          }
          if (title == "最近新增" && !vm.metaBound) {   // radio-meta 未绑定（混态/缺资产）firstSeen 全空——原因说明（读 vm.metaBound 现成字段，派生不动）
            item("mb$idx") {
              Text("radio-meta 未绑定，暂无法派生最近新增（重新同步数据后恢复）", fontSize = 12.sp, color = pal.dim,
                modifier = Modifier.padding(start = 16.dp, bottom = 4.dp))
            }
          }
          item("r$idx") {
            BoxWithConstraints {   // 卡宽口径：min(120dp, 可用宽/3)，行内横滚
              val cw = minOf(120.dp, maxWidth / 3)
              LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(horizontal = 16.dp)) {
                items(list, key = { title + "|" + it.key }) { s ->
                  DiscoveryCard(s, favKeys.contains(s.key), vm.logoOf(s), cw) { vm.startPlay(s) }
                }
              }
            }
          }
        }
      }
    }
  }
}

/* 发现卡片（原浮层 DiscoveryRow 提取为卡片形态，纯展示件留顶层供复用、不持 vm——logo 由调用方
   vm.logoOf 注入）：台标 + 台名（displayParts 剥 [国别] 后缀）+ 分类徽标 + 收藏星角标
   （只读 fav 态，卡片不可点星标）；点击走注入 onClick（= vm.startPlay，不再收浮层）。 */
@Composable
fun DiscoveryCard(s: Station, fav: Boolean, logo: String, width: Dp, onClick: () -> Unit) {
  val pal = LocalVrPalette.current
  Box(Modifier.width(width).clip(RoundedCornerShape(10.dp)).background(pal.panel)
    .border(1.dp, pal.line, RoundedCornerShape(10.dp)).clickable(onClick = onClick)) {
    Column(Modifier.padding(10.dp)) {
      StationLogo(logo, s.n, s.key, 40.dp)
      Text(displayParts(s.n).first, fontSize = 13.sp, color = pal.tx, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(top = 6.dp))
      VrBadge(s.c, modifier = Modifier.padding(top = 4.dp))
    }
    if (fav) Text("★", fontSize = 14.sp, color = pal.acc, modifier = Modifier.align(Alignment.TopEnd).padding(6.dp))
  }
}
