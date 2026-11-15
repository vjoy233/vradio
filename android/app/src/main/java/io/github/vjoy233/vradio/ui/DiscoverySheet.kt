@file:OptIn(ExperimentalMaterial3Api::class)
package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* 发现页浮层（B3-C，discoveryEnabled 开关控制入口可见）：本地派生六分组 + 暂无质量数据组，
   纯展示——点击统一走 AppVm.startPlay（既有播放通道，不复制决策）；不改变主列表排序。 */
@Composable
fun DiscoverySheet(vm: AppVm) {
  val pal = LocalVrPalette.current
  val d by vm.discovery.collectAsState()
  val favKeys by vm.favKeys.collectAsState()
  ModalBottomSheet(onDismissRequest = { vm.showDiscovery.value = false }) {
    Column(Modifier.padding(horizontal = 16.dp).navigationBarsPadding()) {
      Text("发现", fontSize = 15.sp, fontWeight = FontWeight.Bold, color = pal.tx,
        modifier = Modifier.padding(bottom = 2.dp))
      Text("本地派生（质量/健康/来源记录），点击即播", fontSize = 12.sp, color = pal.dim,
        modifier = Modifier.padding(bottom = 8.dp))
      LazyColumn(Modifier.fillMaxWidth().heightIn(max = 520.dp), contentPadding = PaddingValues(bottom = 16.dp)) {
        val g = d.groups
        val sections = listOf(
          "稳定直连" to g.stableDirect, "最近新增" to g.recentlyAdded, "最近恢复" to g.recentlyRecovered,
          "有曲讯" to g.withMetadata, "未听过" to g.unlistened, "精选" to g.featured,
        )
        for ((idx, sec) in sections.withIndex()) {
          val (title, list) = sec
          if (list.isEmpty() && !(title == "稳定直连" && g.noQualityData.isNotEmpty())) continue
          item("t$idx") {
            Text(title, fontSize = 13.sp, color = pal.acc, fontWeight = FontWeight.SemiBold,
              modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))
          }
          if (title == "稳定直连" && g.noQualityData.isNotEmpty()) {
            item("uq") {   // 无质量记录的台不进质量分组——在稳定直连组头给「暂无质量数据」提示行（双端口径）
              Text("另有 ${g.noQualityData.size} 台暂无质量数据（样本不足，未纳入分组）", fontSize = 12.sp, color = pal.dim,
                modifier = Modifier.padding(bottom = 4.dp))
            }
          }
          items(list, key = { title + "|" + it.key }) { s ->
            DiscoveryRow(s, favKeys.contains(s.key)) {
              vm.showDiscovery.value = false
              vm.startPlay(s)
            }
          }
        }
      }
    }
  }
}

@Composable
private fun DiscoveryRow(s: Station, fav: Boolean, onClick: () -> Unit) {
  val pal = LocalVrPalette.current
  Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 6.dp)) {
    Text((if (fav) "★ " else "") + s.n, fontSize = 14.sp, color = pal.tx, modifier = Modifier.weight(1f))
    Text(s.c, fontSize = 12.sp, color = pal.dim)
  }
}
