package io.github.vjoy233.vradio.ui

import io.github.vjoy233.vradio.BuildConfig

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* 设置页（契约 §Agent C SettingsScreen）：主题三态/无效源显示/手动体检（进度+分档统计完成态）/
   D7 数据更新/端内同步 M4/添加电台入口/导入导出五件套（SAF）/关于。 */
@Composable
fun SettingsScreen(vm: AppVm) {
  val pal = LocalVrPalette.current
  val theme by vm.theme.collectAsState()
  val showDead by vm.showDead.collectAsState()
  val healthBusy by vm.healthBusy.collectAsState()
  val healthProg by vm.healthProg.collectAsState()
  val healthResult by vm.healthResult.collectAsState()
  val updateBusy by vm.updateBusy.collectAsState()
  val updateMsg by vm.updateMsg.collectAsState()
  val syncBusy by vm.syncBusy.collectAsState()
  val syncMsg by vm.syncMsg.collectAsState()
  val confirm by vm.confirmReq.collectAsState()

  // SAF 导出（CreateDocument 预填文件名）与导入（OpenDocument 放宽到 */*——SAF 的 mime 上报不稳定）
  val expBackup = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { u -> if (u != null) vm.exportTo(u, AppVm.Exp.BACKUP) }
  val expM3u = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("audio/x-mpegurl")) { u -> if (u != null) vm.exportTo(u, AppVm.Exp.M3U) }
  val expSongs = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { u -> if (u != null) vm.exportTo(u, AppVm.Exp.SONGS) }
  val expCfg = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { u -> if (u != null) vm.exportTo(u, AppVm.Exp.CFG) }
  val impBackup = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u -> if (u != null) vm.importFrom(u, AppVm.Imp.BACKUP) }
  val impM3u = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u -> if (u != null) vm.importFrom(u, AppVm.Imp.M3U) }
  val impCfg = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u -> if (u != null) vm.importFrom(u, AppVm.Imp.CFG) }

  confirm?.let { msg ->
    ConfirmDialog("确认导入", msg, onOk = { vm.applyConfirmed() }, onDismiss = { vm.cancelConfirm() })
  }

  Column(Modifier.fillMaxSize().background(pal.bg).statusBarsPadding()) {
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
      TextButton(onClick = { vm.nav.value = Nav.LIST }) { Text("← 返回") }
      Text("设置", fontWeight = FontWeight.Bold, fontSize = 17.sp)
    }
    LazyColumn(
      Modifier.fillMaxSize().padding(horizontal = 16.dp),
      contentPadding = PaddingValues(bottom = 32.dp),
    ) {
      item {
        Section("外观")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          listOf("auto" to "跟随系统", "light" to "浅色", "dark" to "深色").forEach { (v, label) ->
            FilterChip(selected = theme == v, onClick = { vm.setTheme(v) }, label = { Text(label) })
          }
        }
      }
      item {
        Section("列表")
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Text("显示无效源（体检 ✗ 的电台）", Modifier.weight(1f), fontSize = 14.sp, color = pal.tx)
          Switch(checked = showDead, onCheckedChange = { vm.toggleDead() })
        }
        Info("默认隐藏；疑似不可达与长期确认停运两档，复活经复测自动回归")
      }
      item {
        Section("数据与体检")
        ItemTitle("手动体检", "逐台探测当前列表（含默认隐藏的死台），约几分钟")
        Button(onClick = { vm.manualHealth() }, enabled = !healthBusy, modifier = Modifier.fillMaxWidth()) {
          Text(if (healthBusy) "体检中…" else "开始体检")
        }
        if (healthProg.isNotEmpty()) Info(healthProg)
        if (healthResult.isNotEmpty()) Info(healthResult)
        ItemTitle("检查数据更新", "从 GitHub 主仓拉取最新 radio.txt / logos.txt（轻量快通道）")
        Button(onClick = { vm.checkUpdate() }, enabled = !updateBusy, modifier = Modifier.fillMaxWidth()) {
          Text(if (updateBusy) "检查中…" else "检查更新")
        }
        if (updateMsg.isNotEmpty()) Info(updateMsg)
        ItemTitle("同步最新源", "国内上游重分类 + 欧美台逐个实测重建，约 1 分钟")
        Button(onClick = { vm.fullSyncNow() }, enabled = !syncBusy, modifier = Modifier.fillMaxWidth()) {
          Text(if (syncBusy) "同步中…" else "立即同步")
        }
        if (syncMsg.isNotEmpty()) Info(syncMsg)
      }
      item {
        Section("电台")
        Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
          Column(Modifier.weight(1f)) {
            Text("添加自定义电台", fontSize = 15.sp, color = pal.tx)
            Info("先探活（拒绝假流/死链），通过后写入个人列表 my-radio.txt（同步不覆盖）")
          }
          TextButton(onClick = { vm.nav.value = Nav.ADD }) { Text("添加") }
        }
      }
      item {
        Section("导入导出")
        PairRow("备份全部", { expBackup.launch("vradio-backup.json") }, "恢复备份", { impBackup.launch(arrayOf("*/*")) })
        PairRow("导出收藏 m3u", { expM3u.launch("vradio-favorites.m3u") }, "导入收藏 m3u", { impM3u.launch(arrayOf("*/*")) })
        PairRow("导出歌曲历史", { expSongs.launch("vradio-songs.txt") }, "导出维护配置", { expCfg.launch("vradio-config.json") })
        OutlinedButton(onClick = { impCfg.launch(arrayOf("*/*")) }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
          Text("导入维护配置")
        }
        Info("备份 = 全部个人数据 v2（收藏/配置/健康标记/歌曲历史/自定义电台，与 Web 版互通）；" +
          "m3u 给外部播放器、导回恢复收藏；songs txt 拿去音乐 App 搜歌")
      }
      item {
        Section("关于")
        Info("VRadio ${BuildConfig.VERSION_NAME} · 零依赖本地网络电台（国内电台为主）· 数据来自公开仓库同步\n" +
          "流地址天然漂移：播不了先体检或同步源，再怀疑网络")
      }
    }
  }
}

@Composable
private fun Section(t: String) {
  Text(t, color = LocalVrPalette.current.acc, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
    modifier = Modifier.padding(top = 20.dp, bottom = 4.dp))
}
@Composable
private fun ItemTitle(t: String, d: String) {
  Column(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 2.dp)) {
    Text(t, fontSize = 15.sp, color = LocalVrPalette.current.tx)
    Text(d, fontSize = 12.sp, color = LocalVrPalette.current.dim)
  }
}
@Composable
private fun Info(t: String) {
  Text(t, fontSize = 12.sp, color = LocalVrPalette.current.dim,
    modifier = Modifier.padding(top = 4.dp, start = 2.dp))
}
@Composable
private fun PairRow(a: String, fa: () -> Unit, b: String, fb: () -> Unit) {
  Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    OutlinedButton(onClick = fa, modifier = Modifier.weight(1f), shape = RoundedCornerShape(8.dp)) { Text(a, maxLines = 1) }
    OutlinedButton(onClick = fb, modifier = Modifier.weight(1f), shape = RoundedCornerShape(8.dp)) { Text(b, maxLines = 1) }
  }
}
