package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* 添加自定义电台（A-2 平移）：台名/分类（下拉选既有 + 自填优先）/流 URL 三件，
   探活先行（12s 窗）通过才写 my-radio，失败明示原因不静默。 */
@Composable
fun AddStationScreen(vm: AppVm) {
  val pal = LocalVrPalette.current
  var name by rememberSaveable { mutableStateOf("") }
  var url by rememberSaveable { mutableStateOf("") }
  var custom by rememberSaveable { mutableStateOf("") }
  var selCat by rememberSaveable { mutableStateOf("") }
  val cats by vm.addCats.collectAsState()                     // 分类候选响应式（审计 P3：直读 lib.cats 无订阅，boot 未完成进页则永远空）
  LaunchedEffect(cats) { if (selCat.isEmpty() && cats.isNotEmpty()) selCat = cats.first() }
  val addBusy by vm.addBusy.collectAsState()
  val addMsg by vm.addMsg.collectAsState()

  Column(
    Modifier.fillMaxSize().background(pal.bg).statusBarsPadding().imePadding()
      .verticalScroll(rememberScrollState()),
  ) {
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
      TextButton(onClick = { vm.nav.value = Nav.LIST }) { Text("← 返回") }
      Text("添加电台", fontWeight = FontWeight.Bold, fontSize = 17.sp)
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
      OutlinedTextField(
        value = name, onValueChange = { name = it },
        label = { Text("电台名") }, singleLine = true,
        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
      )
      Text("分类（选既有或自填，自填优先）", fontSize = 12.sp, color = pal.dim, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
      if (cats.isEmpty()) {
        Text("（列表尚未装载完成，可直接自填分类）", fontSize = 12.sp, color = pal.dim)
      } else {
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(vertical = 2.dp)) {
          items(cats, key = { it }) { c ->
            FilterChip(selected = selCat == c, onClick = { selCat = c }, label = { Text(c, fontSize = 12.sp) })
          }
        }
      }
      OutlinedTextField(
        value = custom, onValueChange = { custom = it },
        label = { Text("自定义分类（可选）") }, singleLine = true,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
      )
      OutlinedTextField(
        value = url, onValueChange = { url = it },
        label = { Text("流地址 http(s)://…（mp3/aac 直流或 m3u8）") }, singleLine = true,
        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
      )
      Button(
        onClick = {
          vm.addStation(name, selCat, custom, url) {
            name = ""; url = ""; custom = ""
            vm.nav.value = Nav.LIST
          }
        },
        enabled = !addBusy && name.isNotBlank() && url.isNotBlank(),
        modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
      ) { Text(if (addBusy) "探活中…" else "添加（先探活）") }
      if (addMsg.isNotEmpty()) Text(addMsg, fontSize = 12.sp, color = pal.warn, modifier = Modifier.padding(top = 8.dp))
      Text(
        "说明：探活通过才写入 my-radio.txt（500 行 / 64KB 封顶，同步不覆盖）；" +
          "蜻蜓系建流 5-10 秒属正常，探活窗最长 12 秒",
        fontSize = 12.sp, color = pal.dim, modifier = Modifier.padding(top = 12.dp, bottom = 24.dp),
      )
    }
  }
}
