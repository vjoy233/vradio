package io.github.vjoy233.vradio.ui

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.net.ConnectivityManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.vjoy233.vradio.MainActivity
import io.github.vjoy233.vradio.Prefs
import io.github.vjoy233.vradio.check.CheckStream
import io.github.vjoy233.vradio.check.Health
import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.Backup
import io.github.vjoy233.vradio.data.CfgCodec
import io.github.vjoy233.vradio.data.HttpText
import io.github.vjoy233.vradio.data.Library
import io.github.vjoy233.vradio.data.Logos
import io.github.vjoy233.vradio.data.MyRadio
import io.github.vjoy233.vradio.data.RadioTxt
import io.github.vjoy233.vradio.data.SafeTarget
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.check.OkHttpRaw
import io.github.vjoy233.vradio.data.OkHttpText
import io.github.vjoy233.vradio.model.Cfg
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.model.SongRec
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.sync.Gh
import io.github.vjoy233.vradio.sync.LightUpdate
import io.github.vjoy233.vradio.sync.SyncEngine
import kotlinx.coroutines.Dispatchers
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

enum class Nav { LIST, SETTINGS, ADD }   // 手写导航态（无导航库，契约）

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

  /* ---------- 列表态（radio.view/showdead/theme 三键持久化，app.js loadUi3 同款） ---------- */
  val cat = MutableStateFlow("全部")
  val keyword = MutableStateFlow("")
  val view = MutableStateFlow("grid")
  val showDead = MutableStateFlow(false)
  val theme = MutableStateFlow("auto")
  private val stamp = MutableStateFlow(0)                    // 渲染哨兵（app.js state.stamp）
  val nav = MutableStateFlow(Nav.LIST)
  val showSrc = MutableStateFlow(false)
  val srcKey = MutableStateFlow<String?>(null)                // 选源浮层打开时的台 key（换台即收起，srcPopK 同款）
  val showSongs = MutableStateFlow(false)
  val locate = MutableStateFlow<String?>(null)               // 回到正在播（web locatePlaying）
  val status = MutableStateFlow("")                          // 用户主动操作反馈（#status 同款）

  /* ---------- 进行态/结果文案 ---------- */
  val healthBusy = MutableStateFlow(false); val healthProg = MutableStateFlow(""); val healthResult = MutableStateFlow("")
  val updateBusy = MutableStateFlow(false); val updateMsg = MutableStateFlow("")
  val syncBusy = MutableStateFlow(false); val syncMsg = MutableStateFlow("")
  val addBusy = MutableStateFlow(false); val addMsg = MutableStateFlow("")
  val confirmReq = MutableStateFlow<String?>(null)           // 导入覆盖确认门槛
  val manualRun = MutableStateFlow(false)                     // 手动体检在跑（静默版让位标志；StateFlow 供设置页「取消体检」按钮态，B3）
  private val healthAbort = AtomicBoolean(false)              // 手动体检取消（Web sync.js this.abort 同款：已确认的标记保留）
  private var pendingImp: Pair<Imp, Any?>? = null
  private var assetsStamp = ""

  /* —— batch1（2026-10-18 拍板）新增态：N4/E5 本地开关（Prefs，非 radio.* 契约）+ E3/E4 入口 —— */
  val resumeOnStart = MutableStateFlow(false)          // N4 启动自动续播（默认关）
  val audioOffload = MutableStateFlow(false)           // E5 音频卸载（默认关，实验性，重启生效）
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

  private val toastCh = Channel<String>(Channel.BUFFERED)
  val toasts: Flow<String> = toastCh.receiveAsFlow()
  fun toast(msg: String) { toastCh.trySend(msg) }

  private val cur get() = PlayerHolder.ui.value
  private val playKeys = PlayerHolder.ui.map { it.st to it.station?.key }.distinctUntilChanged()

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

  /* 添加电台页的分类候选（审计 P3：catOptions() 直读无订阅，boot 未完成进页则 chips 永远空——从 listUi 派生响应式） */
  val addCats: StateFlow<List<String>> = listUi
    .map { lu -> lu.chips.drop(3).map { c -> c.first } }                 // 掐头去「全部/★收藏/最近」
    .distinctUntilChanged()
    .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

  init {
    wirePlayer()
    resumeOnStart.value = Prefs.get(ctx, Prefs.RESUME, false)   // N4
    audioOffload.value = Prefs.get(ctx, Prefs.OFFLOAD, false)   // E5
    viewModelScope.launch(Dispatchers.IO) { boot() }
  }

  /* ---------- boot 编排（app.js boot + sync.js bootQuiet 平移；安卓不跑首启基线，plan M3 拍板）：
     assets 读 radio.txt/logos.txt/data-stamp.txt → D7 filesDir 副本优先（LightUpdate.radioText 非空用之）→
     my-radio 装载 → Library.reload 装配 → Logos 装载 → UI 三键恢复 → 台标预取（收藏+正在播）→
     4s 后静默体检（收藏+最近 ∪ 死标记台范围，Health.bootScope 节流；仅 WiFi，D10） ---------- */
  private suspend fun boot() {
    assetsStamp = readAsset("data-stamp.txt")?.trim() ?: ""
    val aRadio = readAsset("radio.txt") ?: ""
    val aLogos = readAsset("logos.txt") ?: ""
    val mainTxt = light.radioText() ?: aRadio                 // 文件读取留 IO
    val myTxt = myRadio.readText()
    val logosTxt = light.logosText() ?: aLogos
    withContext(Dispatchers.Main) {                           // Library 装配收敛主线程（审计 P2：非线程安全集合与渲染读侧单线程化）
      lib.mainText = mainTxt
      lib.myText = myTxt
      runCatching { lib.reload() }
      runCatching { logos.loadBuiltins(logosTxt) }
    }
    refreshUi3()                                                          // view/showdead/theme 三键恢复（app.js loadUi3 同款）
    stamp.value++
    primeAll()
    withContext(Dispatchers.Main) {
      booted = true
      consumePending()   // batch1 启动末梢：E3 快捷方式点播 > E4 接流预填 > N4 自动续播（默认关）
      updateShortcuts()  // E3 动态快捷方式初装（收藏变更/导入时增量刷新）
    }
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
      if (u.startsWith("http://") || u.startsWith("https://")) {
        addPreset.value = u
        if (booted) { nav.value = Nav.ADD; toast("已填入流地址，探活通过后点「添加」") }
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
        else { resumeLastIfWanted(); status.value = "快捷方式指向的电台已不在列表中" }
      }
      addPreset.value != null -> nav.value = Nav.ADD
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

  /* PlayerHolder 回调接线（player 不反向伸手进 UI，方向照抄 Web） */
  private fun wirePlayer() {
    PlayerHolder.onStepFav = { d -> stepFav(d) }                          // ⏮⏭ / ←→ 收藏间切台
    PlayerHolder.onPlayLast = { resumeLast() }                            // 媒体键 play 空台 → 续播上次
    PlayerHolder.onSong = { u0, t ->                                     // ICY 换歌（PlayerHolder 已做换歌判定）：入史
      viewModelScope.launch(Dispatchers.IO) { runCatching { lib.pushSong(u0, t) }; stamp.value++ }
    }
    PlayerHolder.logoProvider = { s -> logos.get(s) }                     // 锁屏 artwork 同步窥探口径
  }

  /* 台标预取（收藏 + 正在播优先，请求量可控）；完成后重渲一次取新解析到的 URL */
  private fun primeAll() = viewModelScope.launch(Dispatchers.IO) {
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
    chips.add("★收藏" to vis.count { runCatching { lib.isFav(it) }.getOrDefault(false) })
    chips.add("最近" to recentList(vis).size)
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
    viewModelScope.launch(Dispatchers.IO) { runCatching { logos.prime(s, true) } }   // 正在播台标优先补全
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
      stamp.value++
      updateShortcuts()                                                  // E3：快捷方式随收藏增减刷新
      if (fav) viewModelScope.launch(Dispatchers.IO) { runCatching { logos.prime(s, true) } }   // 新收藏优先补台标
    }
  }

  fun stepFav(d: Int) {                                                   // ←/→ 收藏间切台（A-5）
    val favsIn = filteredList(showDead.value).filter { runCatching { lib.isFav(it) }.getOrDefault(false) }
    if (favsIn.isEmpty()) { status.value = "还没有收藏电台——点电台旁 ☆ 收藏后可用收藏间切换"; return }
    val curIdx = cur.station?.let { c -> favsIn.indexOfFirst { it.key == c.key } } ?: -1
    val nx = if (curIdx < 0) (if (d > 0) 0 else favsIn.size - 1) else (curIdx + d + favsIn.size) % favsIn.size
    togglePlay(favsIn[nx].key)
  }

  fun resumeLast() {                                                      // ▶ 空台 = 续播上次收听
    val r = lib.recents.firstOrNull()
    val s = r?.let { runCatching { lib.resolve(it.k) }.getOrNull() }
    if (s == null) { status.value = if (r == null) "还没有播放记录" else "上次收听的电台已不在列表中，请直接点播"; return }
    startPlay(s)
  }

  fun locatePlaying() {                                                   // 回到正在播（N5）：当前筛选下不可见才回全部+清搜索（app.js:519 同判，保留浏览上下文）
    val s = cur.station ?: return
    val invisible = runCatching { filteredList(showDead.value).none { it.key == s.key } }.getOrDefault(true)
    if (invisible) { cat.value = "全部"; keyword.value = "" }
    nav.value = Nav.LIST
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
    status.value = if (had) "已恢复默认源，从默认源重播" else "本无源记忆，按默认序重播"
  }

  /* ---------- 音量（每台音量记忆在 PlayerHolder；取消静音的恢复值走 restoreVolPct——AIbot P1-5） ---------- */

  private fun refreshUi3() {                                              // view/showdead/theme 三键恢复（boot 与备份导入共用，app.js loadUi3 同款）
    view.value = if (Store.get(C.K_VIEW) == "list") "list" else "grid"    // 网格默认
    showDead.value = Store.get(C.K_SHOWDEAD) == "1"                       // 死台默认隐藏
    theme.value = listOf("auto", "light", "dark", "oled").firstOrNull { it == Store.get(C.K_THEME) } ?: "auto"   // N18 +oled（软扩展：Web 侧未知值回退 auto 不炸，app.js:236 已核）
  }

  fun setVol(pct: Int) { PlayerHolder.setVolPct(pct) }

  fun toggleMute() {
    if (cur.volPct > 0) { PlayerHolder.setVolPct(0); status.value = "已静音" }
    else {
      // restoreVolPct = 当前台记忆 → 全局 → 默认（player.js restoreVol 同语义）；会话内近似值会把台记忆覆盖坏
      val rv = PlayerHolder.restoreVolPct()
      PlayerHolder.setVolPct(rv); status.value = "音量 $rv%"
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

  private suspend fun probe(s: Station): Probe {
    var allNet = true                       // 全部源都「网络失败」→ 本台无判定依据
    // G P3：s.u 与主线程 applyCfg/reapplyCfg 的 addAll 并发遍历可 CME——快照失败按无判据跳过（不落标，安全方向）
    val us = runCatching { s.u.take(4) }.getOrNull() ?: return Probe.NET
    for (u in us) {
      val v = runCatching { checker.check(u, C.CHECK_WINDOW_MS) }.getOrNull() ?: return Probe.NET
      if (v.ok) return Probe.OK
      if (v.why != "网络失败") allNet = false // 有任一源给出真应答（HTTP/超阈拒），死结论才有据
    }
    return if (allNet) Probe.NET else Probe.DEAD
  }

  private suspend fun probeAll(list: List<Station>, conc: Int, stop: () -> Boolean, onProg: (Int, Int) -> Unit): List<Pair<Station, Probe>> {
    val q = ConcurrentLinkedQueue(list)
    val out = ConcurrentLinkedQueue<Pair<Station, Probe>>()
    val done = AtomicInteger(); val total = list.size
    coroutineScope {
      repeat(conc) {
        launch(Dispatchers.IO) {
          while (!stop()) {
            val s = q.poll() ?: return@launch
            out.add(s to probe(s))
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
      Probe.OK -> { runCatching { Health.onAlive(marks, s.key) }; c[0]++ }
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

  fun manualHealth() {                                                    // 手动全量（并发 5=Web runCheck 口径；反馈走设置页文案 + 完成 toast）
    if (manualRun.value) return
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
        val res = probeAll(list, 5, { healthAbort.get() }) { d, t -> if (!healthAbort.get()) healthProg.value = "体检中 $d/$t" }
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
        val res = probeAll(scope, 2, { manualRun.value }) { _, _ -> }
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
        val res = probeAll(list, 2, { manualRun.value }) { _, _ -> }
        if (manualRun.value) return@launch
        if (res.size >= 5 && res.all { it.second == Probe.NET }) return@launch
        val c = withContext(Dispatchers.Main) { applyMarks(res) }
        persistHealth()
        toast("新增 ${list.size} 台体检完成，${c[1] + c[2]} 台无效已隐藏")
      } catch (_: Exception) { } finally { healthBusy.value = false } // AIbot P1-1：同上，无条件清
    }
  }

  /* ---------- D7 轻更新（设置页手动触发；判新旧 = GitHub commits vs 打包基线/assets 副本 stamp） ---------- */

  fun checkUpdate() {
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
        if (res == null) { updateMsg.value = "更新失败：下载未完成（已保留原数据）"; return@launch }
        val texts = withContext(Dispatchers.IO) { light.radioText() to light.logosText() }
        texts.first?.let { lib.mainText = it }
        texts.second?.let { runCatching { logos.loadBuiltins(it) } }
        lib.reload(); stamp.value++
        primeAll()
        updateMsg.value = "已更新到 ${res.commitIso.take(10)} · 台数 +${res.added}/-${res.removed}"
        toast(updateMsg.value)
        pointGone(before)                                                 // 收藏台消失点名（removed ∩ 收藏）
        if (res.addedCheck.isNotEmpty()) { delay(800); incCheck(res.addedCheck.take(C.ADDED_CHECK_CAP)) }   // D4 增量体检（审计 P2）：D7 是主更新通道且安卓无首启基线——缺此调用 D7 新增国内台永远零体检（Web 唯一同步路径必跑 incHealth）
      } catch (e: Exception) { updateMsg.value = "检查更新失败：${e.message ?: "网络错误"}" }
      finally { updateBusy.value = false }
    }
  }

  /* ---------- M4 端内同步（WiFi-only：移动数据给提示不跑；完成后 diff 摘要 + 收藏点名 + 增量体检） ---------- */

  fun fullSyncNow() {
    viewModelScope.launch {
      if (syncBusy.value) return@launch
      if (updateBusy.value) { syncMsg.value = "数据更新进行中，稍后再同步"; return@launch }   // 审计 P2：互锁（与 checkUpdate 对称）
      if (!unmetered()) {
        syncMsg.value = "移动数据下不同步（欧美台逐个实测流量大）——连 WiFi 后再试"
        toast(syncMsg.value); return@launch
      }
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
        lib.reload(); stamp.value++
        primeAll()
        syncMsg.value = "同步完成：新增 ${d.added} 台、消失 ${d.removed} 台"
        toast(syncMsg.value)
        pointGone(before)
        if (d.addedCheck.isNotEmpty()) { delay(800); incCheck(d.addedCheck.take(C.ADDED_CHECK_CAP)) }   // D4
      } catch (e: Exception) { syncMsg.value = "同步失败：${e.message ?: "网络错误"}"; toast(syncMsg.value) }
      finally { syncBusy.value = false }
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
          Exp.BACKUP -> Backup.exportAll(lib, myRadio.readText(), System.currentTimeMillis())
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
          confirmReq.value = "导入将覆盖本地全部数据（备份含 $n 个数据项：收藏/维护配置/健康标记/歌曲历史全部替换）。继续？"
        }
        Imp.M3U -> {                                                      // N2 泛导入：任意 m3u——库内/已知 URL 恢复收藏态；库外台收集→确认后入 my-radio
          val list = runCatching { RadioTxt.parse(text) }.getOrDefault(emptyList())
          if (list.isEmpty()) { toast("导入失败：未解析到任何电台"); return@launch }
          var added = 0
          withContext(Dispatchers.Main) {                                 // Library 变异归 Main（审计 P2：toggleFav/rebind 与渲染迭代并发 CME）
            for (s in list) {
              val has = runCatching { lib.isFav(s) }.getOrDefault(false)
              if (!has) { runCatching { lib.toggleFav(s) }; added++ }
            }
            runCatching { lib.rebind() }                                  // AIbot P3：导入后立即回绑（改名台休眠条目不等下次 reload 自愈）
            stamp.value++
          }
          // 库外台收集：URL 不在主列表、不在 my 层、也不在收藏快照（第三种已恢复为休眠收藏，勿重复入库）
          val known = HashSet<String>()
          runCatching { for (st in lib.stations) known.addAll(st.u) }
          runCatching { for (f in lib.favs) known.addAll(f.u) }
          val myRows = runCatching { lib.myText.split(Regex("\\r?\\n")) }.getOrDefault(emptyList())
          val extra = ArrayList<Station>()
          val seen = HashSet<String>()
          withContext(Dispatchers.Main) {
            for (s in list) for (u in s.u) {
              if (u in known || u in seen || myRows.any { it.trim().endsWith(",$u") }) continue
              seen.add(u)
              val c = s.c.takeIf { it.isNotEmpty() && it != "未分类" } ?: "自定义"   // m3u 无 group-title 的兜底分类
              extra.add(Station(c, s.n, mutableListOf(u)))
            }
          }
          updateShortcuts()
          if (extra.isEmpty()) { toast("已恢复收藏：${list.size} 个电台（其中新增收藏 $added）"); return@launch }
          pendingImp = Imp.M3U to extra
          confirmReq.value = "已恢复收藏 ${list.size} 个（新增 $added）。另有 ${extra.size} 个库外电台，是否写入自定义电台（my-radio.txt）？"
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

  fun cancelConfirm() { confirmReq.value = null; pendingImp = null }

  fun applyConfirmed() {
    val p = pendingImp ?: return
    confirmReq.value = null; pendingImp = null
    viewModelScope.launch {
      try {
        when (p.first) {
          Imp.BACKUP -> {
            val pay = p.second as Backup.ImportPayload
            var myOk = true
            withContext(Dispatchers.IO) {
              Store.applyAll(pay.data)                                    // 白名单键写入/缺键 remove
              pay.my?.let { myOk = runCatching { myRadio.replace(it.joinToString("\n")) }.getOrDefault(false) }   // v2 含 my-radio（v1 无则不动）
              lib.myText = myRadio.readText()
            }
            // AIbot P1-2：Store 已被整体替换，三层内存态必须显式刷新——缺一层 = 重启才生效，
            // 且播放层旧 volperst/srcmem 内存会在下次调音量/换源时整体回写冲掉刚导入的值（数据损坏向）
            lib.reloadStore()                                             // 收藏/最近/健康标记/cfg 内存重载
            lib.reload()                                                  // 主列表/my 层重装配 + 回绑
            PlayerHolder.reloadMems()                                     // volperst/srcmem2/vol 重载（public 化入口）
            refreshUi3()
            stamp.value++; primeAll()
            updateShortcuts()                                             // E3：收藏已整体替换，快捷方式重建
            toast(if (myOk) "已恢复完整备份" else "已恢复完整备份（my-radio 超限未恢复：500 行/64KB）")   // AIbot P3：超限失败明示不静默
          }
          Imp.M3U -> {                                                    // N2：库外台批量入 my-radio（append 自带查重/清洗/封顶/SafeTarget）
            @Suppress("UNCHECKED_CAST") val extra = p.second as List<Station>
            var ok = 0; var skip = 0
            withContext(Dispatchers.IO) {
              for (s in extra) {
                if (runCatching { myRadio.append(s.n, s.c, s.u0) }.getOrDefault(false)) ok++ else skip++
              }
              if (ok > 0) lib.myText = myRadio.readText()
            }
            if (ok > 0) { lib.reload(); stamp.value++; primeAll() }
            toast("已写入自定义电台 $ok 个" + (if (skip > 0) "，跳过 $skip 个（重复/封顶/地址不合规）" else ""))
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

