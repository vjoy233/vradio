package io.github.vjoy233.vradio.timeshift

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* B7 Spike 最简 UI（隔离在 timeshift/ 包内）：
   - PlayerBar「↩15s」按钮：仅实验开关开启且 CAPTURING（≥3s 缓冲）时显示
   - 设置页开关行：文案标明实验性质与范围（本地 pref，非 radio.*） */

@Composable
fun TimeshiftRewindButton() {
  val t by Timeshift.ui.collectAsState()
  if (t.on && t.state == TsState.CAPTURING && t.bufferedMs >= 3000) {
    TextButton(onClick = { Timeshift.rewind15() }) { Text("↩15s", fontSize = 12.sp) }
  }
}

@Composable
fun TimeshiftSettingRow(checked: Boolean, onChange: (Boolean) -> Unit) {
  val pal = LocalVrPalette.current
  Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
    Text("实验：时移回听（不稳定）", Modifier.weight(1f), fontSize = 14.sp, color = pal.tx)
    Switch(checked = checked, onCheckedChange = onChange)
  }
  Text(
    "仅单源 MP3 直流台可「↩15s」重听刚错过的内容（最多回看约 60 秒）；技术验证代码，随时可能移除（本机设置，不随备份迁移）",
    fontSize = 12.sp, color = pal.dim, modifier = Modifier.padding(top = 4.dp, start = 2.dp),
  )
}
