# VRadio 安卓版立项调研与落地框架

> 2026-10-14 首版，供 owner review。既有拍板引用：移动端方向已定「单独的安卓原生 app，不走 Web 响应式/PWA」（owner 拍板 2026-10-12，docs/roadmap-research.md D5 + README roadmap）；docs/roadmap-research-r2.md 十「安卓原生 app」已给形态锚点（数据管线可复用、无 CORS、代理层消失、checkStream 字节验收平移）。本文档把形态锚点落成可执行方案；**2026-10-14 grill 问答轮已对 D1-D12 + D11-R2 全部拍板（第八节决策记录）**。

## 一、定位

- **产品**：VRadio 安卓版 = 独立 APK，国内电台为主的网络电台播放器，与 Web 版**数据同源、格式互通、代码不共享**（Web 五文件 JS 不进安卓包）。
- **分工**：Web 版继续做「本机全功能形态」（同步引擎在 PC 跑、维护面板全量编辑）；安卓版做「移动收听形态」（播放/浏览/收藏/体检为主，重编辑后置）。
- **非目标**：iOS（远期不承诺，仅数据格式层面不设限）；Play Store 上架（渠道决策见 D4）；账号/云同步（与「本地优先」公理冲突）。

## 二、现状盘点（立项信息收集产出）

### 2.1 代码资产与安卓侧去向

| Web 文件 | 行数 | 职责 | 安卓侧去向 |
|---|---|---|---|
| app.js | 1289 | 列表/搜索/分类/收藏/双视图/维护面板/导入导出/曲讯轮询 | 语义平移到 Compose UI；维护面板**编辑**后置、**数据层全兼容**（见 5.2） |
| player.js | 304 | 三级播放策略/断流自愈/成功源记忆/MediaSession/睡眠定时/每台音量 | 语义平移到 Media3 封装（决策链保留、三级塌缩为一级，见 5.3） |
| logos.js | 112 | 台标三级来源/缓存/收藏+正在播优先 | 平移（HttpURLConnection 直取，无 CORS） |
| store.js | 99 | 13 键白名单/服务端仲裁/多标签广播 | **大幅简化**：单进程无仲裁无广播，键与格式原样（见 2.3） |
| sync.js | 167 | 同步/体检编排（四通道） | 平移（体检 M3 进、同步 M4 进） |
| server.js | 308 | 静态+代理+五 API+安全护栏 | **整体消失**（无监听端口），端点逐条映射见 2.4 |
| update-sources.js | 429 | 同步引擎（双上游/classifyCn/欧美实测/护栏） | M4 移植核心到 Kotlin（classifyCn 语义照抄、护栏瘦身） |
| index.html + hls.min.js | 352+2 | 结构壳/样式/本地化 hls.js | 重写为 Compose；**hls.min.js 不进包**（原生 HLS） |
| test/smoke.js | 171 | 零依赖离线冒烟 | 对应物 = Gradle 单测（解析器/classifyCn 平价测试），秒级离线口径不变 |

（行数 = 2026-10-14 `fix/audit-r4` 批次后口径——第四轮审计在本文档撰写期间落地（app.js +38 等），初版数字为旧快照，review 轮已核正。）

### 2.2 数据资产（直接复用，这是立项的底气）

- `radio.txt`：1655 行 / 120KB / 9 分类 / ~1646 条电台行（含多源行）。纯文本行协议（`分类,#genre#` + `台名,URL`），APK assets 直接打包。
- `logos.txt`：10KB，`分类|台名,图片URL` 行格式，随行打包。
- `my-radio.txt` 行格式、四个导出物格式（见 2.3）全部沿用。
- APK 体积预估 4-6MB（无 hls.min.js 的 415KB、无原生库、全 dex+资源；验收哨兵与调节条款见 M5，review 二轮 R1 统一口径）。

### 2.3 存储与互通（Web↔安卓迁移是硬要求）

- 13 个白名单键原样沿用：`radio.favs / recents / health / cfg / songs / volperst / srcmem2 / vol / view / showdead / theme / baseline / baselineProg`。
- 安卓落点 `filesDir/store.json`，键名与值格式（JSON 字符串）与 Web 完全一致；**没有** rev 发号、dirty 标记、BroadcastChannel 对账、多标签防双播——单进程，这些问题不存在（Web 端 store.js 最复杂的 40% 在安卓上天然消失）。
- **互通通道 = 既有 `vradio-backup.json`**（`{v:1, at, data:{键:值}}`，app.js exportAll/importAll）：安卓侧实现同格式导入导出，Web 导出的备份安卓可直接吃，反之亦然。另有 m3u 收藏导出（外部播放器可读）、songs txt、config json 三件套格式保持。

### 2.4 server.js 端点 → 安卓承接映射（核心简化表）

| Web 端点/机制 | 职责 | 安卓承接 |
|---|---|---|
| 静态服务 | 前端资源 + dotfile/`.bak` 拦截 | assets + Compose，无文件服务 |
| `/proxy?url=` | CORS 绕行 + 分片重写 | **不需要**（原生 HTTP 无 CORS 概念；央广 ngcdn 直连即播） |
| `/api/nowplaying` | ICY 旁路会话/keep-open/15s 轮询/并发封顶/icy-br | **Media3 原生**：`IcyInfo`(曲名) + `IcyHeaders`(台名/genre/**bitrate**) 经 `onMetadata` 推流，轮询与并发管理整个消失 |
| `/api/check?url=` | 探活（≤4 源） | Kotlin 探针，checkStream「持续吐字节 ≥ 阈值」验收纪律照抄（xmcdn 假流免疫的唯一资产） |
| `/api/mystation` | 添加电台（探活先行+原子写） | filesDir/my-radio.txt 本地写（探活先行口径不变） |
| `/api/sync` | 拉上游+classifyCn+欧美实测+diff | M4 端内同步模块：**照抄 ghFile 主路径**（api.github.com + `Accept: vnd.github.raw` 直取；gh CLI 回退在端上不存在 → 失败明示不静默）；**不引入 raw.githubusercontent.com**（国内不稳 + 投毒前科，review Q7）；匿名 60 次/时对单用户足够 |
| `/api/store` | GET/POST 全量 + rev 发号 | filesDir 直读写，无仲裁 |
| 安全护栏（safeTarget/guardLookup/Origin/Host 白名单） | SSRF/CSRF 防护 | **对象消失**（无监听端口、无浏览器跨源）；「流地址=不可信输入」的验收纪律保留 |

## 三、技术路线调研（2026-10 现势）

### 3.1 候选对比

| 路线 | 前端复用 | 播放/后台 | 工作量 | 理念契合 | 长期演进（widget/Auto） | 结论 |
|---|---|---|---|---|---|---|
| **A 原生 Kotlin + Compose + Media3** | 无（UI 重写 ~3-4k 行 Kotlin） | **一等公民**（MediaSessionService/通知/锁屏/ICY/HLS 原生） | 高但可分阶段 | 好（依赖白名单纪律可守） | 顺 | **推荐** |
| B WebView 混合壳（复用 Web UI + 原生桥） | ~95% | 差：WebView 音频按 Home 即停，须 FGS + 手工 JS→MediaSession 桥（WebView 不向原生暴露媒体元数据） | 低（1 周可播 demo） | 差（双世界桥维护） | 需桥 | 仅作 spike 备选，不当主线 |
| C Tauri 2 mobile | 同 B | 同 B（system WebView）+ Rust 工具链 | 中 | 差（引入 Rust 链） | 需桥 | 否 |
| D Capacitor 8 | 同 B | 同 B + 插件生态 | 中 | 差（npm 生态与零依赖理念正面冲突） | 需插件 | 否 |
| E nodejs-mobile（server.js 整体搬进 app） | 100% | 同 B | 中 | — | — | 否（原维护方 JaneaSystems 已弃坑，社区 fork Node 版本滞后） |
| F PWA/响应式 | 100% | 浏览器形态 | 低 | — | — | **owner 已拍板否**（移动场景访问不到 localhost；SW 受非 secure context 限制） |
| G fork RadioDroid | — | — | — | — | — | **只参照不抄码**：GPL-3.0 与本仓 MIT 不兼容，架构可借鉴（ExoPlayer+radio-browser 生态同型产品） |

### 3.2 决定性的调研事实

1. **Media3 1.11.1（2026-09 stable，Kotlin 2.2）ICY 原生支持**：`IcyHeaders`（name/genre/url/bitrate-kbps）+ `IcyInfo`（title/url）经 `onMetadata` 推送——Web 端 B-6/B-7 曲讯链路（旁路会话、keep-open、15s 轮询、并发封顶 2、noIcy 负缓存）在安卓上**整体消失**，且码率随帧可得。
2. **WebView 后台音频不可靠是实锤**：按 Home 后短时即停，救法 = mediaPlayback 前台服务 + 注入 JS 把播放态转发给原生 MediaSession。B 路线播放层照样要写一套原生代码加一层桥——省不掉最难的部分。
3. **ICY 非标状态行坑**：Icecast 服务器回 `ICY 200 OK`（非 HTTP 标准），Media3 的 DefaultHttpDataSource（HttpURLConnection 系）解不了，官方 troubleshooting 推荐 okhttp DataSource。这是依赖白名单唯一建议破例的点（D6）。
4. **前台服务现行要求（Android 14/15+）**：`FOREGROUND_SERVICE_MEDIA_PLAYBACK` 权限 + `foregroundServiceType="mediaPlayback"` + `POST_NOTIFICATIONS`（13+ 运行时权限，未授权则通知不显但播放仍活）+ 须前台启动。Media3 `MediaSessionService` 内建处理。
5. **AndroidX 自 2026-07 起多库 minSdk 24 起步**——minSdk 决策见 D3。
6. **断流恢复模式**：`onPlayerError` → `player.prepare()` 重试 + `LoadErrorHandlingPolicy` 定制重试节奏 + 网络恢复重触发；**跨 URL 的变体顺延没有库级方案**，与 Web 端一样是应用层逻辑（决策链设计可平移，这恰好是本项目已沉淀的资产）。

### 3.3 D1 专项深挖：原生 vs 混合壳（owner 三轮追问，2026-10-14）

「混合壳」不是一个方案，按**音频引擎归属**拆三种形态分别裁决：

- **B1 纯 WebView（连音频一起播，player.js 原样跑）——三事实判死**：
  ① **Media Session API 在 WebView 被官方禁用**（Chromium [40765779](https://issues.chromium.org/issues/40765779) / [w3c/mediasession#337](https://github.com/w3c/mediasession/issues/337)：WebView 无法桥接系统 MediaSession 框架，故整体关闭）——player.js 的锁屏/MediaSession/⏮⏭ 投资在 WebView 里**归零**，锁屏控制照样要原生重建 + 手工桥；
  ② **WebView `<audio>` 自动抢音频焦点且行为不可控**（[SO 75698156](https://stackoverflow.com/questions/75698156/android-webview-transient-audio-focus)、Chromium [40946745](https://issues.chromium.org/issues/40946745)；Android 12+ 连 `android.audio-focus.disabled` 开关都失效，见 [Jitsi #13803](https://github.com/jitsi/jitsi-meet/issues/13803)）——来电/导航播报后的暂停与恢复行为不一致，对电台 app 是核心 UX 缺陷；
  ③ **hls.js 在后台 WebView 数小时后冻结**（[SO 73271339](https://stackoverflow.com/questions/73271339/why-does-my-android-webview-app-with-a-hls-js-video-player-freezes-after-3-4-hou)：JS 定时器后台节流致分片拉取停摆）——央广系全 m3u8 全走 hls.js，恰好命中「睡前收听数小时 + 睡眠定时」这一本项目明示的目标场景。
  另计：Chromium 渲染器 + MSE JS 管线整夜存活的电量差、国产 ROM 对后台 WebView 的冻结。
- **B2 WebView UI + 原生播放桥——省不掉的部分比账面更多**：桥面约 15-20 个方法 × 各自的生命周期/竞态边角（世代令牌防串台在异步边界重现）；**决策链归属两难**：留在 JS 侧 → WebView 被冻结时后台断流自愈断线；移到 Kotlin 侧 → WebView 退化成纯终端，player.js「播放态唯一所有者」契约跨运行时撕裂，srcMenu/prefer/forgetSrc 每次 UI 交互都过桥；通知栏台名/台标要服务端可取 → 数据访问双份。B2 的终局演化形态 = 写完 A 的全部原生核心，再额外背一个 WebView 和一座桥。前期成本约为 A 的 50-60%，但含**永久性双运行时维护税**与更低的产品上限。
- **C 原生核心 + 局部 WebView 岛——留作后手不作主线**：适用「低频重编辑屏」（如未来的维护面板）以**无状态快照**形态嵌入（配置 JSON 进、结果 JSON 出，不共享活状态——避开 B2 的活状态桥问题）；v1 不需要（D2 已裁剪 + 引导桌面 Web 处理）。

**D1 决策推论链（顺序不能乱）**：① 播放引擎必须原生（B1 三事实）；② 播放决策链/断流自愈必须与引擎同侧（跨异步边界的自愈不可靠）→ 核心必然原生；③ 此时 UI 选 WebView 的残余收益只剩「省 Compose 工作量」一项，代价是桥税 + 双运行时 + 移动手感天花板 → **UI 也原生**。strangler 渐进迁移（先壳后抽原生）不适用：混合→原生的迁移边界恰好切在状态最热的播放状态机上，后拆等于把桥重写两遍。

## 四、推荐路线：A（原生 Kotlin + Compose + Media3）

- **播放是电台 app 的生死线**：安卓上 Media3 把 Web 端最重的三块（代理层/曲讯旁路/三级策略）变成平台一等公民能力——r2 调研原话「本项目最复杂的部分在安卓上恰好消失」，本次调研逐条证实。
- **UI 重写成本真实存在**，但：① v1 范围可裁（重编辑后置）；② Web 端 ui-audit 的移动端打磨经验（触屏文案可见性、命中区 ≥44px、低频操作收纳）直接指导 Compose 设计，不是从零认知。
- **理念翻译**：Web「零依赖无构建」→ 安卓「依赖白名单**封闭清单制**（review Q3/Q10，新增一律先议事）」：compose-bom / material3 / activity-compose / androidx.core-ktx / media3-exoplayer / media3-exoplayer-hls / media3-session / media3-datasource-okhttp（okhttp 传递引入，D6）/ kotlinx-coroutines-android（Q3 收编——协程必用，不收编即第二次破例）；Kotlin stdlib 与 Gradle 插件不计；不引 lifecycle-runtime-compose/Hilt/Retrofit/Room/navigation-compose（两三级页面手写状态）；JSON 用内置 org.json；台标加载手写（HttpURLConnection + BitmapFactory + LruCache，台标 40~200px 小图且只有「收藏+正在播」才取，量级不需要 Coil）。
- **长期演进**：桌面 widget、Android Auto、穿戴只有原生路径是顺路。
- B 路线（混合壳）保留为「一周内出可播 demo」的验证通道记录在案，不投资主线。

## 五、架构落地框架

### 5.1 工程形态

- **monorepo**：本仓 `android/` 子目录（D9 拍板项，论证见下）。radio.txt/logos.txt 由 update-sources.js 产出、两侧共同消费（数据单一来源；安卓 build 从仓库根拷贝进 assets，Gradle task 化）。
- **仓库形态（D9）论证要点**：① 契约耦合是主要矛盾——radio.txt 格式、13 个 radio.* 键、backup 格式、cfg 语义的变更在本项目当前阶段并不低频（r2 批次即新增 volperst/srcmem2/baseline 系键），同仓才能一个 PR 原子更新 update-sources.js + store.js KEYS + server.js STORE_KEYS + 安卓解析器，双仓则把 AGENTS.md「⚠ 必须同步扩」警告块所防御的「改了这头忘那头」类 bug 结构性放大；② 跨端任务（加持久键、改行协议、backup 互通回归）单检出完成，AI 会话无需跨仓上下文，android 会话天然读到同文件里的 Web 契约节；③ 「零依赖无构建」是 Web 产品的属性，不因自包含的 android/ 子目录存在而被破坏（根目录只新增 README/AGENTS 条目与 .gitignore 数行）；④ F-Droid 官方支持 `subdir:` 子目录构建，发布渠道不为仓库形态设限；⑤ **可逆性不对称**：`git filter-repo --subdirectory-filter android/` 可带完整历史拆出，合并则是难向门——先 monorepo 保留了低成本拆分期权。**重新评估拆分的触发条件**：安卓成长为主产品需要独立社区/star/issue 流；换维护者；F-Droid 可复现构建对 monorepo 内二进制（gradle-wrapper.jar）产生实际摩擦；Web 侧明确提出仓库纯净诉求。
- Gradle Kotlin DSL、单 module、无 flavor；`gradle` CLI 全程可跑（无 IDE 依赖，适配单人+AI 工作流；CI 后补 GitHub Actions）。
- 版本基线（2026-10，scaffold 时锁定）：Media3 1.11.1、Kotlin 2.2 系、AGP 8.x、compileSdk/targetSdk 取当时 stable。
- minSdk 建议 26（Android 8，国产 ROM 底线；Media3 最低 24，留两档余量）。

### 5.2 模块划分（对应 Web 五文件精神的分层）

```
android/app/src/main/java/…/
  data/    RadioTxt 解析（行协议取前两字段、3+ 字段容错跳过——回听等未来列扩展免疫，A2）/ Store（13 键 filesDir JSON，tmp+rename 原子写——进程写一半被杀不丢收藏，照抄 server.js 纪律，A3）/ MyRadio / Logos / Cfg（applyCfg 维护层套用）
  player/  RadioPlayer：ExoPlayer 封装 + MediaSessionService
  ui/      Compose：列表(网格/单列)/搜索/分类条/收藏/最近/播放条/选源浮层/歌曲历史（播放条曲名 → bottom sheet，D2 加码）/设置
  check/   体检执行器（字节验收四常数钉死、与 update-sources.js:128-145 同口径：非 HLS ≥8000B / HLS 分片 ≥6000B / 拒 text/html / 4.5s 窗（添加电台 12s），A4；分档/TTL/FIFO 同语义）
  sync/    (M4) GitHub 直拉（同 2.4 口径）+ classifyCn 移植 + diff 摘要
```

- **身份公理照抄**：URL = 持久身份，名字 = 显示层；收藏/最近/srcmem/健康标记按源 URL 回绑，带 URL 休眠条目永不回收。
- **cfg 数据层全兼容、编辑面板后置**：Web 导出的 backup 含 radio.cfg（移动/重命名/隐藏/追加源），安卓 v1 数据层就要按「任一源 URL 命中」套用（渲染期逻辑，无编辑 UI 成本可控）——否则会造成「Web 配置在安卓静默失效」。追加源同样只挂台尾不动 `s.u[0]` 身份键。
- 台标三级来源照抄：STARTER 内置（精选层随包）→ logos.txt → 运行时解析（蜻蜓频道页封面/Radio Browser byurl，仅收藏+正在播）。运行时缓存落 `filesDir/logos-cache.json`（与 Web 侧 `radio.logos` 同语义：可重建、不入 13 键主源）。
- 口径细目（review A9/A14/A17/A19）：网络超时等全部常数集中一处定义、与 Web 侧常数注释对照（防双端漂移）；数据更新/同步/探活的网络失败一律明示 toast 不静默降级；v1 双主题照抄 `radio.theme` 语义、不做 Material You 动态取色、竖屏为主横屏不崩即可；通知权限首播时申请不在 boot 弹。

### 5.3 播放机制映射表（player.js 语义 → Media3）

| Web 机制 | 安卓机制 |
|---|---|
| 三级策略：直流 mp3/AAC → hls.js 直连 → /proxy 兜底 | ExoPlayer 统一吃（HlsMediaSource/ProgressiveMediaSource 自动识别），**三级塌缩为一级**；央广 ngcdn 直连即播 |
| 蜻蜓 `ls.qingting.fm/live/{id}.m3u8` → 同 id 64k mp3 换算 | 数据层换算规则照抄 |
| 多源变体 + 级联顺延 + 成功源记忆 srcmem2（FIFO 300） | 同语义应用层逻辑（Media3 无跨 URL fallback）；决策链顺序不变：手动 prefer > srcmem2 > 启发式 srcOrder > 顺延 |
| 断流自愈（error 级联 + 12s watchdog + ended 自愈，先重连当前源再顺延） | `onPlayerError`/`onPlaybackStateChanged` 超时看护 + `LoadErrorHandlingPolicy` + ConnectivityManager 网络恢复重触发；「先重连当前源一次再顺延」节奏保留 |
| MediaSession（台名+曲讯+台标 artwork+⏮⏭ 收藏切台） | MediaSessionService 原生（通知/锁屏/耳机线控），⏮⏭ 接 stepFav 同语义 |
| 曲讯 15s 轮询 + icy-br 旁路 | `onMetadata` 推流（IcyInfo 曲名入 radio.songs 历史，IcyHeaders.bitrate 显 kbps；国内 m3u8 台无 ICY 显示为空的口径不变）；**入史去重照抄 Web（`list[0].t !== title` 才入史、每台 12 首封顶，app.js:622 同款——onMetadata 推流频率高于 Web 15s 轮询，漏了灌爆 radio.songs，A6）** |
| 每台音量 volperst + 静音态切台保持 | ExoPlayer.volume(0..1) 同语义，键沿用 |
| 睡眠定时（淡出） | 平移（Handler/协程定时 + 音量渐降） |
| 多标签防双播（BroadcastChannel） | N/A（单进程）；音频焦点抢占由 Media3 自动处理 |

### 5.4 权限与清单

- `INTERNET` + `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` + `POST_NOTIFICATIONS`（13+ 运行时申请，拒绝不阻断播放）。
- `android:allowBackup="false"`（本地优先公理：数据导出只走 SAF 显式通道，不做系统自动云备，A5）。
- `android:usesCleartextTraffic="true"`：绝大多数国内电台流是 http://，不做域名例外清单（明示：等价于 Web 版现状，接受运营商 QoS/劫持的既有边界）。
- 无存储/定位/电话权限；my-radio/store 走应用私有目录 + SAF 文件选择器（导入导出）。

### 5.5 安全面变化

- 监听端口消失 → SSRF/CSRF/Host/dotfile 护栏的对象不复存在（护栏与 test/smoke.js 矩阵留在 Web 侧不动）。
- 保留的纪律：流地址=不可信输入（字节级验收才认活）；探活/同步仅直连 api.github.com（与 2.4 同口径，**不引入 raw.githubusercontent.com**，review 二轮 R2）；台标 URL 只作图片加载不执行任何内容。
- 分发即信任边界：直装 APK + GitHub Releases（Release 附 hash）；不起 Play Protect 依赖。

## 六、里程碑（每段可独立验收，段间可停）

| 阶段 | 内容 | 验收标准 | 粗估人日（AI 辅助口径） |
|---|---|---|---|
| M-1 环境闸口（review Q1/Q8） | JDK 17 Temurin（清华 Adoptium 镜像，不追 21）/ cmdline-tools（dl.google.com 直达）/ sdkmanager platform-tools+platforms+build-tools（版本 scaffold 时钉死）/ gradle wrapper（distributionUrl 走腾讯镜像）/ settings.gradle.kts 仓库序 Aliyun google/central 镜像优先、官方源兜底 / android/README.md 环境节固化以上（换机照抄） | **干净检出起 gradle CLI 全链路可跑**（CI 干净环境验证由 M0 建立后持续生效——review 二轮 N1，闸口期不以尚不存在的东西验收）；空壳 APK 在 OV 实机装起；**3-4 周工期自此起算** | 0.5-1 |
| M-1.5 Media3 spike（review A11，可并入 M-1） | 一个 mp3 直流起播 + 通知栏亮出（Media3 最小闭环） | 通知可点暂停/恢复；消化 Media3 学习曲线——工期估算的最大不确定源前置 | 0.5 |
| M0 脚手架+数据 | Gradle 工程/assets 打包/radio.txt 解析/列表+搜索+分类+双主题/**最小 CI**（GitHub Actions：gradlew test + assembleDebug，path filter `android/**`——Web 提交不烧安卓 CI，review Q5/A12：本机镜像环境「能编」不作数，CI 是唯一干净环境验证） | 冷启动 <1s 出全库 1646 行列表；飞行模式可浏览；APK 跑通 minSdk 26 实机；CI 绿 | 2-3 |
| M1 播放核心 | ExoPlayer+MediaSessionService+决策链+断流自愈+ICY | 直流/HLS/蜻蜓/央广 ngcdn 四形态各实测 ≥1 台；后台 30 分钟+锁屏控制+通知；断网自愈；ICY 曲讯+kbps；多源顺延+srcmem 记忆；**喜马拉雅样本台字节验收**；后台/锁屏以 OV 实机验收（D12）；**音频焦点四场景（review Q6/Q11——判死 B1 的理由之二必须在主线验收单上）**：来电/导航播报/其它播放器起播/蓝牙断连（becoming noisy 暂停），transient 暂停 · can_duck 降音量 · 永久丢失停止，全用 Media3 默认行为不自研；OV 实机全做、模拟器做来电+播放器两项 | 4-6 |
| M2 个人数据 | 收藏/最近/每台音量/睡眠定时/台标/歌曲历史视图+导出全部（D2 加码）/backup 导入导出 | **vradio-backup.json(v2，含 my-radio) 与 Web 版双向互通实测**（依赖 Web 先行小批，D11-R2）；**导入 v1 旧备份（无 my 字段）兼容不炸**（A1 矩阵的安卓收 v1 方向，review 二轮 R4）；m3u 导出外部播放器可读；cfg 数据层套用（Web 导出的移动/隐藏/追加源生效） | 4-6 |
| M3 韧性 | 手动体检+健康分档+无效源隐藏+自定义电台+boot 静默复查（收藏+最近，流量策略按 D10）+**数据轻更新通道（D7 修订版，review Q9）**：commits API 查 radio.txt/logos.txt 最后提交时间 vs BuildConfig 打包时刻判新旧、contents API 下载、filesDir 运行时副本优先（assets 只作首启种子） | 分档/TTL/FIFO 语义与 Web 一致；mystation 探活先行；死台「已停运」徽标；**安卓 v1 不跑首启全量基线**（几百个探活在移动端不现实）：全新安装的死台隐藏靠手动/boot 检查积累标记，导入 backup 携带的 health/baseline 标记直接生效；D7 成功反馈只报「已更新到 \<date\> · 台数 ±N」（A10）、更新后收藏/健康/srcmem 按 URL 回绑不失效（A16） | 3-4 |
| M4 端内同步 | GitHub 直拉+classifyCn 移植+diff 摘要+收藏点名 | **classifyCn 金样 fixture 100% 平价**（fixture 从 update-sources.js 抽出、提交为测试资源，review A15）+ 实跑对照 ≥95%；欧美重建节 WiFi-only 策略；diff+收藏台消失点名 | 4-6 |
| M5 发布 | 签名/R8 收缩/图标/splash/GitHub Releases | release APK <5MB（review Q4：**事故哨兵而非功能预算**——R8 忘开/资源误打包会爆线，合规基线实测 5-6MB 则调哨兵不砍功能）；Release 说明附国内加速下载指引（gh-proxy 类模板）+ **hash 置顶、先验后装**（A13）；keystore 生成即双备份（密码管理器 + 离线介质，**丢失 = 无法续签升级**，流程文档化） | 1-2 |

合计约 3-4 周净工作量（**自 M-1 闸口通过起算**，闸口+spike 前置约 1.5 天；D2 加码歌曲历史已体现在 M2 上调）。v1 明确**不做**：维护面板编辑 UI（数据层全兼容，重编辑引导桌面 Web）、快捷键帮助、多标签语义（单进程无此问题域）、回听（Web 远期 spike 项不随行，行协议 3+ 字段容错已免疫）；Web 端不受任何影响（并行开发，交点 = 数据文件格式 + D11-R2 的 Web 先行小批）。

## 七、风险清单

1. **ICY 200 OK 状态行**（3.2-3）：DefaultHttpDataSource 解析失败 → 引 media3-datasource-okhttp（推荐，D6）或自写 ~30 行 DataSource 兜底。
2. **xmcdn 假流**：字节级验收平移是硬要求，M1 验收含喜马拉雅样本；不能信状态码/Content-Type 的教训写进安卓探针注释。
3. **国产 ROM 后台查杀**：ColorOS 有 OV 系实机验收（D12）；MIUI/HyperOS 无实机、留社区反馈渠道——设置页「省电策略白名单」引导不分工况照做。
4. **蜻蜓建流 5-10s 慢**：连接态 UI 指示平移，防用户误判卡死。
5. **GPL 隔离**：RadioDroid 只可读不可抄；连 UI 布局思路都保持距离，防实质衍生。
6. **数据陈旧窗口**：M3 前随 APK 发版携带；**M3 起 D7 手动拉主仓成品**，窗口收敛到最后一次 `npm run sync` 提交（不再依赖发版频率，review 二轮 R3 跟上 D7 修订）；M4 起端内全量同步为重通道。
7. **AI 工作流×Android 工具链**：本机 java/gradle/Android SDK 全无（已实证）——**升格为 M-1 环境闸口（review Q1）**，含国内镜像策略（清华 JDK/腾讯 gradle dist/Aliyun maven/dl.google.com cmdline-tools），配置固化 android/README.md 换机照抄；gradle CLI 无 IDE 依赖仍是硬要求，CI 为唯一干净环境验证（Q5）。
8. **Web/安卓行为漂移**：决策链/分档/身份公理的语义以 AGENTS.md 为契约源，安卓实现偏差在 review 时对照本表 5.3 核查。

## 八、决策记录（2026-10-14 grill 问答轮全部拍板：D1-D12 + D11-R2）

| # | 决策 | 拍板 |
|---|---|---|
| D1 | 技术路线 | **A 原生主线**（Kotlin + Compose + Media3；依据 3.3 深挖）→ [ADR-0001](adr/0001-android-native-route.md) |
| D2 | v1 范围 | **裁剪维护面板编辑 UI；歌曲历史视图进 v1**（owner 加码档；cfg 数据层全兼容、歌曲数据随 backup 保留不变；安卓不跑首启基线，见 M3） |
| D3 | minSdk | **26**（Android 8；Media3 最低 24） |
| D4 | 发布渠道 | **直装 APK + GitHub Releases**（附 hash）；F-Droid/Play 后议不上 |
| D5 | 包名 | **io.github.vjoy233.vradio** |
| D6 | okhttp DataSource | **破例引入**（依赖白名单唯一例外；ICY 200 OK 非标状态行） |
| D7 | 轻更新通道 | **加**：设置页手动触发「检查数据更新」，不做启动自动检查。**通道模型 review 轮修订（2026-10-14）**：~~Releases 附件~~ → 仓库 main 直取（commits API 判新旧 + contents API 下载，与 M4 共用同一 GitHub 客户端；「发版才放数据」的控制点是幻觉——提交即公开）；实现粒度见 M3 行（Q9），终态与 M4 并存为快/重双通道（Q12） |
| D8 | iOS 远期 | **不承诺不设限**（不引 KMP/多平台库；数据格式天然中立） |
| D9 | 仓库形态 | **本仓 monorepo（android/ 子目录）**（论证见 5.1）→ [ADR-0002](adr/0002-monorepo-android-subdir.md) |
| D10 | 静默体检流量策略 | **仅 WiFi 静默**（移动数据跳过 boot 静默复查；手动体检不限网络）；不设移动数据播放警告——WiFi-only 只管静默体检，播放流量用户自选（A18） |
| D11 | my-radio 互通 | **backup v2 含 my-radio**（owner 选一步到位）：格式 = 现有结构 + 顶层 `my` 字段（my-radio.txt 行数组）；旧端导入时未知字段被 KEYS 白名单忽略，**天然向前兼容**；Web 侧需先开 my-radio 读取通道（exportAll 在浏览器、文件在服务端：新增 GET 端点或复用 /api/sync 载荷）；**导入四方向兼容矩阵（双端 × v1/v2 文件）落 Web 小批 PR 验收**，file:// 形态遇 my 字段明示「自定义电台需 http 形态」不静默丢（A1 精确化：真正未升级的旧端无从提示，静默忽略是白名单既有行为） |
| D11-R2 | v2 批次时机 | **Web 先行独立小批**：先合 Web PR（exportAll/importAll 扩 v2 + 读取通道），安卓 M2 直接按 v2 实现，免二次迁移；**基于 fix/audit-r4 合并后拉分支**——第四轮审计批次同 touch app.js/server.js，同文件区撞车排串行（批复排程注） |
| D12 | 验收设备（事实） | **OV 系实机（ColorOS）+ 原生系/模拟器**；无小米系实机——MIUI/HyperOS 抗杀留社区反馈，省电白名单引导照做（风险 3 已同步） |

## 九、调研依据

- Media3 ICY 元数据：[androidx/media#153](https://github.com/androidx/media/issues/153)、[Media3 Releases](https://developer.android.com/jetpack/androidx/releases/media3)（1.11.1 stable，2026-09）
- 播放事件与恢复：[Player Events](https://developer.android.com/media/media3/exoplayer/listening-to-player-events)、[Load Error Handling](https://medium.com/google-exoplayer/load-error-handling-in-exoplayer-488ab6137)、[Troubleshooting（ICY 状态行→okhttp）](https://developer.android.com/media/media3/exoplayer/troubleshooting)、[androidx/media#2401](https://github.com/androidx/media/issues/2401)
- 前台服务：[FGS 类型（mediaPlayback）](https://developer.android.com/develop/background-work/services/fgs/service-types)、[Android 14 FGS 类型强制](https://developer.android.com/about/versions/14/changes/fgs-types-required)、[通知运行时权限](https://developer.android.com/develop/ui/compose/notifications/notification-permission)
- WebView 后台音频：[Stack Overflow #58569423](https://stackoverflow.com/questions/58569423/how-to-keep-webview-running-in-foreground-service-after-pressing-home-button-in)
- 跨端框架现势：[Tauri 2（2.11.x，2026-07）](https://v2.tauri.app/blog/tauri-2-0-0-release-candidate)、[Capacitor 8（2025-12）](https://ionic.io/blog/announcing-capacitor-8)、[nodejs-mobile 弃坑公告](https://github.com/JaneaSystems/nodejs-mobile)
- 同型参照：[RadioDroid（GPL-3.0，ExoPlayer+radio-browser）](https://github.com/segler-alex/radiodroid)、[F-Droid 页](https://f-droid.org/en/packages/net.programmierecke.radiodroid2)

## 十、立项后的协同动作

- README roadmap「安卓原生 app」项改挂 docs/plan-android.md 并标「进行中」；AGENTS.md 增 `android/` 目录条目与「radio.txt/logos.txt 两侧消费」契约（改格式须两侧同步）。
- **Web 侧先行小批（D11-R2，先于安卓 M2 合入）**：exportAll/importAll 扩 backup v2（顶层 my 字段，含 my-radio 行数组）+ 服务端开 my-radio 读取通道（file:// 置空）+ 四方向导入兼容矩阵验收（A1），独立 PR；**基于 fix/audit-r4 合并后拉分支**（同文件区撞车回避）；对 Web 用户本身是独立价值（换机丢 my-radio 的既有缺口就此清零），现在就做不等 M2（A8）。
- 开发分支建议 `feat/android-m0` 起步，每里程碑一个 PR；Web 侧改动照常走既有流程，互不阻塞。
- **android/ 目录落地（M-1/M0）时补办**（review 二轮 🔵 延期项）：AGENTS.md store.js 行的 ⚠ 警告块扩为「同步扩 store.js KEYS、server.js STORE_KEYS **与 android/ 侧 Store 白名单**」——现在加会指向不存在的文件空转。

## 更新记录

- 2026-10-14：首版立项调研与落地框架（owner review 待拍板项见第八节 D1-D8）。
- 2026-10-14（二）：owner 提出仓库形态关键问题——补 D9 决策点与 5.1「仓库形态论证要点」（结论：monorepo，附重新评估拆分的触发条件）。
- 2026-10-14（三）：owner 三轮追问架构选择——补 3.3「D1 专项深挖」：混合壳拆 B1/B2/C 三形态裁决（B1 三事实判死：WebView MediaSession 官方禁用/音频焦点失控/hls.js 后台冻结；B2 终局=A+桥税；C 无状态岛留后手），维持 A 原生推荐。
- 2026-10-14（四）：grill-with-docs 全面审核轮——自查补漏四处入文（M3 基线语义/M5 keystore 保管/5.2 logos 缓存落点/决策表新增 D10-D12，其中 D11 是 backup.json 不含 my-radio 的既有缺口实证）；frontier 问答拍板进行中，结果随拍板回写本表。
- 2026-10-14（五）：问答轮收口——D1-D12 + D11-R2 全部拍板（第八节转决策记录；两项 owner 加码：D2 歌曲历史进 v1、D11 backup v2 一步到位）；M1/M2/工期/风险 3/§十 随拍板同步；D1、D9 落 ADR（docs/adr/0001、0002）。
- 2026-10-14（六）：外部 review 批复回写（Q1-Q12 全采纳、A1-A19 全采纳，无驳回项）——M-1 环境闸口 + M-1.5 Media3 spike 入里程碑表（Q1/Q8/A11）；D7 通道模型修订为仓库 main 直取（Q2/Q7/Q9，拍板行已标注修订）；依赖白名单转封闭清单制、coroutines 收编（Q3/Q10）；体积哨兵 <5MB+边界条款（Q4）；CI 提前 M0 + path filter（Q5/A12）；M1 补音频焦点四场景（Q6/Q11）；M4 金样 fixture 两层验收（A15）；A1/A6/A7/A13/A18 等口径细目入 5.2-5.4 与决策表；行数刷新至 fix/audit-r4 后口径；新增排程注：D11-R2 基于 fix/audit-r4 合并后拉分支防同文件区撞车；README roadmap 挂本方案、AGENTS.md 补两侧契约入口（同批完成）。
- 2026-10-14（七）：二轮复核修正回写漏网的 6 处编辑级问题——R1 2.2 体积口径与 M5 统一（预估 4-6MB，哨兵见 M5）；R2 5.5 上游白名单删 raw.githubusercontent.com（与 2.4 对齐）；R3 风险 6 数据新鲜度跟上 D7 修订（M3 起收敛到提交频率）；R4 M2 验收补「导入 v1 旧备份兼容不炸」；N1 M-1 验收去掉 CI 前置引用；N2 AGENTS.md 用词统一「回听」+ 单引 5.2。🔵 store.js 警告块扩写挂 §十 待 android/ 落地时补办。
- 2026-10-14（八）：**首批代码落地（feat/android 分支）**。M-1 环境闸口通过（JDK 17.0.20+1 清华/SDK cmdline-tools 16111833 + android-36 + build-tools 36.0.0/gradle 8.14.6 wrapper 钉腾讯镜像；环境步骤固化 android/README.md 换机照抄）。M0-M4 全层实现：数据层（RadioTxt/Store tmp+rename/MyRadio/Cfg/Library 装配管线/Backup v2 五件套/Logos 三级来源/STARTER）、播放层（PlayerHolder 决策链+世代令牌+halt 守卫+看门狗+ICY+每台音量+睡眠渐弱+MediaSession ForwardingPlayer、MediaSessionService）、UI 层（Compose 双主题 Web 色板/列表双视图/选源浮层/歌史/设置/添加电台/导入导出 SAF/体检编排 WiFi-only boot 静默）、体检同步层（CheckStream 字节验收/Health 分档/Gh/LightUpdate D7/ClassifyCn 金样 1512 台零偏差/SyncEngine 全量移植）。并行开发经 CONTRACTS.md 接口冻结 + 四 subagent 分层实现 + 主线收口（含一处数据层真 bug 修复：Library my 层并入悬挂 else 致新键台永不并入，单测逮住）。本地验证：**84/84 单测全绿**（parser/classifyCn 金样/store/cfg/backup/library/health/lightupdate）、debug APK 15.1MB、release APK（R8）**2.7MB**（<5MB 哨兵）；CI（path filter android/**）随批入库。**待办：OV 实机验收（M1 音频焦点四场景/通知栏/后台 30 分钟）与 M5 发布流程（keystore 生成=owner 动作）**。
