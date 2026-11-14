# B7 时移回听技术 Spike 报告

> 日期：2026-11-15 · 分支：feat/r4-b7（基于 B0 完成态）
> 依据：docs/plan-expansion-r4.md §11；不推翻 ADR-0003（Web 侧时移仍不做），本文不产出 ADR、
> 不下「是否产品化」结论——Spike 未过实机验证，产品化决策按方案另走 ADR 流程。

## 0. 结论摘要

首选方案（流字节环形缓冲 + MP3 帧边界索引）**在 JVM 层全量验证通过**：帧头解析表驱动正确、
坏数据/假同步可跳过、60s 容量环形淘汰与索引修剪自洽、回退 15 秒稳定落在合法帧边界、ICY 元数据
块可剥离、状态机全迁移符合 §11 状态图。ExoPlayer 接线采用「DataSource 包装 tee + 内存快照回放」，
未转向 PCM AudioSink 或本地 relay（遵守 §11 禁令）。**实机项（声音连续性/回直播头/断流清理）本
环境无实机，全部待验**——这是 Spike 尚不能收口的唯一硬缺口。

## 1. 文件清单

实验代码全部隔离在 `android/app/src/main/java/io/github/vjoy233/vradio/timeshift/` 包（8 文件）：

| 文件 | 层 | 职责 |
|---|---|---|
| `Mp3Index.kt` | 纯 JVM | MP3 帧头解析（同步字/version/layer/bitrate/samplerate/padding 全表）+ 流式帧索引扫描器（严格验证：下一帧头可见才确认，防假同步污染切入点） |
| `RingBuffer.kt` | 纯 JVM | 固定容量字节环形缓冲：写入淘汰最旧、按流绝对偏移查询/读取/快照；容量参数化 + 4MB 硬顶，默认 2.4MB（60s × 320kbps ÷ 8） |
| `TimeshiftStateMachine.kt` | 纯 JVM | §11 状态图纯函数迁移 + 范围判定（HLS / 非 .mp3 直流 → `REJECTED_NOT_SUPPORTED`） |
| `IcyStripper.kt` | 纯 JVM | Icecast ICY 元数据块剥离（每 metaint 音频字节后的 1+N×16 元数据块），状态机式跨 chunk |
| `TimeshiftCore.kt` | 纯 JVM | 捕获核心：剥 ICY → 入环 → 建索引 → 随淘汰修剪索引；回退定位 = 自最新帧往回累计时长 |
| `TeeDataSource.kt` | DataSource 包装 | 直播 URI 字节透传 + 旁路副本进环；回放 URI（`vradiots://replay/snapshot.mp3`）改喂内存快照 |
| `Timeshift.kt` | 控制器 | 实验开关（SharedPreferences `timeshiftSpike`，非 radio.*）/会话生命周期/回退 15s 执行/ENDED·error 监听/`TsUi` StateFlow |
| `TimeshiftUi.kt` | Compose | PlayerBar「↩15s」按钮 + 设置页开关行（最简实现） |

挂点（删包 + 撤销下列 diff 即完全回退，普通播放零影响）：

- `player/PlayerHolder.kt` 5 处一行挂点：①`ensure` 工厂包装 `Timeshift.factory(ds)`；②`ensure` 在 `addListener` 之前 `Timeshift.attach`（监听顺序 = 控制器先见 ENDED）；③`loadVariant` `Timeshift.onNewStream(u)`（切台/刷新/换源/自愈重连全汇于此）；④`stop` `Timeshift.reset()`；⑤`onAir` `Timeshift.onLiveAir()`；另 `pushMeta` 的 `replaceMediaItem` 加 `!Timeshift.isReplaying()` 守卫（回放中元数据原位替换会顶掉快照 item）。
- `Prefs.kt` +1 常量、`ui/AppVm.kt` +1 StateFlow/setter/init 读、`ui/SettingsScreen.kt` +1 行、`ui/PlayerBar.kt` +1 行（合计 22 insertions / 2 deletions，含注释）。

测试：`android/app/src/test/java/io/github/vjoy233/vradio/timeshift/TimeshiftIndexTest.kt`（12 用例）。

## 2. 首选方案实现描述（数据流）

```text
直播（CAPTURING）：
  okhttp 流 → TsDataSource.read（原样返回给上层）
        └旁路副本→ Timeshift.feedCapture → IcyStripper 剥元数据块 → RingBuffer 写入
                                                    └→ Mp3Indexer 流式确认帧 → 帧索引（随环形淘汰同步修剪）
回退 15 秒（REPLAYING）：
  rewindTarget(15s)：自最新确认帧往回累计时长 ≥15s（不足退到最旧存活帧）→ 帧边界 offset
  RingBuffer.snapshot(offset) 一次性拷出（≤60s≤2.4MB）→ exo.setMediaItem(vradiots://replay/snapshot.mp3)
  回放时 TsDataSource 识别该 URI → ByteArrayDataSource 喂快照（一次性消费）
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

`cd android && source env.local.sh && ./gradlew testDebugUnitTest`：**119 全绿**（存量 107 + 本次 12），`assembleDebug` 编译通过。TimeshiftIndexTest 12 用例（MP3 fixture 全部程序化合成，帧头 + 帧长表驱动填零，不引真实音频文件）：

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

## 4. 临场决策记录（未在 §11 明示、由实现需要定夺）

1. **「单源」的落地口径**：按「当前在播 variant URL 是否 .mp3 直流」判定（多源台在播 mp3 源也捕获）；换源经 `loadVariant` 自然重置会话——比按台源数判定更贴播放事实，也不用 timeshift 反向读台数据。
2. **回放期间不持续捕获**：快照播放时 ExoPlayer 读内存、网络连接已断，环形缓冲冻结；代价是「回到直播头」跳过回放期间错过的内容（[T, T+15s] 窗口丢失）。产品化前若要无缝追上需旁路第二连接持续落环（带宽翻倍）或 seek-to-live 语义，见 §8。
3. **回到直播头复用既有自愈**：快照 ENDED 即「直播不该 ended」场景，直接让 PlayerHolder 的 `retryOrNext` 重连当前源，Spike 不新增回直播通路；CATCHING_UP 只是这段追赶间隙的可见状态。
4. **REWIND_FAIL → FAILED**（§11 状态图分支）：实际触发面极窄（按钮 ≥3s 缓冲才亮、快照在锁内构造不可能被淘汰抢先）；FAILED 后下一连接 `START` 复活，不永久卡死。
5. **开关即时生效**：sink 绑定在 `read()` 时按 (URL, 状态) 动态判定（每读一次一次字符串比较，可忽略），开启后当前流即刻开始捕获，无需刷新/切台。
6. **暂停/睡眠不破坏缓冲**：暂停时 ExoPlayer 停止拉流 → 捕获自然冻结（缓冲保留不破坏），但暂停期间的内容不会被录下（与 ADR-0003 的物理前提一致）。

## 5. 已知限制（Spike 范围内有意为之）

- **仅覆盖 `.mp3` 直流**（含蜻蜓换算 `lhttp…/64k.mp3`）；无扩展名旁路流（`/stream` 等）不捕获——按钮不亮、无误导。AAC（ADTS）在 §11 范围外。
- **回放期间不录流**（见临场决策 2）：回直播头有内容跳变，听感是「快进了 15 秒」。
- **断流自愈重连清空缓冲**：重连 = 新连接 = 新会话（`loadVariant` 重置），60s 窗口从零再攒；§11 验收口径允许「清空或重建」。
- **帧索引严格验证留尾**：最后一帧要等后继帧头到达才确认，索引恒落后实时 ~1 帧（26ms@44100），无感知影响。
- ** trusting icy-metaint**：剥块完全信任响应头（与 ExoPlayer 自身 `IcyDataSource` 同等信任面）；服务器谎报 metaint 会污染捕获（普通播放同坏，非本 Spike 引入）。
- **回放期状态栏文案**：`onAir()` 在快照起播时也说「直播中」（复用既有事件，Spike 未细分）；ICY 曲讯在回放期无更新（快照无 ICY，结构性）。
- **不写任何永久文件**：环形缓冲在内存、快照一次性消费，进程退出即无痕；不进备份（radio.* 零新增，契约测试 ContractTest 不受影响）、不进统计。

## 6. 实机待验项（本环境无实机，如实标注——Spike 收口的硬缺口）

1. **声音连续性**：真实电台流（128kbps/44.1k 直流 + ICY）回退 15 秒从帧边界起播是否有爆音/丢首帧；icy 剥块边界在真实 metaint（常见 8192/16000/32768）下是否与索引对齐。
2. **回到直播头**：快播完 → ENDED → 自愈重连 → 起播整链实机时序（含暂停态搁浅 `heldNext` 接回路径）。
3. **断流清理**：看门狗触发/`onPlayerError` 级联时环形缓冲与状态是否干净复位、无残留 tee 写入。
4. **后台/锁屏**：`WAKE_MODE_NETWORK` 下 tee 写入与主线程快照拷贝（≤2.4MB 一次 arraycopy）是否造成可感知卡顿。
5. **多码率漂移**：流中途变 bitrate/samplerate（VBR 电台）时帧长表驱动的索引与时长累计是否失真（回退秒数精度）。
6. **低端机内存**：2.4MB 环 + 2.4MB 快照峰值在低端设备 GC 行为。

## 7. 五人日止损线评估

§11 止损条件是「5 人日内无法稳定从合法帧边界回放就停止投入」。当前状态：**JVM 层约 1.5 人日完成且全绿**，帧边界回放的确定性问题（本次最大技术风险）已在纯 JVM 层闭环；剩余风险全部集中在 ExoPlayer 实机时序（§6 的 1-3），每项都是窄面验证（单台直流量级 0.5-1 人日可趟完）。**未触止损线**，且没有出现需要转向 PCM AudioSink 或本地 relay 才能解的信号——@OptIn 的 DataSource tee 挂法在 1.11.1 上成立。

## 8. 产品化前必须解决的点（清单，供 ADR 议事，本文不下结论）

1. 回放期持续捕获（旁路第二连接落环）或显式「追直播」语义，消解 §5 的内容跳变。
2. 无扩展名 mp3 直流的识别（Content-Type/字节探活级判定，或复用 `check/CheckStream.kt` 的字节验收）。
3. AAC（ADTS）帧边界索引（央广系以外的第二大盘）与 HLS 滑窗时移的取舍——后者结构性贵，建议继续拒绝。
4. 回放期 UI 语义：状态栏文案、MediaSession 通知（进度条/时长对快照的处理）、锁屏 artwork。
5. 缓冲秒数显示/回退进度条（当前只有一枚「↩15s」按钮）。
6. 实机验收矩阵固化（§6 六项）+ 真机 CI 或录屏脚本。
7. 若产品化：设置项文案去掉「实验」、ADR-0003 增补 Android 例外条目（Web 侧维持不做）。

## 9. 回退方式

删除 `android/.../timeshift/` 两个目录（main + test），撤销 §1 列出的 5 个文件挂点 diff（22 行），即恢复普通播放原样——开关关闭时本来也零行为变化（`TsDataSource` 纯透传、`feedCapture` 空转、按钮不渲染）。
