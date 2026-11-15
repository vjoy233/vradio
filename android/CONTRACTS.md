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

## r4 扩展契约（B0 起生效，docs/plan-expansion-r4.md）

- **仓库根 `contracts/` 是 Web/Android 双端共同契约面**：`radio-keys.json`（13 键白名单单一来源，三侧
  store.js KEYS / server.js STORE_KEYS / C.KEYS 漂移由 Web `test/contracts.js` 与 Android `ContractTest.kt`
  双端拦截）、`source-diagnostic.json`、`quality-summary.json`、`metadata-event.json`、`backup-v3.schema.json`、
  `listen-stats-summary.json`（B3 收听统计：days 双端同构/写失败落盘确认模型/GET ?rev= 条件获取/409 机器可读
  code，AIbot 复核 P1/P2）及 `fixtures/` 黄金样本（backup-v2/v3、metadata-golden、playlist-pls/xspf/asx、
  diagnostic-results）。
  Android 经 `app/build.gradle.kts` 的 test resources 接线读取（`getResource("radio-keys.json")` /
  `getResource("fixtures/…")`），改契约文件两侧行为都会被测试点名。
- **`radio.cfg` v2**：新增 `v`（无 v 视为 v1，迁移 = 补版本语义不动字段）与源生命周期三字段
  `srcManualOrder` / `srcDisabled` / `srcLabels`（清洗口径 = srcs 同款 URL 数组映射；语义接线在 B1）。
  Web `normCfg/migrateCfgV1` ↔ Android `CfgCodec.parse/toJson` 必须保持 round-trip 一致。
- **sidecar 分层**：质量/收听统计等不进 `radio.*` 主 Store、不占 2MB 配额；Web 走专用 `/api/quality`
  （操作事件合并 + op.id 幂等 + rev 唯一发号，契约详见 `contracts/quality-summary.json`），Android 落
  `filesDir/quality.json`（B2 QualityStore.kt）。`radio.logos`/`radio.storeDirty` 继续排除在白名单外。
- **备份版本映射**：v1 无 my 不动 my-radio；v2 读取 `my` 数组；v3（B4）读取 `myRadio` 数组 + `extensions`
  sidecar 可选导出；导出统一 v3。Web/Android 黄金样本互读为验收硬项。

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
  fun partitionImport(list: List<Station>): Pair<List<Station>, List<Station>>   // N2 m3u 导入分流（纯决策不变异，
                                                // AIbot P1-1）：库内可解析台（键优先/任一源 URL 兜底）→ favHits 交调用方批量恢复收藏
                                                // （内存并入、收尾 rebind 一次落盘，免逐台全量写盘）；库外台（不在 stations/favs 快照/my 层行）
                                                // → extra 待确认入 my-radio。分流必须先于收藏变异，否则 extra 恒空
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
  fun refresh()                                // 手动刷新回直播头：当前源整链重开 play(s,curSi)（镜像 Web）；暂停中直接起播；空台无响应；不写 srcmem
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
11. **刷新（refresh，两侧镜像 Web）**：当前赢家源整链重开回直播头（docs/plan-refresh-live.md §2 状态矩阵）——暂停/连接中均允许（token 作废重来、暂停中直接起播）、空台无响应、不写成功源记忆；入口 = 播放栏「刷新」+ 通知栏自定义 action（SessionCommand 经 onConnect 放行 + setCustomLayout，锁屏/后台直达）。

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
- **Theme**：双主题照抄 Web 色板（index.html CSS 变量）——深色 bg#101418/panel#1a2027/line#2a323c/tx#e8ecf1/dim#8b97a5/acc#4fc08d/warn#e07a5f，浅色 bg#f4f6f8/panel#fff/line#d9dee4/tx#1f2733/dim#5d6a77/acc#1f7a54/warn#b5431a；`radio.theme`（auto/light/dark + **oled 纯黑档**（batch1 N18 软扩展，Web 侧未知值回退 auto），默认 auto，auto 跟随系统实时）；不做 Material You 动态取色。收藏星色深 #f5c542/浅 #8a6508。
- **AppVm**（集中 state 对象 + 单一渲染入口精神）：持有 Library/Logos/MyRadio/CheckStream/LightUpdate/Gh；StateFlows：列表态（cat/keyword/view grid|list/showdead/theme）、toast、体检进度、D7 结果、导入导出状态文案；把 PlayerHolder.ui 转播给 UI。boot 流程照抄 app.js boot + sync.js boot 静默体检（仅 WiFi，D10）。
  **batch1（2026-10-18 拍板）新增 API**：`handleIntent(Intent)`（E3/E4 入口：快捷方式 extra `vradio.shortcut`→点播；ACTION_VIEW 流链接→`addPreset` 预填添加页。onCreate 仅 `savedInstanceState==null` 时路由——重建（旋转/深浅色切换）不重放启动 intent，热路径在 onNewIntent，AIbot P1-4）、`updateShortcuts()`（E3 动态快捷方式整组重建，收藏变更/导入后调用）、`shareStation(Station)`（N8 ACTION_SEND）、`setResume/setOffload`（N4/E5 本地开关，持久化在根包 `Prefs`（SharedPreferences "vradio"）——**非 radio.\* 契约键**，2026-10-18 契约表拍板只开 radio.notes 留 Web 先行）、`offloadCap`（E5 能力探测，置灰用）。
- **列表**：分类条 chip（「全部/★收藏/最近」+ 实体分类 + 数量角标）+ 搜索框（多词空格 AND）+ 网格(台标图+名)/单列双视图切换 + 行内 ☆ 收藏 + 死台删除线+「已停运/疑似不可达」徽标 + 正在播高亮 + 连接中指示（蜻蜓建流 5-10s 属正常要有连接中反馈）。飞行模式可浏览（数据全在本地）。
- **PlayerBar**（底部常驻）：台名/分类、曲名行（"♪ 歌名 · Nkbps"，点开本台歌史 bottom sheet）、播放/暂停、选源入口（多源台）、睡眠定时菜单（15/30/60，进行中再点取消）、音量滑杆（联动 volperst）、回到正在播、刷新（plan-refresh-live）、分享（batch1 N8）。
- **SrcSheet**：正在听的多源台切源浮层——整行点选立即切播、序号徽标（记忆/正在用）、底部「↺ 恢复默认源」（forgetSrc+重播）。
- **SettingsScreen**：主题三态、无效源显示开关、手动体检（全量，进度+分档统计完成态）、数据更新（D7：检查→commits 判新→下载→「已更新到 <date> · 台数 ±N」；收藏台消失点名 favsGone）、端内同步（M4，调 SyncEngine，WiFi-only 提示）、添加自定义电台入口、导入导出五件套（backup v2/m3u/songs txt/config json，SAF 文件选择器 ACTION_OPEN_DOCUMENT/CREATE_DOCUMENT）、关于（版本/许可/键盘帮助不需要）。**batch1 新增**：播放节（N4 启动续播开关默认关 + E5 音频卸载实验开关、offloadCap 置灰）、疑难与反馈节（N3 省电白名单引导 + GitHub Issues 入口）、m3u 导入放宽为任意 m3u（N2：库内恢复收藏、库外确认后入 my-radio）、主题第四档纯黑 OLED。
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

---

## B1 API 面（r4 扩展契约·Android 侧，2026-11-15，plan-expansion-r4 §5）

> B1 批次落地后的冻结接口；语义与 Web 侧（srcorder.js / app.js 详情面板）必须镜像，冲突以 plan-expansion-r4 §5 为准。

- **`CheckStream.Verdict` 结构化（§5.1）**：
  `Verdict(ok, bytes, hls, why, code, httpStatus, contentType, latencyMs, checkedAt)`，
  `Code = { OK, NETWORK, HTML, HTTP, EMPTY_PLAYLIST, NO_SEGMENT, SHORT_BODY, REDIRECT_REJECTED, INVALID_URL }`。
  code 是程序分支唯一依据、why 仅人读。判定次序（双端须一致）：直流/分片 = `HTML`（Content-Type text/html
  且字节 ≥ 阈值）> `SHORT_BODY`（窗内字节不足，fixture 336B 假流口径）> `OK`；HLS 清单非 200 → `HTTP`、
  清单无分片 → `EMPTY_PLAYLIST`、分片拉不到/地址解析失败 → `NO_SEGMENT`（bytes/ct 报清单侧观察值）。
  安卓侧 `REDIRECT_REJECTED` 恒不产生（okhttp 跟重定向不逐跳复查，G P3 留档）、`INVALID_URL` 仅入口
  http(s) 预检触发；两值保留为枚举/契约对齐。`RawHttp.Resp` 增 `latencyMs`（TTFB 近似）。
- **`DiagnosticResult`（model/）+ `DiagnosticCodec`（check/）**：字段 = contracts/source-diagnostic.json
  result 形态；`Verdict.toDiagnostic(url)` 产 mode=direct|hls；fixture 对齐测试在 `DiagnosticModelTest`。
- **`Station.mo/dis/lbl`（运行时字段，不持久化、不参与 equals）**：`mo` = 人工有效顺序
  （manual 中存在于 u 的按 manual 序排前 + 未列按 u 原序追加；null = 无人工序即默认 [0..n-1]，**含禁用位**）；
  `dis` = 禁用索引集；`lbl` = 源 URL→标签。`Station.effOrder()` = mo 剔除 dis（播放维度）。**绝不物理重排
  `u[]`**——cfg 三字段键一律 = 身份 URL `u[0]`（与 srcs 的「任一源命中」口径不同）。
- **Library B1 编辑口**：`srcMove(s, i, up)`（材料化当前完整序相邻交换，>6 源台由 urlArrMap take(6) 截断——
  两侧同款护栏）、`srcOrderReset(s)`（撤销人工源排序，只删该台 srcManualOrder）、`srcDisabledToggle(s, i)`
  （启用/禁用切换，主源可禁不换身份键）；全部整表写 cfg + reapplyCfg 即时生效。
- **PlayerHolder 决策链（B1 扩展）**：`srcOrder(s)` 基座 = effOrder 按直流优先稳定排序；链 =
  手动 `prefer`（须在有效序内，禁用不播）> `srcmem2.i`（须在有效序内，指向禁用源忽略）> `mo` 首位（人工默认序）
  > 启发式对 mo 序遍历；级联自愈只走有效序。
- **`NO_ENABLED_SOURCE`**：`effOrder()` 为空时 `play()` 不建流不建 pctx——`PlayerUiState.noSrc=true` +
  status「该台所有源都已手动禁用，请先启用一个源」，保持停播；不写 radio.health、不自动复活、不换
  identityUrl；`resume()` 重进提示路径。自动体检（boot 静默/手动全量）跳过禁用源（`probe` 只测 effOrder，
  全禁台无判据不落标）。
- **恢复默认两动作（彼此独立）**：「恢复默认播放源」`PlayerHolder.forgetSrcOf(s)` 只清 srcmem2（人工序/禁用
  保留；`forgetSrc()` 旧入口=当前台）；「撤销人工源排序」`Library.srcOrderReset(s)` 只删 srcManualOrder
  （禁用/追加源保留）。
- **`SourceDetailSheet`（ui/SrcSheet.kt）**：
  ```kotlin
  @Composable fun SourceDetailSheet(station: Station, player: PlayerUiState, diagnostics: List<DiagnosticResult>,
    onCheck: () -> Unit, onPlay: (Int) -> Unit, onEdit: (SourceAction) -> Unit,
    fav: Boolean = false, checking: Boolean = false, onSongs: (() -> Unit)? = null,
    logo: String = "", onDismiss: () -> Unit = {})
  sealed class SourceAction { data class Move(index, up); data class ToggleDisable(index);
    object RestoreDefault; object ResetOrder }
  ```
  三个必选回调按 §5.5 签名；带默认值的可选参数（fav/checking/onSongs/logo/onDismiss）由 AppRoot 注入，
  浮层本身不持 vm。手动禁用的源点诊断**不发请求**，显示「该源已被手动禁用，不能诊断」+「取消禁用」。
  入口：SrcSheet 尾行「ⓘ 源详情」+ PlayerBar 台名长按（单击仍=回到正在播 N5；列表行长按保留 N7 收藏语义）。

---

## B2 API 面（r4 扩展契约·Android 侧，2026-11-15，plan-expansion-r4 §6）

> B2 批次落地后的冻结接口；聚合/淘汰序以 `contracts/quality-summary.json` 为单一语义源，与 Web 侧
> `quality-store.js` / `update-sources.js` 候选管线必须镜像，冲突以 plan-expansion-r4 §6 为准。

- **`filesDir/quality.json` sidecar 声明**：源质量数据落本机 `filesDir/quality.json`（Web HTTP 走
  `/api/quality` → `data/quality.json`）。**不进 `radio.*` 主 Store、不占 /api/store 2MB 配额、不进
  备份**（B4 sidecar 勾选导出另议）；与 `radio.health`（死台/停运）永不合并、聚合结果不得直接改写
  死台隐藏条件。坏文件按空库恢复。文件硬上限 2MB（`C.QUALITY_MAX_BYTES`），每台源聚合封顶 6。
  **包装层分层（AIbot P1-2，契约 quality-summary.json `files` 节冻结）**：两侧文件包装不同——本文件
  `{v:1,stations:…}`（纯本机）vs Web 服务端 `data/quality.json` `{v:1,rev,ops,data:…}`（rev/ops 是
  Web 服务端并发机器）；跨端一致的是 stationRecord 内层聚合形态（双端黄金样本
  `contracts/fixtures/quality-aggregate.json` round-trip 锁定：Web test/quality-store.js 与
  ContractTest 同源消费）。
- **mode 归一（AIbot P1-1）**：`recordDiagnostic`/`recordPlayback` 入口对 mode 归一永不为空
  （`normMode`：合法枚举原样；缺失/非法按实际尝试过的 variant URL 形态兜底——m3u8→hls、其余→direct；
  归不出即丢弃该事件，契约无 unknown 值）。Web 侧 `quality-store.js qNormMode` 同款镜像——服务端
  `/api/quality` 枚举校验保持严格，空 mode 不再引发 409 整批丢样本。
- **`data/QualityStore.kt`**（纯 JVM）：
  ```kotlin
  class QualityStore(dir: File, clock: () -> Long = System::currentTimeMillis, capBytes: Int = C.QUALITY_MAX_BYTES) {
    fun load()                                                                  // 坏文件按空库恢复
    fun summary(identityUrl: String, sources: List<String> = emptyList()): QualityAggregate?   // 无记录 null
    fun recordDiagnostic(identityUrl: String, r: DiagnosticResult, trigger: String)             // trigger=manual|boot|sync
    fun recordPlayback(identityUrl: String, sourceUrl: String, ok: Boolean, latencyMs: Long, mode: String, trigger: String)  // play|watchdog|switch|error
    fun trim(keep: Set<String>); fun save(); fun sizeBytes(): Int
    @Volatile var keepHint: Set<String>                                         // 收藏+最近保护集（AppVm Main 快照回填）
    data class QualityAggregate(identityUrl, sourceCount, directCount, okCount, failCount,
      lastOkAt, lastFailAt, lastPlaybackAt, lastObservedAt, avgLatencyMs, disconnects, metadata, stability)
  }
  ```
  存储形态：`{v:1, stations:{身份URL:{cf, sources:{源URL:{okCount,failCount,lastOkAt,lastFailAt,
  lastPlaybackAt,latSum,latN,disconnects,modes[],lastDiag,lastPlayFail}}}}}`——每源聚合值 + 最近一次
  诊断 + 最近一次播放失败，不留完整历史。**与 Web 侧需要对齐的四个拍板（Web quality-store.js 实现
  时逐条对齐，不一致以本节修订为准）**：
  1. **30 天窗近似**：存储无逐样本时间戳，「近 30 天成功率/样本数」= lastObservedAt 新鲜度门控
     （行超 30 天无观察 → unknown）+ 全量计数器近似；
  2. **连续失败** = 台级 `cf` 计数器（任一源 ok 清零、fail +1），`cf≥3` 一票否决进 poor；
  3. **metadata(icy|none|mixed)** 由观测 modes 派生（op 事件无 icy 字段）：纯 direct → icy、纯
     hls → none、混合 → mixed；
  4. **trimOrder 下钻实现**：受害台 = 非保护集优先、再最久未访问（同刻 identityUrl 字典序）→
     先清该台最大历史源的 lastDiag/lastPlayFail（旧者先）→ 再丢该源 → 台空才整台丢。
- **样本来源接线（AppVm，PlayerHolder 不感知 QualityStore）**：probe/体检三通道（手动 manual /
  boot 静默 boot / 同步后增量 sync）与源详情逐源诊断（manual）写 diagnostic；PlayerUiState 流映射写
  playback——CONNECTING→PLAYING = 成功（play；同台换源到达 = switch，延迟 = 该源连接锚起算）、
  PLAYING→CONNECTING 同台 = 断流（同源重连 watchdog / 级联换源 error，均计 disconnects）、级联耗尽
  （CONNECTING→IDLE 清台 + ⚠ 文案）= error。**自动体检绝不产 playback**；写失败只丢样本不影响播放。
- **`SourceDetailSheet` B2 扩展参数**：`quality: QualityStore.QualityAggregate? = null`（默认 null 保
  §5.5 兼容，AppRoot 经 `vm.qualitySummaryOf(ds)` 注入）——NO_ENABLED_SOURCE 文案下方渲染稳定性徽标行
  （● 稳定/● 一般/● 不稳定/○ 样本不足 + 成功率/平均延迟/断流/样本数）；质量只做展示，永不替代死台
  隐藏判定（契约硬点）。
- **`sync/Candidates.kt`**（纯 JVM，镜像 Web 候选管线纯函数）：
  ```kotlin
  data class SyncCandidate(stationName, category, url, upstream, upstreamId = "", logoUrl = "",
    normalizedUrl = "", duplicateKey = "", validationResult: String? = null)
  object Candidates {
    fun normalizeUrl(raw: String): String?      // 保守归一化：去空白/scheme·host 小写/删默认端口；保留 path·query·尾斜杠；只用于比对不替换原 URL
    fun fromLine(cat: String, line: String, upstream: String, upstreamId: String = "", logoUrl: String = ""): SyncCandidate?
    fun dedupe(candidates: List<SyncCandidate>): List<SyncCandidate>   // 精确 URL → 归一化 URL → 同分类同名（duplicateKey=「分类|台名」共享=多源合并，不同分类同名不并）
    fun toLine(c: SyncCandidate): String
  }
  ```
  SyncEngine 国内节经此去重（跨节全局 URL 去重是 B2 新增能力；分类/装配口径不变）；`validationResult`
  预留 null（国内节不探活，欧美节实测已有）。
- **`sync/RadioMeta.kt` + radio-meta.json 消费**（生成在 Web 同步侧，Android 只消费）：
  ```kotlin
  class RadioMeta { companion object { val EMPTY; fun parse(text: String?): RadioMeta? } }   // null=非法/v≠1（更新通道保留旧 meta）；消费侧 ?: EMPTY 兜底
  data class MetaStation(name, category, sources: List<MetaSource>)
  data class MetaSource(url, upstream, upstreamId, kind, firstSeenAt)
  ```
  - `app/build.gradle.kts` copyRadioData 打包清单**可选包含** radio-meta.json：仓库根缺文件**跳过不报错**
    （Web 侧生成落地后自然带上），data-stamp 仍只看 radio/logos 两文件提交（meta 单独晚提交不触发
    D7 误报）。
  - LightUpdate.apply() 主库与 meta **分开落盘**：下载到但 v≠1/不可解析（`metaInvalid`）→ 保留旧 meta +
    toast 明示不阻断主库；下载失败/仓库未提供（null）→ 静默保留旧 meta（防 Web 侧未落地期间误报）。
    `Result` 增 `metaChanged/metaInvalid` 两默认参数；新增 `metaText()` 读 filesDir 副本。
  - 内容 hash 校验：下载通道仍不带 hash（GitHub contents 无内容哈希，Web sync-manifest.json 落地后再挂）；
    **本地批次见证已补位（AIbot 三轮 P1）**——apply 末位写 stamp.json 三重见证（`meta` 布尔 + `radioHash`/
    `metaHash` = SHA-256 内容哈希），`stampHashOk()` boot 核对当前 filesDir 两文件与 stamp 记录一致，
    任一写失败残留的「新文件 + 旧 stamp」由哈希核对拦下（meta 写失败同批删旧件、radio 写失败整体失败）。
    B2/早期旧 stamp 无哈希字段 → 保守不绑定（同既有拍板）。
- **测试面**：`QualityAggregateTest`（四档/聚合计数/lastObservedAt/分流/trim/坏件/往返/源封顶）、
  `SyncCandidateTest`（归一化/三层去重/同名合并/来源保留/行序）、`LightUpdateTest` 增 meta 四例 +
  批次提交协议三例（AIbot 三轮 P1：meta 写失败注入→删旧件/见证失效、新 radio 配残留旧 stamp 哈希拦截、
  旧 stamp 无哈希保守不绑定）；
  `capBytes` 构造注入令 trim 测试不必造 2MB 数据。

---

## B3 API 面（r4 扩展契约·Android 侧，2026-11-15，plan-expansion-r4 §7）

> B3 独立发布单元（可单独回滚）：元数据管线 / 收听统计 / 本地发现三个 feature flag 全默认关，
> 门槛（§7.4 双端黄金样本全绿）过后才翻 true。开关不新增 `radio.*` 键；关闭任一开关不清数据、
> 不影响主列表/播放/健康/QualityStore/备份 v3 主流程。语义源 = `contracts/metadata-event.json`
> + `contracts/fixtures/metadata-golden.json`（双端逐字段硬验收），冲突以 plan-expansion-r4 §7 为准。

- **`FeatureFlags`（根包 `FeatureFlags.kt`）**：`const val METADATA_V2/LISTEN_STATS/DISCOVERY = false`
  ——由版本发布配置提供默认值；开发构建可临时改 true 自测，发布默认关。
- **`model/MetadataEvent.kt`**：`data class MetadataEvent(stationIdentityUrl, title, artist, track,
  program, bitrateKbps, source, at, confidence)`——契约 event 节九字段；`Confidence.PARSED/STREAM`。
- **`metadata/MetadataNormalizer.kt`（纯 JVM）**：
  ```kotlin
  object MetadataNormalizer {
    fun parseIcyTitle(rawTitle: String?, stationName: String = ""): IcyParts   // 空白清理(JS \s 同集含全角空格) +
    fun normalize(raw: IcyRaw, ctx: IcyCtx, now: Long): MetadataEvent          // 半/全角连接号分隔 + 重复台名前缀只剥一层
    fun isDuplicate(prev: MetadataEvent?, next: MetadataEvent, windowMs = 30_000L): Boolean   // 同名 30s 窗
    data class IcyRaw(title, program, bitrateKbps, source = "none", at = 0)   // at<=0 回退 now；source 空回退 none
    data class IcyCtx(identityUrl, stationName)
  }
  ```
  黄金样本 `fixtures/metadata-golden.json` 全 case 逐字段断言在 `MetadataNormalizerTest`。
- **`MetadataPipeline`（同文件，纯 JVM；AIbot P1-2 起 v2 专用）**：eventOrder 固定序的状态机——
  `State(station, last, display)` / `accept(s, ev): Pair<State, Decision>` /
  `reset(s, station)`；Decision = `Drop | Show(title) | +Archive(u0, 被替换旧曲)`。
  空曲讯 Drop 不覆盖；`stationIdentityUrl` 不匹配（串台/旧世代）Drop；`at < last.at`（迟到）Drop；
  同曲去重（连续同名 + 30s 窗）；换曲 Archive 旧曲——v2 入史窗口簿记 `State.hist`
  （同名 30s 内已入史不再入，A-B-A-B 抖动防重复刷史，Web mpHistDecide 同语义）。
  切台/刷新/全部失败先 reset（PlayerHolder ui 的 CONNECTING+空 song / 清台形态驱动，AppVm.mapMetaReset）。
- **`LegacyMetadataSink`（同文件；flag 关闭时 AppVm 专用独立分支，AIbot P1-2——不再借道管线）**：
  feat/r4-b2 PlayerHolder ICY 段语义原样（仅事件源改为契约 MetadataEvent）：`accept(u0, ev)`——
  空曲讯不动作（发射侧已拦）/ 连续同名去重（`last` = B2 lastSong 等价物）/ 换歌先 `show(t)`
  （= PlayerHolder.setSong：ui.song + MediaSession）再 `archive(u0, old)`（old 空不归档，radio.songs
  键=台主 URL 格式不变）；切台/刷新/全部失败 `reset()` 清 last（mapMetaReset 随行调用，旧世代不串台）。
  footer/icy-br 不经本类（IcyHeaders 路径 B2 起未动）。Web 侧对应 `metaSinkLegacy`（管线 dedup30s=false，
  换歌一律入史——无 30s 窗，B2 前语义）。
- **PlayerHolder B3 改造**：`onSong` 回调移除，改 `var onMetadata: ((MetadataEvent) -> Unit)?`
  ——ICY 只产事件（`MetadataNormalizer.normalize` 后回调，`IcyHeaders` 只更新 `ui.kbps` 与事件随行
  `lastKbps`），世代令牌在发射侧验；播放层不碰 radio.songs/统计（模块边界）。消费在 AppVm 两 sink：
  **LegacyMetadataSink**（flag 关）= 现状（setSong 路径的当前曲讯/MediaSession + lib.pushSong 入史，
  格式不变）；**MetadataV2Sink**（flag 开）= 同路径 + 30s 去重 + `AppVm.curMetadata`
  （规范化事件 StateFlow，供统计/发现派生）。两者不得同时写历史（flag 单选接线）。
  `source` 严格枚举 icy|none（AIbot P2-5）：非法来源字符串 normalize 归一为 none（契约 event.source 措辞已收紧）。
- **`stats/ListenStats.kt`（纯 JVM）**：
  ```kotlin
  object ListenStats {
    fun enter(state, u0, cat, wallNow)                       // sessions 只在「新建流 PLAYING」+1（与质量采样同锚）
    fun add(state, session, nowMono, nowWall): StatsState     // 增量入账：mono 回拨重锚钳 0；跨午夜按 wall 占比拆两日
    fun trim(state, keepDays = 90, maxBytes = 512KB, measure 注入): StatsState   // 90 天 + 512KB 先删最早日
    fun summary(state, days = 7): StatsSummary
  }
  class ListenTracker(mono, wall, initial)                   // 状态机（fake clock 双注入）：onState(PState/台/源URL)、
                                                             // settle() 收账（≥1s 才入账，Web tickMin 同款）、
                                                             // pending（未确认增量在账）/flush(sidecar)（AIbot 复核 P1）
  class ListenSidecar(dir, writeFn 注入) { load()/save(): Boolean }   // 坏文件空库恢复；写失败回执 false（增量保内存重试）
  ```
  会话语义（双端冻结；AIbot P2-6 起 plan §7.2 已同步同文）：**只在「新建流到达 PLAYING」建立 session**
  （play/切台/切源/重连首达，sessions+1）——精确定义：session = 从非 PLAYING 进入 PLAYING 且不属于
  「同一台同一源」的暂停恢复；**暂停关账但保留 resume 资格**——续播同台同源重锚不开新 session
  （暂停时长绝不计入：暂停期无会话，tick 不产账）；连接中/失败（善后 IDLE+清台映射）/停机彻底关。
  日期键历法严格校验（AIbot P1-1）：`ListenStats.validDay`（YYYY-MM-DD 且月/日真实存在，02-31/13-01/
  非闰 02-29 拒绝）——`ListenStatsCodec.parse` 坏键丢弃、`bucket` 坏键不入账（Web lsDayKeyOk 同规则，
  /api/listenstats schema 校验同源）。Android 无「他页复测对账」路径（单进程），
  复活记录只走体检通道。sidecar `filesDir/listen-stats.json`：`{v:1, days:{yyyy-MM-dd:{ms, stations{u0:ms},
  categories{cat:ms}, sessions}}}`（days 部分与 Web 同构；Web HTTP 侧 AIbot P1-3 起 /api/listenstats 升级
  ops+op.id 幂等增量合并——多标签同 base 各自 POST 不同增量不互相覆盖；AIbot 复核 P2 起 GET ?rev= 条件获取
  （命中回 notModified，BC 重拉零全量传输）、P1 起 409 响应带机器可读 code（schema 丢批留痕/batch-limit 收窄
  批宽重试），契约描述 `contracts/listen-stats-summary.json`——Android 单进程 filesDir 不受影响）
  ——不进 radio.* 主 Store/2MB 配额/
  备份 v3 默认导出；flush = 30s tick + MainActivity.onStop；**落盘确认模型（AIbot 复核 P1，§7.2「写失败只保留
  内存增量并在下次 flush/启动重试」）**：tracker 持确认快照（最近一次成功落盘），flush 只在有未确认增量时写、
  写成功才推进确认——失败增量保留内存，下次 flush 快照覆盖一次写入全部（不重放不双计，幂等）；**启动重试
  （AIbot 三轮 P1）**：写失败同时把含未确认增量的快照落独立临时文件 `filesDir/listen-stats.pending.json`
  （tmp+rename、IO 线程 flush 内 best-effort 不碰播放线程），进程重启 `ListenTracker.restore` 以主快照为
  确认基线、pending 经 `ListenStats.merge`（日键并集/数值取大）幂等合流入账——增量转入待确认走既有 flush
  链路，成功写主快照后原子清理 pending（残留/清理失败由合流幂等消化不双计，坏 pending 丢弃按主快照冷启）；
  开关关不消费不 flush 不清数据。
- **`discovery/Discovery.kt`（纯 JVM）**：`build(DiscoveryInput): Groups` 六分组（精选/稳定直连/最近新增/
  最近恢复/有曲讯/未听过）+ `noQualityData` 名单（不进质量分组的无记录台，UI 在「稳定直连」组头显示
  「另有 N 台暂无质量数据」提示行，不单列分组）；规则：过滤 hidden/隐藏分类（无例外）/dead（正在播·
  连接中例外 = visible 同口径）；无质量记录不进质量分组、不误判 poor；稳定直连 = good 且 directCount>0；
  有曲讯 = metadata==icy；最近新增 = radio-meta.firstSeenAt（**挂 sources[] 为主、台级直挂容错、取最早**，
  `MetaStation.firstSeenAt` 旁挂字段；无 meta 组空；AIbot P1-4 混态拦截——消费前须过 `RadioMeta.bound`
  同批绑定校验：filesDir/assets 来源配对 + stamp.json 三重见证 = `meta` 布尔 + `radioHash`/`metaHash`
  内容哈希（AIbot 三轮 P1：LightUpdate.apply 批次提交协议——stamp 末位写，radio 写失败整体失败、
  meta 写失败删旧件且不记见证，「新文件 + 残留旧 stamp」由哈希核对拦下；SyncEngine 端内同步后删 meta+
  写 meta=false+radioHash；B2/早期旧 stamp 无字段或无哈希一律按混态保守不绑定），
  不绑定整组置空不猜，其余分组不受影响）；最近恢复 = `RecoveryLog`（dead→alive 转移 Map +
  `Prefs.RECOVERED` 运行时缓存 7 天过期，键非 radio.*；同步重建不产生记录——只有体检通道 wasDead→ok 才记）；
  未听过 = 不在 radio.recents；精选 = `Station.starter`（originMask 位，双端口径 = **STARTER URL 命中或
  精确同名**：Library.reload 装配时打，URL 命中只打标记不动装配，运行时不持久化、不按 u[0] 现场比对）；
  排序 = 组内时间降序（新增用 firstSeenAt 其余 lastObservedAt）+ identityUrl 字典序；每组 ≤20；同台可跨组。
  UI：StationList「✦ 发现」入口（开关关隐藏）+ `DiscoverySheet` 简单列表浮层（AppVm.discovery StateFlow
  派生，stamp 哨兵驱动）；点击走 `AppVm.startPlay` 既有通道。
- **测试面**：`MetadataNormalizerTest`（黄金样本逐字段 + 连接号/空白/前缀/去重边界）、
  `MetadataEventTest`（事件形态 + 管线固定序：空曲讯/迟到/串台/去重/入史/reset/v2 入史窗去重）、
  `ListenStatsTest`（fake clock 全矩阵：播放/暂停/续播重锚/连接中/失败/切源/切台/跨午夜/双回拨/
  1s 阈值/90 天/512KB/幂等/写失败/连续写失败→成功增量完整不重复计数（AIbot 复核 P1 确认快照模型）/
  写失败→pending 落盘→重启恢复不丢不双计→成功清理（AIbot 三轮 P1 启动重试，ListenSidecar.pending/
  ListenStats.merge/ListenTracker.restore）/
  坏件/summary）、`DiscoveryTest`（六分组矩阵 + originMask
  装配打点（同名/URL 命中）+ starter 位不参与 equals）。全量 251 用例离线秒级。
