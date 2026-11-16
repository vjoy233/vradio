package io.github.vjoy233.vradio.ui

import io.github.vjoy233.vradio.BuildConfig

import android.content.Intent
import android.net.Uri
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.timeshift.TimeshiftSettingRow
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
  val manualRun by vm.manualRun.collectAsState()
  val updateBusy by vm.updateBusy.collectAsState()
  val updateMsg by vm.updateMsg.collectAsState()
  val syncBusy by vm.syncBusy.collectAsState()
  val syncMsg by vm.syncMsg.collectAsState()
  val confirm by vm.confirmReq.collectAsState()
  val impHasQ by vm.impHasQuality.collectAsState()     // 备份含质量 sidecar（确认框复选显隐，B4 三轮 P1-3）
  val impSc by vm.impSidecar.collectAsState()          // 用户勾选「恢复质量 sidecar」
  val expSc by vm.backupWithSidecar.collectAsState()   // 导出「包含本机 sidecar」
  val resume by vm.resumeOnStart.collectAsState()      // N4 启动续播（本地 pref，batch1）
  val offload by vm.audioOffload.collectAsState()      // E5 音频卸载（本地 pref，batch1）
  val netFull by vm.netFullCheck.collectAsState()      // B5 网络与流量
  val netSync by vm.netSync.collectAsState()
  val netLogo by vm.netLogoWifi.collectAsState()
  val traffic by vm.trafficTxt.collectAsState()
  val gate by vm.netGate.collectAsState()
  val timeshiftOn by vm.timeshiftOn.collectAsState()   // B7 Spike 时移回听（本地 pref，默认关）

  // SAF 导出（CreateDocument 预填文件名）与导入（OpenDocument 放宽到 */*——SAF 的 mime 上报不稳定）
  val expBackup = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { u -> if (u != null) vm.exportTo(u, AppVm.Exp.BACKUP) }
  val expM3u = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("audio/x-mpegurl")) { u -> if (u != null) vm.exportTo(u, AppVm.Exp.M3U) }
  val expSongs = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { u -> if (u != null) vm.exportTo(u, AppVm.Exp.SONGS) }
  val expCfg = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { u -> if (u != null) vm.exportTo(u, AppVm.Exp.CFG) }
  val impBackup = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u -> if (u != null) vm.importFrom(u, AppVm.Imp.BACKUP) }
  val impM3u = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u -> if (u != null) vm.importFrom(u, AppVm.Imp.M3U) }
  val impCfg = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u -> if (u != null) vm.importFrom(u, AppVm.Imp.CFG) }

  confirm?.let { msg ->
    ConfirmDialog("确认导入", msg, onOk = { vm.applyConfirmed() }, onDismiss = { vm.cancelConfirm() },
      checkLabel = if (impHasQ) "恢复备份内 sidecar（质量/收听统计，将覆盖本机对应数据）" else null,   // 默认不勾 = 保留本机（AIbot 三轮 P1-3；B4 双 sidecar 一勾整体覆盖）
      checked = impSc, onCheckedChange = { vm.impSidecar.value = it })
  }
  // B5：移动数据大流量操作确认门（全量体检/主库同步/轻更新，拒绝则不发；AIbot P1 后轻更新同入 SYNC 门）
  gate?.let { (act, msg) ->
    ConfirmDialog(
      when (act) {
        io.github.vjoy233.vradio.network.NetGate.Act.SYNC -> "移动数据同步确认"
        io.github.vjoy233.vradio.network.NetGate.Act.LIGHT_UPDATE -> "移动数据更新确认"
        else -> "移动数据体检确认"
      },
      msg, onOk = { vm.proceedGate() }, onDismiss = { vm.cancelGate() })
  }

  Column(Modifier.fillMaxSize().background(pal.bg).statusBarsPadding()) {
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
      TextButton(onClick = { vm.closeSecondary() }) { Text("← 返回") }
      Text("设置", fontWeight = FontWeight.Bold, fontSize = 17.sp)
    }
    LazyColumn(
      Modifier.fillMaxSize().padding(horizontal = 16.dp),
      contentPadding = PaddingValues(bottom = 32.dp),
    ) {
      item {
        Section("外观")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          listOf("auto" to "跟随系统", "light" to "浅色", "dark" to "深色", "oled" to "纯黑 OLED").forEach { (v, label) ->
            FilterChip(selected = theme == v, onClick = { vm.setTheme(v) }, label = { Text(label) })
          }
        }
      }
      item {
        Section("播放")
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Text("启动时自动续播上次电台", Modifier.weight(1f), fontSize = 14.sp, color = pal.tx)
          Switch(checked = resume, onCheckedChange = { vm.setResume(it) })
        }
        Info("默认关；打开 app 即接续上次收听（本机设置，不随备份迁移）")
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Text("音频卸载省电（实验）", Modifier.weight(1f), fontSize = 14.sp, color = pal.tx)
          Switch(checked = offload, enabled = vm.offloadCap, onCheckedChange = { vm.setOffload(it) })
        }
        Info(if (vm.offloadCap) "DSP 硬解码降播放耗电；不支持的流自动回退软解；更改后重启应用生效"
             else "本机不支持音频卸载（需 Android 13+ 且音频 DSP 支持），已自动置灰")
        TimeshiftSettingRow(timeshiftOn) { vm.setTimeshift(it) }   // B7 Spike：时移回听实验开关
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
        ItemTitle("手动体检", "逐台探测当前列表（含默认隐藏的死台），约几分钟；进行中可取消（已确认的标记保留）")
        Button(
          onClick = { if (manualRun) vm.cancelHealth() else vm.manualHealth() },
          enabled = !healthBusy || manualRun, modifier = Modifier.fillMaxWidth(),
        ) {
          Text(if (manualRun) "取消体检" else if (healthBusy) "体检中…" else "开始体检")   // B3：Web「取消体检」同款按钮翻转（sync.js health()）
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
        Section("网络与流量")   // B5（plan-expansion-r4 §9.2）：播放永不阻断；仅约束大流量后台操作
        ItemTitle("移动数据 · 全量体检", "逐台探测全部电台，移动数据下流量较大")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          listOf("allow" to "允许", "confirm" to "每次确认", "deny" to "禁止").forEach { (v, label) ->
            FilterChip(selected = netFull == v, onClick = { vm.setNetFullCheck(v) }, label = { Text(label) })
          }
        }
        ItemTitle("移动数据 · 主库同步", "欧美台逐个实测重建，约 1 分钟")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          listOf("allow" to "允许", "confirm" to "每次确认", "deny" to "禁止").forEach { (v, label) ->
            FilterChip(selected = netSync == v, onClick = { vm.setNetSync(v) }, label = { Text(label) })
          }
        }
        Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
          Text("台标补全 Wi-Fi 优先", Modifier.weight(1f), fontSize = 14.sp, color = pal.tx)
          Switch(checked = netLogo, onCheckedChange = { vm.setNetLogoWifi(it) })
        }
        Info("移动数据下默认跳过台标网络补全（列表照常显示首字母色块）；关闭后移动数据也补")
        ItemTitle("本次收听流量（估）", traffic.ifEmpty { "播放中每 30 秒采样累计；无码率时按 128kbps 估算并标注" })
      }
      item {
        Section("电台")
        Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
          Column(Modifier.weight(1f)) {
            Text("添加自定义电台", fontSize = 15.sp, color = pal.tx)
            Info("先探活（拒绝假流/死链），通过后写入个人列表 my-radio.txt（同步不覆盖）")
          }
          TextButton(onClick = { vm.openAddStation() }) { Text("添加") }
        }
      }
      item {
        Section("导入导出")
        PairRow("备份全部", { expBackup.launch("vradio-backup.json") }, "恢复备份", { impBackup.launch(arrayOf("*/*")) })
        Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
          Text("导出包含本机 sidecar（质量数据）", Modifier.weight(1f), fontSize = 13.sp, color = pal.dim)
          Switch(checked = expSc, onCheckedChange = { vm.backupWithSidecar.value = it })   // 默认关（与 Web mSidecar 同口径，AIbot 三轮 P1-3）
        }
        PairRow("导出收藏 m3u", { expM3u.launch("vradio-favorites.m3u") }, "导入歌单", { impM3u.launch(arrayOf("*/*")) })
        PairRow("导出歌曲历史", { expSongs.launch("vradio-songs.txt") }, "导出维护配置", { expCfg.launch("vradio-config.json") })
        OutlinedButton(onClick = { impCfg.launch(arrayOf("*/*")) }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
          Text("导入维护配置")
        }
        Info("备份 = 全部个人数据 v3（收藏/配置/健康标记/歌曲历史/自定义电台，与 Web 版互通，兼容读 v1/v2）；" +
          "歌单导入支持 m3u / pls / xspf / asx / 纯链接 txt——本地解析不联网探活，预览新增/已知/重复/非法四桶后写入，" +
          "已知台恢复收藏、新台入 my-radio；songs txt 拿去音乐 App 搜歌")
      }
      item {
        Section("疑难与反馈")
        ItemTitle("后台播放被杀？", "国产 ROM 默认限制后台。到 系统设置 → 应用 → VRadio → 电池/耗电管理，允许后台运行（MIUI：省电策略选「无限制」；ColorOS：允许完全后台行为）。仍被杀请用下方入口反馈机型与 ROM 版本")
        val c = LocalContext.current
        OutlinedButton(onClick = {
          runCatching { c.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ISSUES_URL))) }
        }, modifier = Modifier.fillMaxWidth()) { Text("问题反馈（GitHub Issues）") }
      }
      item {
        Section("关于")
        Info("VRadio ${BuildConfig.VERSION_NAME} · 零依赖本地网络电台（国内电台为主）· 数据来自公开仓库同步\n" +
          "无任何 Google 服务（GMS）依赖——国产 ROM / 无 GMS 设备全功能可用\n" +
          "流地址天然漂移：播不了先体检或同步源，再怀疑网络")
      }
    }
  }
}

private const val ISSUES_URL = "https://github.com/vjoy233/vradio/issues"   // N15 反馈入口（D12 无小米系实机的补偿通道）

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
