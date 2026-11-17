package io.github.vjoy233.vradio.ui

import io.github.vjoy233.vradio.BuildConfig

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.vjoy233.vradio.timeshift.TimeshiftSettingRow
import io.github.vjoy233.vradio.ui.theme.LocalVrMotion
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette

/* 设置页（§5.6 七组折叠重构，§7 P3）：分组可折叠列表，SAF launcher 与确认门
   （备份覆盖 + sidecar 复选 / 移动数据）原样保留在屏幕层；折叠只改展示，
   不触 AppVm 状态与任何持久键（§8.1 SettingsSectionTest）。 */

/* 分组模型（§5.6/Q26）：折叠是纯 UI 展示态，不触任何持久键 */
data class SettingsGroup(val id: String, val title: String, val defaultExpanded: Boolean)

/* 七组定义：id 顺序即渲染顺序（§5.6）；默认展开「播放」「数据与体检」（Q26） */
val settingsGroups: List<SettingsGroup> = listOf(
  SettingsGroup("play", "播放", defaultExpanded = true),
  SettingsGroup("appearance", "外观", defaultExpanded = false),
  SettingsGroup("data", "数据与体检", defaultExpanded = true),
  SettingsGroup("network", "网络与流量", defaultExpanded = false),
  SettingsGroup("station", "电台", defaultExpanded = false),
  SettingsGroup("backup", "备份与导入", defaultExpanded = false),
  SettingsGroup("about", "关于与反馈", defaultExpanded = false),
)

/* 默认展开集（Q26）：屏幕初始化与测试共用同一口径 */
fun defaultExpandedIds(): Set<String> = settingsGroups.filter { it.defaultExpanded }.map { it.id }.toSet()

/* 纯函数：有则去无则加（天然幂等），折叠态记账只认 id */
fun toggleExpanded(cur: Set<String>, id: String): Set<String> = if (id in cur) cur - id else cur + id

@OptIn(ExperimentalLayoutApi::class)   // FlowRow（review#48：chips 行换行防 320dp/字体放大溢出）
@Composable
fun SettingsScreen(vm: AppVm, pad: PaddingValues) {
  val pal = LocalVrPalette.current
  val theme by vm.theme.collectAsState()
  val view by vm.view.collectAsState()
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
  // 折叠态（Q26/Q18，review#48）：plain remember——进程死亡回默认（Q18 严格口径，不进 SavedStateRegistry）；
  // 旋转重建同样回默认，丢折叠态是拍板取舍（折叠只是纯 UI 展示态，不写 AppVm/Store）
  var openIds by remember { mutableStateOf(defaultExpandedIds()) }

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
      // review#49-2：消费 VrScaffold pad（次级页在 content 槽内——pad 含 mini player/底栏实高），32dp 是页脚呼吸位
      contentPadding = PaddingValues(bottom = 32.dp + pad.calculateBottomPadding()),
    ) {
      settingsGroups.forEach { g ->
        item(key = "grp." + g.id) {
          SettingsSection(g, g.id in openIds, { openIds = toggleExpanded(openIds, g.id) }) {
            when (g.id) {
              "play" -> {   // 启动续播/音频卸载/时移（原「播放」section 原样归位）
                SettingsRow("启动时自动续播上次电台", "默认关；打开 app 即接续上次收听（本机设置，不随备份迁移）") {
                  Switch(checked = resume, onCheckedChange = { vm.setResume(it) })
                }
                SettingsRow("音频卸载省电（实验）",
                  if (vm.offloadCap) "DSP 硬解码降播放耗电；不支持的流自动回退软解；更改后重启应用生效"
                  else "本机不支持音频卸载（需 Android 13+ 且音频 DSP 支持），已自动置灰") {
                  Switch(checked = offload, enabled = vm.offloadCap, onCheckedChange = { vm.setOffload(it) })
                }
                TimeshiftSettingRow(timeshiftOn) { vm.setTimeshift(it) }   // B7 Spike：时移回听实验开关
              }
              "appearance" -> {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {   // review#48：FlowRow 换行，320dp/字体放大不溢出
                  listOf("auto" to "跟随系统", "light" to "浅色", "dark" to "深色", "oled" to "纯黑 OLED").forEach { (v, label) ->
                    FilterChip(selected = theme == v, onClick = { vm.setTheme(v) }, label = { Text(label) })
                  }
                }
                SettingsRow("默认视图", "网格 / 列表双视图的默认形态") {   // P3 新接入（§5.6：外观 = 主题 + 默认视图）
                  FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {   // review#48：FlowRow 换行
                    listOf("grid" to "网格", "list" to "列表").forEach { (v, label) ->
                      FilterChip(selected = view == v, onClick = { vm.setView(v) }, label = { Text(label) })
                    }
                  }
                }
                // 旧「列表」section 整体并入外观组（plan §5.6 七组无列表项——不丢设置，注释注明）
                SettingsRow("显示无效源（体检 ✗ 的电台）", "默认隐藏；疑似不可达与长期确认停运两档，复活经复测自动回归") {
                  Switch(checked = showDead, onCheckedChange = { vm.toggleDead() })
                }
              }
              "data" -> {   // 手动体检（含取消/进度/结果）/检查更新/同步源（原「数据与体检」section 原样归位）
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
              "network" -> {   // B5（plan-expansion-r4 §9.2）：播放永不阻断；仅约束大流量后台操作（原样归位）
                ItemTitle("移动数据 · 全量体检", "逐台探测全部电台，移动数据下流量较大")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {   // review#48：FlowRow 换行
                  listOf("allow" to "允许", "confirm" to "每次确认", "deny" to "禁止").forEach { (v, label) ->
                    FilterChip(selected = netFull == v, onClick = { vm.setNetFullCheck(v) }, label = { Text(label) })
                  }
                }
                ItemTitle("移动数据 · 主库同步", "欧美台逐个实测重建，约 1 分钟")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {   // review#48：FlowRow 换行
                  listOf("allow" to "允许", "confirm" to "每次确认", "deny" to "禁止").forEach { (v, label) ->
                    FilterChip(selected = netSync == v, onClick = { vm.setNetSync(v) }, label = { Text(label) })
                  }
                }
                SettingsRow("台标补全 Wi-Fi 优先", "移动数据下默认跳过台标网络补全（列表照常显示首字母色块）；关闭后移动数据也补") {
                  Switch(checked = netLogo, onCheckedChange = { vm.setNetLogoWifi(it) })
                }
                ItemTitle("本次收听流量（估）", traffic.ifEmpty { "播放中每 30 秒采样累计；无码率时按 128kbps 估算并标注" })
              }
              "station" -> {
                SettingsRow("添加自定义电台", "先探活（拒绝假流/死链），通过后写入个人列表 my-radio.txt（同步不覆盖）") {
                  TextButton(onClick = { vm.openAddStation() }) { Text("添加") }
                }
                // 维护配置（radio.cfg：移动/重命名/隐藏/追加备选源）从「导入导出」移入电台组（§5.6：电台 = 添加 + 维护配置）
                SettingsActionRow("维护配置 · 导出", "导出", "radio.cfg 全量导出（json，与 Web 版互通）") { expCfg.launch("vradio-config.json") }
                SettingsActionRow("维护配置 · 导入", "选择文件", "json 全量替换现有维护配置（移动/重命名/隐藏/追加备选源）") { impCfg.launch(arrayOf("*/*")) }
              }
              "backup" -> {   // 旧「导入导出」除维护配置外全部移入；SAF launcher 与 sidecar 开关调用原样保留
                SettingsActionRow("备份导出", "备份全部", "全部个人数据 v3（收藏/配置/健康标记/歌曲历史/自定义电台，与 Web 版互通，兼容读 v1/v2）") { expBackup.launch("vradio-backup.json") }
                SettingsActionRow("备份恢复", "选择文件", "恢复将覆盖本机数据（覆盖确认 + sidecar 复选在确认框内）") { impBackup.launch(arrayOf("*/*")) }
                SettingsActionRow("导出收藏 m3u", "导出", "收藏台歌单文件，拿去别的播放器") { expM3u.launch("vradio-favorites.m3u") }
                SettingsActionRow("歌单导入", "选择文件", "m3u / pls / xspf / asx / 纯链接 txt——本地解析不联网探活，预览新增/已知/重复/非法四桶后写入；已知台恢复收藏、新台入 my-radio") { impM3u.launch(arrayOf("*/*")) }
                SettingsActionRow("歌曲历史导出", "导出", "songs txt 拿去音乐 App 搜歌") { expSongs.launch("vradio-songs.txt") }
                SettingsRow("导出包含本机 sidecar（质量数据）") {
                  Switch(checked = expSc, onCheckedChange = { vm.backupWithSidecar.value = it })   // 默认关（与 Web mSidecar 同口径，AIbot 三轮 P1-3）
                }
              }
              "about" -> {   // 旧「关于」+「疑难与反馈」并组（§5.6：关于与反馈）
                Info("VRadio ${BuildConfig.VERSION_NAME} · 零依赖本地网络电台（国内电台为主）· 数据来自公开仓库同步\n" +
                  "无任何 Google 服务（GMS）依赖——国产 ROM / 无 GMS 设备全功能可用\n" +
                  "流地址天然漂移：播不了先体检或同步源，再怀疑网络")
                ItemTitle("后台播放被杀？", "国产 ROM 默认限制后台。到 系统设置 → 应用 → VRadio → 电池/耗电管理，允许后台运行（MIUI：省电策略选「无限制」；ColorOS：允许完全后台行为）。仍被杀请用下方入口反馈机型与 ROM 版本")
                val c = LocalContext.current
                OutlinedButton(onClick = {
                  runCatching { c.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ISSUES_URL))) }
                }, modifier = Modifier.fillMaxWidth()) { Text("问题反馈（GitHub Issues）") }
              }
            }
          }
        }
      }
    }
  }
}

private const val ISSUES_URL = "https://github.com/vjoy233/vradio/issues"   // N15 反馈入口（D12 无小米系实机的补偿通道）

/* 分组折叠件（§5.6）：48dp 组头可点折叠/展开，箭头用字符 ▾/▸（白名单无图标库）；
   内容 AnimatedVisibility 用 VrMotion token（enterMs/exitMs） */
@Composable
private fun SettingsSection(group: SettingsGroup, expanded: Boolean, onToggle: () -> Unit, content: @Composable () -> Unit) {
  val pal = LocalVrPalette.current
  val mo = LocalVrMotion.current
  Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
    Row(
      Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClick = onToggle),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(group.title, color = pal.acc, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
      Text(if (expanded) "▾" else "▸", color = pal.dim, fontSize = 14.sp)   // 字符箭头，不引图标库
    }
    AnimatedVisibility(
      expanded,
      enter = fadeIn(tween(mo.enterMs)) + expandVertically(tween(mo.enterMs)),
      exit = fadeOut(tween(mo.exitMs)) + shrinkVertically(tween(mo.exitMs)),
    ) { content() }
  }
}

/* 行小件：左 label（可选副文案）+ 右控件（Switch/按钮/chips），48dp 命中区（收敛旧散装 Row） */
@Composable
private fun SettingsRow(label: String, sub: String? = null, control: @Composable () -> Unit) {
  val pal = LocalVrPalette.current
  Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
    Column(Modifier.weight(1f)) {
      Text(label, fontSize = 14.sp, color = pal.tx)
      if (sub != null) Text(sub, fontSize = 12.sp, color = pal.dim)
    }
    control()
  }
}

/* 动作行：label + 右侧文字按钮（收敛旧 PairRow 双按钮组合——按 §5.6 分组命名拆行） */
@Composable
private fun SettingsActionRow(label: String, action: String, sub: String? = null, onClick: () -> Unit) {
  SettingsRow(label, sub) { TextButton(onClick = onClick) { Text(action) } }
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
