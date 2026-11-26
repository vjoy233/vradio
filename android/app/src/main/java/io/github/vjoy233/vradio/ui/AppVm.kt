package io.github.vjoy233.vradio.ui

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.vjoy233.vradio.FeatureFlags
import io.github.vjoy233.vradio.MainActivity
import io.github.vjoy233.vradio.Prefs
import io.github.vjoy233.vradio.check.CheckStream
import io.github.vjoy233.vradio.check.Health
import io.github.vjoy233.vradio.check.toDiagnostic
import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.Backup
import io.github.vjoy233.vradio.data.CfgCodec
import io.github.vjoy233.vradio.data.HttpText
import io.github.vjoy233.vradio.data.Library
import io.github.vjoy233.vradio.data.Logos
import io.github.vjoy233.vradio.data.MyRadio
import io.github.vjoy233.vradio.data.PlaylistParser
import io.github.vjoy233.vradio.data.QualityStore
import io.github.vjoy233.vradio.data.RadioTxt
import io.github.vjoy233.vradio.data.SafeTarget
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.check.OkHttpRaw
import io.github.vjoy233.vradio.data.OkHttpText
import io.github.vjoy233.vradio.discovery.Discovery
import io.github.vjoy233.vradio.discovery.DiscoveryInput
import io.github.vjoy233.vradio.discovery.Groups
import io.github.vjoy233.vradio.discovery.QInfo
import io.github.vjoy233.vradio.discovery.RecoveryLog
import io.github.vjoy233.vradio.metadata.LegacyMetadataSink
import io.github.vjoy233.vradio.metadata.MetadataPipeline
import io.github.vjoy233.vradio.model.MetadataEvent
import io.github.vjoy233.vradio.model.Cfg
import io.github.vjoy233.vradio.model.DiagnosticResult
import io.github.vjoy233.vradio.model.FavEntry
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.PlayerUiState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.model.SongRec
import io.github.vjoy233.vradio.network.NetGate
import io.github.vjoy233.vradio.network.NetProbe
import io.github.vjoy233.vradio.network.NetworkPolicy
import io.github.vjoy233.vradio.network.TrafficEstimator
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.timeshift.Timeshift
import io.github.vjoy233.vradio.stats.ListenSidecar
import io.github.vjoy233.vradio.stats.ListenStats
import io.github.vjoy233.vradio.stats.ListenStatsCodec
import io.github.vjoy233.vradio.stats.ListenTracker
import io.github.vjoy233.vradio.sync.Gh
import io.github.vjoy233.vradio.sync.LightUpdate
import io.github.vjoy233.vradio.sync.Freshness
import io.github.vjoy233.vradio.sync.RadioMeta
import io.github.vjoy233.vradio.sync.SyncEngine
import io.github.vjoy233.vradio.widget.WidgetCommands
import io.github.vjoy233.vradio.widget.WidgetPush
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/* AppVm —— 集中 state 对象 + 单一渲染入口精神（app.js App.state 的安卓形态）。
   持有数据层（Library/Logos/MyRadio）并编排：boot 装配、手动/boot 静默/同步后增量体检、
   D7 轻更新、M4 端内同步、导入导出、播放交互。
   纪律：全部主线程交互，网络/体检在 viewModelScope + Dispatchers.IO；
   toast = 后台任务反馈、status = 用户主动操作反馈（sync.js/App.toast 分工，两通道不双写）。 */

/** 各目的地页内 UI 瞬态（P0，方案 §6.1）：搜索词/分类/网格视图/滚动位——纯进程内保留（destinationUi map），
    不落 radio.*（零新持久键），进程被杀恢复默认 */
data class DestinationUiState(
  val query: String = "",
  val category: String = "全部",
  val grid: Boolean = false,
  val firstVisibleItem: Int = 0,
  val firstVisibleOffset: Int = 0,
)

/* P1 §5.5 收藏页投影：收藏集合内独立搜索/分类；数据源仍 lib.favs 单一来源，不复制收藏状态 */
data class FavoriteListUi(
  val list: List<Station> = emptyList(),
  val chips: List<Pair<String, Int>> = emptyList(),   // 首项「全部」+ 收藏内实际出现分类与数量（顺序沿用 lib.cats() 顺序过滤）
  val empty: String? = null,
  val ver: Int = 0,
)

/** 收藏页投影纯函数（§5.5，JVM 直测零 Android 依赖；AppVm.favoriteListUi 的 combine 调用）：
 *  favs 按 favorites 投影序（收藏写入序旧→新）传入，输出 Q16「最新收藏置顶」（新→旧）；
 *  query 多词空格 AND 大小写不敏感（filteredList keyword 同款）；category 仅在收藏内实际出现的分类生效
 *  （哨兵/失效分类一律不过滤——收藏页独立状态不写 cat）；chips 计数口径 = 全量收藏集合（同 listUi chips
 *  基于 vis 全量非过滤后列表），顺序按 cats（lib.cats()）过滤，cats 未覆盖的按收藏数据序兜底；
 *  empty 两档：收藏全空给引导语、过滤后无命中给换词提示；ver 透传 stamp（哨兵进值域防 StateFlow 判等丢渲染，
 *  同 ListUi.ver）。 */
fun buildFavoriteListUi(favs: List<Station>, query: String, category: String, stamp: Int,
                        cats: List<String> = emptyList()): FavoriteListUi {
  val byCat = favs.groupingBy { it.c }.eachCount()
  val ordered = LinkedHashSet<String>()
  for (c in cats) if (byCat.containsKey(c)) ordered.add(c)              // lib.cats() 顺序优先（与 listUi chips 分类序同口径）
  for (s in favs) ordered.add(s.c)                                     // cats 未覆盖兜底（无 cats 时 = 收藏数据序）
  val chips = ArrayList<Pair<String, Int>>(ordered.size + 1)
  chips.add("全部" to favs.size)
  for (c in ordered) chips.add(c to (byCat[c] ?: 0))
  var list = if (category == "全部" || !ordered.contains(category)) favs else favs.filter { it.c == category }
  val kw = query.trim().lowercase()
  if (kw.isNotEmpty()) {                                               // 多词空格 AND（audit-r2 口径，与 filteredList 同款）
    val ws = kw.split(Regex("\\s+"))
    list = list.filter { s -> val n = s.n.lowercase(); ws.all { n.contains(it) } }
  }
  val empty = when {
    favs.isEmpty() -> "还没有收藏电台，去电台页长按或点星标收藏吧"
    list.isEmpty() -> "收藏中没有匹配的电台"
    else -> null
  }
  return FavoriteListUi(list.asReversed(), chips, empty, stamp)
}

class AppVm(private val ctx: Application) : AndroidViewModel(ctx) {

  /* ---------- 依赖层装配（契约 API，收口后口径） ---------- */
  private val http: HttpText = OkHttpText()
  private val gh = Gh(http)
  private val myRadio = MyRadio(ctx.filesDir)
  val lib = Library(Store, ctx.filesDir)                     // mainText/myText 由 boot 装载后 reload
  val logos = Logos(ctx.filesDir, http, System::currentTimeMillis)
  private val checker = CheckStream(OkHttpRaw())
  private val light = LightUpdate(gh, ctx.filesDir)
  // SyncEngine.run(curText)：写 filesDir 副本 + 返回 SyncResult（ok=false=合并低于下限已中止未动文件）
  private val engine by lazy { SyncEngine(gh, checker, ctx.filesDir) }
  // B2 源质量 sidecar（filesDir/quality.json，不进 radio.* 主 Store）+ radio-meta 消费态（生成在 Web 同步侧）
  private val quality = QualityStore(ctx.filesDir)
  val radioMeta = MutableStateFlow(RadioMeta.EMPTY)          // 来源追踪元数据（发现页 B3 消费；缺件空对象）

  /* ---------- 列表态（radio.view/showdead/theme 三键持久化，app.js loadUi3 同款） ---------- */
  val cat = MutableStateFlow("全部")
  val keyword = MutableStateFlow("")
  val view = MutableStateFlow("grid")
  val showDead = MutableStateFlow(false)
  val theme = MutableStateFlow("auto")
  private val stamp = MutableStateFlow(0)                    // 渲染哨兵（app.js state.stamp）

  /* ---------- 根导航态（P0，方案 §6.1；契约在 ui/Navigation.kt）：目的地/次级页/全屏播放器/搜索展开
     + 各目的地页内 UI 瞬态 map——全部纯 UI 瞬态不持久化（零新 radio.* 键），进程死恢复默认 ---------- */
  val destination = MutableStateFlow(Destination.LIBRARY)
  val secondary = MutableStateFlow<SecondaryRoute?>(null)
  val playerExpanded = MutableStateFlow(false)
  val searchExpanded = MutableStateFlow(false)
  val destinationUi = MutableStateFlow<Map<Destination, DestinationUiState>>(emptyMap())

  val showSrc = MutableStateFlow(false)
  val srcKey = MutableStateFlow<String?>(null)                // 选源浮层打开时的台 key（换台即收起，srcPopK 同款）
  val showSongs = MutableStateFlow(false)
  val locate = MutableStateFlow<String?>(null)               // 回到正在播（web locatePlaying）
  val status = MutableStateFlow("")                          // 用户主动操作反馈（#status 同款）

  /* ---------- 根导航动作（P0，方案 §6.1）：守卫/返回裁决走 ui/Navigation.kt 契约纯函数 ---------- */

  /** 顶层目的地切换：发现关闭时去发现 = 回退电台（navigateGuard 契约同款）；
      次级页开着时显式切目的地 = 离开次级页（review#45：返回始终回当前目的地，Q11 来源契约在全路径成立） */
  fun navigate(to: Destination) { destination.value = navigateGuard(to); secondary.value = null }

  /** 次级页开合：先记来源目的地再设 secondary（返回时回跳来源页，Q11/Q15） */
  private val settingsFocusNetwork = MutableStateFlow(false)
  val focusNetworkSettings: StateFlow<Boolean> = settingsFocusNetwork
  fun openSettings(focusNetwork: Boolean = false) {
    settingsFocusNetwork.value = focusNetwork
    secondary.value = SecondaryRoute.SETTINGS
  }
  fun consumeNetworkSettingsFocus() { settingsFocusNetwork.value = false }
  fun openAddStation() { secondary.value = SecondaryRoute.ADD_STATION }
  fun closeSecondary() { secondary.value = null }

  /** status 反馈单一所有者（review#46/#47 P1）：每次写入重启 6s TTL，UI 层不得再自建清理协程（旧三处竞态删除） */
  private var statusJob: Job? = null
  fun setStatus(s: String) {
    status.value = s
    statusJob?.cancel()
    statusJob = viewModelScope.launch { delay(6000); status.value = "" }
  }

  /** 撤销队列排空（review#46 二轮：离开收藏页作废——在飞 Snackbar 由 UI dismiss，未消费事件全部作废） */
  fun clearFavUndo() { while (favUndoCh.tryReceive().isSuccess) { } }

  /** 各目的地页内 UI 瞬态快照（toMutableMap 拷贝替换触发流更新）：离开页面前/进次级页前调一次，不在滚动帧回调里写 */
  fun saveDestinationUi(d: Destination, ui: DestinationUiState) {
    destinationUi.value = destinationUi.value.toMutableMap().apply { put(d, ui) }
  }

  fun openPlayer() { playerExpanded.value = true }
  fun closePlayer() { playerExpanded.value = false }

  /* ---------- 进行态/结果文案 ---------- */
  val healthBusy = MutableStateFlow(false); val healthProg = MutableStateFlow(""); val healthResult = MutableStateFlow("")
  val updateBusy = MutableStateFlow(false); val updateMsg = MutableStateFlow("")
  val syncBusy = MutableStateFlow(false); val syncMsg = MutableStateFlow("")
  val logoRetryPending = MutableStateFlow(false)
  private fun refreshLogoRetry() { logoRetryPending.value = io.github.vjoy233.vradio.sync.SyncBarrier.logoRetryPending(ctx.filesDir) }
  val freshnessPref = MutableStateFlow(Freshness.parse(Store.get(C.K_SYNC_FRESHNESS)))
  val freshnessPrompt = MutableStateFlow(false)
  val freshnessAge = MutableStateFlow("unknown")
  private fun saveFreshness(p: Freshness.Pref) { freshnessPref.value = p; Store.set(C.K_SYNC_FRESHNESS, p.json()) }
  fun setFreshnessDays(days: Int) { saveFreshness(Freshness.parse(Store.get(C.K_SYNC_FRESHNESS)).copy(reminderDays = if (days in listOf(7, 14, 30)) days else 14, disabled = false)) }
  fun disableFreshness() { freshnessPrompt.value = false; saveFreshness(Freshness.parse(Store.get(C.K_SYNC_FRESHNESS)).copy(disabled = true)) }
  fun dismissFreshness() { freshnessPrompt.value = false; saveFreshness(Freshness.parse(Store.get(C.K_SYNC_FRESHNESS)).copy(dismissedUntil = System.currentTimeMillis() + Freshness.DAY)) }
  fun syncFromFreshness() { freshnessPrompt.value = false; fullSyncNow(onDenied = { openSettings(focusNetwork = true) }) }
  private suspend fun checkFreshness() {
    while (healthBusy.value || syncBusy.value || updateBusy.value || PlayerHolder.ui.value.st == PState.PLAYING || PlayerHolder.ui.value.st == PState.CONNECTING) delay(5000)
    val p = Freshness.parse(Store.get(C.K_SYNC_FRESHNESS)); freshnessPref.value = p
    val now = System.currentTimeMillis()
    val fact = Freshness.fact(ctx.filesDir)
    val state = Freshness.state(p, fact?.refreshedAt, fact?.provenance, now)
    if (state.prompt) {
      freshnessAge.value = state.age; saveFreshness(p.copy(lastPromptAt = now)); freshnessPrompt.value = true
    }
  }
  val addBusy = MutableStateFlow(false); val addMsg = MutableStateFlow("")
  val confirmReq = MutableStateFlow<String?>(null)           // 导入覆盖确认门槛
  val impHasQuality = MutableStateFlow(false)                // 待确认备份含质量 sidecar（确认框显隐复选，AIbot 三轮 P1-3）
  val impSidecar = MutableStateFlow(false)                   // 用户勾选「恢复质量 sidecar」（默认不勾 = 保留本机，与 Web 同语义）
  val backupWithSidecar = MutableStateFlow(false)            // 导出「包含本机 sidecar」复选（默认关，与 Web mSidecar 同口径）
  val manualRun = MutableStateFlow(false)                     // 手动体检在跑（静默版让位标志；StateFlow 供设置页「取消体检」按钮态，B3）
  private val healthAbort = AtomicBoolean(false)              // 手动体检取消（Web sync.js this.abort 同款：已确认的标记保留）
  private var pendingImp: Pair<Imp, Any?>? = null
  private var assetsStamp = ""

  /* —— batch1（2026-10-18 拍板）新增态：N4/E5 本地开关（Prefs，非 radio.* 契约）+ E3/E4 入口 —— */
  val resumeOnStart = MutableStateFlow(false)          // N4 启动自动续播（默认关）
  val audioOffload = MutableStateFlow(false)           // E5 音频卸载（默认关，实验性，重启生效）
  val timeshiftOn = MutableStateFlow(false)            // B7 Spike：时移回听实验开关（本地 pref，默认关）
  val addPreset = MutableStateFlow<String?>(null)      // E4 接流预填 URL（AddStationScreen 消费后自清）
  private var pendingSc: String? = null                // E3 待点播的快捷方式目标（"last" 或台 key）
  private var booted = false

  /** E5 能力探测：API 33+ 且 mp3 offload 支持（静态查询；不支持设置页置灰；探测失败按不支持，宁灰勿误开） */
  val offloadCap: Boolean = runCatching {
    Build.VERSION.SDK_INT >= 33 && android.media.AudioManager.isOffloadedPlaybackSupported(
      android.media.AudioFormat.Builder().setEncoding(android.media.AudioFormat.ENCODING_MP3)
        .setSampleRate(44100).setChannelMask(android.media.AudioFormat.CHANNEL_OUT_MONO).build(),
      android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA)
        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC).build())
  }.getOrDefault(false)

  enum class Imp { BACKUP, M3U, CFG }
  enum class Exp { BACKUP, M3U, SONGS, CFG }
  /** B4 歌单导入确认载荷：hits=库内命中台（确认后恢复收藏，N2 语义）；extra=库外新台（确认后批量入 my-radio）。
   *  确认前零副作用（B4：取消=无副作用），四桶计数 dup/invalid 随行进完成态文案 */
  data class PlaylistImp(val hits: List<Station>, val extra: List<Station>, val dup: Int, val invalid: Int, val fmt: String)

  /* ---------- B5：网络策略与流量（plan-expansion-r4 §9.2；设置本地态存 Prefs，非 radio.* 契约） ---------- */

  /** 探测面：ConnectivityManager 经 NetProbe 注入（network/ 纯 JVM 不碰 android.*）；查不到一律 UNKNOWN 宽松 */
  private val policy = NetworkPolicy(object : NetProbe {
    override fun online(): Boolean? {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
      val net = cm.activeNetwork ?: return false                       // 无活动网络 = 离线
      val caps = cm.getNetworkCapabilities(net) ?: return null
      return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
    override fun metered(): Boolean? {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
      return cm.isActiveNetworkMetered
    }
  })

  val netFullCheck = MutableStateFlow("confirm")   // 移动数据全量体检（allow/confirm/deny）
  val netSync = MutableStateFlow("confirm")        // 移动数据主库同步（同款三态）
  val netLogoWifi = MutableStateFlow(true)         // 台标补全 Wi-Fi 优先
  val trafficTxt = MutableStateFlow("")            // 本次收听流量估算（设置页展示；估算口径非精确计费）
  private val gate = NetGate(policy)                     // 入口门（AIbot P1）：三入口同构门控，纯 JVM 可测
  val netGate = MutableStateFlow<Pair<NetGate.Act, String>?>(null)   // 移动数据大流量操作确认门（载荷=待恢复动作）

  private var listenMs = 0L                        // 本次会话累计收听时长（不持久化：会话级口径）
  private var lastKbps = 0                         // 最近一次已知码率（0=无 ICY，估算按 128kbps 并明示）

  private fun netRules() = NetworkPolicy.Rules(
    cellFullCheck = ruleOf(netFullCheck.value),
    cellSync = ruleOf(netSync.value),
    logoWifiOnly = netLogoWifi.value,
  )
  private fun ruleOf(s: String) = when (s) {
    "allow" -> NetworkPolicy.CellularRule.ALLOW
    "deny" -> NetworkPolicy.CellularRule.DENY
    else -> NetworkPolicy.CellularRule.CONFIRM
  }

  fun setNetFullCheck(v: String) { netFullCheck.value = v; Prefs.set(ctx, Prefs.NET_FULL_CHECK, v) }
  fun setNetSync(v: String) { netSync.value = v; Prefs.set(ctx, Prefs.NET_SYNC, v) }
  fun setNetLogoWifi(b: Boolean) { netLogoWifi.value = b; Prefs.set(ctx, Prefs.NET_LOGO_WIFI, b) }

  /** 确认门：允许则放行原操作（大流量二段式——DENY 在入口已拦，CONFIRM 弹门，ALLOW 直跑） */
  fun proceedGate() {
    val g = netGate.value ?: return
    netGate.value = null
    when (g.first) {
      NetGate.Act.FULL_CHECK -> runManualHealth()
      NetGate.Act.SYNC -> runFullSync()
      NetGate.Act.LIGHT_UPDATE -> runCheckUpdate()        // AIbot P1：确认后续跑轻更新整链（检查+下载+应用）
    }
  }
  fun cancelGate() { netGate.value = null }

  /** 台标补全 Wi-Fi 优先：策略判过才发请求（已缓存台标的同步窥探不受影响） */
  private fun logoAllowed() = policy.allow(NetworkPolicy.Op.LOGO_PREFETCH, netRules()).ok

  private val toastCh = Channel<String>(Channel.BUFFERED)
  val toasts: Flow<String> = toastCh.receiveAsFlow()
  fun toast(msg: String) { toastCh.trySend(msg) }

  private val cur get() = PlayerHolder.ui.value
  private val playKeys = PlayerHolder.ui.map { it.st to it.station?.key }.distinctUntilChanged()

  /* —— B3 状态声明（须在 init 前声明：init 内装载/接线，声明式初始化按文本序执行会回写覆盖）—— */
  /** v2 新消费面（规范化事件，供统计/发现派生；legacy 恒 null）。切台/清空随管线 reset 归 null。 */
  val curMetadata = MutableStateFlow<MetadataEvent?>(null)
  private var metaState = MetadataPipeline.State()
  /** Legacy 曲讯分支（AIbot P1-2）：metadataV2 关闭时专用——B2 前语义独立消费（不经 MetadataPipeline，
   *  v2 的 30s 窗/迟到 at 丢弃不渗入）；show=setSong（ui.song+MediaSession）、archive=pushSong 入史。 */
  private val legacySink = LegacyMetadataSink(
    show = { PlayerHolder.setSong(it) },
    archive = { u0, t -> viewModelScope.launch(Dispatchers.IO) { runCatching { lib.pushSong(u0, t) }; stamp.value++ } })
  private val listenSidecar = ListenSidecar(ctx.filesDir)
  private var listenTracker: ListenTracker? = null
  private val recovered = LinkedHashMap<String, Long>()   // 台 key → 复活时刻（Prefs 缓存 7 天过期）
  /** radio-meta 与当前 radio 资产同批绑定（AIbot P1-4 + 三轮 P1）：false/混态时发现页「最近新增」置空（不猜）。
   *  判据见 RadioMeta.bound（filesDir/assets 来源配对 + stamp.meta 见证 + radio/meta 内容哈希核对）。 */
  var metaBound = false; private set
  val metadataUnbound = MutableStateFlow(false)

  /** 渲染快照（唯一渲染入口精神：列表 + 分类角标 + 死台开关可见性 + 空态文案）；
   *  ver = stamp 哨兵进值域（审计 P2）：StateFlow 按相等合并，内容未变的 stamp++ 会被判等丢弃——
   *  台标后解析补渲/体检升档徽标翻面就靠它（收藏星 b1dfed6 事故的同族另一半） */
  data class ListUi(val list: List<Station>, val chips: List<Pair<String, Int>>, val hasDead: Boolean, val empty: String?, val ver: Int = 0)

  val listUi: StateFlow<ListUi> = combine(cat, keyword, showDead, playKeys, stamp) { _, _, _, _, st ->
    computeListUi().copy(ver = st)
  }.stateIn(viewModelScope, SharingStarted.Eagerly, ListUi(emptyList(), emptyList(), false, null))

  /* 收藏键集（响应式）：行级收藏星的状态源——不能在行内直读 lib.isFav（行参数不变时 LazyColumn 会跳过
     行重组，星星永远不翻面——实机收藏「无反应」的根因）；经 items lambda 外层捕获才能触发逐行重渲 */
  val favKeys: StateFlow<Set<String>> = listUi
    .map { runCatching { lib.favKeys() }.getOrDefault(emptySet()) }
    .distinctUntilChanged()
    .stateIn(viewModelScope, SharingStarted.Eagerly, emptySet())

  /* 收藏页投影（P0 最小版，方案 §5.5 子集；P1 升级 FavoriteListUi 全量）：按收藏写入序遍历 lib.favs——
     键优先 URL 兜底解析（Library.resolveEntry 同款），休眠孤儿/手动隐藏跳过、按键去重（回绑可归并同台）；
     顺序语义 = 既有实现遍历序（Web scopeFavRecent/logosEnsure 同款，「最新收藏置顶」留 P1 全量版裁决）；
     combine(stamp) 与 listUi 同款哨兵驱动，收藏/装配/维护配置变更自动重算，composable 不直读 lib */
  val favorites: StateFlow<List<Station>> = combine(stamp) {
    runCatching {
      val seen = HashSet<String>(); val out = ArrayList<Station>()
      for (f in lib.favs) {
        val s = runCatching { lib.resolve(f.k) }.getOrNull() ?: (
          if (f.u.isEmpty()) null else runCatching { lib.stations.firstOrNull { st -> st.u.any { it in f.u } } }.getOrNull())
        if (s == null || s.hidden || !seen.add(s.key)) continue
        out.add(s)
      }
      out
    }.getOrDefault(emptyList())
  }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

  /* 添加电台页的分类候选（审计 P3：catOptions() 直读无订阅，boot 未完成进页则 chips 永远空——从 listUi 派生响应式） */
  val addCats: StateFlow<List<String>> = listUi
    .map { lu -> lu.chips.drop(2).map { c -> c.first } }                 // 掐头去「全部/最近」（§5.1 chips 已去收藏哨兵；addCats 语义 = 真实分类）
    .distinctUntilChanged()
    .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

  /* 收藏页全量投影（P1 §5.5）：收藏集合内独立搜索/分类——favoriteQuery/favoriteCategory 进程内瞬态，
     不写电台页 cat/keyword（收藏顶层页是收藏集合唯一主入口，电台页范围 chip 只留 全部/最近）；
     数据源 = favorites（lib.favs 单一来源投影）+ favKeys 触发；过滤/chips/empty 派生收口在
     buildFavoriteListUi 纯函数（JVM 直测）；ver = stamp 哨兵进值域（同 ListUi.ver） */
  val favoriteQuery = MutableStateFlow("")
  val favoriteCategory = MutableStateFlow("全部")
  val favoriteListUi: StateFlow<FavoriteListUi> =
    combine(favorites, favKeys, favoriteQuery, favoriteCategory, stamp) { favs, _, q, c, st ->
      buildFavoriteListUi(favs, q, c, st, runCatching { lib.cats() }.getOrDefault(emptyList()))
    }.stateIn(viewModelScope, SharingStarted.Eagerly, FavoriteListUi())

  init {
    wirePlayer()
    resumeOnStart.value = Prefs.get(ctx, Prefs.RESUME, false)   // N4
    audioOffload.value = Prefs.get(ctx, Prefs.OFFLOAD, false)   // E5
    netFullCheck.value = Prefs.get(ctx, Prefs.NET_FULL_CHECK, "confirm")   // B5 网络策略三键
    netSync.value = Prefs.get(ctx, Prefs.NET_SYNC, "confirm")
    netLogoWifi.value = Prefs.get(ctx, Prefs.NET_LOGO_WIFI, true)
    timeshiftOn.value = Prefs.get(ctx, Prefs.TIMESHIFT, false)  // B7 Spike（attach 处也会读，幂等）
    // B3-C：health 复活记录运行时缓存（7 天过期剪裁；坏 JSON 按空表恢复）
    recovered.putAll(runCatching { parseRecovered(Prefs.getStr(ctx, Prefs.RECOVERED, "")) }.getOrDefault(emptyMap()))
    if (FeatureFlags.LISTEN_STATS) {
      // B3-B：sidecar 装载在 Main 构造（filesDir 小文件）；消费/flush 由开关门控——关 = 不消费不 flush不清数据。
      // AIbot 三轮 P1：restore 先合流 pending（上次写失败残留的未确认增量快照）——重启不丢，走既有 flush 链路
      listenTracker = runCatching {
        ListenTracker.restore(SystemClock::elapsedRealtime, System::currentTimeMillis, listenSidecar)
      }.getOrNull() ?: ListenTracker(SystemClock::elapsedRealtime, System::currentTimeMillis)
      viewModelScope.launch {   // 30s 周期 flush（页面隐藏 flush 在 onAppHidden；快照覆盖幂等）
        while (true) { delay(30_000); runCatching { flushStats() } }
      }
    }
    viewModelScope.launch(Dispatchers.IO) { boot() }
    // B5：Widget 状态推送（与 PlaybackService 侧收集生命周期互补，onUi 幂等去重不双刷）
    viewModelScope.launch { PlayerHolder.ui.collect { WidgetPush.onUi(ctx, it) } }
    // B2 播放样本 + B3 元数据管线 reset / 收听状态机：PlayerHolder 状态流统一消费（映射在 Main；
    // QualityStore 写盘派发 IO）。PlayerHolder 不感知这些消费方（模块边界照抄 onstate 回调注入方向）
    viewModelScope.launch {
      PlayerHolder.ui.collect { u ->
        runCatching { mapQualityEvent(u) }
        runCatching { mapMetaReset(u) }
        if (listenTracker != null) runCatching { mapListenState(u) }
        qPrev = u
      }
    }
    // B5：流量估算采样（30s 一跳，仅播放中累计；估算口径防精确计费误导）
    viewModelScope.launch {
      while (true) {
        delay(30000)
        val u = PlayerHolder.ui.value
        if (u.st == PState.PLAYING) {
          listenMs += 30000
          if (u.kbps > 0) lastKbps = u.kbps
          trafficTxt.value = TrafficEstimator.estimateText(lastKbps, listenMs, listenMs / 60000)
        }
      }
    }
  }

  override fun onCleared() {   // VM 亡后通知栏/Widget 的 ⏮⏭ 与空台续播仍可用：回装文件侧兜底（VRadioApp 同款）
    WidgetCommands.wireFallback(ctx)
  }

  /* ---------- boot 编排（app.js boot + sync.js bootQuiet 平移；安卓不跑首启基线，plan M3 拍板）：
     assets 读 radio.txt/logos.txt/data-stamp.txt → D7 filesDir 副本优先（LightUpdate.radioText 非空用之）→
     my-radio 装载 → Library.reload 装配 → Logos 装载 → UI 三键恢复 → 台标预取（收藏+正在播）→
     4s 后静默体检（收藏+最近 ∪ 死标记台范围，Health.bootScope 节流；仅 WiFi，D10） ---------- */
  private suspend fun boot() {
    assetsStamp = readAsset("data-stamp.txt")?.trim() ?: ""
    val aRadio = readAsset("radio.txt") ?: ""
    val aLogos = readAsset("logos.txt") ?: ""
    val fRadio = light.radioText()                            // filesDir 副本（AIbot P1-4 绑定判据）
    val mainTxt = fRadio ?: aRadio                            // 文件读取留 IO
    val myTxt = myRadio.readText()
    val logosTxt = light.logosText() ?: aLogos
    val fMeta = light.metaText()
    runCatching { quality.load() }                            // B2 质量侧车（坏文件按空库恢复）
    val parsedMeta = RadioMeta.parse(fMeta ?: readAsset("radio-meta.json"))
    radioMeta.value = parsedMeta ?: RadioMeta.EMPTY   // 缺件/坏件空对象兜底
    // AIbot P1-4 混态拦截：meta 与当前 radio 资产须同批（filesDir/assets 来源配对 + stamp.meta 见证 +
    // 三轮 P1 内容哈希核对——新 radio 配残留旧 stamp 时哈希对不上）→ 不绑定则发现页「最近新增」置空（不猜）
    val hashW = light.stampHashOk()
    metaBound = RadioMeta.bound(fRadio != null, fMeta != null, light.stampMetaOk(), hashW.first, hashW.second)
    metadataUnbound.value = metadataUnavailable(parsedMeta != null, metaBound)
    withContext(Dispatchers.Main) {                           // Library 装配收敛主线程（审计 P2：非线程安全集合与渲染读侧单线程化）
      lib.mainText = mainTxt
      lib.myText = myTxt
      runCatching { lib.reload() }
      runCatching { logos.loadBuiltins(logosTxt) }
      quality.keepHint = qualityKeepSnapshot()                // trim 保护集（收藏+最近的 URL 快照，Main 侧读）
    }
    refreshUi3()                                                          // view/showdead/theme 三键恢复（app.js loadUi3 同款）
    stamp.value++
    primeAll()
    withContext(Dispatchers.Main) {
      refreshLogoRetry()
      booted = true
      consumePending()   // batch1 启动末梢：E3 快捷方式点播 > E4 接流预填 > N4 自动续播（默认关）
      updateShortcuts()  // E3 动态快捷方式初装（收藏变更/导入时增量刷新）
    }
    viewModelScope.launch { delay(5000); checkFreshness() }
    delay(4000)                                                          // 首屏后 4s 静默复查（B-10）
    if (unmetered()) silentCheck()                                       // 仅 WiFi（D10）；移动数据静默跳过
  }

  private fun readAsset(name: String): String? = runCatching {
    ctx.assets.open(name).bufferedReader().use { it.readText() }
  }.getOrNull()

  /* ---------- batch1：E3/E4 入口路由 · N4 启动续播 · N8 分享 · E3 桌面快捷方式 ---------- */

  /** E3/E4 入口（MainActivity onCreate/onNewIntent 都到这）。boot 未完成时挂起由启动末梢消费
   *  （列表未装载无法解析台 key）；已 boot 则即时消费（Main 线程——play 链要求）。 */
  fun handleIntent(i: Intent?) {
    i ?: return
    val sc = i.getStringExtra(EXTRA_SC)
    if (sc != null) {
      pendingSc = sc
      if (booted) viewModelScope.launch(Dispatchers.Main) { consumePending() }
      return
    }
    if (i.action == Intent.ACTION_VIEW) {   // E4：流链接 → 预填添加页（探活口径不变，不自动入库）
      val u = i.data?.toString()?.trim().orEmpty()
      if (u.startsWith("http://", ignoreCase = true) || u.startsWith("https://", ignoreCase = true)) {   // AIbot P3：浏览器转发可能保留大写 scheme
        addPreset.value = u
        if (booted) { openAddStation(); toast("已填入流地址，探活通过后点「添加」") }
      }
    }
  }

  /** 启动末梢的消费序（有意固定）：快捷方式点播 > 链接接流预填 > 自动续播——显式意图不抢。 */
  private fun consumePending() {
    val sc = pendingSc; pendingSc = null
    when {
      sc == "last" -> resumeLast()
      sc != null -> {
        val s = runCatching { lib.stations.firstOrNull { it.key == sc } }.getOrNull()
        if (s != null) startPlay(s)
        else { resumeLastIfWanted(); setStatus("快捷方式指向的电台已不在列表中") }
      }
      addPreset.value != null -> { openAddStation(); toast("已填入流地址，探活通过后点「添加」") }   // AIbot P3：冷启动接流与热路径反馈一致
      else -> resumeLastIfWanted()
    }
  }

  /** N4 启动自动续播（默认关，2026-10-18 拍板）：冷启动且无台在播时接续上次收听 */
  private fun resumeLastIfWanted() {
    if (!resumeOnStart.value || PlayerHolder.ui.value.station != null || lib.recents.isEmpty()) return
    resumeLast()
  }

  /** E3 动态桌面快捷方式：「继续收听」+ 收藏前 N 台（maxShortcutCountPerActivity 封顶）。
   *  minSdk 26 ≥ ShortcutManager 基线；收藏变更/导入后调用刷新（setDynamicShortcuts 整组替换）。 */
  fun updateShortcuts() {
    if (Build.VERSION.SDK_INT < 26) return
    runCatching {
      val sm = ctx.getSystemService(ShortcutManager::class.java) ?: return
      val cap = sm.maxShortcutCountPerActivity.coerceAtLeast(1)
      val out = ArrayList<ShortcutInfo>(cap)
      fun mk(id: String, label: String, extra: String) = ShortcutInfo.Builder(ctx, id)
        .setShortLabel(label.take(10)).setLongLabel(label.take(25))
        .setIntent(Intent(ctx, MainActivity::class.java).setAction(Intent.ACTION_MAIN).putExtra(EXTRA_SC, extra)).build()
      out.add(mk("last", "继续上次收听", "last"))
      for (f in lib.favs) {
        if (out.size >= cap) break
        val s = runCatching { lib.resolve(f.k) }.getOrNull() ?: continue
        out.add(mk("fav:" + s.key, s.n, s.key))
      }
      sm.setDynamicShortcuts(out)
    }
  }

  /** N8 分享电台：台名 + 主源 URL 纯文本（http 直链任何播放器可开） */
  fun shareStation(s: Station) {
    runCatching {
      val i = Intent(Intent.ACTION_SEND).setType("text/plain")
        .putExtra(Intent.EXTRA_TEXT, "${s.n} · VRadio\n${s.u0}")
      ctx.startActivity(Intent.createChooser(i, "分享电台").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }.onFailure { toast("分享失败：${it.message ?: it.toString()}") }
  }

  fun setResume(b: Boolean) { resumeOnStart.value = b; Prefs.set(ctx, Prefs.RESUME, b) }   // N4
  fun setOffload(b: Boolean) { audioOffload.value = b; Prefs.set(ctx, Prefs.OFFLOAD, b) } // E5（重启生效）
  fun setTimeshift(b: Boolean) {                                                        // B7 Spike（即时生效）
    timeshiftOn.value = b; Prefs.set(ctx, Prefs.TIMESHIFT, b); Timeshift.setEnabled(b)
  }

  /* PlayerHolder 回调接线（player 不反向伸手进 UI，方向照抄 Web） */
  private fun wirePlayer() {
    PlayerHolder.onStepFav = { d -> stepFav(d) }                          // ⏮⏭ / ←→ 收藏间切台
    PlayerHolder.onPlayLast = { resumeLast() }                            // 媒体键 play 空台 → 续播上次
    PlayerHolder.onMetadata = { ev -> runCatching { onMetaEvent(ev) } }   // B3-A：ICY 事件（清洗已做）→ 管线/sink
    PlayerHolder.logoProvider = { s -> logos.get(s) }                     // 锁屏 artwork 同步窥探口径
  }

  /* ---------- B3-A 元数据 sink（Legacy/V2 显式分支，AIbot P1-2；两者不得同时写历史） ---------- */

  /** 事件消费：flag 开 = MetadataV2Sink（管线决策：30s 窗/迟到丢弃 + 归一化事件留底 curMetadata）；
   *  flag 关 = LegacyMetadataSink（B2 前语义独立分支：连续同名去重/换歌入史，无 30s 窗——绝不双写）。 */
  private fun onMetaEvent(ev: MetadataEvent) {
    if (FeatureFlags.METADATA_V2) {
      val (st, d) = MetadataPipeline.accept(metaState, ev)
      metaState = st
      if (d.show != null) PlayerHolder.setSong(d.show)
      if (d.archiveU0 != null && d.archiveTitle != null) {
        val u0 = d.archiveU0; val t = d.archiveTitle
        viewModelScope.launch(Dispatchers.IO) { runCatching { lib.pushSong(u0, t) }; stamp.value++ }
      }
      curMetadata.value = metaState.last
    } else {
      legacySink.accept(ev.stationIdentityUrl, ev)
      curMetadata.value = null
    }
  }

  /** 切台/刷新/全部失败先清空旧曲讯再接受新世代事件（防旧连接串台）：play()/refresh() 必经
   *  CONNECTING+空 song（ui 承担显示清零）、善后必清台——管线簿记与 legacySink.last（B2 lastSong 等价物）
   *  一并 reset；台变化兜底第三分支。 */
  private fun mapMetaReset(u: PlayerUiState) {
    val id = u.station?.u0
    when {
      id == null -> if (metaState.station != null || legacySink.last.isNotEmpty()) {
        metaState = MetadataPipeline.reset(metaState, null); legacySink.reset()
      }
      u.song.isEmpty() && (u.st == PState.CONNECTING || u.st == PState.IDLE) ->
        if (metaState.station != id || metaState.display.isNotEmpty() || legacySink.last.isNotEmpty()) {
          metaState = MetadataPipeline.reset(metaState, id); legacySink.reset()
        }
      metaState.station != id -> { metaState = MetadataPipeline.reset(metaState, id); legacySink.reset() }
    }
    if (!FeatureFlags.METADATA_V2) curMetadata.value = null
  }

  /* ---------- B3-B 收听统计（filesDir/listen-stats.json sidecar；只 PLAYING 累加，诊断不算收听） ---------- */

  /** PState 流映射（fake-clock 可测状态机在 ListenTracker；这里只喂事件）。 */
  private fun mapListenState(u: PlayerUiState) {
    val src = u.station?.let { s -> u.srcIdx.takeIf { i -> i in s.u.indices }?.let { s.u[it] } }
    listenTracker?.onState(u.st, u.station, src)
  }

  /** flush（30s tick / 页面隐藏 / 手动）：收账 + trim(90 天·512KB) + 快照覆盖写（幂等）；写成功才推进
   *  确认快照——失败增量保留内存下次 flush/启动重试（AIbot 复核 P1，ListenTracker.flush 单元把守）。 */
  fun flushStats() {
    val t = listenTracker ?: return
    viewModelScope.launch(Dispatchers.IO) { runCatching { t.flush(listenSidecar) } }
  }

  /** 页面隐藏（MainActivity.onStop）：收听统计 flush（Web visibilitychange 同款时机）。 */
  fun onAppHidden() { if (FeatureFlags.LISTEN_STATS) runCatching { flushStats() } }

  /** 近 N 天汇总（设置页/发现页展示口径；开关关时数据仍在，读不消费）。 */
  fun statsSummary(days: Int = 7) = listenTracker?.let { ListenStats.summary(it.state, days) }
    ?: runCatching { ListenStats.summary(listenSidecar.load(), days) }.getOrNull()

  /* ---------- B3-C 本地发现页（纯本地派生：不联网、不改主列表排序、点击走既有 play 通道） ---------- */

  data class DiscoveryUi(val groups: Groups, val ver: Int = 0)

  /** 派生视图（stamp 哨兵驱动：体检/同步/收藏/数据更新后自动重算；开关关 UI 不入口，计算也跳过）。 */
  val discovery: StateFlow<DiscoveryUi> = combine(stamp, showDead, playKeys) { _, _, _ ->
    DiscoveryUi(if (FeatureFlags.DISCOVERY) runCatching { buildDiscovery() }.getOrDefault(Groups.EMPTY)
               else Groups.EMPTY, stamp.value)
  }.stateIn(viewModelScope, SharingStarted.Eagerly, DiscoveryUi(Groups.EMPTY))

  private fun buildDiscovery(): Groups {
    val sts = runCatching { lib.stations.toList() }.getOrDefault(emptyList())
    val q = HashMap<String, QInfo>()
    for (s in sts) runCatching { quality.summary(s.u0, s.u) }.getOrNull()?.let {
      q[s.u0] = QInfo(it.stability, it.directCount, it.metadata, it.lastObservedAt)
    }
    val meta = radioMeta.value
    val firstSeen = HashMap<String, Long>()
    if (metaBound) for ((id, m) in meta.stations) {   // firstSeenAt 挂 sources[] 为主、台级直挂容错——取最早（B3-C 双端口径）；
      val fs = (listOf(m.firstSeenAt) + m.sources.map { it.firstSeenAt }).filter { it > 0L }.minOrNull() ?: 0L   // AIbot P1-4：混态（不绑定）整组置空
      if (fs > 0L) firstSeen[id] = fs
    }
    return Discovery.build(DiscoveryInput(
      stations = sts,
      playingKey = playKey(), connectingKey = connKey(),
      hiddenCats = runCatching { lib.cfg.hideC.keys }.getOrDefault(emptySet()),
      quality = q, firstSeenAt = firstSeen,
      recoveredAt = RecoveryLog.prune(recovered, System.currentTimeMillis()),
      recentKeys = runCatching { lib.recents.map { it.k }.toSet() }.getOrDefault(emptySet()),
    ))
  }

  /** health dead→alive 转移记录（体检三通道共用；调用方先验 marks 含 key 才调——转移才记，不猜）。 */
  private fun noteRecoveredIfRevived(key: String) {
    if (recovered.containsKey(key)) return
    val now = System.currentTimeMillis()
    recovered[key] = now
    val pruned = RecoveryLog.prune(recovered, now)   // 顺带清过期（保留刚记的）
    recovered.clear(); recovered.putAll(pruned)
    Prefs.setStr(ctx, Prefs.RECOVERED, JSONObject().apply { for ((k, v) in pruned) put(k, v) }.toString())
    stamp.value++   // 发现页「最近恢复」即时可见
  }

  private fun parseRecovered(raw: String): Map<String, Long> {
    if (raw.isEmpty()) return emptyMap()
    val o = runCatching { JSONObject(raw) }.getOrNull() ?: return emptyMap()
    val out = LinkedHashMap<String, Long>()
    for (k in o.keys()) { val v = o.optLong(k, 0L); if (v > 0) out[k] = v }
    return RecoveryLog.prune(out, System.currentTimeMillis())
  }

  /* ---------- B2 质量样本映射（PlayerUiState 流 → QualityStore；自动体检路径只写 diagnostic，绝不产 playback） ----------
     事件面（plan §6.1 样本来源四类）：CONNECTING→PLAYING = 成功（trigger=play；同台换源到达 = switch，
     延迟 = 该源 CONNECTING 锚起算）；PLAYING→CONNECTING 同台 = 断流（同源重连 = watchdog、级联换源 =
     error，均计 disconnects）；CONNECTING→IDLE 清台且「⚠ 全部源失败」= 播放失败（error）。暂停/停止不产事件。 */
  private var qPrev = PlayerUiState()
  private var qConnMark = ""       // "key|srcIdx" 的 CONNECTING 计时锚（成功事件延迟采样）
  private var qConnAt = 0L
  private var qPlayedKey: String? = null   // 最近一次成功起播的台 key / 源序号（switch 判定）
  private var qPlayedSrc = -1

  private fun mapQualityEvent(cur: PlayerUiState) {
    val prev = qPrev
    val ps = prev.station; val cs = cur.station
    if (cur.st == PState.CONNECTING && cs != null) {
      val mark = "${cs.key}|${cur.srcIdx}"
      // 断流重开（PLAYING→CONNECTING）也重置锚：恢复成功的延迟 = 重连耗时，不混入已播时长
      if (mark != qConnMark || prev.st == PState.PLAYING) { qConnMark = mark; qConnAt = System.currentTimeMillis() }
    }
    if (prev.st == PState.PLAYING && cur.st == PState.CONNECTING && ps != null && cs != null && cs.key == ps.key) {
      val u = cur.srcIdx.takeIf { it in cs.u.indices }?.let { cs.u[it] }
      if (u != null) qPlayback(cs.u0, u, false, 0, cur.mode, if (cur.srcIdx == prev.srcIdx) "watchdog" else "error")
      return   // 断流后紧接的成功/失败由后续状态迁移单独产事件
    }
    if (cur.st == PState.PLAYING && cs != null &&
      (prev.st == PState.CONNECTING || prev.station?.key != cs.key || prev.srcIdx != cur.srcIdx)) {
      val u = cur.srcIdx.takeIf { it in cs.u.indices }?.let { cs.u[it] }
      if (u != null) {
        val lat = if (qConnMark == "${cs.key}|${cur.srcIdx}" && qConnAt > 0) System.currentTimeMillis() - qConnAt else 0L
        val trig = if (qPlayedKey == cs.key && qPlayedSrc >= 0 && qPlayedSrc != cur.srcIdx) "switch" else "play"
        qPlayback(cs.u0, u, true, lat, cur.mode, trig)
        qPlayedKey = cs.key; qPlayedSrc = cur.srcIdx
      }
    }
    if (prev.st == PState.CONNECTING && cur.st == PState.IDLE && cur.station == null && ps != null &&
      cur.status.startsWith("⚠")) {   // 级联耗尽善后文案（PlayerHolder 常量串；stop() 清空 status 不误触）
      val u = prev.srcIdx.takeIf { it in ps.u.indices }?.let { ps.u[it] }
      if (u != null) qPlayback(ps.u0, u, false, 0, prev.mode, "error")
    }
    if (cur.station == null) { qPlayedKey = null; qPlayedSrc = -1 }
  }

  private fun qPlayback(id0: String, src: String, ok: Boolean, latMs: Long, mode: String, trig: String) {
    quality.keepHint = runCatching { qualityKeepSnapshot() }.getOrDefault(quality.keepHint)
    viewModelScope.launch(Dispatchers.IO) { runCatching { quality.recordPlayback(id0, src, ok, latMs, mode, trig) } }
  }

  /** trim 保护集：收藏 + 最近的源 URL 快照（身份 URL 含于其中；Main 侧快照防与 Library 变异并发）。 */
  private fun qualityKeepSnapshot(): Set<String> {
    val out = HashSet<String>()
    runCatching {
      for (f in lib.favs) out.addAll(f.u)
      for (r in lib.recents) out.addAll(r.u)
    }
    return out
  }

  /** 源详情质量摘要（B2）：无样本返回 null（浮层不渲染稳定性行）。 */
  fun qualitySummaryOf(s: Station): QualityStore.QualityAggregate? =
    runCatching { quality.summary(s.u0, s.u) }.getOrNull()

  /* 台标预取（收藏 + 正在播优先，请求量可控）；完成后重渲一次取新解析到的 URL。
     B5：Wi-Fi 优先策略——移动数据（未开「也允许」）整段跳过，已缓存台标的同步窥探不受影响 */
  private fun primeAll() = viewModelScope.launch(Dispatchers.IO) {
    if (!logoAllowed()) return@launch
    val favs = withContext(Dispatchers.Main) {                             // favs 快照归 Main（审计 P2：IO 迭代与 Main 变异并发 CME）
      runCatching { lib.favs.toList() }.getOrDefault(emptyList())
    }
    val seen = HashSet<String>()
    for (f in favs) {
      val s = runCatching { lib.resolve(f.k) }.getOrNull() ?: continue
      if (seen.add(s.key)) runCatching { logos.prime(s, true) }
    }
    cur.station?.let { s -> if (seen.add(s.key)) runCatching { logos.prime(s, true) } }
    // AIbot P2-7：台标若在开播后才解析到，锁屏 artwork 需补刷（app.js:545 ensure 回调 → setSong 同款）
    if (PlayerHolder.ui.value.st == PState.PLAYING) PlayerHolder.setSong(PlayerHolder.ui.value.song)
    stamp.value++
  }

  /* WiFi-only 判定（D10）：isActiveNetworkMetered==false 视为 WiFi（无网时系统报计量，自然跳过） */
  private fun unmetered(): Boolean {
    val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
    return !cm.isActiveNetworkMetered
  }

  /* E13 同步前置电量检查（xueshi86 思路）：sticky 广播读电量；读不到按 100 放行（不误拦） */
  private fun battSticky() = runCatching {
    ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
  }.getOrNull()
  private fun battPct(): Int {
    val b = battSticky() ?: return 100
    val lv = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1); val sc = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    return if (lv < 0 || sc <= 0) 100 else lv * 100 / sc
  }
  private fun charging(): Boolean = (battSticky()?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0

  /* ---------- 列表计算（app.js visible/catCounts/emptyHtml 平移；分类/关键词口径叠加在 Library.visible 之上） ---------- */

  private fun playKey(): String? { val u = cur; return if (u.st == PState.PLAYING || u.st == PState.PAUSED) u.station?.key else null }
  private fun connKey(): String? { val u = cur; return if (u.st == PState.CONNECTING) u.station?.key else null }

  private fun recentList(vis: List<Station>): List<Station> {
    val keys = vis.mapTo(HashSet()) { it.key }
    return lib.recents.mapNotNull { r -> runCatching { lib.resolve(r.k) }.getOrNull() }
      .filter { keys.contains(it.key) }.distinctBy { it.key }
  }

  private fun filteredList(includeDead: Boolean): List<Station> {
    var list = runCatching { lib.visible(includeDead, playKey(), connKey()) }.getOrDefault(emptyList())
    list = when (val c = cat.value) {
      "最近" -> recentList(list)
      "★收藏" -> list.filter { runCatching { lib.isFav(it) }.getOrDefault(false) }
      "全部" -> list
      else -> list.filter { it.c == c }
    }
    val kw = keyword.value.trim().lowercase()
    if (kw.isNotEmpty()) {                                                // 多词空格 AND（audit-r2 口径）
      val ws = kw.split(Regex("\\s+"))
      list = list.filter { s -> val n = s.n.lowercase(); ws.all { n.contains(it) } }
    }
    return list
  }

  private fun computeListUi(): ListUi {
    val vis = runCatching { lib.visible(showDead.value, playKey(), connKey()) }.getOrDefault(emptyList())
    val byCat = vis.groupingBy { it.c }.eachCount()
    val chips = ArrayList<Pair<String, Int>>(10)
    chips.add("全部" to vis.size)
    chips.add("最近" to recentList(vis).size)                // §5.1 范围 chip 只留 全部/最近——★收藏 收敛到收藏顶层页（§5.5 唯一主入口）
    val cats = runCatching { lib.cats() }.getOrDefault(emptyList())
    for (c in cats) chips.add(c to (byCat[c] ?: 0))
    if (cat.value != "全部" && cat.value != "★收藏" && cat.value != "最近" && chips.none { it.first == cat.value })
      cat.value = "全部"                                                  // 数据更新/分类被藏后回退全部（buildCats 同款）
    val list = filteredList(showDead.value)
    val empty = if (list.isEmpty()) emptyMsg() else null
    val hasDead = runCatching { lib.stations.any { it.health == "dead" } }.getOrDefault(false)
    return ListUi(list, chips, hasDead, empty)
  }

  private fun emptyMsg(): String {                                        // emptyHtml 平移（空态给原因和下一步）
    if (cat.value == "★收藏" && lib.favs.isEmpty()) return "还没有收藏电台——点电台旁 ☆ 即可收藏"
    if (cat.value == "最近" && lib.recents.isEmpty()) return "还没有播放记录——点任意电台即开始收听"
    if (filteredList(true).isNotEmpty()) return "当前筛选的电台均已体检不可用（默认隐藏）——到设置打开「显示无效源」"
    return if (keyword.value.isNotBlank()) "没有匹配「${keyword.value}」的电台，换个关键词试试" else "该分类暂无电台"
  }

  /* ---------- 交互入口（用户主动操作，反馈走 status） ---------- */

  fun setCat(c: String) { cat.value = c }
  fun setKeyword(k: String) { keyword.value = k }
  fun setView(v: String) { view.value = v; viewModelScope.launch(Dispatchers.IO) { Store.set(C.K_VIEW, v) } }
  fun toggleDead() {
    showDead.value = !showDead.value
    viewModelScope.launch(Dispatchers.IO) { Store.set(C.K_SHOWDEAD, if (showDead.value) "1" else "0") }
  }
  fun setTheme(t: String) { theme.value = t; viewModelScope.launch(Dispatchers.IO) { Store.set(C.K_THEME, t) } }

  fun startPlay(s: Station, prefer: Int = -1) {
    MainActivity.reqNotif?.invoke()                                       // 通知权限首播申请（拒绝不阻断，只问一次）
    viewModelScope.launch {                                               // 最近重排归 Main（审计 P2：Library 变异收敛，防与 computeListUi 迭代并发 CME）
      runCatching { lib.recordRecent(s) }
      stamp.value++
    }
    viewModelScope.launch(Dispatchers.IO) { if (logoAllowed()) runCatching { logos.prime(s, true) } }   // 正在播台标优先补全（B5 策略门）
    PlayerHolder.play(s, prefer)
  }

  fun togglePlay(k: String) {                                             // 再点当前台 = 暂停/继续；点其他台 = 切换
    val s = runCatching { lib.stations.firstOrNull { it.key == k } }.getOrNull() ?: return
    val u = cur
    if (u.station?.key == k && u.st != PState.IDLE) { PlayerHolder.toggle(); return }
    startPlay(s)
  }

  fun toggleFav(s: Station) {
    viewModelScope.launch {                                               // Library 变异归 Main（审计 P2：与 favKeys/computeListUi 迭代并发 CME）
      runCatching { lib.toggleFav(s) }
      val fav = runCatching { lib.isFav(s) }.getOrDefault(false)
      quality.keepHint = runCatching { qualityKeepSnapshot() }.getOrDefault(quality.keepHint)   // B2：trim 保护集随收藏增减
      stamp.value++
      updateShortcuts()                                                  // E3：快捷方式随收藏增减刷新
      if (fav && logoAllowed()) viewModelScope.launch(Dispatchers.IO) { runCatching { logos.prime(s, true) } }   // 新收藏优先补台标（B5 策略门）
    }
  }

  /* 取消收藏撤销（P1 Q13/Q17）：收藏页专用入口——立即取消 + 入撤销队列（AppRoot 顺序 collect 出 Snackbar，
     每条约 8s 可撤销、离开收藏页 clearFavUndo() 排空作废）；撤销按 URL 身份恢复，不按台名回绑。
     review#46 二轮 P2：单槽 MutableStateFlow 会被快速连续取消覆盖（前一台撤销窗口丢失）——改带 operationId
     的 Channel 事件队列，逐操作入队/逐条消费，Snackbar 按 id 归属、互不覆盖 */
  data class FavUndoEvent(val id: Long, val station: Station)
  private val favUndoCh = Channel<FavUndoEvent>(Channel.UNLIMITED)
  val favUndoEvents: Flow<FavUndoEvent> = favUndoCh.receiveAsFlow()       // UI 顺序消费（一条 Snackbar 关闭再出下一条）
  private var favUndoSeq = 0L

  /** 收藏页取消收藏：toggle 即取消（守卫防误加——非收藏态不翻转）+ 发撤销请求 */
  fun unfavWithUndo(s: Station) {
    viewModelScope.launch {                                               // Library 变异归 Main（审计 P2，同 toggleFav）
      if (!runCatching { lib.isFav(s) }.getOrDefault(false)) return@launch
      runCatching { lib.toggleFav(s) }
      quality.keepHint = runCatching { qualityKeepSnapshot() }.getOrDefault(quality.keepHint)   // B2：trim 保护集随收藏增减
      stamp.value++
      updateShortcuts()                                                  // E3：快捷方式随收藏增减刷新
      favUndoSeq += 1
      favUndoCh.trySend(FavUndoEvent(favUndoSeq, s))
    }
  }

  /** 撤销取消收藏：按 URL 身份找回库内同一台（reload/同步重建后显示键可能漂移，任一源 URL 命中即回绑；
     失联时按原条目写回 = 休眠待回绑，带 URL 的条目永不回收），走 toggleFav 同一条写回路径 + 台标 prime */
  fun undoUnfav(s: Station) {
    viewModelScope.launch {
      val cur = runCatching { lib.stations.firstOrNull { st -> st.u.any { u -> u in s.u } } }.getOrNull() ?: s
      if (runCatching { lib.isFav(cur) }.getOrDefault(false)) return@launch   // 期间已手动加回 = 幂等不翻转
      runCatching { lib.toggleFav(cur) }
      quality.keepHint = runCatching { qualityKeepSnapshot() }.getOrDefault(quality.keepHint)
      stamp.value++
      updateShortcuts()
      if (logoAllowed()) viewModelScope.launch(Dispatchers.IO) { runCatching { logos.prime(cur, true) } }   // 恢复收藏优先补台标（B5 策略门）
    }
  }

  fun stepFav(d: Int) {                                                   // ←/→ 收藏间切台（A-5）
    val favsIn = filteredList(showDead.value).filter { runCatching { lib.isFav(it) }.getOrDefault(false) }
    if (favsIn.isEmpty()) { setStatus("还没有收藏电台——点电台旁 ☆ 收藏后可用收藏间切换"); return }
    val curIdx = cur.station?.let { c -> favsIn.indexOfFirst { it.key == c.key } } ?: -1
    val nx = if (curIdx < 0) (if (d > 0) 0 else favsIn.size - 1) else (curIdx + d + favsIn.size) % favsIn.size
    togglePlay(favsIn[nx].key)
  }

  fun resumeLast() {                                                      // ▶ 空台 = 续播上次收听
    val r = lib.recents.firstOrNull()
    val s = r?.let { runCatching { lib.resolve(it.k) }.getOrNull() }
    if (s == null) { setStatus(if (r == null) "还没有播放记录" else "上次收听的电台已不在列表中，请直接点播"); return }
    startPlay(s)
  }

  fun locatePlaying() {                                                   // 回到正在播（N5）：当前筛选下不可见才回全部+清搜索（app.js:519 同判，保留浏览上下文）
    val s = cur.station ?: return
    val invisible = runCatching { filteredList(showDead.value).none { it.key == s.key } }.getOrDefault(true)
    if (invisible) { cat.value = "全部"; keyword.value = "" }
    secondary.value = null; destination.value = Destination.LIBRARY   // 旧 nav=LIST 平移：回电台页（次级页开着也一并收回）
    locate.value = s.key
  }

  /* ---------- 选源（web ②a/②c：立即切播；↺ 恢复默认 = forgetSrc + 重播） ---------- */

  /* 默认源启发式：直接复用 PlayerHolder.srcOrder（AIbot P3——本层复刻一份会与决策链漂移） */
  fun srcDefault(s: Station): Int = PlayerHolder.srcOrder(s).firstOrNull() ?: 0

  fun openSrc() { srcKey.value = cur.station?.key; showSrc.value = true }  // 打开选源浮层记台 key——换台（⏮⏭/线控）即收起（srcPopK 同款，app.js:563）

  fun srcReset() {
    val s = cur.station ?: return
    val had = PlayerHolder.forgetSrc()
    startPlay(s)                                                          // 无 prefer 且记忆已清 → 纯启发式序
    setStatus(if (had) "已恢复默认源，从默认源重播" else "本无源记忆，按默认序重播")
  }

  /* ---------- B1 源详情（SourceDetailSheet 编排）：逐源诊断（禁用源不发请求）+ 源动作 ---------- */

  val showDetail = MutableStateFlow(false)
  val detailKey = MutableStateFlow<String?>(null)              // 详情浮层打开时的台 key（台消失即收起）
  val detailDiag = MutableStateFlow<List<DiagnosticResult>>(emptyList()) // 最近一轮逐源诊断（按 URL 归位）
  val detailBusy = MutableStateFlow(false)                      // 诊断进行中（浮层按钮态）

  fun openDetail(s: Station) { detailKey.value = s.key; detailDiag.value = emptyList(); showDetail.value = true }
  fun openDetailOf(k: String?) {                               // PlayerBar 台名长按等入口：按 key 反解
    val s = k?.let { runCatching { lib.resolve(it) }.getOrNull() } ?: return
    openDetail(s)
  }
  fun closeDetail() { showDetail.value = false; detailKey.value = null; detailDiag.value = emptyList() }
  fun detailStation(): Station? = detailKey.value?.let { runCatching { lib.resolve(it) }.getOrNull() }

  /** 逐源诊断（B1）：只测启用源——手动禁用的源不发请求（浮层已明示「不能诊断」+「取消禁用」入口）；
   *  Android 无 /api?detail=1，CheckStream 直连；结果按测的 URL 归位，诊断顺序 = 人工有效序。
   *  ≤4/批串行推进（B1 review P1-7，Web checkStationSources 分批口径：单次探活放大面 ≤4，超 4 分批）。 */
  fun checkDetailSources(s: Station) {
    if (detailBusy.value) return
    viewModelScope.launch(Dispatchers.IO) {
      detailBusy.value = true
      try {
        val urls = withContext(Dispatchers.Main) {              // 快照归 Main（审计 P2：与 reapplyCfg 变异并发防 CME）
          runCatching { s.effOrder().map { s.u[it] } }.getOrDefault(emptyList())
        }
        if (urls.isEmpty()) return@launch
        quality.keepHint = runCatching { qualityKeepSnapshot() }.getOrDefault(quality.keepHint)
        val out = java.util.concurrent.ConcurrentHashMap<String, DiagnosticResult>()
        for (b in diagBatches(urls.size))                       // 批间串行、批内并发（放大面恒 ≤4，B1 三轮 P1-7）
          coroutineScope { for (i in b) launch {
            runCatching { checker.check(urls[i]) }.getOrNull()?.let {
              val d = it.toDiagnostic(urls[i])
              out[urls[i]] = d
              runCatching { quality.recordDiagnostic(s.u0, d, "manual") }   // B2：手动逐源诊断产 diagnostic 样本
            }
          } }
        withContext(Dispatchers.Main) { detailDiag.value = urls.mapNotNull { out[it] } }
      } catch (_: Exception) { } finally { detailBusy.value = false }
    }
  }

  /** 源动作编排（B1）：排序/禁用走 Library 整表写（reapplyCfg 即时生效）；恢复默认两动作彼此独立——
   *  「恢复默认播放源」只清 srcmem2（人工序/禁用保留），「撤销人工源排序」只删 srcManualOrder。 */
  fun srcEdit(s: Station, act: SourceAction) = viewModelScope.launch(Dispatchers.Main) {
    when (act) {
      is SourceAction.Move -> runCatching { lib.srcMove(s, act.index, act.up) }
      is SourceAction.ToggleDisable -> runCatching { lib.srcDisabledToggle(s, act.index) }
      SourceAction.RestoreDefault -> {                          // 恢复默认播放源（清 srcmem2；正在听则按链重播）
        val had = PlayerHolder.forgetSrcOf(s)
        if (cur.station?.key == s.key) startPlay(s)
        setStatus(if (had) "已恢复默认播放源（人工顺序与禁用保留）" else "本无源记忆，按默认序处理")
      }
      SourceAction.ResetOrder -> {                              // 撤销人工源排序（恢复同步原始顺序；禁用/追加源保留）
        runCatching { lib.srcOrderReset(s) }
        setStatus("已撤销人工源排序（禁用与追加源保留）")
      }
    }
    stamp.value++
  }

  /* ---------- 音量（每台音量记忆在 PlayerHolder；取消静音的恢复值走 restoreVolPct——AIbot P1-5） ---------- */

  private fun refreshUi3() {                                              // view/showdead/theme 三键恢复（boot 与备份导入共用，app.js loadUi3 同款）
    view.value = if (Store.get(C.K_VIEW) == "list") "list" else "grid"    // 网格默认
    showDead.value = Store.get(C.K_SHOWDEAD) == "1"                       // 死台默认隐藏
    theme.value = listOf("auto", "light", "dark", "oled").firstOrNull { it == Store.get(C.K_THEME) } ?: "auto"   // N18 +oled（软扩展：Web 侧未知值回退 auto 不炸，app.js:236 已核）
  }

  fun setVol(pct: Int) { PlayerHolder.setVolPct(pct) }

  fun toggleMute() {
    if (cur.volPct > 0) { PlayerHolder.setVolPct(0); setStatus("已静音") }
    else {
      // restoreVolPct = 当前台记忆 → 全局 → 默认（player.js restoreVol 同语义）；会话内近似值会把台记忆覆盖坏
      val rv = PlayerHolder.restoreVolPct()
      PlayerHolder.setVolPct(rv); setStatus("音量 $rv%")
    }
  }

  /* ---------- 只读透出 ---------- */

  fun logoOf(s: Station): String = runCatching { logos.get(s) }.getOrDefault("")
  fun songsOf(u0: String): List<SongRec> = runCatching { lib.songsOf(u0) }.getOrDefault(emptyList())
  fun permOf(s: Station): Boolean = runCatching { lib.healthMarks[s.key]?.perm == 1 }.getOrDefault(false)
  fun lastLine(): String {
    val r = lib.recents.firstOrNull() ?: return "未在播放"
    val s = runCatching { lib.resolve(r.k) }.getOrNull() ?: return "未在播放"
    return "上次收听：${s.n}"
  }

  /* ---------- 体检编排（sync.js 四通道的安卓面：手动全量 / boot 静默 / 同步后增量；busy 互斥手动优先） ----------
     网络探测在 IO 并发（前 4 源任一活即 OK，web runCheck 口径），结果回主线程统一落标记
     （Library/HashMap 非线程安全）。网络层整体故障（全部失败且样本量够）不落标记——
     移动网络抖动不该把整库标死（Web 无此问题：探活走本机后端恒可达）。 */

  private enum class Probe { OK, DEAD, NET }   // AIbot P1-4：NET=探测请求自身失败（sync.js:23 口径——请求失败不落标，
                                               // 与「台真的死」分开；防中途断网把整片台 n+1 误升停运档）

  private suspend fun probe(s: Station, qTrigger: String): Probe {
    var allNet = true                       // 全部源都「网络失败」→ 本台无判定依据
    // G P3：s.u 与主线程 applyCfg/reapplyCfg 的 addAll 并发遍历可 CME——快照失败按无判据跳过（不落标，安全方向）
    // B1：禁用源不测（体检口径=播放口径）；按人工有效序取前 4（用户优先序先测）。全禁台 us 空 → 无判据 NET
    val us = runCatching { s.effOrder().map { s.u[it] }.take(4) }.getOrNull() ?: return Probe.NET
    for (u in us) {
      val v = runCatching { checker.check(u, C.CHECK_WINDOW_MS) }.getOrNull() ?: return Probe.NET
      // B2：体检通道产 diagnostic 样本（trigger=manual|boot|sync；自动体检绝不产 playback）；写失败只丢样本
      runCatching { quality.recordDiagnostic(s.u0, v.toDiagnostic(u), qTrigger) }
      if (v.ok) return Probe.OK
      if (v.code != CheckStream.Verdict.Code.NETWORK) allNet = false // code 是程序分支唯一依据（B1：不按 why 文案反推）
    }
    return if (allNet) Probe.NET else Probe.DEAD
  }

  private suspend fun probeAll(list: List<Station>, conc: Int, qTrigger: String, stop: () -> Boolean,
                               onProg: (Int, Int) -> Unit): List<Pair<Station, Probe>> {
    val q = ConcurrentLinkedQueue(list)
    val out = ConcurrentLinkedQueue<Pair<Station, Probe>>()
    val done = AtomicInteger(); val total = list.size
    coroutineScope {
      repeat(conc) {
        launch(Dispatchers.IO) {
          while (!stop()) {
            val s = q.poll() ?: return@launch
            out.add(s to probe(s, qTrigger))
            onProg(done.incrementAndGet(), total)
          }
        }
      }
    }
    return out.toList()
  }

  /** 主线程统一套用分档生命周期并计数（0=ok 1=疑似 2=停运 3=网络失败跳过——不落标不计数） */
  private fun applyMarks(res: List<Pair<Station, Probe>>): IntArray {
    val c = IntArray(4)
    val marks = lib.healthMarks
    for ((s, p) in res) when (p) {
      Probe.OK -> {
        // B3-C：dead→alive 转移才记「最近恢复」（marks 原含 key = 复活；无标记台探活成功不算恢复，不猜）
        if (runCatching { marks.containsKey(s.key) }.getOrDefault(false)) runCatching { noteRecoveredIfRevived(s.key) }
        runCatching { Health.onAlive(marks, s.key) }; c[0]++
      }
      Probe.DEAD -> {
        runCatching { Health.onDead(marks, s.key, s.u.take(6), System.currentTimeMillis()) }
        if (marks[s.key]?.perm == 1) c[2]++ else c[1]++
      }
      Probe.NET -> c[3]++
    }
    return c
  }

  private suspend fun persistHealth() {                                  // 落盘走 IO、内存态套用回主线程（调用方上下文不定，此处自归位）
    withContext(Dispatchers.IO) { runCatching { lib.saveHealth() } }
    withContext(Dispatchers.Main) { runCatching { lib.applyHealthToStations() }; stamp.value++ }
  }

  fun manualHealth() {                                                    // 手动全量入口（B5：移动数据先过策略门——允许直跑/需确认弹门/禁止明示）
    if (manualRun.value) return
    when (val n = gate.enter(NetworkPolicy.Op.FULL_CHECK, NetGate.Act.FULL_CHECK, netRules())) {
      is NetGate.Next.Deny -> { healthResult.value = "未开始：${n.why}"; toast(healthResult.value) }
      is NetGate.Next.Confirm -> netGate.value = n.act to n.why
      NetGate.Next.Run -> runManualHealth()
    }
  }

  private fun runManualHealth() {                                         // 手动全量（并发 5=Web runCheck 口径；反馈走设置页文案 + 完成 toast）
    viewModelScope.launch {
      manualRun.value = true
      healthAbort.set(false)
      try {
        if (healthBusy.value) healthProg.value = "等待后台体检收尾…（可点「取消体检」中止）"   // G P3：让位等待最坏 30-40s，零反馈观感像卡死
        while (healthBusy.value && !healthAbort.get()) delay(250)         // 静默版让位收尾（手动优先，B-10 互斥）
        if (healthAbort.get()) { healthResult.value = "体检已取消"; toast(healthResult.value); return@launch }
        healthBusy.value = true
        healthResult.value = ""
        val list = runCatching { lib.visible(true, playKey(), connKey()) }.getOrDefault(emptyList())   // 连默认隐藏的死台一起复查
        healthProg.value = "体检中 0/${list.size}"
        quality.keepHint = runCatching { qualityKeepSnapshot() }.getOrDefault(quality.keepHint)   // trim 保护集随体检通道刷新
        val res = probeAll(list, 5, "manual", { healthAbort.get() }) { d, t -> if (!healthAbort.get()) healthProg.value = "体检中 $d/$t" }
        if (healthAbort.get()) {                                          // B3 取消：已探完的结果照常落标（sync.js 取消也走收尾 saveHealth——「已确认的标记已保留」）
          applyMarks(res); persistHealth()
          healthResult.value = "体检已取消：完成 ${res.size}/${list.size}（已确认的标记已保留）"
          toast(healthResult.value); return@launch
        }
        if (res.size >= 5 && res.all { it.second == Probe.NET }) {         // 网络层整体故障兜底：不落任何标记
          healthResult.value = "体检未完成：全部探测失败（疑似网络不可用），未标记任何电台"
          toast(healthResult.value); return@launch
        }
        val c = applyMarks(res)
        persistHealth()
        healthResult.value = "体检完成：正常 ${c[0]} · 疑似不可达 ${c[1]} · 已停运 ${c[2]}" +
          (if (c[3] > 0) " · 网络失败跳过 ${c[3]}（不落标记）" else "")
        toast(healthResult.value)
      } catch (e: Exception) { healthResult.value = "体检异常：${e.message ?: e.toString()}" }
      finally { manualRun.value = false; healthAbort.set(false); healthBusy.value = false }
    }
  }

  fun cancelHealth() {                                                    // B3：取消手动体检（Web「取消体检」同款；在飞探测收尾后停，已确认标记保留）
    if (!manualRun.value) return
    healthAbort.set(true)
    healthProg.value = "正在取消体检…（等在飞探测收尾）"
  }

  private fun silentCheck() {                                             // boot 静默复测（并发 2；不碰状态栏/toast）
    viewModelScope.launch(Dispatchers.IO) {
      if (manualRun.value || healthBusy.value) return@launch
      val scope = withContext(Dispatchers.Main) {
        // AIbot P2-1 + 审计 P2：快照拷贝归 Main——LinkedHashMap(map)/toList 拷贝本身也迭代源集合，与 IO 变异并发同样 CME
        runCatching {
          Health.bootScope(LinkedHashMap(lib.healthMarks), lib.favs.toList(), lib.recents.toList(), lib.stations.toList(), System.currentTimeMillis())
        }.getOrNull()
      } ?: return@launch
      if (scope.isEmpty()) return@launch
      healthBusy.value = true
      try {
        val res = probeAll(scope, 2, "boot", { manualRun.value }) { _, _ -> }
        if (manualRun.value) return@launch                                // 让位手动：已测结果由手动收尾统一落
        if (res.size >= 5 && res.all { it.second == Probe.NET }) return@launch
        withContext(Dispatchers.Main) { applyMarks(res) }
        persistHealth()
      } catch (_: Exception) { } finally { healthBusy.value = false } // AIbot P1-1：无条件清——条件清会在「静默让位手动」时把三通道锁死到进程重启（手动方已持 manualRun 在等，清标志即接管无竞态）
    }
  }

  private fun incCheck(names: List<String>) {                             // 同步后增量体检（D4）：diff 新增国内台
    viewModelScope.launch(Dispatchers.IO) {
      if (manualRun.value || healthBusy.value) return@launch
      val set = names.toHashSet()
      val list = runCatching { lib.stations.filter { set.contains(it.n) && !it.hidden } }.getOrDefault(emptyList())
      if (list.isEmpty()) return@launch
      healthBusy.value = true
      toast("后台体检新增电台 ${list.size} 台…")
      try {
        val res = probeAll(list, 2, "sync", { manualRun.value }) { _, _ -> }
        if (manualRun.value) return@launch
        if (res.size >= 5 && res.all { it.second == Probe.NET }) return@launch
        val c = withContext(Dispatchers.Main) { applyMarks(res) }
        persistHealth()
        toast("新增 ${list.size} 台体检完成，${c[1] + c[2]} 台无效已隐藏")
      } catch (_: Exception) { } finally { healthBusy.value = false } // AIbot P1-1：同上，无条件清
    }
  }

  /* ---------- D7 轻更新（设置页手动触发；判新旧 = GitHub commits vs 打包基线/assets 副本 stamp） ---------- */

  fun checkUpdate() {      // 入口（AIbot PR#21 P1）：检查+下载+应用整链同过 Op.SYNC 门（§9.2「主库同步」同类别，
                           // 与 fullSyncNow 同构）——蜂窝 deny 拒绝明示、confirm 弹确认后经 proceedGate 续跑整链，
                           // Wi-Fi/allow 直跑；无「仅查版本免门」暗道（版本检查本身也走 GitHub 网络）
    when (val n = gate.enter(NetworkPolicy.Op.SYNC, NetGate.Act.LIGHT_UPDATE, netRules())) {
      is NetGate.Next.Deny -> { updateMsg.value = "未开始：${n.why}"; toast(updateMsg.value) }
      is NetGate.Next.Confirm -> netGate.value = n.act to n.why
      NetGate.Next.Run -> runCheckUpdate()
    }
  }

  private fun runCheckUpdate() {                                          // 门后执行体（直跑或确认后续跑，唯一调 light.check/apply 的路径）
    viewModelScope.launch {
      if (updateBusy.value) return@launch
      if (syncBusy.value) { updateMsg.value = "同步进行中，等同步完成后再检查更新（两通道写同一份 filesDir 数据，并发会互相覆盖）"; return@launch }   // 审计 P2：互锁
      updateBusy.value = true; updateMsg.value = "检查更新中…"
      try {
        val base = light.stamp() ?: assetsStamp
        // AIbot P1-3：check 的真契约 = 返回 null 且从不抛异常（网络失败填 light.lastFailWhy）——
        // 失败必须明示「检查失败」（plan 5.2：网络失败一律明示不静默），null 一律当「已是最新」会误导
        val newer = withContext(Dispatchers.IO) { light.check(base) }
        if (newer == null) {
          if (light.lastFailWhy.isNotEmpty()) { updateMsg.value = "检查失败：${light.lastFailWhy}"; return@launch }
          updateMsg.value = if (base.isEmpty()) "已是最新" else "已是最新（数据基线 ${base.take(10)}）"
          return@launch
        }
        updateMsg.value = "发现新数据（${newer.take(10)}），下载中…"
        val before = lib.favs.mapNotNull { f -> runCatching { lib.resolve(f.k) }.getOrNull()?.let { f to it } }
        val res = withContext(Dispatchers.IO) { runCatching { light.apply(lib.mainText) }.getOrNull() }
        if (res == null) { updateMsg.value = "更新未完成：${light.lastFailWhy.ifEmpty { "发生异常，请检查本地数据" }}"; return@launch }
        val texts = withContext(Dispatchers.IO) { light.radioText() to light.logosText() }
        texts.first?.let { lib.mainText = it }
        texts.second?.let { runCatching { logos.loadBuiltins(it) } }
        val nfMeta = light.metaText()
        radioMeta.value = withContext(Dispatchers.IO) { RadioMeta.parse(nfMeta) ?: RadioMeta.EMPTY }   // B2 meta 随更新收口（缺件空对象；混态已被 apply 删件拦截）
        val hW = light.stampHashOk()   // AIbot 三轮 P1：apply 后即时核对（radio/meta 内容哈希 vs stamp 见证）
        metaBound = RadioMeta.bound(true, nfMeta != null, light.stampMetaOk(), hW.first, hW.second)   // AIbot P1-4：更新后重算绑定（apply 已写 stamp 见证）
        metadataUnbound.value = metadataUnavailable(RadioMeta.parse(nfMeta) != null, metaBound)
        lib.reload(); stamp.value++
        primeAll()
        updateMsg.value = lightUpdateMessage(res, metaBound)
        toast(updateMsg.value)
        pointGone(before)                                                 // 收藏台消失点名（removed ∩ 收藏）
        if (res.addedCheck.isNotEmpty()) { delay(800); incCheck(res.addedCheck.take(C.ADDED_CHECK_CAP)) }   // D4 增量体检（审计 P2）：D7 是主更新通道且安卓无首启基线——缺此调用 D7 新增国内台永远零体检（Web 唯一同步路径必跑 incHealth）
      } catch (e: Exception) { updateMsg.value = "检查更新失败：${e.message ?: "网络错误"}" }
      finally { updateBusy.value = false }
    }
  }

  /* ---------- M4 端内同步（B5：移动数据按策略门默认需确认；完成后 diff 摘要 + 收藏点名 + 增量体检） ---------- */

  fun fullSyncNow(onDenied: (() -> Unit)? = null) {                         // 入口：先过网络策略门，再过电量门（与 checkUpdate 同构）
    when (val n = gate.enter(NetworkPolicy.Op.SYNC, NetGate.Act.SYNC, netRules())) {
      is NetGate.Next.Deny -> {
        syncMsg.value = "未开始：${n.why}"; toast(syncMsg.value)
        onDenied?.invoke()
      }
      is NetGate.Next.Confirm -> netGate.value = n.act to n.why
      NetGate.Next.Run -> runFullSync()
    }
  }

  private fun runFullSync() {
    viewModelScope.launch {
      if (syncBusy.value) return@launch
      if (updateBusy.value) { syncMsg.value = "数据更新进行中，稍后再同步"; return@launch }   // 审计 P2：互锁（与 checkUpdate 对称）
      if (!charging()) {                                                 // E13 电量前置（充电中跳过；<5% 拒 / <20% 警告放行）
        val bp = battPct()
        if (bp < 5) {
          syncMsg.value = "电量 ${bp}%，请先充电再同步（欧美台逐个实测约 1 分钟）"
          toast(syncMsg.value); return@launch
        }
        if (bp < 20) toast("电量 ${bp}% 偏低，同步约 1 分钟，建议插电进行")
      }
      syncBusy.value = true
      syncMsg.value = "同步中：国内上游 + 欧美台逐个实测，约 1 分钟…"
      try {
        val before = lib.favs.mapNotNull { f -> runCatching { lib.resolve(f.k) }.getOrNull()?.let { f to it } }
        val d = withContext(Dispatchers.IO) { engine.run(lib.mainText) }
        if (!d.ok) {
          syncMsg.value = "同步失败：合并结果异常，已保留原列表"; toast(syncMsg.value); return@launch
        }
        val texts = withContext(Dispatchers.IO) { light.radioText() to light.logosText() }
        texts.first?.let { lib.mainText = it }
        texts.second?.let { runCatching { logos.loadBuiltins(it) } }
        val nfMeta = light.metaText()
        radioMeta.value = RadioMeta.parse(nfMeta) ?: RadioMeta.EMPTY
        val h = light.stampHashOk()
        metaBound = RadioMeta.bound(true, nfMeta != null, light.stampMetaOk(), h.first, h.second)
        metadataUnbound.value = metadataUnavailable(RadioMeta.parse(nfMeta) != null, metaBound)
        lib.reload(); stamp.value++
        primeAll()
        syncMsg.value = "同步完成：新增 ${d.added} 台、消失 ${d.removed} 台；" +
          (if (d.cnUpdated) "国内已更新" else "国内未更新，保留旧数据") + "；" +
          (if (d.euKept != null) "欧美已更新" else "欧美未更新，保留旧数据")
        toast(syncMsg.value)
        pointGone(before)
        if (d.addedCheck.isNotEmpty()) { delay(800); incCheck(d.addedCheck.take(C.ADDED_CHECK_CAP)) }   // D4
      } catch (e: Exception) {
        syncMsg.value = syncFailureMessage(e.message ?: "网络错误", java.io.File(ctx.filesDir, "full-sync.pending").exists())
        toast(syncMsg.value)
      }
      finally { refreshLogoRetry(); syncBusy.value = false }
    }
  }

  /** 收藏台消失点名：更新前能解析、更新后失联的收藏台（不依赖 diff 明细字段） */
  private fun pointGone(before: List<Pair<io.github.vjoy233.vradio.model.FavEntry, Station>>) {
    val gone = before.filter { runCatching { lib.resolve(it.first.k) }.getOrNull() == null }.map { it.second.n }
    if (gone.isEmpty()) return
    toast("⚠ 收藏台已不在新列表：" + gone.take(5).joinToString("、") + if (gone.size > 5) " 等 ${gone.size} 个" else "")
  }

  /* ---------- 添加自定义电台（A-2）：探活先行（12s 窗，蜻蜓系慢源救援口径），失败明示不静默 ---------- */

  fun addStation(name: String, catIn: String, customCat: String, url: String, onOk: () -> Unit) {
    val n = name.trim().replace(Regex("[,\\r\\n|]"), " ").take(40)        // csv 分隔符清洗（server.js 同款）
    val u = url.trim().replace(Regex("\\s+"), "")                          // URL 内不该有空白（坑③）
    val c = customCat.trim().take(24).ifEmpty { catIn }
    if (n.isEmpty()) { addMsg.value = "请填写电台名"; return }
    if (!SafeTarget.ok(u)) { addMsg.value = "流地址需为公网 http(s) 地址（内网/回环/变形 IP 不收）"; return }   // AIbot P2-5：与 server.js safeTarget 同口径（MyRadio.append 兜底同判）
    if (c.isEmpty()) { addMsg.value = "请选择或填写分类"; return }
    // 查重先行（G P3：重复比超限常见，也不该白等 12s 探活；文案对齐 server.js myStationWrite 三分口径）
    val myLines = runCatching { lib.myText.split(Regex("\\r?\\n")).dropLastWhile { it.isEmpty() } }.getOrDefault(emptyList())
    if (myLines.any { it.trim() == "$n,$u" }) { addMsg.value = "该电台已在个人列表中"; return }
    val dup = myLines.firstOrNull { it.trim().endsWith(",$u") }            // 同 URL 换名也不双开（装配按键合并会出两行）
    if (dup != null) { addMsg.value = "该流地址已存在（「${dup.trim().substringBefore(',')}」），同一地址请直接使用现有电台"; return }
    viewModelScope.launch {
      addBusy.value = true; addMsg.value = "探活中…（最长 12 秒，蜻蜓系建流慢属正常）"
      // B5 网络策略：单台探活移动数据允许但一次性提示；离线直接明示（不发注定失败的请求）
      val pd = policy.allow(NetworkPolicy.Op.SINGLE_CHECK, netRules())
      if (!pd.ok) { addMsg.value = "未探活：${pd.why}"; addBusy.value = false; return@launch }
      if (policy.state() == NetworkPolicy.State.CELLULAR) toast(pd.why)
      try {
        val v = withContext(Dispatchers.IO) { runCatching { checker.check(u, C.MYSTATION_TIMEOUT_MS) }.getOrNull() }
        if (v == null || !v.ok) {
          addMsg.value = "探活未通过：${v?.why?.takeIf { it.isNotEmpty() } ?: "源不可用（假流/死链）"}——未写入"
          return@launch
        }
        val ok = withContext(Dispatchers.IO) { runCatching { myRadio.append(n, c, u) }.getOrDefault(false) }
        if (!ok) { addMsg.value = "my-radio.txt 已达上限（500 行），请清理后再添加"; return@launch }
        withContext(Dispatchers.IO) { lib.myText = myRadio.readText() }
        lib.reload(); stamp.value++
        toast("已添加「$n」到「$c」（持久于 my-radio.txt，同步不覆盖）")
        onOk()
      } catch (e: Exception) { addMsg.value = "添加失败：${e.message ?: e.toString()}" }
      finally { addBusy.value = false }
    }
  }

  /* ---------- 导入导出（SAF；backup v2 / m3u 收藏 / songs txt / config json 四件导出 + 三件导入） ---------- */

  fun exportTo(uri: Uri, kind: Exp) {
    viewModelScope.launch(Dispatchers.IO) {
      try {
        val content = when (kind) {
          // 「包含本机 sidecar」勾选（AIbot 三轮 P1-3）：捕获数据经 qualityTrim/lsTrim 白名单裁剪（与 Web exportAll 同构）。
          // 收听统计取内存账（settle 收账后 ⊇ 磁盘快照——未确认增量也随备份走），经 ListenStatsCodec 白名单解码
          Exp.BACKUP -> {
            val qExt = if (backupWithSidecar.value) runCatching {
              val cap = JSONObject(quality.capture())
              val trimmed = Backup.qualityTrim(cap.optJSONObject("stations") ?: JSONObject())
              if (trimmed.length() > 0) JSONObject().put("v", 1).put("data", trimmed) else null
            }.getOrNull() else null
            val lExt = if (backupWithSidecar.value) runCatching {
              listenTracker?.settle()
              val st = listenTracker?.state ?: listenSidecar.load()
              val days = JSONObject(ListenStatsCodec.toJson(ListenStats.trim(st))).optJSONObject("days") ?: JSONObject()
              val trimmed = Backup.lsTrim(days)
              if (trimmed.length() > 0) JSONObject().put("v", 1).put("data", trimmed) else null
            }.getOrNull() else null
            Backup.exportAll(lib, myRadio.readText(), System.currentTimeMillis(), qExt, lExt)
          }
          Exp.M3U -> Backup.m3uFavs(lib)                                  // 空串 = 无可解析收藏台（收藏全休眠同判）
          Exp.SONGS -> Backup.songsTxt(lib) { System.currentTimeMillis() }
          Exp.CFG -> Backup.cfgJson(lib.cfg)
        }
        // G P3：空数据提示不落盘（Web 口径——exportSongs/exportFavs 状态栏提示不触发下载），文案逐字对齐
        val emptyHint = when (kind) {
          Exp.M3U -> "还没有收藏，先点 ☆ 收藏再导出"
          Exp.SONGS -> "暂无歌曲历史（换歌后自动记录）"
          else -> null
        }
        if (emptyHint != null && content.isEmpty()) { toast(emptyHint); return@launch }
        val w = ctx.contentResolver.openOutputStream(uri, "wt")
        if (w == null) { toast("导出失败：无法写入文件"); return@launch }
        w.use { it.write(content.toByteArray(Charsets.UTF_8)) }
        toast("已导出 ${expName(kind)}")
      } catch (e: Exception) { toast("导出失败：${e.message ?: e.toString()}") }
    }
  }

  private fun expName(kind: Exp) = when (kind) {
    Exp.BACKUP -> "vradio-backup.json"; Exp.M3U -> "vradio-favorites.m3u"
    Exp.SONGS -> "vradio-songs.txt"; Exp.CFG -> "vradio-config.json"
  }

  fun importFrom(uri: Uri, kind: Imp) {
    viewModelScope.launch(Dispatchers.IO) {
      val text = readUri(uri) ?: run { toast("读取文件失败"); return@launch }
      when (kind) {
        Imp.BACKUP -> {
          val p = runCatching { Backup.parseImport(text) }.getOrNull()
          if (p == null) { toast("导入失败：不是 vradio 完整备份文件"); return@launch }
          val n = C.KEYS.count { p.data[it] != null }
          if (n == 0) { toast("导入失败：备份中无有效数据"); return@launch }
          pendingImp = Imp.BACKUP to p
          // sidecar 选择语义与 Web 对齐（AIbot 三轮 P1-3，B4 起双 sidecar 一个复选整体覆盖）：备份含质量/收听
          // 统计数据时确认框出复选（默认不勾=保留本机），勾选才经事务恢复（下方 applyConfirmed 按 impSidecar 传参）
          val qn = p.quality?.optJSONObject("data")?.length() ?: 0
          val ln = p.listenStats?.optJSONObject("data")?.length() ?: 0
          impHasQuality.value = qn > 0 || ln > 0
          impSidecar.value = false
          val scNote = listOfNotNull(
            if (qn > 0) "$qn 台质量数据" else null,
            if (ln > 0) "$ln 天收听统计" else null,
          ).takeIf { it.isNotEmpty() }?.joinToString("、")
          confirmReq.value = "导入将覆盖本地全部数据（备份含 $n 个数据项：收藏/维护配置/健康标记/歌曲历史全部替换" +
            (if (scNote != null) "；备份含 $scNote，勾选下方复选框才会覆盖本机对应数据" else "") + "）。继续？"
        }
        Imp.M3U -> {                                                      // B4 歌单导入：m3u/pls/xspf/asx/纯 URL 统一解析（PlaylistParser，
                                                                          // 纯本地不联网探活）→ 四桶预览（新增/已知/重复/非法）→ 确认后已知台恢复收藏（N2 语义）+ 新台入 my-radio
          val r = runCatching { PlaylistParser.parse(text) }.getOrNull()
          if (r == null || (r.entries.isEmpty() && r.invalid == 0 && r.dups == 0)) {
            toast("导入失败：未解析到任何电台（识别为 ${r?.format ?: "未知"} 格式）"); return@launch
          }
          // 分流纯决策不变异（AIbot P1-1：收藏变异必须后置到确认——B4 取消=零副作用；原顺序逐台全量收藏会把
          // 库外 URL 写进 favs，known 随之遮蔽一切、extra 恒空）；库内命中→favHits，库外台→extra 待确认入 my-radio
          val sts = r.entries.map { Station(it.category, it.name, mutableListOf(it.url)) }
          val (hits, extra) = withContext(Dispatchers.Main) {
            runCatching { lib.partitionImport(sts) }
              .getOrDefault(emptyList<Station>() to emptyList())
          }
          val known = r.entries.size - extra.size
          pendingImp = Imp.M3U to PlaylistImp(hits, extra, r.dups, r.invalid, r.format)
          confirmReq.value = "识别为 ${r.format} 格式，共 ${r.entries.size} 条：新增 ${extra.size}、已知 $known（将恢复收藏）、" +
            "文件内重复 ${r.dups}、地址不合法 ${r.invalid}。\n" +
            (if (extra.isEmpty()) "没有新电台需要写入。是否恢复已知电台的收藏？"
             else "新增电台将写入个人列表 my-radio.txt（自带查重/清洗/封顶），导入后建议跑一次「体检」。继续？")
        }
        Imp.CFG -> {
          val j = runCatching { JSONObject(text) }.getOrNull()
          if (j == null) { toast("导入失败：不是合法 JSON 文件"); return@launch }
          val c = runCatching { CfgCodec.parse(j.optJSONObject("cfg")?.toString()) }.getOrDefault(Cfg())
          val n = runCatching { CfgCodec.count(c) }.getOrDefault(0)
          pendingImp = Imp.CFG to c
          confirmReq.value = "导入将覆盖本地全部维护配置（新配置共 $n 项，含 ${c.cats.size} 个自建分类）。继续？"
        }
      }
    }
  }

  private fun readUri(uri: Uri): String? = runCatching {
    ctx.contentResolver.openInputStream(uri)?.use { ins ->
      val cap = C.BACKUP_MAX_BYTES.toInt()                                // 2MB 封顶（server.js 同款口径）
      val bos = java.io.ByteArrayOutputStream()
      val buf = ByteArray(8192); var total = 0
      while (total < cap) {
        val n = ins.read(buf); if (n < 0) break
        val take = minOf(n, cap - total); bos.write(buf, 0, take); total += take
      }
      String(bos.toByteArray(), Charsets.UTF_8)
    }
  }.getOrNull()

  fun cancelConfirm() { confirmReq.value = null; pendingImp = null; impHasQuality.value = false; impSidecar.value = false }

  fun applyConfirmed() {
    val p = pendingImp ?: return
    val sidecarChoice = impSidecar.value // 同步捕获（下方立即复位，协程内只用局部值）
    confirmReq.value = null; pendingImp = null
    impHasQuality.value = false; impSidecar.value = false
    viewModelScope.launch {
      try {
        when (p.first) {
          Imp.BACKUP -> {
            val pay = p.second as Backup.ImportPayload
            // 三阶段纪律（B4，§13.2）：提交前快照四件（Store + my-radio + 旧质量 + 旧收听统计 sidecar），任一步
            // 失败整体回滚——AIbot P1-1：v3 sidecar 经 QualityStore/ListenSidecar 事务式覆盖真正落盘
            // AIbot 三轮 P1-3：sidecar 恢复是明确可选项——仅当用户在确认框勾选（impSidecar）才传 sidecar 数据，
            // 未勾选 = 保留本机 sidecar（快照也不必留）；applyStore/rollbackStore 升级为可感知落盘失败（三轮 P1-2）
            val restoreQ = pay.quality != null && sidecarChoice
            val restoreL = pay.listenStats != null && sidecarChoice
            val snap = Store.snapshot()
            val myOld = myRadio.readText()
            val qSnap = if (restoreQ) quality.capture() else null
            val qData = if (restoreQ) pay.quality!!.optJSONObject("data") else null
            val lsSnap = if (restoreL) listenSidecar.load() else null   // 旧收听统计快照（磁盘态；回滚经同通道回写）
            val lsData = if (restoreL) pay.listenStats!!.optJSONObject("data") else null
            val err = withContext(Dispatchers.IO) {
              fun lsApply(): Boolean {                                   // days → 白名单解码 + trim → 快照覆盖落盘（save 回执可判定）
                val st = ListenStatsCodec.parse(JSONObject().put("v", 1).put("days", lsData).toString())
                return listenSidecar.save(ListenStats.trim(st))
              }
              val e = Backup.commitImport(pay.data, pay.my, qData, Backup.ImportIO(
                { Store.applyAllChecked(pay.data) },                     // 白名单键写入/缺键 remove；落盘失败可感知（三轮 P1-2）
                { Store.applyAllChecked(snap) },
                { pay.my == null || runCatching { myRadio.replace(pay.my!!.joinToString("\n")) }.getOrDefault(false) },   // v1 无 my 不动；v2 读 my；v3 读 myRadio
                { runCatching { myRadio.replace(myOld) } },
                { qData == null || quality.replaceImport(qData) },        // sidecar 最后提交（覆盖语义，§13.2-6）
                { qSnap == null || quality.restore(qSnap) },             // 失败恢复旧 quality 快照（replaceImport 内部已自恢复，此处兜底盘面）
                { lsData == null || lsApply() },                         // 收听统计四件事务收官（B4）
                { lsSnap == null || listenSidecar.save(lsSnap) },        // 失败恢复旧统计快照（save 回执失败仅内存不留）
              ), lsData)
              lib.myText = myRadio.readText()
              e
            }
            if (err != null) { toast("导入失败：$err，已回滚到导入前状态"); return@launch }
            // AIbot P1-2：Store 已被整体替换，三层内存态必须显式刷新——缺一层 = 重启才生效，
            // 且播放层旧 volperst/srcmem 内存会在下次调音量/换源时整体回写冲掉刚导入的值（数据损坏向）
            freshnessPref.value = Freshness.parse(Store.get(C.K_SYNC_FRESHNESS))
            freshnessPrompt.value = false
            lib.reloadStore()                                             // 收藏/最近/健康标记/cfg 内存重载
            lib.reload()                                                  // 主列表/my 层重装配 + 回绑
            quality.keepHint = runCatching { qualityKeepSnapshot() }.getOrDefault(quality.keepHint)   // B2：收藏整体替换后保护集重算
            PlayerHolder.reloadMems()                                     // volperst/srcmem2/vol 重载（public 化入口）
            if (restoreL && FeatureFlags.LISTEN_STATS) runCatching {     // 统计内存账对齐导入态：从磁盘重建 tracker（否则旧账
              listenTracker = ListenTracker.restore(SystemClock::elapsedRealtime, System::currentTimeMillis, listenSidecar)
            }                                                             // 下次 flush 会整体回写冲掉导入数据；开关关=不建不消费）
            refreshUi3()
            stamp.value++; primeAll()
            updateShortcuts()                                             // E3：收藏已整体替换，快捷方式重建
            toast("已恢复完整备份（v${pay.ver}）"
              + (if (restoreQ) "，含质量 sidecar（已覆盖本机质量数据）" else if (pay.quality != null) "，本机质量数据保持不变" else "")
              + (if (restoreL) "，含收听统计（已覆盖本机收听统计）" else if (pay.listenStats != null) "，本机收听统计保持不变" else ""))
          }
          Imp.M3U -> {                                                    // B4 四桶确认后执行：已知台恢复收藏（N2 语义）+ 新台批量入 my-radio
            val p2 = p.second as PlaylistImp                              // （append 自带查重/清洗/SafeTarget/封顶）
            var n = 0
            withContext(Dispatchers.Main) {
              for (hit in p2.hits) if (!runCatching { lib.isFav(hit) }.getOrDefault(false)) {
                runCatching { lib.favs.add(FavEntry(hit.key, hit.u.take(6))) }; n++
              }
              runCatching { lib.rebind() }                                // 回绑 + 收藏增量一次写齐（AIbot P2-5/P3：改名台休眠条目不等下次 reload 自愈）
              stamp.value++
            }
            updateShortcuts()                                             // E3：收藏可能新增，快捷方式刷新
            var ok = 0; var skip = 0
            withContext(Dispatchers.IO) {
              for (s in p2.extra) {
                if (runCatching { myRadio.append(s.n, s.c, s.u0) }.getOrDefault(false)) ok++ else skip++
              }
              if (ok > 0) lib.myText = myRadio.readText()
            }
            if (ok > 0) { lib.reload(); stamp.value++; primeAll() }
            toast((if (n > 0) "已恢复收藏 $n 个。" else "") + "已写入自定义电台 $ok 个" +
              (if (skip > 0) "，跳过 $skip 个（重复/封顶/地址不合规）" else "") + "——可到设置跑一次体检验证")
          }
          Imp.CFG -> {
            val c = p.second as Cfg
            withContext(Dispatchers.IO) { Store.set(C.K_CFG, CfgCodec.toJson(c)) }
            lib.cfg = c
            runCatching { lib.reapplyCfg() }
            stamp.value++
            toast("已导入维护配置")
          }
        }
      } catch (e: Exception) { toast("导入失败：${e.message ?: e.toString()}") }
    }
  }

  companion object {
    const val EXTRA_SC = "vradio.shortcut"   // E3 快捷方式 extra 键（MainActivity 路由进 handleIntent）
  }
}

/** 详情诊断分批（B1 review P1-7，Web checkStationSources ≤4/批口径）：n 条启用源切成 ≤4 条的下标区间，
    批间串行推进——单次探活放大面恒 ≤4。Top-level 纯函数 JVM 直测。 */
fun diagBatches(n: Int): List<IntRange> {
  if (n <= 0) return emptyList()
  return (0 until n).chunked(4).map { it.first()..it.last() }
}

