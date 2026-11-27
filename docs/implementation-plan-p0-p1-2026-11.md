# VRadio P0/P1 五方向落地实施方案

> 版本：v1.2（施工前勘误，按 origin/main 源码核验）
> 日期：2026-11-26
> 适用基线：`origin/main` / HEAD `bd1667c`
> 状态：实施设计文档，**本次不改业务代码、不生成电台资产、不运行真实同步**。
>
> 本文基于已确认的产品选择：
>
> - 按依赖顺序推进：A1 契约/纯函数 → A2 详情诊断 → C1 本地发现 → D 新鲜度；B Android 协调文件所有权后可并行；C2 独立测量，C3 须达标且用户确认；
> - Android 本批先完成代码、JVM/fixture/必要模拟器测试；**真机发布验收后置为独立发布门，不得在本批宣称已完成日用发布**；
> - 精选发现分为 C1 本地派生、C2 第三上游测量、C3 达标后接入：`deroverda/recommended-radio-streams` **先测量存活率、增量价值和耗时，再评审是否接入**；测量阶段不改正式资产、不接 `/api/sync`、不新增 Android 投递协议。正式接入仍须独立失败隔离，不能覆盖国内/现有欧美主层；
> - 自动新鲜度采用“启动检查 + 提醒，默认不自动发布”；用户确认后才进入现有同步质量门；
> - 允许按契约同步扩展 Web/Android/backup/contracts，并为旧数据提供兼容迁移；新鲜度只新增单一 `radio.syncFreshness` JSON 键；
> - 质量解释统一采用无状态纯函数导出；Android 保留现有 PlaybackService 生命周期，只补公开只读状态/API 和测试，不直接套用不可编译的服务重写骨架。

---

## 0. 统一原则、非目标与批次门

### 0.1 不可破坏的现有约束

1. **零 npm 运行依赖、无构建步骤、经典 script 顺序**保持不变。
2. `radio.txt` 继续是两字段协议：`电台名,http(s) URL`；不向主文件追加 provider、质量、来源、token 列。
3. URL 身份公理继续成立：`s.u[0]` 是收藏、最近、健康、源记忆、维护配置和 QualityStore 的身份键。
4. `radio.health` 只表示死台/停运生命周期；质量摘要不得直接隐藏或复活电台。
5. 自动任务不得抢占用户正在播放的音频连接；诊断与同步不能把“网络失败”写成死台。
6. Web 与 Android 新增行为必须先有纯函数/fixture，再接 UI；跨端形态写进 `contracts/`。
7. 不引入录音、云同步、账号、在线推荐 API、歌词、频谱/EQ、Cast、多房间；第三方精选清单仅允许作为独立、可回滚的静态上游试点。

### 0.2 批次出口

| 批次 | 主要出口 | 进入条件 | 退出条件 |
|---|---|---|---|
| A | 质量与诊断基础 | 当前 `QualityStore`、`source-diagnostic` 已稳定 | Web/Android 同一质量快照逐字段一致；用户能完成诊断→自救闭环 |
| B | Android 代码与自动化测试 | A 的状态语义和刷新/错误动作冻结 | JVM/fixture/必要模拟器测试通过；真机锁屏、焦点、长听和升级作为后置独立发布门，不得提前宣称通过 |
| C | C1 本地发现与来源分层；C2 第三上游测量 | C1 依赖 A 的质量/来源派生；C2 只读主库，可独立测量 | C1 保留现有播放/筛选语义；C2 交付测量报告与继续/暂停建议；C3 正式接入须测量达标并经确认，不作为 C1 完成条件 |
| D | 自动新鲜度提醒 | A 的资产版本/同步结果可查询 | 默认只提醒/确认，不自动发布；手动同步优先；可关闭 |

### 0.3 执行顺序与冲突协调

A1 → A2 → C1 → D；B 与相关文件所有者协调后可并行，不等待真机发布门。C2 是独立只读 Spike，可提前执行；C3 仅 C2 测量达标且用户确认后启动。本文 A–E 是主题章节，不等同批次字母：诊断主题 C 属 Batch A2，发现主题 D 属 Batch C，新鲜度主题 E 属 Batch D。不擅自提交。

---

# A. P0：电台数据质量与来源可解释性 2.0

## A.1 目标与验收

### 用户目标

用户看到一个电台时，能回答：

- 它来自哪里，是否为精选/个人台？
- 最近一次诊断/播放何时成功？
- 当前启用源有几个，哪个源成功过？
- 失败是网络、HTML 假流、短数据、HLS 清单/分片、还是服务端权限错误？
- 我现在应该重测、换源、刷新，还是等待网络恢复？

### 不做的事情

- 不把质量分数直接等同于死台。
- 不做实时云端排行榜。
- 不保存完整响应体、歌词、音频片段、IP、DNS 结果。
- 不把一次 `NETWORK` 失败升级为 `radio.health.dead`。

### A 批次验收

1. `npm run test:contract`、`npm run test:unit`、`npm run test:api` 通过。
2. Web 与 Android 使用同一质量 fixture，聚合结果逐字段相等。
3. 详情中心能从质量摘要进入：重测当前源、重测启用源、播放成功源、复制诊断摘要。
4. 诊断/同步/播放失败文案能区分“暂时网络问题”和“内容/协议问题”。
5. 质量数据缺失时显示“暂无样本”，不显示“差”。

## A.2 数据模型：保持 quality sidecar，新增来源与可解释摘要

当前 [quality-store.js](../quality-store.js) 已冻结 station/source 聚合形态。建议**不改现有 `opEvent`**，新增两个旁车契约：

### 1）`radio-meta.json` 来源字段

当前 `buildRadioMeta()` 已按 URL 生成 station/source 记录。扩展 source 字段；字段契约见新建 `contracts/source-meta.json`，不要修改语义不同的 `metadata-event.json`：

```json
{
  "url": "https://stream.example/radio.mp3",
  "upstream": "gao",
  "upstreamId": "source-row-or-stable-id",
  "kind": "main",
  "firstSeenAt": 1732500000000,
  "lastSeenAt": 1732600000000,
  "lastVerifiedAt": 1732600000000,
  "verification": "sync|unknown"
}
```

只增加可重建的来源/观察字段，不把运行时隐私数据写入公共资产。旧 `radio-meta.json` 缺字段时按：

```text
lastSeenAt = firstSeenAt || 0
lastVerifiedAt = 0
verification = "unknown"
```

### 2）质量摘要 UI 投影（沿用现有累计计数 + 30 天无观察过期近似；文案不得声称精确的逐样本“近 30 天成功率”）

不把 UI 文案写进 sidecar：新增无状态纯函数 `qExplain(summary, now)` 与 `diagnosticAction(code, httpStatus)`，JS/Kotlin 同消费黄金 fixture 并逐字段输出 `{level, action, reason}` 机器值，UI 各端映射中文，不调用虚构的 `QualityStore.explain`。空样本、缺失观察时间、未来时钟异常与样本不足均明确返回 unknown；年龄 `>= 30 * 86400000` 过期，测试边界前一毫秒/恰好/后一毫秒。累计 ok/fail/延迟只是累计统计，以最近观察时间作过期近似，绝非精确滚动 30 天。修改现有 `qualityHtml` 中“近 30 天成功率”误导文案。

诊断 action 仅依固定 code + httpStatus 映射，why 仅展示不作分支；HTTP 401/403 提示服务拒绝/需要配置、不标停运、不发明 AUTH/PERMISSION。直流探活按字节门而 HLS 有 HTTP 判断，不假定 401/403 必得 HTTP code。NETWORK、HTML、SHORT_BODY、EMPTY_PLAYLIST、NO_SEGMENT、REDIRECT_REJECTED、INVALID_URL 均覆盖，并区分未知码。诊断不更改 health。



## A.3 Web 文件级改动

### A.3.1 `update-sources.js`

保留实际签名 `buildRadioMeta(merged, prevMeta, cnCands, euLines, now, upstreamDefault = '')`，包括 `--init-meta` 传 `local` 的兼容路径。按 URL 关联可证明的上游行，未知保持 unknown；基线 radio-meta 统计 1624 个 source 均为 local，不能凭分类重标：国际/欧美分类含国内捞回项。真实同步或可验证映射才可补来源。仅 `buildEuLines` 显式携带 `checkDetail` 通过证据及其 checkedAt 才能写 lastVerifiedAt/verification=sync；沿用旧可信值，否则 0/unknown。手动诊断和播放只记本地 QualityStore，不回写公共资产。来源契约示例中的 verification 仅允许公共资产使用 sync/unknown，避免误指本地事实。

内部报告采用不冲突的新字段如 `sourceQualityReport`，保留现有稳定同步摘要 `quality: {oldTotal,newTotal}`，不得覆盖。资产只走既有发布/manifest，禁止手工改生成物。



### A.3.2 `app.js`

接入现有 `qualityHtml(s)` 与无参 `renderDetail()`，使用 `QualityStore.summary(s.u[0], s.u)` 和纯投影；不存在示例中的详情数据 return。`Player.getSourceState()` 无参，仅在返回 station 与目标台一致时使用 `sourceIndex`、`srcMemIndex`；非当前台只显示真实历史证据。重测复用 `checkStationSources(s)` / `recheckSource(s,i)`，保留禁用源、每台最多 6、每请求 4、file 守卫和 URL 回绑。现有 `detail.results` 是稀疏数组，保持此模型。

加强并发：独立单调 generation，在打开、关闭（含同台重开）、换台及每次启动批量/单源诊断时递增；异步请求每次 await 后以及 catch、finally、写结果、写 QualityStore、清 loading、render 前都核验 generation、stationKey、详情仍打开和 URL 仍属于当前台。新请求覆盖旧请求，旧请求任何副作用均丢弃；按钮禁用不能代替守卫。保留每批真实诊断结果，网络异常不能伪造服务器 code。加入延迟响应同台重开、单源与批量交错、关闭、源更改、QualityStore 不污染的测试。

复制诊断默认脱敏 URL：去 userinfo、query、fragment（包括路径可能含 token 的情况，默认仅输出 scheme + host，必要时显示路径已隐藏）；不输出 why、异常堆栈、响应体、凭据、重定向链。台名/分类也按用户数据提示审阅；原始 URL 仅由既有独立“复制源”经用户明确操作提供。复用/抽取 `copySource` 的 clipboard + execCommand fallback，使其返回成功/失败并捕获异常，成功或失败均 toast，LAN 非安全上下文可用，不影响播放。加凭据、token、碎片和 clipboard 拒绝的测试。



### A.3.3 `server.js`

第一阶段不新增 API。复用：

- `/api/check?detail=1&url=...`；
- `/api/quality`；
- `/api/nowplaying` 不参与诊断；
- `/proxy` 不增加任何诊断特例。

若后续需要“单源立即重测”接口，继续走现有 `/api/check`，不要另开绕过 `crossOrigin/safeTarget/guardLookup` 的端点。

## A.4 Android 文件级改动

### A.4.1 `RadioMeta.kt`

扩展已有 `RadioMeta.MetaSource`，不要新造 `SourceMeta`；未知字段容错、旧字段缺失按 0/unknown，Android 只消费展示值。`QualityStore.kt` 镜像上述无状态纯函数及同一 JSON fixture，冻结机器字段与边界而非要求中文逐字一致。

## A.5 测试清单

新增：

- `test/quality-explain.js`：无样本、过期、good/fair/poor、所有 diagnostic code。
- `test/meta-source.js`：旧 meta 无新字段、来源字段继承、国内不伪造 verified。
- `test/diagnostic.js`：单源重测不写 health、HTML/SHORT_BODY 行动建议。
- Android `QualityExplainTest.kt`：同输入同输出；`RadioMetaTest.kt`：旧 JSON 兼容。
- 浏览器 PR 门修改 `ui-demo/pr-smoke.cjs`：详情打开、重测、复制摘要、换源、恢复默认；多标签/视口按需修改既有脚本。新测试须登记 `test/run.js` 的 unit/api profile；`npm test` 自动发现不等于定向 profile 覆盖。

---

# B. P0：Android 从技术骨架到可日用产品

## B.1 目标与范围

本批只做代码、JVM/fixture 与必要模拟器验证；真机锁屏、焦点、30 分钟长听、弱网、升级和 release 签名/hash/回滚为 B.7 后置独立发布门，未测不得宣称日用发布。

已实现勿重写：Android UI 重设计已合并；PlaybackService/MediaSession、自连 controller、ExoPlayer 音频焦点/noisy/wake、刷新/级联、Prefs.RESUME、LightUpdate 与 SrcSheet 已存在。先对照现实现有行为与测试，仅补真实缺口；不另建第二套 UI 或服务。

### 不包含

- 不复刻 Web 全部维护草稿 UI；
- 不新增 Android 私有 radio.* 键；
- 不让 Android 依赖 Web server localhost；
- 不在此批引入 DI.FM、账号源或新运行时依赖。

## B.2 现有代码接入点

当前 `PlayerHolder.kt` 已有：

- `ExoPlayer`、`MediaSession`、`PlaybackService`；
- `AudioAttributes` 音频焦点；
- `setHandleAudioBecomingNoisy(true)`；
- `WAKE_MODE_NETWORK`；
- `onStepFav`、`onPlayLast`；
- `refresh()`；
- 看门狗、源级联、ICY metadata、Widget command。

因此本批优先补生命周期和验收，而不是重写播放层。

## B.3 PlaybackService：保留现有生命周期，只补最小公开 API

当前仓库已经有 `PlaybackService`、`MediaSession`、`VRadioApp.onCreate → PlayerHolder.ensure()` 和自连 `MediaController`。本批**不重写** `onTaskRemoved`/`onDestroy`，不直接套用网上的前台服务骨架，避免重复初始化或调用不存在的 API。

审核 Manifest、现有生命周期及自连 controller/session/exo 所有权、服务重启和重连；补测试先行，仅在确证缺口且专项设计后修改。不要贸然新增 `releaseForServiceDestroy` 或只释放 controller：可能破坏后台通知与重连。模拟器覆盖可自动验证部分；硬件行为留 B.7。

## B.4 音频焦点与状态机验收

现有 ExoPlayer 已配置焦点与 noisy；先以现有 Media3 实际回调和测试核验，不凭伪代码创建第二状态机或承诺系统一定自动恢复。下表为后置真机预期，实际结果须记录设备/系统差异。

验收状态矩阵：

| 场景 | 预期 |
|---|---|
| 锁屏 | 音频持续，通知显示台名/曲讯 |
| 蓝牙下一曲/上一曲 | 收藏台切换 |
| 来电 | 暂停或 duck，通话结束恢复 |
| 拔耳机 | 自动暂停，不重新创建错误链 |
| 其他播放器抢焦点 | 暂停/duck，焦点回来可续播 |
| Android 杀进程 | 下次打开可看到最近台；不自动偷偷起播 |
| 用户显式停止 | 清理媒体通知/服务，不被后台 ticker 复活 |

## B.5 进程恢复与最近台

复用已有 `Prefs.RESUME` 与 `radio.recents`，`radio.last` 是遗留迁移键，不是现有契约。不另造 resume 存储或自动续听设置；按 URL 回绑，找不到不创建幽灵台，现有启动行为以源码和测试为准。

## B.6 Android 轻量数据更新

当前实现不是跨文件事务：radio 下载/原子写失败返回 null 并保旧；radio 写成功立即生效。logos 下载或写失败保旧、不阻断；现有 `logosChanged` 只反映下载非空，不能证明写成功。meta 缺失、非法或写失败时尽力删除旧 meta 防混态，stamp 的 meta 标志及 radioHash/metaHash 在读取时核验绑定；删除失败或 stamp 失败由哈希不匹配保守不绑定。stamp 最后尽力写，失败不回滚已生效 radio，旧 stamp 使后续可重试；`Result` 非空不证明 logos/meta/stamp 全成功。补故障注入和可观察结果，必要时扩结果字段，不宣称整批回滚。端内 SyncEngine 写 radio 后删除旧 meta、stamp.meta=false，且其本机时钟 stamp 不是远端 commit 事实。

## B.7 后置真机发布门（不属于本批完成条件）

后置发布门开启后，至少用一台 Android 设备执行以下剧本；本批代码/JVM/fixture 通过不代表这些项目已通过：

```text
1. 冷启动，播放直流台；锁屏 30 分钟，确认无自停。
2. 切换 Wi-Fi/移动数据，确认重连且不串台。
3. 插拔蓝牙耳机，测试播放/暂停/上一收藏/下一收藏。
4. 来电/播放视频抢焦点，确认让位与恢复。
5. 从最近任务划掉应用，重新打开，确认最近台/收藏/质量未损坏。
6. 执行数据更新，模拟中途断网，确认旧资产仍可用。
7. 安装新版本覆盖升级，验证 Store、收藏、配置、sidecar、Widget。
8. 运行 release APK，记录版本、设备、API、网络、持续时间、结果。
```

证据文件建议：`docs/test-reports/android-daily/<run-id>/validation.json`，不提交账号、IP、个人 URL 快照。

---

# C. P1：播放故障诊断与用户自救闭环

虽然部分能力在 A 的详情中心完成，但 C 作为独立用户流程验收。

## C.1 用户流程

```text
点击播放
  → connecting 显示“源 1/4”
  → 失败显示播放事实；真实诊断到达后显示 code/行动建议
  → 自动顺延
  → 成功显示“源 3，direct，延迟/码率”
  → 用户打开详情
  → 重测/复制/禁用/追加/恢复默认/刷新
  → 下次按成功记忆播放
```

## C.2 播放失败事实与详情诊断

Player 已有 `refresh()`，复用而非新建 `refreshCurrent()`；必要时新增只读不可变失败快照：播放模式、发生时间、error/watchdog/exhaust 事实、尝试数和实际源身份，不能凭 audio/HLS error 猜测 NETWORK/HTML/HTTP 或 httpStatus。code 只能来自真实 checkDetail 结果并标明检测时间，历史与当前播放事实分开展示。级联耗尽不等于停运。`getSourceState()` 仅当前台且返回 `sourceIndex`，不能当其他台成功源；若提供“播放成功源”，必须从对应台已验证的 QualityStore 源记录选启用源，找不到不瞎猜。

复用 `checkStationSources`、`recheckSource`、`playSource`、`Player.forgetSrc` 与 `refresh`。`resetSrcDefaults` 与清成功记忆、草稿清人工排序不是同一操作，分别标注并测试。详情请求 generation 与复制脱敏规范见 A.3.2。现有 openDetail 已自动诊断；禁止叠加无界事后自动诊断，新增事后探测默认用户点击触发；若未来自动化须显式限流、单飞、世代令牌、手动暂停守卫，避免隐形重复开流。



## C.5 Android 平价

`AppVm.checkDetailSources()` 已有 Android 直连 CheckStream 路径。补齐：

- 结果按 `sourceUrl` 映射；
- `DiagnosticAction` 与 Web 固定枚举一致；
- HTTP 401/403 仍使用现有 `code=HTTP`，通过 `httpStatus` 和固定行动文案显示“需要配置/服务拒绝”；不新增 AUTH/PERMISSION code，也不写 `Health.dead`；
- `SrcSheet` 增加“重测全部启用源”“清除成功源记忆”。

---

# D. P1：精选发现与来源分层（本地派生 + 独立第三上游试点）

## D.1 目标与非目标

目标：让用户在不搜索全库的情况下，快速找到可信台。

发现分为两层：

1. 本地派生层：使用当前已装配电台、QualityStore、radio-meta、radio.recents 和收藏；不改变主列表排序。
2. 第三上游测量层：对 [recommended-radio-streams](https://github.com/deroverda/recommended-radio-streams) 先做 C2 测量 Spike。只有测量显示有足够增量价值、网络与耗时可接受，并经用户确认，才进入 C3 正式接入；**本阶段不生成正式 `radio-discovery.json`，不修改 `radio.txt` 或 `SYNC_ASSETS`，不接入 `/api/sync` 或 Android 轻更新**。

### D.1.1 C2：测量 Spike（先交报告，不改正式资产）

拟新增独立 CLI `tools/measure-recommended-radio.js`，使用 Node 内置模块与现有 `checkDetail/safeTarget/guardLookup`；不增加 npm 依赖。CLI 只由维护者显式执行，不挂到 `npm run sync`、启动任务或 PR 离线测试。

测量步骤：

1. 固定上游 commit，记录仓库、CC0-1.0 许可与测量时间；读取该 commit 的 `playlists/` 文件清单，再读取 m3u。review 报告的 16 个文件、约 62KB 仅作待复核快照，不能硬编码为长期事实。
2. 解析 `#EXTINF` 与 URL；保存英文流派 slug 作为报告标签，暂不映射到正式中文分类。台标缺失保持空，不额外全量抓图。
3. 与当前主库只读比对：精确 URL 为主去重键；另输出仅做保守规范化后的重叠率（保留 path/query，不剥除可能影响授权/频道的参数）。同名不同 URL 只列为疑似重叠，不自动合台。
4. 跨 m3u 去重后逐条 `checkDetail`，复用默认超时与安全护栏；并发上限 4，按 URL 确定性排序。单轮最多测 300 个不同 URL，超过时报告截断范围，不能把抽样结果冒充全集。
5. 分开记录上游获取失败、探活结构化 code、网络 errno 和程序异常。首次失败不能直接判上游无价值；明显环境故障应复测。
6. 只写独立报告目录（例如 `docs/test-reports/recommended-radio/<run-id>/`），包含 JSON 和简明 Markdown；不调用 `publishSync/publishResult`，不写公共电台、manifest、用户 Store 或个人列表。

报告必填：固定 commit/文件清单、原始条数、精确 URL 去重数、与主库重叠数/重叠率、真正新增且探活通过数、总体/分流派存活率、code/errno 分布、探活延迟分布、总耗时、台标覆盖率、截断数量、测试环境/网络方式与限制。`checkDetail=OK` 只代表字节/协议通过，不等于内容正确；最终精选需对少量新增代表台做实际试听验收。

**达标评审门**：先收集上述数据，再确定并确认新增可用台数量、存活率、耗时预算和重叠率的具体接受阈值；本次没有擅自设定数值阈值。未确认阈值或结果不达标时，停止在报告阶段，不自动启动正式接入。网络被代理时不能把测量称为“国内直连”。

### D.1.2 C3：测量达标后的正式接入设计门

测量通过并经确认后，才补齐以下设计再编码：

- 英文流派到中文分类映射、URL/同名去重、300 上限的选择/排序规则；
- 候选 sidecar（`radio-discovery.json` 仍是候选名称，原草案 schema 不再视为冻结契约）、来源/许可/commit 记录；
- 独立发布/manifest 与旧快照回退，是否加入 `/api/sync`、如何避免影响既有四资产协议与欧美塌陷门；
- Android 打包/轻更新/端内同步的投递和失败保留路径；
- 发现页试听对象如何进入现有播放/统计/收藏生命周期，以及显式加入个人层的身份回绑；
- Web/Android/契约/资产测试与回滚开关。

保留的产品意图是：不直接覆盖国内/现有欧美主层；发现页可试听，用户显式加入才写个人层。但这些交互必须在 C3 的正式资产与身份设计补齐后才实现，不能据本段提前生成生产资产。

非目标：推荐算法、云端个性画像、实时热门、地理浏览、按省份再拆分类。

## D.2 来源层模型

台级聚合所有可证明 source upstream 集合，可并列展示；未知/local 不冒充已知上游。STARTER 标识 `om` 不覆盖真实来源。个人来源必须在主库、STARTER、my-radio、维护追加源装配时显式携带运行时 origin 标志并跨端镜像：区分个人层与个人调整，按 URL 回绑，不能猜分类、dCat 或不存在的 kind=personal；混合来源保留集合，不回写公共 meta。

## D.3 发现纯函数

增量扩展现有 `buildDiscovery(input)` 和 Android `Discovery.Groups`，不复制其过滤器或重建返回模型。保留 starter/stable/fresh/revived/icy/unheard、unknown、手动隐藏、dead 的 playingKey 与 connectingKey 双例外，recents 的 key/URL 双判定；新增 recentlyVerified/needsAttention 在同一合格 rows 管线内派生，排序后截 20（时间倒序、URL 稳定 tie-break），对过期/未来 verified 保守处理。原组顺序及排序不变；同 fixture 测比较跨端组和顺序。

建议第一版展示分组：

1. 精选；2. 稳定直连；3. 最近新增（fresh）；4. 最近恢复；5. 有曲讯；6. 未听过；7. 最近验证；8. 需要关注。

`needsAttention` 不是“坏台列表”，详情文案必须写“建议重测”，不自动隐藏。

## D.4 Web 接线

- `features.js` 新增 `sourceExplain: true`（发现仍由 `discovery` 控制）；
- `app.js` 现有发现入口增加来源 badge 和质量摘要；
- 点击发现卡片统一 `App.play(s)`；
- 发现页切换不修改 `state.cat` 主列表筛选；
- 卡片操作只允许播放、收藏、打开详情；
- 无质量数据分组不显示“稳定/不稳定”，只显示“暂无样本”。

## D.5 Android 接线

增量扩已有 `Discovery.Groups`，保留已有字段与分组顺序，新增字段默认空；Android UI 同 Web 空态，不新增独立推荐数据源。

## D.6 测试

- `test/discovery.js`：隐藏台、dead 台、无质量、过期 verified、收藏/最近、分组上限、去重。
- Android `DiscoveryTest.kt`：相同 fixture 组 ID/顺序一致。
- 浏览器：发现卡点击播放不产生第二套播放状态；返回主列表筛选不被改变。
- C2 测量脚本：离线 fixture 覆盖 m3u 解析、跨文件重复、主库重叠、同名不同 URL、300 截断/确定性顺序、上游失败、报告计数；网络测试只用本机 fixture，不在 PR 连公网。
- 对测量前后的四生成资产、manifest、个人列表和 Store 做字节级快照断言，证明 Spike 零业务写入；报告输出目录除外。
- 新增测试必须登记进 `test/run.js` 对应 profile 白名单，避免 `npm run test:unit` 漏跑；C3 的资产/Android/UI 测试在正式接入设计门中另行冻结。

---

# E. P1：低打扰自动新鲜度（启动检查 + 提醒，默认不自动发布）

## E.1 明确语义

### 默认行为

- 启动后首屏完成，再检查本地资产上次同步时间；
- 超过 14 天（建议默认）显示一次可关闭 toast/卡片；
- 用户点击“立即同步”才调用现有 `/api/sync`；
- 不自动发布、不静默下载完整上游、不抢占正在播放；
- `file://` 只显示“请在 npm start 下同步”或静默跳过；
- 用户可选择 7 天、14 天、30 天或关闭提醒。

### 事实与用户偏好分离

唯一新持久键 `radio.syncFreshness`，形状 `{reminderDays,disabled,dismissedUntil,lastPromptAt}`，上限 1024 字节；坏 JSON、非法数值及未知字段安全归一，7/14/30 天，默认 14，disabled 默认 false。Store/server/Android C.KEYS、contracts/radio-keys、backup v3/schema/fixtures 三侧同步。不存在 `radio.lastsync` 迁移。不保存 lastSuccessAt/lastVersion；同步/备份不伪造资产事实。

资产事实由当前实际生效批次独立提供 `{version, refreshedAt, provenance}`：Web 只从经验证、与生效资产一致的 manifest/stamp 和可信生成流程读取；Android 只用与当前生效 radio 绑定的可信远端 commit 或明确端内真实同步成功事实。`generatedAt`、`commitIso` 必须标注来源：bootstrap/init 生成时间和 Android SyncEngine 的本地当前时钟 stamp 不能冒充上游刷新。既有 stamp 缺乏证明时为 unknown，实施须增加可校验 provenance/事实接口，不能将 bootstrap 当成功。CLI 同步或 git pull 后重新读取当前有效 manifest，不能依用户键；多浏览器取同一服务端事实，用户键沿用 Store LWW，不能承诺跨客户端恰好一次。Android 包内资产取可证明的打包时间/版本，否则 unknown；LightUpdate 的 radio 已生效但 stamp 写失败视为事实未知而非回滚。允许显示“时间未知，请手动检查”，不能断言刚更新或无限静默。

### E.2 统一状态机与时钟

JS/Kotlin 共享 fixture 与 epoch 毫秒算法，均注入 now：仅可信且 `0 < refreshedAt <= now` 的时间参与过期判断，未来/非法时间为 unknown；不依时区。可信时间年龄 `>= reminderDays * 86400000` 为 due；unknown 可提示“时间未知”。disabled、未到 dismissedUntil 或短冷却时不提示；lastPromptAt 仅短防重复（例如 1 分钟），绝不参与 7/14/30 天资产年龄计算。未来的 lastPromptAt 一律视为 0；dismissedUntil 超过 now+24h 一律视为 0，介于 now 与 now+24h 才抑制，避免时钟回拨无限等待；测试时钟前后跳，前跳可能提前到期但不得当成资产更新；短冷却固定 1 分钟；显式稍后按当前时钟设置 `dismissedUntil=now+24h`，短冷却不应把 24h 延到 14 天。首次提示后同一 boot 防重，跨 boot 按上述规则计算；取消/失败不更新资产事实。

### E.3 接线与失败语义

首屏与 Store.load 后检查，播放、connecting、体检、同步在忙时延迟而非抢占，空闲再检查；现有 sync busy 范围先核验，新增明确的同步在途状态。file:// 不自动联网，提供启动服务提示或跳过。明确扩展现有 toast 实际关闭/稍后回调并接 `markDismissed`；用户点击立即同步走现有手动两步质量门，禁止自动 POST。显示时只记 lastPromptAt，稍后/关闭具体动作记 24 小时抑制，关闭提醒设置 disabled；失败、取消、质量门中止、409 busy 均不改资产事实，不冒充成功。主层成功但某上游保留旧层的部分更新应展示各层结果，不将旧层标新；若无法证明分层时间，以 unknown 提示。发布成功后重新读取并验证实际生效资产事实，不以响应 ok 或客户端当前时间臆造。

Android 复用已有 metered/NetworkPolicy，移动数据需用户确认，禁止策略给设置入口；不凭臆造接口阻断播放。LightUpdate 部分成功按 B.6 展示；stamp 失败或混态返回 unknown；端内同步成功与实际提交结果/时间分开见证，不自动将本地 stamp 冒充远端 commit。JS/Kotlin 在相同输入下输出相同状态；播放、取消、409、异常及重启均可复测。



## E.6 测试

- `test/freshness.js`：空状态、7/14/30 天、off、`dismissedUntil` 24 小时抑制、坏 JSON 默认、成功/取消/失败。
- `test/store.js`：新增键三侧白名单与迁移幂等。
- `test/sync.js`：提醒点击触发同步；提醒不自动 POST；播放中不弹；同步 409 不写成功时间。
- Android `FreshnessTest.kt`：时区无关 epoch 计算、坏 JSON、移动数据二次确认。
- 浏览器：刷新页面不重复弹出；“稍后”不会把成功时间更新为现在；关闭提醒永久不弹直到用户恢复。

---

# F. 跨端契约与迁移总表

## F.1 必须同步的文件

| 变化 | Web | Android | 契约/测试 |
|---|---|---|---|
| `radio.syncFreshness` | `store.js`、`server.js` | `Consts.kt`、Store | `contracts/radio-keys.json`、backup v3、fixtures、contracts test |
| meta source 字段 | `update-sources.js`、`app.js` | `RadioMeta.kt`、Discovery | metadata fixture、Android ContractTest |
| quality explain | `quality-store.js` | `QualityStore.kt` | quality fixture、JS/Kotlin unit |
| discovery 分组 | `app.js` | `Discovery.kt`/UI | discovery fixture、Web/Android unit |
| diagnostic action | `update-sources.js`/app | `CheckStream`/AppVm | diagnostic fixture、错误码测试 |
| C2 第三上游测量 | 独立 CLI 与报告，无生产写入 | 本阶段不新增投递 | m3u/去重/截断/零业务写入 fixture；不扩 `SYNC_ASSETS`、备份或 Store |
| C3 正式精选候选资产 | 仅测量达标并确认后设计 | 届时明确打包/轻更新路径 | 届时冻结 schema、manifest、回退、跨端测试；本阶段不实施 |

## F.2 备份策略

- `radio.syncFreshness` 进入 backup v3 `data` 白名单；旧备份缺失时使用默认值，不阻止导入。
- `radio-meta` 和 `quality` 继续按 sidecar 策略，不把完整诊断事件/服务端 op log 放入备份。
- 导入旧 v1/v2 时不创建假的 freshness 成功时间；使用默认 0，让用户看到一次新鲜度提醒。
- source 元数据缺失按未知，不影响电台播放。

## F.3 版本与回滚

- 先发布契约兼容版本：新客户端能读旧数据，旧客户端忽略新 sidecar 字段。
- 再翻转 UI/提醒 feature flag。
- Web `features.js` 与 Android `FeatureFlags` 分别管理各自真实开关，不加入无意义的 `window.FEATURES.androidDailyEvidence`，发布配置不进用户 Store。
- 新质量字段解析失败时回退旧摘要，不阻塞列表和播放。

---

# G. 编码任务拆解（可直接交接）

## G.1 Batch A

1. 新建 `contracts/source-meta.json` 和对应 fixture，冻结 source 字段；不要修改语义不同的 `contracts/metadata-event.json`。
2. 扩 `buildRadioMeta()`，补旧字段默认值和测试。
3. 增加并导出无状态纯函数 `qExplain/diagnosticAction`，JS/Kotlin 双实现；不挂 `QualityStore.explain` 单例。
4. 详情中心接入质量摘要、固定行动按钮、复制诊断摘要。
5. Player 按 C.2 增加真实失败事实只读快照，复用 `refresh()`。
6. Android `RadioMeta`、`QualityStore`、`SrcSheet` 平价。
7. 跑 contract/unit/api/browser；补质量和诊断 fixture。

## G.2 Batch B

1. 核验已合并 Android UI 与现有播放、Prefs.RESUME、LightUpdate、SrcSheet；仅补真实缺口和自动化。
2. 不重写服务；补部分成功/混态/写失败测试。
3. 真机长听、网络切换、焦点、升级与报告均属 B.7 后置发布门，本批不宣称通过。



## G.3 Batch C：C1 本地发现 → C2 测量 → C3 条件接入

### C1 本地派生（不依赖第三上游测量是否通过）

1. 冻结 source badge / upstream 兼容字段。
2. 增量扩展现有 `buildDiscovery()`，不复制播放逻辑。
3. Web 发现页接入分组、来源 badge、质量摘要。
4. Android Discovery 模型和 UI 同步。
5. 补跨端 discovery fixture 和 UI smoke。

### C2 recommended-radio-streams 测量 Spike

1. 新增独立只读测量 CLI，固定上游 commit 并记录文件清单/许可。
2. 解析 m3u、对主库精确 URL 去重和重叠统计，再做限并发/限数量的 `checkDetail` 测量。
3. 输出 D.1.1 定义的 JSON/Markdown 报告；不改正式资产/manifest/Store，不接生产同步和 Android。
4. 补解析、去重、截断、报告计数和零业务写入测试，登记测试 profile。
5. 根据测量报告确认量化接受阈值，给出继续或暂停结论；未通过不得进入 C3。

### C3 正式接入（有条件后续任务）

只有 C2 达标并经用户确认后，补齐 D.1.2 的 sidecar/schema、分类、发布回退、Android 投递、身份与播放接线以及测试设计，再进入实现。原 `radio-discovery.json` 草案不能直接作为已冻结接口使用。

## G.4 Batch D

1. `freshness.js` 纯函数 + tests。
2. Store/Server/Android/backup/contracts 扩 `radio.syncFreshness`。
3. `radio.syncFreshness` 缺失/坏 JSON 统一按首次提醒默认值处理；不迁移不存在的 `radio.lastsync`，保持解析幂等。
4. 启动检查 + toast 确认，不自动 POST。
5. 成功/取消/409/播放中状态测试。
6. Android 网络策略和移动数据二次确认。

---

# H. 验收命令与发布门

## Web

```bash
npm run test:contract
npm run test:unit
npm run test:api
npm run test:browser
npm run test:nightly -- --quick
```

真实源和长听在发布前单独运行：

```bash
npm run test:nightly -- --real
npm run test:nightly -- --soak=60
```

真实源健康类失败只进入报告；程序错误、契约回归和安全回归必须非零退出。

## Android

```bash
cd android
./gradlew test
./gradlew assembleDebug
./gradlew assembleRelease
```

本批不执行 B.7 后置真机剧本；未来开启发布门后再按该剧本验收，发布报告必须记录：

- APK versionCode/versionName；
- commit SHA；
- 设备型号/API；
- 网络类型；
- 测试开始/结束时间；
- 各项 pass/fail；
- 失败日志脱敏摘要。

---

# I. 最终产品验收标准

五项全部完成后，用户应获得以下体验：

1. 列表中的电台有可解释来源和质量摘要，但不会被一次网络波动粗暴隐藏。
2. 播放失败时可以直接重测、换源、刷新、复制诊断或追加救援源。
3. Android 代码和自动化完成后不依赖 Web localhost；锁屏、耳机、来电、弱网和进程回收是否可日用，须以后置真机发布门的真实证据为准。
4. 发现页优先展示本地可信台，不因引入全球大库而增加噪声和网络依赖。
5. 列表过期时只提醒用户确认，不在后台偷偷同步、耗流量或抢占播放。
6. Web/Android/备份/契约对旧数据兼容，任何新增字段都能通过 fixture 和回滚验证。

> 交接要求：接手者先实现 Batch A 的纯函数与 fixture，再进入 UI；Batch B 必须先读 `android/README.md`、`android/CONTRACTS.md` 和本文件 B 节；Batch D 不得绕过现有 `/api/sync` 两步质量门。
