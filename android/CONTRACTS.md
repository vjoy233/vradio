# android/ 并行开发契约（CONTRACTS.md）

> 本文件是四个并行开发面的**接口冻结点**：`model/Model.kt` 与 `consts/Consts.kt` 已由主线写死（勿改），
> 下面各 API 签名按各自归属文件实现；跨文件调用只允许走本文列出的公开 API。
> 语义来源 = Web 侧源码（`app.js` / `player.js` / `store.js` / `logos.js` / `sync.js` / `server.js` / `update-sources.js`），
> 每个实现前先读对应 Web 文件；行为以 Web 为准，本文与 Web 冲突时以 Web 实际行为为准并在收尾报告中注明。
> 方案文档 `docs/plan-android.md` §5.2（分层）/ §5.3（播放映射表）是总纲。

## 硬性纪律（所有开发面）

- 包名 `io.github.vjoy233.vradio`，源码根 `android/app/src/main/java/io/github/vjoy233/vradio/`。
- **中文注释、中文 UI 文案、极度紧凑短行**（AGENTS.md 代码风格，安卓侧保持一致）。
- 依赖封闭清单（build.gradle.kts 已锁）：compose-bom/material3/ui、activity-compose、core-ktx、
  media3(exoplayer/hls/session/datasource-okhttp)、okhttp、kotlinx-coroutines-android。**不引任何其它库**；
  JSON 一律 `org.json`；异步一律协程；不得使用 java.net.HttpURLConnection 之外的自研网络栈做流请求之外的东西（探活/曲讯/台标统一 okhttp 或 HttpURLConnection，见各节）。
- 数据层（data/check/sync）**不得 import 任何 android.* / androidx.***（纯 JVM 可测）；只有 player/ui 层碰 Android。
- 单测 JUnit4 纯 JVM（`app/src/test/java/...`），不引 robolectric；文件系测试用 `kotlin.io.path.createTempDirectory` 或 `File.createTempFile` + teardown 删除。
- 你只能写你名下的文件；**不要跑 gradle、不要 git**（主线统一编译收口）。
- 播放器/列表的回调注入方向照抄 Web：player 不伸手进 app/logos，UI 反馈经 StateFlow/回调注入。

## 已冻结的共享代码（只读）

- `model/Model.kt`：`Station`（key/u0/hidden/health/dCat/dName/dU）、`Cfg`、`HealthEntry`、`FavEntry`、`RecentEntry`、`SongRec`、`SrcMem`、`PState`、`PlayerUiState`。
- `consts/Consts.kt`：`C`（13 键白名单/体检四常数/分档常数/决策链常数/歌史常数/UI 分类序等，每条带 Web 出处注释）。

---

## Agent A —— 数据层（data/）

名下文件：
```
data/RadioTxt.kt    data/Store.kt    data/MyRadio.kt    data/Cfg.kt
data/Library.kt     data/Backup.kt   data/Logos.kt      data/Starter.kt
（测试）app/src/test/java/io/github/vjoy233/vradio/RadioTxtTest.kt / StoreTest.kt / CfgTest.kt / BackupTest.kt / LibraryTest.kt
```

### Store.kt（对标 store.js，但单进程大幅简化）
```kotlin
object Store {
  fun init(dir: File)                       // dir = filesDir；持久文件 store.json
  fun get(k: String): String?               // 值恒为 JSON 字符串（与 Web localStorage 镜像/store.json 完全同格式）
  fun set(k: String, v: String)             // 写内存 + 落盘（tmp+rename 原子写，进程写一半被杀不丢收藏——A3 纪律）
  fun remove(k: String)
  fun snapshot(): Map<String, String>       // 白名单 C.KEYS 内且存在的键（exportAll 用）
  fun applyAll(data: Map<String, String>)   // 导入恢复：白名单键有值写入/缺键 remove（app.js importAll 同语义）
}
```
- 落盘格式 = `{"radio.favs":"…", …}`（值是字符串，不是嵌套对象）；`get/set` 全部 `@Synchronized`。

### RadioTxt.kt
```kotlin
object RadioTxt {
  fun parse(text: String): List<Station>    // app.js parse() 同款：#genre# 分节 + 名字,地址 csv + #EXTINF m3u 双格式、
                                            // 同键并源去重；**行协议取前两字段、3+ 字段容错跳过**（plan 5.2/A2，与 Web lastIndexOf 语义的
                                            // 差异点写注释）；URL 须 http(s)；Station 的 dCat/dName/dU 留底由 Library 填，parse 返回即可不填
}
```

### Cfg.kt
```kotlin
object CfgCodec {
  fun parse(raw: String?): Cfg              // normCfg 同语义（app.js:77-92）：URL 键过滤/trim/封顶（srcs 条 6×512）
  fun toJson(c: Cfg): String
  fun count(c: Cfg): Int                    // cfgCount 同款（导入确认文案用）
}
```

### MyRadio.kt
```kotlin
class MyRadio(private val dir: File) {      // dir = filesDir；文件 my-radio.txt
  fun readText(): String
  fun read(): List<Station>                 // RadioTxt.parse(readText())
  fun replace(text: String): Boolean        // backup v2 导入恢复用（行数 500/64KB 封顶内才收，tmp+rename）
  fun append(name: String, cat: String, url: String): Boolean   // csv 清洗（台名/分类去逗号换行）+ 封顶 + tmp+rename
}
```
- my-radio.txt 行格式先查 `server.js` 的 /api/mystation 写盘格式与 `app.js` 的消费方式，保持一致。

### Library.kt（数据装配管线 + 持久态唯一所有者，对标 app.js 的 App 数据面）
```kotlin
class Library(
  val store: Store,
  private val filesDir: File,
  var mainText: String = "",        // radio.txt 全文（AppVm 从 assets/D7 副本装载）
  var myText: String = "",          // my-radio.txt 全文（AppVm 从 filesDir 装载）
  private val clock: () -> Long = System::currentTimeMillis,
) {
  val stations: List<Station>
  fun cats(): List<String>                       // 除去「全部/★收藏/最近」的实体分类序（华语/欧美置顶，见 C.CAT_TOP）
  var cfg: Cfg
  fun reapplyCfg()                               // 回滚 dCat/dName/dU → applyCfg → rebind
  // —— 收藏/最近（favs:[FavEntry] recents:[RecentEntry]，boot 从 store 容错读 + 旧格式迁移照抄 app.js loadStore）——
  fun isFav(s: Station): Boolean
  fun toggleFav(s: Station)                      // 落盘 radio.favs
  fun recordRecent(s: Station)                   // 队首去重 ≤20，落盘 radio.recents
  // —— 健康标记（radio.health 的内存态 + 落盘；分档生命周期函数在 check 层 Health 对象，这里只承载）——
  var healthMarks: MutableMap<String, HealthEntry>
  fun saveHealth()                               // FIFO 分额度裁剪照抄 app.js saveHealth
  fun applyHealthToStations()                    // 先清全部行内标再按 marks 挂 dead——体检复活即回归列表（app.js patchHealth 口径，G P1）
  // —— 歌史（radio.songs）——
  fun pushSong(u0: String, title: String)        // app.js pushSongHist 同款：list[0].t!==title 才入、每台 12/台数 50 FIFO
  fun songsOf(u0: String): List<SongRec>
  fun allSongs(): Map<String, List<SongRec>>
  // —— 视图 ——
  fun visible(showDead: Boolean, playingKey: String?, connectingKey: String?): List<Station>   // app.js visible 同口径
  fun search(kw: String): List<Station>          // 多词空格 AND（audit-r2 拍板口径），只搜可见台
  fun resolve(key: String): Station?             // key 反解（收藏/最近回绑用）
  fun resolveByUrl(u0: String): Station?
  // —— 生命周期 ——
  fun reload()                                   // parse(mainText/myText) → applySources（STARTER 按精确名去重并入 + my 常驻并入
                                                //  + dCat/dName/dU 留底）→ applyCfg → rebind（收藏/最近按 URL 回绑）→ applyHealthToStations
  fun rebind()                                   // favs/recents 按任一源 URL 回绑刷新键与快照（app.js rebind 同款）
}
```

### Backup.kt（导入导出五件套）
```kotlin
object Backup {
  fun exportAll(lib: Library, myText: String, at: Long): String          // {v:2, at, data:{13键快照}, my:[my-radio 行数组]}——D11 一步到位
  data class ImportPayload(val data: Map<String, String>, val my: List<String>?)   // my=null 表示 v1 无 my 字段
  fun parseImport(text: String): ImportPayload?                          // null=非法文件；data 白名单过滤（typeof string 才收）
  fun m3uFavs(lib: Library): String                                      // #EXTM3U + #VRADIO:FAV（app.js exportFavs 同款）
  fun songsTxt(lib: Library, clock: () -> Long): String                  // 全台历史按时间倒序（app.js exportSongs 同款格式）
  fun cfgJson(cfg: Cfg): String                                          // {v:1, cfg}
}
```
- v2 的 my 行数组 = my-radio.txt 的原始行（不含结尾空行）。导入 v1（无 my）不动 my-radio.txt。

### Logos.kt（台标数据唯一所有者，对标 logos.js）
```kotlin
interface HttpText {  // 也供 sync 层复用：okhttp 实现，超时/字节封顶/失败 null
  suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String> = emptyMap()): String?
}
class Logos(private val filesDir: File, private val http: HttpText, private val clock: () -> Long) {
  fun loadBuiltins(text: String)                // logos.txt 全文（AppVm 从 assets/D7 副本装载）：「分类|台名,URL」行
  fun get(s: Station): String                   // 同步窥探绝不发请求：STARTER.l → 内置表 → 运行时缓存
  fun prime(s: Station, isFavOrPlaying: Boolean) // 仅收藏+正在播才异步解析：蜻蜓台频道页封面 <img class="img">、
                                                 // 其它查 Radio Browser byurl favicon；负缓存 7 天（C.LOGOS_NEG_MS）；
                                                 // 缓存落 filesDir/logos-cache.json（可重建，不入 13 键主源）
}
```
- 蜻蜓台判定与频道页 URL 换算照抄 logos.js；Radio Browser 端点照抄（`https://de1.api.radio-browser.info/json/stations/byurl?url=`…）。

### Starter.kt
- 从 app.js:6-21 逐条照抄 14 个精选台为 Kotlin 常量列表（`val STARTER: List<Station>`，l 字段保留）。

### 单测要求（每个文件至少 3-6 个用例，离线秒级）
- RadioTxt：#genre#/csv/m3u 三形态、同名并源、3+ 字段跳过、URL 非法丢行、真实 radio.txt 首中尾抽查。
- Store：白名单 round-trip / 缺键 remove / 坏 JSON 容错 / 重启（重新 init）数据仍在。
- Cfg：坏形状回退空配置、srcs 封顶清洗、URL 键过滤。
- Backup：v2 导出→导入 round-trip；v1 导入（无 my）兼容不炸；非法 JSON → null；my 不进 13 键白名单。
- Library：装配管线（STARTER 去重/追加源挂尾不动 u[0]/手动隐藏彻底消失/死台隐藏的正在播例外）、收藏 URL 回绑、pushSong 去重与 FIFO。
- 测试里 radio.txt 样例用内联小文本，不读真实大文件（冷启动 <1s）。

---

## Agent B —— 播放层（player/）

名下文件：`player/PlayerHolder.kt`、`player/PlaybackService.kt`（依赖 model/Consts 只读）。

### PlayerHolder.kt —— ExoPlayer 封装 + 决策链 + 自愈 + ICY（对标 player.js 全部语义，plan 5.3 映射表）
```kotlin
object PlayerHolder {
  fun ensure(ctx: Context)                     // VRadioApp.onCreate 调一次；建 ExoPlayer/MediaSession
  val ui: StateFlow<PlayerUiState>             // UI 唯一读口
  val player: ExoPlayer                        // 供 MediaSessionService 挂
  val session: MediaSession
  fun play(s: Station, prefer: Int = -1)       // 决策链（见下）+ 每台音量 + MediaSession 元数据
  fun pause() / resume() / toggle() / stop()
  fun setVolPct(pct: Int)                      // rememberVol 语义分流：正在播→台记忆（首调随行更新全局锚点）；无台→全局；0 不入记忆
  fun forgetSrc(): Boolean                     // 恢复默认源=清当前台 srcmem（true=真清了，UI 随即按启发式重播）
  fun sleep(min: Int) / cancelSleep()          // 到点前 30s 线性渐弱，停止后音量按逻辑值恢复
  fun srcmemOf(s: Station): Int                // 记忆的源序号（选源浮层「正在用/记忆」徽标），-1=无
  var onStepFav: ((Int) -> Unit)?              // ⏮⏭ = 收藏间切台（通知栏/耳机线控）
  var onPlayLast: (() -> Unit)?                // 媒体键 play 但无台 → 续播上次
  var onSong: ((u0: String, title: String) -> Unit)?   // ICY 曲名（含换歌判定后触发；UI 入史+刷新）
  var logoProvider: ((Station) -> String)?     // 锁屏 artwork（同步窥探口径）
}
```
语义硬点（逐条对照 player.js 实现，注释里标 Web 行号）：
1. **variants**：蜻蜓 `ls.qingting.fm/live/{id}.m3u8` 换算 `http://lhttp.qingting.fm/live/{id}/64k.mp3` 前置 + 原 URL（安卓无 /proxy 级）。
2. **决策链**：`srcOrder`（srcRank：首个 variant 非 m3u8=0 否则 1，稳定排序保行序）→ srcmem2 记忆 unshift → prefer unshift → 展开成 {url, si} 级联表。
3. **世代令牌**：每次 play() ++token；所有异步回调先验令牌防串台（快速连点场景）。
4. **级联**：onPlayerError → next()；全部耗尽 → 状态栏「⚠ 全部源失败，建议体检或同步源」+ ui 复位。
5. **看门狗**：BUFFERING/静默 12s 无进展（C.WATCHDOG_MS）→ retryOrNext（**先重连当前源一次**再顺延，retried 标志）；READY/进展即撤。
6. **ended**：直播不该 ended → retryOrNext；**halt 守卫**（有意暂停后 error/ended 不许自愈复活，heldNext 挂起等 resume 接回——audit-r4 P2-2 语义）。
7. **ICY**：OkHttpDataSource.Factory + `setAudioAttributes(USAGE_MEDIA, CONTENT_TYPE_MUSIC, handleAudioFocus=true)` + `setHandleAudioBecomingNoisy(true)`；onMetadata 里 IcyInfo.title → 与 lastSong 不同才触发 onSong + MediaSession 歌名；IcyHeaders.bitrate → ui.kbps（>0 才显示）。HLS 结构性无 ICY 显示空不是 bug。
8. **每台音量**：play() 套 `radio.volperst[u0]`（无记忆用 gvol）；静音态切台保持静音。Store 直读写（radio.volperst/radio.vol/radio.srcmem2，FIFO 300 照抄）。
9. **MediaSession**：MediaMetadata title=歌名/台名、artist="VRadio · "+分类、artworkUri=logoProvider 返回值；⏮⏭ 经 ForwardingPlayer 或 custom command 接 onStepFav（通知栏按钮可用）；睡眠定时渐弱。
10. WAKE_MODE_NETWORK；通知由 MediaSessionService 自动管理（POST_NOTIFICATIONS 运行时申请在 UI 层首播时做，拒绝不阻断播放）。

### PlaybackService.kt
```kotlin
class PlaybackService : MediaSessionService() { override fun onGetSession(info) = PlayerHolder.session }
```

---

## Agent C —— UI 层（ui/ + 根文件）

名下文件：
```
VRadioApp.kt  MainActivity.kt
ui/theme/Theme.kt  ui/AppVm.kt  ui/AppRoot.kt  ui/StationList.kt  ui/PlayerBar.kt
ui/SrcSheet.kt  ui/SongsSheet.kt  ui/SettingsScreen.kt  ui/AddStationScreen.kt  ui/Common.kt
```
- **Theme**：双主题照抄 Web 色板（index.html CSS 变量）——深色 bg#101418/panel#1a2027/line#2a323c/tx#e8ecf1/dim#8b97a5/acc#4fc08d/warn#e07a5f，浅色 bg#f4f6f8/panel#fff/line#d9dee4/tx#1f2733/dim#5d6a77/acc#1f7a54/warn#b5431a；`radio.theme`（auto/light/dark，默认 auto，auto 跟随系统实时）；不做 Material You 动态取色。收藏星色深 #f5c542/浅 #8a6508。
- **AppVm**（集中 state 对象 + 单一渲染入口精神）：持有 Library/Logos/MyRadio/CheckStream/LightUpdate/Gh；StateFlows：列表态（cat/keyword/view grid|list/showdead/theme）、toast、体检进度、D7 结果、导入导出状态文案；把 PlayerHolder.ui 转播给 UI。boot 流程照抄 app.js boot + sync.js boot 静默体检（仅 WiFi，D10）。
- **列表**：分类条 chip（「全部/★收藏/最近」+ 实体分类 + 数量角标）+ 搜索框（多词空格 AND）+ 网格(台标图+名)/单列双视图切换 + 行内 ☆ 收藏 + 死台删除线+「已停运/疑似不可达」徽标 + 正在播高亮 + 连接中指示（蜻蜓建流 5-10s 属正常要有连接中反馈）。飞行模式可浏览（数据全在本地）。
- **PlayerBar**（底部常驻）：台名/分类、曲名行（"♪ 歌名 · Nkbps"，点开本台歌史 bottom sheet）、播放/暂停、选源入口（多源台）、睡眠定时菜单（15/30/60，进行中再点取消）、音量滑杆（联动 volperst）、回到正在播。
- **SrcSheet**：正在听的多源台切源浮层——整行点选立即切播、序号徽标（记忆/正在用）、底部「↺ 恢复默认源」（forgetSrc+重播）。
- **SettingsScreen**：主题三态、无效源显示开关、手动体检（全量，进度+分档统计完成态）、数据更新（D7：检查→commits 判新→下载→「已更新到 <date> · 台数 ±N」；收藏台消失点名 favsGone）、端内同步（M4，调 SyncEngine，WiFi-only 提示）、添加自定义电台入口、导入导出五件套（backup v2/m3u/songs txt/config json，SAF 文件选择器 ACTION_OPEN_DOCUMENT/CREATE_DOCUMENT）、关于（版本/许可/键盘帮助不需要）。
- **AddStationScreen**：台名/分类/流 URL 表单，**探活先行**（CheckStream 12s 窗）通过才写 my-radio，失败明示不静默。
- **权限**：POST_NOTIFICATIONS 首播时申请（不在 boot 弹）；拒绝不阻断。
- **SAF**：导入 ACTION_OPEN_DOCUMENT（backup json/m3u/config）；导出 ACTION_CREATE_DOCUMENT 预填文件名。
- 图标加载：手写小工具（okhttp 取 bytes → BitmapFactory → LruCache，remember(url) + LaunchedEffect），台标 40-200px 小图，量级不需要 Coil；坏图回退首字母色块。
- VRadioApp：onCreate → Store.init(filesDir) → PlayerHolder.ensure(this)；MainActivity：edge-to-edge + setContent { AppRoot() }。

---

## Agent D —— 体检 + 同步层（check/ + sync/）

名下文件：
```
check/CheckStream.kt  check/Health.kt
sync/Gh.kt  sync/ClassifyCn.kt  sync/LightUpdate.kt  sync/SyncEngine.kt
（测试）CheckStreamTest.kt（离线部分）/ HealthTest.kt / ClassifyCnTest.kt / LightUpdateTest.kt
（工具）android/tools/gen-classify-fixture.js（node，跑真实 radio.txt 产 fixture；fixture = app/src/test/resources/classifycn-golden.json）
```
（fixture 文件名建议 `app/src/test/resources/classifycn-golden.json`）

### CheckStream.kt
```kotlin
class CheckStream(private val http: RawHttp) {   // RawHttp = okhttp 字节级拉流接口（自定义 interface，实现同文件）
  data class Verdict(val ok: Boolean, val bytes: Long, val hls: Boolean, val why: String)
  suspend fun check(url: String, windowMs: Long = C.CHECK_WINDOW_MS): Verdict
}
```
- 字节验收纪律（AGENTS 已知坑）：**不能信状态码/Content-Type**（xmcdn 假流/漂移）；窗内（4500ms，mystation 12s）累计字节 ≥8000（非 HLS）认活；HLS：拉 m3u8 + 首段分片 ≥6000B；Content-Type text/html 直接拒。并发由调用方（AppVm）控制。
- **已知差异留档（G P3）**：端上 OkHttp/DataSource 默认跟随重定向且不逐跳复查 safeTarget——Web 的「重定向逐跳复查」服务的是服务端代理 SSRF 面，端上无监听端口不存在（plan 5.5 论证）；若未来引入本地代理/转发面须复查此决定。

### Health.kt（分档生命周期纯函数，plan-health-and-storage grill R1-R4）
```kotlin
object Health {
  fun normalize(raw: String?): MutableMap<String, HealthEntry>     // 容错读 + 疑似档 TTL 180 天过滤 + 旧数据（无 t0/n/perm）兼容为疑似 n=1
  fun onDead(marks: MutableMap<String, HealthEntry>, key: String, urls: List<String>, now: Long)
                                                                   // 首死入疑似；连续确认 n+1；n≥3 且 t0≥30 天 → perm=1 停运档
  fun onAlive(marks: MutableMap<String, HealthEntry>, key: String) // 复活撤销=delete（从疑似档重来）
  fun toJson(marks: Map<String, HealthEntry>): String
  fun bootScope(marks, favs: List<FavEntry>, recents: List<RecentEntry>, stations: List<Station>, now: Long): List<Station>
                                                                   // 开机静默复测范围（收藏+最近 ∪ 死标记台；t>24h 节流、200 封顶、停运档 7 天一次）
}
```

### Gh.kt（GitHub 客户端，D7/M4 共用）
```kotlin
class Gh(private val http: HttpText) {   // HttpText 在 data/Logos.kt 定义（Agent A），此处 import 复用；okhttp 实现可在这里给一份默认工厂
  suspend fun file(repo: String, path: String): String?          // api.github.com/repos/{repo}/contents/{path} + Accept: vnd.github.raw
                                                                 // 4MB 封顶 + body>100 校验（update-sources.js ghFile 同款；不引 raw.githubusercontent.com）
  suspend fun lastCommitIso(repo: String, path: String): String? // /commits?path=…&per_page=1 → commit.committer.date（判新旧）
}
object GhRepos { const val SELF = "vjoy233/vradio"; const val CN_UP = "gaotianliuyun/gao"; const val EU_UP = "AlonDrilich/radio-playlists" }
```

### ClassifyCn.kt（国内台重分类移植）
```kotlin
object ClassifyCn {
  val CAT_ORDER: List<String>; val EU_CAT: String; val ASIA_CAT: String; val INTL_CAT: String; val CN_FALLBACK: String
  fun classify(name: String): String     // CN_RULES 顺序即优先级、兜底 综合·其他、国际台捞回欧美系——语义逐行照抄 update-sources.js
}
```
- **金样验收**（M4/A15）：`android/tools/gen-classify-fixture.js`（node，require 仓库根 update-sources.js 导出的 classifyCn——先确认其导出名，test/smoke.js 有用法可查）跑全量 radio.txt 台名产 `app/src/test/resources/classifycn-golden.json`；Kotlin 测试读 fixture 逐条断言 100% 平价 + 若干手写边界用例。**生成脚本与 fixture 都要提交**（fixture 是测试资源，不是生成物）。

### LightUpdate.kt（D7 轻更新通道）
```kotlin
class LightUpdate(private val gh: Gh, private val filesDir: File) {
  data class Result(val commitIso: String, val radioChanged: Boolean, val logosChanged: Boolean,
                    val added: Int, val removed: Int, val addedCheck: List<String>)
  suspend fun check(localStampIso: String): String?   // 有新版返回最新 commitIso，null=无更新/网络失败（失败明示由 UI 层区分异常）
  suspend fun apply(oldRadioText: String): Result?    // 下载两文件 → filesDir/radio.txt+logos.txt（tmp+rename）+ 落 stamp；
                                                      // diff 按 keyOf 台名集合算 added/removed（R.RING_CHECK_CAP 封顶）、addedCheck（新增国内台、欧美节过滤、500 封顶）
  fun radioText(): String?; fun logosText(): String?; fun stamp(): String?   // filesDir 副本；null=从未更新（用 assets）
}
```
- 判新旧：Gh.lastCommitIso(SELF, "radio.txt"/"logos.txt") vs localStampIso（assets 打包基线 = assets/data-stamp.txt，AppVm 读）。

### SyncEngine.kt（M4 端内同步，尽力实现；最后做）
- 上游 CN（gaotianliuyun/gao 的 radio.txt）拉取 → 按 #genre# 节解析 → classifyCn 重分类整编进 CAT_ORDER；
- 欧美节从 AlonDrilich/radio-playlists m3u（Radio Browser 镜像 top-500）过滤欧美国家 → 逐台实测重建（CheckStream；WiFi-only 由调用方把关）→ 按类型榜拆 欧美音乐/国际新闻·谈话（EU_TALK_NAMES 榜外兜底、UUID 关联键语义照抄）；
- 合并 CAT_ORDER 装配 → 写 filesDir/radio.txt（欧美获取失败保留旧分类；合并结果低于下限中止写盘——下限值抄 update-sources.js）→ diff 摘要 {added, removed, addedCheck}。
- 若完整移植工作量过大，允许降级为：CN 节全链 + 欧美节沿用现文件原样搬运（不做逐台实测）+ 明确 TODO 注释 + 在收尾报告里写明；**不允许静默半实现**。

---

## 收尾报告（每个 agent 的最终输出）

列出：已写文件清单、与 CONTRACTS.md 偏差点及原因、单测清单与自测情况（语法自查，无法编译）、遗留 TODO。
