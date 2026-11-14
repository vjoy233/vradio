# B7 时移回听技术 Spike 报告

> 日期：2026-11-15 · 分支：feat/r4-b7（基于 B0 完成态；同日追加 AIbot review 回执，见 §10）
> 依据：docs/plan-expansion-r4.md §11；不推翻 ADR-0003（Web 侧时移仍不做），本文不产出 ADR、
> 不下「是否产品化」结论——**Spike 未过实机验证**，产品化决策按方案另走 ADR 流程。

## 0. 结论摘要

首选方案（流字节环形缓冲 + MP3 帧边界索引）**在 JVM 层全量验证通过**：帧头解析表驱动正确、
坏数据/假同步可跳过、60s 容量环形淘汰与索引修剪自洽、回退 15 秒稳定落在合法帧边界、ICY 元数据
块可剥离、状态机全迁移符合 §11 状态图、回放结束链路顺序（控制器迁移→原源重连→起播收口）经
可注入伪 Player 测试锚定。ExoPlayer 接线采用「DataSource 包装 tee + 内存快照回放」，未转向
PCM AudioSink 或本地 relay（遵守 §11 禁令）。

**§11 验收未完成：六项实机验收（§6）逐项全部未执行**——本环境无实机，凡需真实 ExoPlayer/
音频输出/后台锁屏/低端设备的验证项一项都没有跑过（声音连续性、回直播头时序、断流清理、后台
锁屏、VBR 漂移、低端机内存）。JVM 132 例只证明纯函数与链路顺序假设，不证明字节层/时序层成立；
在 owner 实机逐项验收通过前，本 Spike 保持「待实机验证的实验代码、默认不开」定位，不写入
产品已支持清单。

## 1. 文件清单

实验代码全部隔离在 `android/app/src/main/java/io/github/vjoy233/vradio/timeshift/` 包（8 文件）：

| 文件 | 层 | 职责 |
|---|---|---|
| `Mp3Index.kt` | 纯 JVM | MP3 帧头解析（同步字/version/layer/bitrate/samplerate/padding 全表）+ 流式帧索引扫描器（严格验证：下一帧头可见才确认，防假同步污染切入点） |
| `RingBuffer.kt` | 纯 JVM | 固定容量字节环形缓冲：写入淘汰最旧、按流绝对偏移查询/读取/快照；容量参数化 + 4MB 硬顶，默认 2.4MB（60s × 320kbps ÷ 8） |
| `TimeshiftStateMachine.kt` | 纯 JVM | §11 状态图纯函数迁移 + 范围判定（HLS / 非 .mp3 直流 → `REJECTED_NOT_SUPPORTED`；仅按 URL 后缀，无扩展名流拒收并在 UI 明示——产品化前置项见 §8.2） |
| `IcyStripper.kt` | 纯 JVM | Icecast ICY 元数据块剥离（每 metaint 音频字节后的 1+N×16 元数据块），状态机式跨 chunk |
| `TimeshiftCore.kt` | 纯 JVM | 捕获核心：剥 ICY → 入环 → 建索引 → 随淘汰修剪索引；回退定位 = 自最新帧往回累计时长 |
| `Timeshift.kt` | 控制器 | `TsController`（纯 JVM 控制器核心：状态/快照/ENDED·error 监听/回退 15s）+ `TsHost`（宿主环境抽象：真播放器/线程模型注入，review P1-2 测试缝）+ `Timeshift` 装配壳（AndroidHost=ExoPlayer+主线程 Handler+后台单线程）。实验开关（SharedPreferences `timeshiftSpike`，非 radio.*）/`TsUi` StateFlow |
| `TeeDataSource.kt` | DataSource 包装 | `TsRoute`（纯 JVM 路由核心：回放=一次性快照消费/直播=metaint 上报+旁路喂环，review 非阻塞建议的伪 DataSource 测试面）+ `TsDataSource`（media3 适配） |
| `TimeshiftUi.kt` | Compose | PlayerBar「↩15s」按钮 + 范围外拒绝原因提示（P2-1）+ 设置页开关行（最简实现） |

挂点（删包 + 撤销下列 diff 即完全回退，普通播放零影响）：

- `player/PlayerHolder.kt` 5 处一行挂点：①`ensure` 工厂包装 `Timeshift.factory(ds)`；②`ensure` 在 `addListener` 之前 `Timeshift.attach`（监听顺序 = 控制器先见 ENDED）；③`loadVariant` `Timeshift.onNewStream(u)`（切台/刷新/换源/自愈重连全汇于此）；④`stop` `Timeshift.reset()`；⑤`onAir` `Timeshift.onLiveAir()`；另两处一行改造：`pushMeta` 的 `replaceMediaItem` 加 `!Timeshift.isReplaying()` 守卫（回放中元数据原位替换会顶掉快照 item）、`onAir` 状态文案按 `isReplaying()` 显示「回听中…/直播中」（P2-2）。
- `Prefs.kt` +1 常量、`ui/AppVm.kt` +1 StateFlow/setter/init 读、`ui/SettingsScreen.kt` +1 行、`ui/PlayerBar.kt` +1 行。

测试：`android/app/src/test/java/io/github/vjoy233/vradio/timeshift/`
`TimeshiftIndexTest.kt`（12 例）+ `TimeshiftChainTest.kt`（13 例，review 回执新增：链路顺序/
halt·heldNext/connecting 停滞/误触发守卫/拒绝原因/回听中区间/异步拷贝防重入/TsRoute 边界/透传回归）。

## 2. 首选方案实现描述（数据流）

```text
直播（CAPTURING）：
  okhttp 流 → TsDataSource.read（原样返回给上层）
        └旁路副本→ TsRoute.onLiveRead → Timeshift.feedCapture → IcyStripper 剥元数据块 → RingBuffer 写入
                                                    └→ Mp3Indexer 流式确认帧 → 帧索引（随环形淘汰同步修剪）
回退 15 秒（REPLAYING）：
  rewind15()：锁内仅帧定位（指针遍历）；≤2.4MB 快照拷贝在后台单线程完成（P2-3），
    拷完回主线程 setMediaItem(vradiots://replay/snapshot.mp3)+prepare+play
  回放时 TsDataSource 识别该 URI → TsRoute 改喂内存快照（一次性消费）
追上（CATCHING_UP → CAPTURING）：
  快照播完 STATE_ENDED → 控制器转 CATCHING_UP；PlayerHolder 既有「直播不该 ended」自愈
  重连当前源（loadVariant→onNewStream，keep 语义保状态）→ 起播 onAir → LIVE_AIR → CAPTURING
```

两个关键技术事实（media3 1.11.1 字节码实证，javap 复核）：

1. **ICY 剥离位置**：`IcyDataSource` 由 `ProgressiveMediaPeriod$ExtractingLoadable` 构造，包在
   DataSource 工厂返回的实例**之外**。因此 tee 层拿到的是**含 ICY 元数据块的原始字节**——read 返回
   值绝不能动（动了普通播放就坏），旁路副本必须自带 `IcyStripper`（按响应头 `icy-metaint` 剥块），
   否则帧索引被元数据字节打断、快照夹带 ICY 块。
2. **回放 URI 路由**：`vradiots://replay/snapshot.mp3` 靠 lastPathSegment 的 `.mp3` 后缀被
   `Util.inferContentType` 归入 progressive 源，走同一个包装工厂，无需第二个 MediaSourceFactory。

## 3. JVM 层验证结果

`cd android && source env.local.sh && ./gradlew testDebugUnitTest --rerun-tasks`：**132 全绿**
（存量 107 + Index 12 + Chain 13），`assembleDebug` 编译通过。

TimeshiftIndexTest 12 例（MP3 fixture 全部程序化合成，帧头 + 帧长表驱动填零，不引真实音频文件）：

| 用例 | 覆盖 |
|---|---|
| 帧头表驱动 | MPEG1/2/2.5 × L1/L3、padding、保留位/坏索引全拒、越界读安全（MPEG1 L3 128k@44100=417B 等表值逐一断言） |
| 索引扫描与严格验证 | 逐帧喂入确认序 + 绝对偏移；尾帧等后继确认才入索引 |
| 坏数据跳过不炸 | 伪同步字/伪帧头混入垃圾后仍精确恢复帧偏移 |
| 假同步右移重扫 | 合法表头但帧尾非帧头 → 严格验证拒绝、右移一字节重同步 |
| 环形读写淘汰与快照 | 淘汰边界/readAt/snapshot/整段大于环只留尾部/容量护栏 |
| 环形淘汰后索引一致性 | 50KB 环 + 20.9s 数据：bufferedMs 有界、回退目标永远在存活帧边界、快照首字节是合法帧头 |
| 六十秒容量淘汰 | 2.4MB 默认环 + 62.7s 数据：淘汰到 ~60s 窗口、startOffset 前移、快照 ≤ 容量 |
| 回退十五秒定位帧边界 | 定位紧贴 15s（多一帧不足/少一帧超界）、offset 为帧长整数倍、快照首字节 0xFF 同步字、缓冲不足退到最旧帧 |
| 状态机全迁移 | §11 状态图全路径 + 任何态 RESET→OFF（切台/刷新/源切换）+ 未定义组合保持原态 |
| 范围判定 | m3u8/aac/无扩展名 → `REJECTED_NOT_SUPPORTED`；蜻蜓 64k.mp3/.mp3?query/.MP3 → 可捕获 |
| 核心会话与 keep 语义 | 拒绝不吞字节、URL 不匹配/OFF 态 feed 不入环、CATCHING_UP 同源重连保状态保环、换 URL 全新会话 |
| icy 剥离跨 chunk | metaint=10 的块边界在 3/1/7 字节刁钻切分下输出纯音频；metaint≤0 纯透传 |

TimeshiftChainTest 13 例（review 回执新增；经 `TsHost` 注入伪 Player/事件驱动**真 TsController**，
PlayerHolder.listener 相关路径以行号锚定的 HolderSide 投影复刻——改 PlayerHolder ENDED/retryOrNext/
loadVariant/onAir 须同步投影）：

| 用例 | 覆盖 |
|---|---|
| 回放结束链路顺序与原源重连 | P1-2 主断言：SNAPSHOT_END 先于自愈、loadVariant 收到**原源** URL、CATCHING_UP keep 语义、LIVE_AIR 收口 CAPTURING；总顺序七事件逐一断言；P2-2「回听中…/直播中」文案映射、P2-3 posted→playSnapshot 异步两段 |
| 回放结束暂停搁浅 halt 与 heldNext | 暂停挡级联 → heldNext 搁浅在 CATCHING_UP → resume 接回 → 原源重连 → 收口 |
| connecting 未清空快照停在 CATCHING_UP | review P1-2 风险显影：STATE_ENDED 后无自愈即停滞（看门狗不武装）；归 §6.2 实机观察项 |
| 直播态误触发 ENDED 不误迁移 | SNAPSHOT_END 仅 REPLAYING 生效；直播自愈重连=新会话清环 |
| 拒绝原因明示进 UI | P2-1：无扩展名/aac → `TsUi.reject=true`；.mp3/reset 清 |
| 回退拷贝异步化与防重入 | P2-3：rewind15 返回时快照未拷出/未起播（posted 未执行）、在飞防重入不并发拷、REPLAYING 态回退入口挡 |
| 无帧回退失败入 FAILED | REWIND_FAIL 路径不进后台拷贝；FAILED 下一连接复活 |
| 回放 open 取走一次性快照与读尽 | TsRoute：快照首字节 0xFF、读尽 -1、无快照重开 false（→IOException 自愈） |
| 直播 open 上报 metaint 与旁路读 | openLive 绑连接、n=0 不喂、close 复位 |
| 重复回退第二次快照可用 | 播完→自愈→续攒→再回退，新快照可用 |
| 回放期切台快照作废 | 切台清快照（旧重开失败走自愈）、刷新同口径 RESET→新会话 |
| 回放期直播 feed 冻结与暂停边界 | REPLAYING 态旁路到达不入环（缓冲冻结不破坏） |
| 开关关闭透传回归 | 关开关硬复位、feedCapture 零字节入环（TsDataSource 纯透传口径） |

## 4. 临场决策记录（未在 §11 明示、由实现需要定夺）

1. **「单源」的落地口径**：按「当前在播 variant URL 是否 .mp3 直流」判定（多源台在播 mp3 源也捕获）；换源经 `loadVariant` 自然重置会话——比按台源数判定更贴播放事实，也不用 timeshift 反向读台数据。
2. **回放期间不持续捕获**：快照播放时 ExoPlayer 读内存、网络连接已断，环形缓冲冻结；代价是「回到直播头」跳过回放期间错过的内容（[T, T+15s] 窗口丢失）。产品化前若要无缝追上需旁路第二连接持续落环（带宽翻倍）或 seek-to-live 语义，见 §8。
3. **回到直播头复用既有自愈**：快照 ENDED 即「直播不该 ended」场景，直接让 PlayerHolder 的 `retryOrNext` 重连当前源，Spike 不新增回直播通路；CATCHING_UP 只是这段追赶间隙的可见状态。链路顺序（含 halt/heldNext/connecting 边界）已由 TimeshiftChainTest 锚定（review P1-2），但**依赖的 Media3 实际派发时序仍属 §6.2 实机待验**。
4. **REWIND_FAIL → FAILED**（§11 状态图分支）：触发面 = 无已确认帧 / 后台拷贝期间快照起点被淘汰（拷贝异步化后窗口存在但极窄：需在 ms 级拷贝期间滚过整个 60s 环）；FAILED 后下一连接 `START` 复活，不永久卡死。
5. **开关即时生效**：sink 绑定在 `read()` 时按 (URL, 状态) 动态判定（每读一次一次字符串比较，可忽略），开启后当前流即刻开始捕获，无需刷新/切台。
6. **暂停/睡眠不破坏缓冲**：暂停时 ExoPlayer 停止拉流 → 捕获自然冻结（缓冲保留不破坏），但暂停期间的内容不会被录下（与 ADR-0003 的物理前提一致）。
7. **快照拷贝异步化**（review P2-3）：`rewind15()` 锁内只做帧定位，≤2.4MB arraycopy 移到后台单线程（`vradio-timeshift` daemon），拷完回主线程起播；拷贝期间与 loading 线程经同一把锁串行（ms 级，仅迟滞一个读周期，不触 ExoPlayer 主线程）。等待期切台/关开关则丢弃不起播；在飞期间重复点按防重入。低端真机 GC/卡顿测量仍属 §6.6。
8. **回放期状态/元数据语义**（review P2-2）：PlayerBar 状态文案回放期显示「回听中…」（复用 onAir 事件按 `isReplaying()` 分流）、通知/MediaSession 标题在快照 item 上为「↩ 回听 · 台名」、回放结束重连装载恢复直播元数据；进度条/时长对快照的处理仍留 §8.4。

## 5. 已知限制（Spike 范围内有意为之）

- **仅覆盖 `.mp3` 直流且仅按 URL 后缀判定**（含蜻蜓换算 `lhttp…/64k.mp3`）；无扩展名旁路流（`/stream` 等）不捕获——**UI 在开关开启且当前台被拒时明示「本台不支持回听（实验仅支持 .mp3 扩展名直流）」**（review P2-1），不再静默无按钮。AAC（ADTS）在 §11 范围外。
- **回放期间不录流**（见临场决策 2）：回直播头有内容跳变，听感是「快进了 15 秒」。
- **断流自愈重连清空缓冲**：重连 = 新连接 = 新会话（`loadVariant` 重置），60s 窗口从零再攒；§11 验收口径允许「清空或重建」。
- **帧索引严格验证留尾**：最后一帧要等后继帧头到达才确认，索引恒落后实时 ~1 帧（26ms@44100），无感知影响。
- **trusting icy-metaint**：剥块完全信任响应头（与 ExoPlayer 自身 `IcyDataSource` 同等信任面）；服务器谎报 metaint 会污染捕获（普通播放同坏，非本 Spike 引入）。
- **回放期 ICY 曲讯无更新**：快照无 ICY（结构性）；状态文案/通知标题已按「回听」区分（P2-2），码率显示沿用上一个直播值。
- **不写任何永久文件**：环形缓冲在内存、快照一次性消费，进程退出即无痕；不进备份（radio.* 零新增，契约测试 ContractTest 不受影响）、不进统计。

## 6. 实机待验项（六项逐项全部未执行——本环境无实机）

> 状态：**1–6 全部「待实机验收」，一项都没有跑过**（review P1-1 处置口径：不把 JVM 层结论表述成
> §11 已收口；owner 合并后按此清单逐项验收，通过前不视为 Spike 完成）。

1. **【待实机】声音连续性**：真实电台流（128kbps/44.1k 直流 + ICY）回退 15 秒从帧边界起播是否有爆音/丢首帧；icy 剥块边界在真实 metaint（常见 8192/16000/32768）下是否与索引对齐。
2. **【待实机】回到直播头**：快播完 → ENDED → 自愈重连 → 起播整链实机时序（含暂停态搁浅 `heldNext` 接回路径、`connecting` 未清空时的 CATCHING_UP 停滞风险——ChainTest 已显影该路径，实机验证 Media3 焦点/版本时序是否触达）。
3. **【待实机】断流清理**：看门狗触发/`onPlayerError` 级联时环形缓冲与状态是否干净复位、无残留 tee 写入。
4. **【待实机】后台/锁屏**：`WAKE_MODE_NETWORK` 下 tee 写入与后台线程快照拷贝（≤2.4MB 一次 arraycopy + 回主线程起播）是否造成可感知卡顿。
5. **【待实机】多码率漂移**：流中途变 bitrate/samplerate（VBR 电台）时帧长表驱动的索引与时长累计是否失真（回退秒数精度）。
6. **【待实机】低端机内存**：2.4MB 环 + 2.4MB 快照峰值在低端设备 GC 行为。

## 7. 五人日止损线评估

§11 止损条件是「5 人日内无法稳定从合法帧边界回放就停止投入」。当前状态：**JVM 层约 2 人日完成且全绿**（含 review 回执的链路顺序/边界测试补强），帧边界回放的确定性问题（本次最大技术风险）已在纯 JVM 层闭环；剩余风险全部集中在 ExoPlayer 实机时序（§6 的 1-3，逐项未验），每项都是窄面验证（单台直流量级 0.5-1 人日可趟完）。**未触止损线**，且没有出现需要转向 PCM AudioSink 或本地 relay 才能解的信号——@OptIn 的 DataSource tee 挂法在 1.11.1 上成立。

## 8. 产品化前必须解决的点（清单，供 ADR 议事，本文不下结论）

1. 回放期持续捕获（旁路第二连接落环）或显式「追直播」语义，消解 §5 的内容跳变。
2. 无扩展名 mp3 直流的识别（Content-Type/字节探活级判定，或复用 `check/CheckStream.kt` 的字节验收）——Spike 仅按 URL 后缀 + UI 明示拒绝（P2-1 处置的另一半留此）。
3. AAC（ADTS）帧边界索引（央广系以外的第二大盘）与 HLS 滑窗时移的取舍——后者结构性贵，建议继续拒绝。
4. 回放期 UI 语义：进度条/时长对快照的处理、锁屏 artwork（「回听中」状态文案与通知标题已随 P2-2 处置加入）。
5. 缓冲秒数显示/回退进度条（当前只有一枚「↩15s」按钮）。
6. 实机验收矩阵固化（§6 六项）+ 真机 CI 或录屏脚本。
7. 若产品化：设置项文案去掉「实验」、ADR-0003 增补 Android 例外条目（Web 侧维持不做）。

## 9. 回退方式

删除 `android/.../timeshift/` 两个目录（main + test），撤销 §1 列出的挂点 diff（PlayerHolder 5 挂点 + 2 处一行改造 + Prefs/AppVm/SettingsScreen/PlayerBar），即恢复普通播放原样——开关关闭时本来也零行为变化（`TsDataSource` 纯透传、`feedCapture` 空转、按钮不渲染）。

## 10. AIbot review 处置记录（2026-11-15，PR #25）

- **P1-1（部分采纳+挂起）**：实机验收本环境不可执行（无设备），维持「实验代码/不默认开启」定位；本报告与 PR 描述已去「已收口」化措辞——六项验收逐项标注【待实机】（§6），摘要不再以三项概括「唯一硬缺口」；回执 commit body 逐项列出未执行状态。
- **P1-2（采纳）**：`Timeshift` 拆出 `TsController`（纯 JVM）+ `TsHost` 宿主抽象（最小测试缝）；新增 TimeshiftChainTest 断言 REPLAYING→SNAPSHOT_END→loadVariant(原源)→LIVE_AIR 顺序、halt/heldNext 组合、connecting 未清空停滞显影、直播误触发守卫；PlayerHolder 侧以行号锚定投影复刻（改 PlayerHolder 须同步）。
- **P2-1（采纳）**：`TsUi.reject` 进 UI 状态；PlayerBar 在开关开启且当前台被拒时显示「本台不支持回听（实验仅支持 .mp3 扩展名直流）」；classify 注释保留「产品化前置项：Content-Type/字节探测」（§8.2）。
- **P2-2（采纳）**：onAir 文案按 `isReplaying()` 分流「回听中…/直播中」；通知标题随快照 item「↩ 回听 · 台名」、回放结束经 loadVariant 恢复直播元数据（结构性）；ChainTest 断言区间。
- **P2-3（采纳）**：rewind15 锁内仅帧定位、≤2.4MB 拷贝移后台单线程、拷完回主线程起播；在飞防重入与变卦丢弃；ChainTest 断言异步结构（不同步完成/防重入）；锁竞争面=loading 线程 ms 级串行（不触主线程）；低端真机测量留 §6.6。
- **非阻塞建议（采纳）**：TsRoute 抽出纯 JVM 路由核心，补 open/close、重复回退、切台/刷新、回放期冻结/暂停边界与开关关闭透传回归测试（合计 13 例）。
- 测试证据：`testDebugUnitTest --rerun-tasks` 132/132 绿（119 + 13 新增，0 失败）。
