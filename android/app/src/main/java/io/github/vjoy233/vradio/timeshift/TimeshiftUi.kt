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
   - 范围外明示拒绝原因（AIbot P2-1）：开关开着但当前台被 classify 拒收时显示提示，而非静默无按钮
   - 设置页开关行：文案标明实验性质与范围（本地 pref，非 radio.*） */

@Composable
fun TimeshiftRewindButton() {
  val t by Timeshift.ui.collectAsState()
  val pal = LocalVrPalette.current
  when {
    t.on && t.state == TsState.CAPTURING && t.bufferedMs >= 3000 ->
      TextButton(onClick = { Timeshift.rewind15() }) { Text("↩15s", fontSize = 12.sp) }
    // P2-1：拒绝原因明示（HLS/AAC/无扩展名流都归此文案）——产品化前置项：按 Content-Type/字节探测
    // 识别无扩展名 mp3（报告 §8.2），Spike 仅按 URL 后缀判定
    t.on && t.state == TsState.OFF && t.reject ->
      Text("⏱ 本台不支持回听（实验仅支持 .mp3 扩展名直流）", fontSize = 10.sp, color = pal.dim)
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
    "仅「.mp3 扩展名」单源直流台可「↩15s」重听刚错过的内容（最多约 60 秒；无扩展名/AAC/HLS 台会显示不支持）；技术验证代码，随时可能移除（本机设置，不随备份迁移）",
    fontSize = 12.sp, color = pal.dim, modifier = Modifier.padding(top = 4.dp, start = 2.dp),
  )
}
