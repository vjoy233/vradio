# VRadio 扩展功能实施计划（r4）

> 计划日期：2026-11-14
> 适用基线：`feat/android-batch1`（Web + Android monorepo）
> 文档性质：实施计划，不直接修改源码；本文已吸收 2026-11-14 review 和后续拍板，可作为直接开工基线。
> 范围：电台详情与逐源诊断、备选源生命周期、源质量、同步质量、本地发现、PLS/XSPF/ASX 导入、备份 v3、Web/Android 契约校验、Android Widget、网络与流量保护、Android Auto、回听与时移、元数据 v2、本地收听统计。

## 1. 先确定实施原则

这批功能不能按用户编号顺序开发。正确顺序是先处理共享领域模型和数据契约，再处理源诊断与同步质量，然后做发现、导入和备份，最后做 Android 原生能力和时移实验。

原因是：详情中心需要区分电台、源和播放变体；源管理需要在不破坏 URL 身份的前提下扩展 `radio.cfg`；质量中心需要结构化探活结果；备份 v3 和持久键契约必须在新增配置之前冻结；Widget 和 Android Auto 依赖稳定的播放状态与 MediaSession；时移会触碰播放引擎边界，必须独立做 Spike。

继续保持这些硬约束：

- Web 零 npm 依赖、无构建步骤、经典 script 顺序；
- Android 依赖白名单封闭，不因为 Widget、Auto 或时移随意引入库；
- `radio.txt`、`logos.txt`、`my-radio.txt` 行格式继续是 Web/Android 共同契约；
- URL 是电台持久身份，名字只是显示层；
- 源地址全部视为不可信输入，继续复用 `safeTarget`、`guardLookup` 和字节级探活；
- 运行时不依赖 Radio Browser 或其他境外在线目录；
- 不引入账号、云同步、遥测和远端收听画像；
- 健康、质量和统计数据不能无限增长；
- 外部项目只借鉴功能和实现原理，不复制代码。

本轮已拍板的实施边界：

- QualityStore 是“本机共享质量数据”：Web HTTP 形态通过专用 API 写入 `data/quality.json`，同一实例的浏览器标签页共享；Android 写入应用私有文件。它不进入 `radio.*` 主 Store。
- `--force` 支持本地 CLI 和 Web 一次性人工确认两条入口；Web 必须使用绑定当前质量报告指纹、5 分钟过期且单次消费的 token。两条入口都不能绕过安全解析、非法 URL 过滤、生成物校验、manifest 提交和写盘失败。
- 人工源排序同时同步实现于 Web 和 Android，使用相同 `radio.cfg` 字段和决策优先级。
- 手动禁用源后，诊断中心不得发起探活；界面必须明确显示“该源已被手动禁用，不能诊断”，并提供“取消禁用”入口。
- 同步发布保留根目录现有生成物；通过根目录 manifest 表示当前批次，不能只把生成物藏进版本目录。
- `radio-meta.json` 是 Android 同步资产，必须与 `radio.txt`、`logos.txt` 一起下载/打包并校验版本。
- 备份 v3 默认不带 sidecar，但提供显式可选导出开关；导入时 sidecar 也必须经过校验、容量裁剪和事务提交。
- 本次开发迭代包含 B0、B1、B2、B3。B0+B1+B2 是核心发布单元；B3 是独立发布单元，可以在同一迭代开发，但必须有自己的完成门槛、功能开关/可回滚提交和独立验收。B3 不得反向阻塞 B0+B1+B2 的核心发布。
- 主源可以被手动禁用；若整台电台没有任何启用源，播放按钮必须明确提示并保持停播，不自动更换 identityUrl。
- QualityStore 样本来自诊断结果和真实播放事件；自动体检只写诊断事件，不把自动体检伪装成真实播放质量。
- 本轮 review 已确认：B3-A 不允许因 feature flag 关闭而让现有曲讯、码率、MediaSession 或 `radio.songs` 回归；采用统一 `MetadataEvent` 入口，按开关选择 legacy sink 或 v2 sink。
- QualityStore 多标签写入采用幂等操作事件合并，不采用整段数据 last-write-wins；相同操作重试不得重复计数。

### 1.1 当前真实代码入口

| 能力 | Web | Android | 现状 |
|---|---|---|---|
| 电台装配 | `app.js` `applySources/applyCfg/rebind` | `data/Library.kt` | 主库、精选层、个人层、维护层已存在 |
| 播放决策 | `player.js` `variants/srcOrder/play` | `player/PlayerHolder.kt` | 成功源记忆、级联、自愈、刷新已存在 |
| 探活 | `update-sources.js`、`server.js /api/check` | `check/CheckStream.kt` | 字节验收和 HLS 分片探测已存在 |
| 健康标记 | `radio.health`、`sync.js` | `check/Health.kt` | 疑似/停运两档和 TTL/FIFO 已存在 |
| 维护源 | `radio.cfg.srcs` | `data/Cfg.kt` | 已支持追加源，尚无完整生命周期管理 |
| 备份 | `app.js` 导入导出 | `data/Backup.kt` | Android 已是 v2；Web 仍是 v1，需先补 v2 兼容再升级 v3 |
| 曲讯 | `/api/nowplaying`、`app.js` | `PlayerHolder` `IcyInfo/IcyHeaders` | 两侧均有曲讯，事件模型尚未统一 |
| Android 播放服务 | Web MediaSession 对应物 | `PlaybackService.kt` | 已有 MediaSessionService，尚无 MediaLibrary 浏览树 |

## 2. 统一领域模型

后续实现必须使用下面的词义，不要把“台”“源”“变体”“探活”和“质量”混为一个对象。

### 2.1 Station：电台身份

```text
Station
  identityUrl = s.u[0]
  displayName = s.n
  category = s.c
  sourceUrls = s.u[]
  logo = s.l
  hidden = s.hidden
  healthMark = radio.health 中按 URL 回绑的标记
```

约束：`identityUrl` 永远是台的持久身份；改名、移动分类、追加源不能改变它；收藏、最近、成功源记忆和健康标记都按 URL 回绑。

### 2.2 Source 与 Variant

Source 是 `s.u[]` 中的原始流地址。Variant 是播放器实际尝试的地址，例如蜻蜓 m3u8 展开的 mp3 地址、原始 m3u8 地址和 Web 代理地址。

```text
Source
  stationIdentityUrl
  sourceUrl
  sourceIndex
  indexSpace = raw station s.u[]
  origin = upstream | starter | my-radio | user
  enabled
  lastKnownHealth

Variant
  sourceUrl
  variantUrl
  mode = direct | hls | proxy
  sourceIndex
```

Variant 不能作为收藏键或电台身份。

### 2.3 DiagnosticResult 与 QualityAggregate

一次探活只描述一次操作，长期质量另存聚合值。

```json
{
  "url": "https://example.test/live.m3u8",
  "ok": true,
  "code": "OK",
  "hls": true,
  "mode": "direct",
  "httpStatus": 200,
  "contentType": "application/vnd.apple.mpegurl",
  "bytes": 8120,
  "latencyMs": 740,
  "why": "hls分片 8120B",
  "checkedAt": 1731500000000
}
```

```json
{
  "identityUrl": "https://main.example/live",
  "sourceCount": 3,
  "directCount": 2,
  "okCount": 18,
  "failCount": 4,
  "lastOkAt": 1731500000000,
  "lastFailAt": 1731490000000,
  "lastPlaybackAt": 1731495000000,
  "lastObservedAt": 1731500000000,
  "avgLatencyMs": 580,
  "disconnects": 2,
  "metadata": "icy|none|mixed",
  "stability": "good|fair|poor|unknown"
}
```

`radio.health` 继续负责“是否隐藏/是否停运”；QualityAggregate 负责“稳定性/延迟/断流/播放方式”。两者不能合并。

`lastObservedAt` 是派生字段，定义为 `max(lastOkAt, lastFailAt, lastPlaybackAt)`；没有对应样本时保持 0/null。发现页只能使用这个已定义字段，不能自行引入 `lastSeenAt` 等别名。

### 2.4 SyncCandidate、MetadataEvent、ListeningSession

```text
SyncCandidate
  stationName / category / url
  upstream / upstreamId / logoUrl
  sourceLine / normalizedUrl / duplicateKey
  validationResult

MetadataEvent
  stationIdentityUrl / title / artist / track / program
  bitrateKbps / source / at / confidence

ListeningSession
  stationIdentityUrl / startedAt / lastPlayingAt
  accumulatedMs / sourceUrl / sourceMode / interruptionCount
```

时移实验另外使用 `TimeshiftBuffer`，不进入备份、`radio.*` 或统计。

## 3. 总体批次和优先级

成本按熟悉当前代码、包含基本测试和文档、不含长期内容维护估算。

| 批次 | 内容 | 优先级 | 成本 | 依赖 |
|---|---|---:|---:|---|
| B0 | 领域模型、契约清单、测试支架、迁移策略、sidecar 协议 | P0 | 4–6 人日 | 无 |
| B1 | 探活结构化、详情中心、源生命周期 | P1 | 10–16 人日 | B0 |
| B2 | 质量摘要、sidecar API、同步去重、来源追踪、替换前校验和 manifest 发布 | P1 | 13–20 人日 | B0，部分依赖 B1 |
| B3 | 元数据 v2、收听统计、本地发现页（独立发布单元） | P2 | 8–13 人日 | B0、B2 的质量数据 |
| B4 | PLS/XSPF/ASX、备份 v3、可选 sidecar 导入导出 | P2 | 9–13 人日 | B0 |
| B5 | Android Widget、网络策略和流量保护 | P3 | 7–12 人日 | B0、播放状态稳定 |
| B6 | Android Auto / MediaLibrary | P4 | 8–15 人日 | B5 部分、MediaSession 稳定 |
| B7 | 回听与时移 Spike | P4 | 3–5 人日 | 独立，可在 B2 后开始 |

推荐顺序：

```text
B0 契约与测试支架
  ↓
B1 探活结构化 → 详情中心 → 源生命周期
  ↓
B2 质量摘要 + 同步质量管线
  ↓
B3 元数据 v2 → 统计 → 发现页（独立发布单元，可与 B0–B2 同迭代交付）
  ↓
B4 导入格式 + 备份 v3
  ↓
B5 Widget + 网络/流量策略
  ↓
B6 Android Auto

B7 时移 Spike 独立推进，不能阻塞主线
```

核心发布单元预计 27–42 人日，包含 B0、B1、B2、Web/Android 自动化测试、manifest 回滚和一次性 Web 强制同步协议。B3 追加 8–13 人日；本次迭代总实现量预计 35–55 人日，预留 15%–25% 集成缓冲后按 40–69 人日排期。B3 可以在 B2 的纯函数和 sidecar 协议稳定后并行开发，但不得在 B2 契约冻结前自行增加 `radio.*` 键。

## 4. B0：共享契约、迁移和自动化门禁

### 4.1 根契约文件

新增：

```text
contracts/radio-keys.json
contracts/backup-v3.schema.json
contracts/source-diagnostic.json
contracts/metadata-event.json
contracts/quality-summary.json
```

`radio-keys.json` 初始只收现有 13 个共享键：

```json
{
  "version": 1,
  "keys": {
    "radio.favs": { "type": "json", "backup": true },
    "radio.recents": { "type": "json", "backup": true },
    "radio.health": { "type": "json", "backup": true },
    "radio.cfg": { "type": "json", "backup": true },
    "radio.songs": { "type": "json", "backup": true },
    "radio.volperst": { "type": "json", "backup": true },
    "radio.srcmem2": { "type": "json", "backup": true },
    "radio.vol": { "type": "string", "backup": true },
    "radio.view": { "type": "string", "backup": true },
    "radio.showdead": { "type": "string", "backup": true },
    "radio.theme": { "type": "string", "backup": true },
    "radio.baseline": { "type": "string", "backup": true },
    "radio.baselineProg": { "type": "string", "backup": true }
  },
  "excluded": ["radio.logos", "radio.storeDirty"]
}
```

持久化分三类，先冻结边界再实现：

1. `radio.*`：只放 Web/Android 共同消费、需要主 Store 仲裁的用户状态；本轮仍是现有 13 键。
2. sidecar：质量、诊断历史、收听统计，以及可选备份中的 sidecar 数据；不进 `/api/store`，不占用主 Store 2MB 配额。
3. 运行时缓存：台标、Widget 快照、时移环形缓冲；可丢失、可重建，不进入 v3 默认备份。

QualityStore 是本机共享质量数据。Web HTTP 形态必须通过专用 `/api/quality` 读写 `data/quality.json`，不能让浏览器直接访问 `data/`，也不能把质量数据塞进 `radio.*`。Android 写入 `filesDir/quality.json`。`listen-stats` 默认是用户本地 sidecar；若启用 v3 sidecar 导出则随备份携带，但不参与主 Store 仲裁。

本轮不增加 `radio.collections` 或 `radio.notes`。`radio.notes` 如未来正式立项，必须重新更新三侧键白名单、备份 schema 和契约测试；v3 的 `extensions` 本轮保持空对象。

### 4.2 自动契约测试

新增 `test/contracts.js`，在 `npm test` 中执行。它读取契约文件，并比较：

- `store.js` 的 `KEYS`；
- `server.js` 的 `STORE_KEYS`；
- Android `Consts.kt` 的 `C.KEYS`；
- Web/Android 备份覆盖键；
- 排除键是否误入主存储白名单；
- `radio.cfg` 迁移入口和 v2 备份兼容入口是否存在。

代码骨架：

```js
// test/contracts.js
const fs = require('fs');
const assert = require('assert');
const spec = JSON.parse(fs.readFileSync('contracts/radio-keys.json', 'utf8'));

function readKeys(file, re) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(re);
  assert(m, `未找到键声明：${file}`);
  return [...m[1].matchAll(/['"](radio\.[A-Za-z0-9]+)['"]/g)].map(x => x[1]);
}

const expected = Object.keys(spec.keys).sort();
const web = readKeys('store.js', /KEYS:\s*\[([\s\S]*?)\]/);
const server = readKeys('server.js', /STORE_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);

function readAndroidKeys(file) {
  const text = fs.readFileSync(file, 'utf8');
  const declared = [...text.matchAll(/^\s*const\s+val\s+K_\w+\s*=\s*"(radio\.[A-Za-z0-9]+)"\s*$/gm)]
    .map(m => m[1]);
  const block = text.match(/KEYS\s*=\s*listOf\(([^)]*)\)/s);
  assert(block, `未找到 Android C.KEYS：${file}`);
  const refs = [...block[1].matchAll(/\b(K_\w+)\b/g)].map(m => m[1]);
  const byName = new Map([...text.matchAll(/^\s*const\s+val\s+(K_\w+)\s*=\s*"(radio\.[A-Za-z0-9]+)"\s*$/gm)]
    .map(m => [m[1], m[2]]));
  assert(refs.length > 0, 'Android C.KEYS 为空');
  const sort = xs => [...new Set(xs)].sort();
  assert.deepStrictEqual(sort(refs.map(k => byName.get(k))), sort(declared), 'Android 常量声明与 C.KEYS 不一致');
  return declared;
}

const android = readAndroidKeys('android/app/src/main/java/io/github/vjoy233/vradio/consts/Consts.kt');

for (const [name, got] of Object.entries({ web, server, android })) {
  assert.deepStrictEqual([...new Set(got)].sort(), expected, `${name} 键集合漂移`);
}

console.log(`contract keys OK: ${expected.length}`);
```

正式实现可以改为生成声明文件，但第一阶段必须保持零依赖、可离线运行。

### 4.3 B0 验收

- `npm test` 包含契约测试并通过；
- `cd android && ./gradlew test` 通过；
- 漏改任一侧白名单能被测试拦截；
- v2 备份样本仍可由 Web 和 Android 读取；
- 每种新数据都明确归类为 `radio.*`、sidecar 或运行时缓存。

## 5. B1：探活结构化、详情中心和源生命周期

### 5.1 结构化探活结果

当前 `checkStream()` 和 Android `CheckStream` 已经有正确的字节级验收，第一步是保留 `ok` 语义并补齐诊断字段。

Web 建议结果：

```js
{
  url, ok, hls, mode,
  httpStatus, contentType, bytes,
  latencyMs, code, why, checkedAt
}
```

`code` 固定枚举：

```text
OK
NETWORK
HTML
HTTP
EMPTY_PLAYLIST
NO_SEGMENT
SHORT_BODY
REDIRECT_REJECTED
INVALID_URL
```

所有正常、失败、重定向和 HLS 分支都必须返回完整结构，不能让 UI 根据 `why` 文案反推状态。

Android 将现有 `Verdict` 扩展为：

```kotlin
data class Verdict(
  val ok: Boolean,
  val bytes: Long,
  val hls: Boolean,
  val why: String,
  val code: Code,
  val httpStatus: Int,
  val contentType: String,
  val latencyMs: Long,
  val checkedAt: Long
) {
  enum class Code { OK, NETWORK, HTML, HTTP, EMPTY_PLAYLIST, NO_SEGMENT, SHORT_BODY, REDIRECT_REJECTED, INVALID_URL }
}
```

### 5.2 详细探活 API

保留现有 `/api/check?url=`，增加：

```text
GET /api/check?detail=1&url=u1&url=u2
```

返回：

```json
{
  "ok": true,
  "results": [
    {
      "url": "https://example.test/live.mp3",
      "ok": true,
      "code": "OK",
      "mode": "direct",
      "hls": false,
      "bytes": 12000,
      "latencyMs": 320,
      "contentType": "audio/mpeg",
      "httpStatus": 200,
      "why": "audio/mpeg 12000B",
      "checkedAt": 1731500000000
    }
  ]
}
```

安全边界不变：最多 4 个 URL；每个 URL 经过 `safeTarget` 和 `guardLookup`；重定向逐跳复查；跨源请求拒绝；不返回响应体；详细模式不能放宽时间窗口。需要查看超过 4 条源时由前端分批请求，服务端单次放大面封顶不变。

### 5.3 Web 详情中心

新增 `App.detail` 状态和接口：

```js
App.detail = { stationKey: '', results: [], loading: false, error: '', openedAt: 0 };

App.openDetail(s);
App.closeDetail();
App.checkStationSources(s);
App.copySource(url);
App.playSource(s, sourceIndex);
App.recheckSource(s, sourceIndex);
```

详情入口：列表行更多按钮、网格卡片更多按钮、正在播放栏台名、维护面板源管理。

`player.js` 只新增只读状态接口，不让 `app.js` 读取 audio、HLS 或 token：

```js
getSourceState() {
  return {
    station: this.station,
    sourceIndex: this.curSi,
    variantUrl: this.curPlay,
    connecting: !!this.connecting,
    mode: this.curPlay ? (/\.m3u8(\?|$)/i.test(this.curPlay) ? 'hls' : 'direct') : '',
    srcMemIndex: this.station ? (this.srcMem[this.station.u[0]]?.i ?? -1) : -1
  };
}
```

详情页展示：台名、分类、台标、收藏、当前源、每个源的探活结果、直连/HLS/代理模式、源序号、质量摘要、歌曲历史、复制地址、播放此源、恢复默认。

### 5.4 源生命周期管理

现有 `radio.cfg.srcs` 继续表达追加源，增加可选字段：

```json
{
  "srcs": {
    "https://main.example/live": ["https://user.example/live.mp3"]
  },
  "srcManualOrder": {
    "https://main.example/live": ["https://user.example/live.mp3", "https://main.example/live"]
  },
  "srcDisabled": {
    "https://main.example/live": ["https://dead.example/live"]
  },
  "srcLabels": {
    "https://user.example/live.mp3": "车机备用"
  }
}
```

规则：

- `srcManualOrder` 只影响人工默认顺序，不覆盖 `prefer` 和 `srcmem2`；字段名刻意避开播放器现有 `Player.srcOrder()` 方法。
- `srcmem2.i`、`srcDisabled` 和 `srcManualOrder` 的持久索引空间一律以同步原始 `s.u[]` 的 URL/索引为准；`srcManualOrder` 只生成运行时有效顺序，不物理重排 `s.u[]`。播放器按原始索引生成播放顺序，避免人工排序后 `srcmem2.i` 指向错误源。
- `srcDisabled` 是用户明确禁用，播放和自动探活都跳过；
- `srcLabels` 只改变展示；
- 每台最多 6 条源；
- 只接受 `http(s)`；
- 主源身份不可替换、不可删除、不可迁移；首版不提供“选择新主源”。主源故障只能通过追加源、调整人工顺序或禁用其它源处理。
- 清空配置后恢复同步层原始源。

`normCfg()` 增加 `normUrlArrayMap`、`normUrlSetMap`、`normUrlStringMap`；`applyCfg()` 先合并源，再按 `srcManualOrder` 排序和标记禁用；`Player.play()` 最后套 `prefer > srcmem2 > 人工默认顺序 > 启发式`。Web 与 Android 必须共享同一排序规则、禁用规则和迁移样本。

“恢复默认”拆成两个独立动作：

- 恢复默认播放源：只清 `radio.srcmem2`，保留 `srcManualOrder` 和 `srcDisabled`，按人工顺序再按播放器启发式播放；
- 撤销人工源排序：单独删除 `srcManualOrder`，恢复同步原始顺序。

手动禁用源的规则：播放器和自动体检都跳过；详情中心仍显示该源及禁用原因。用户点击诊断时不发请求，显示“该源已被手动禁用，不能诊断”，并提供“取消禁用”操作；取消后才允许诊断。主源也只能被标记禁用，不能被 re-key 成新身份。

若一台电台的全部源都处于 `srcDisabled`，`Player.play()` 不创建 audio/HLS/代理连接，返回可区分的 `NO_ENABLED_SOURCE` 状态；UI 显示“该台所有源都已手动禁用，请先启用一个源”，保持停播。该状态不写入 `radio.health`，也不触发自动复活或 identity 迁移。

### 5.5 Android 详情和源管理

优先扩展现有 `SrcSheet`，不新建完整维护后台：

```kotlin
@Composable
fun SourceDetailSheet(
  station: Station,
  player: PlayerUiState,
  diagnostics: List<DiagnosticResult>,
  onCheck: () -> Unit,
  onPlay: (Int) -> Unit,
  onEdit: (SourceAction) -> Unit
)
```

源配置复用 `CfgCodec` 和 `Library.reapplyCfg()`。Web/Android 的源排序、禁用、恢复默认必须使用相同语义。

### 5.6 B1 测试和验收

新增：

```text
test/diagnostic.js
test/source-lifecycle.js
android/.../DiagnosticModelTest.kt
android/.../CfgSourceLifecycleTest.kt
```

测试覆盖：直流成功、HTML 错误页、336B 假流、HLS 无分片、相对分片、畸形重定向、数量封顶、未知源丢弃、主 URL 不变、收藏/srcmem/health 回绑、旧 cfg 无新字段时行为不变、人工排序 Web/Android 一致、手动禁用源不触发诊断且显示明确原因、取消禁用后才可诊断。

`test/smoke.js` 增加 `/api/check?detail=1` 的方法、跨源、私网、结果不含响应体测试。

验收标准：详情页能解释每个源；用户能调整、禁用、删除追加源并立即播放；同步、刷新和备份导入后不失绑；直流、HLS、代理和蜻蜓换算各验至少一台。

## 6. B2：源质量中心和同步质量管线

### 6.1 QualityStore sidecar

不要扩展 `radio.health` 承担质量历史。建议：

```text
Web HTTP：`GET/POST /api/quality` → `data/quality.json`（本机共享）
Web file://：内存或小型 localStorage 临时降级
Android：`filesDir/quality.json`（本机共享给本 App 的所有页面/组件）
```

不能直接让静态服务暴露 `data/`，也不能把 QualityStore 写入 `/api/store`。Web API 必须复用现有 Store 的安全边界：Host/Origin 校验、请求体和文件大小封顶、串行写队列、tmp + rename、损坏文件按空库恢复、返回 `rev` 或等价版本号。多个 Web 标签页用独立的 `BroadcastChannel('quality')` 通知重拉；客户端不自造服务端版本号。API 只服务本机实例，不提供跨设备同步。

新增 Web `quality-store.js`，Android 新增 `data/QualityStore.kt`：

```js
const QualityStore = {
  load() {},
  get(identityUrl) {},
  recordDiagnostic(identityUrl, result) {},
  recordPlayback(identityUrl, event) {},
  summary(identityUrl) {},
  trim() {},
  save() {}
};
```

建议限制：文件硬上限 2MB；第一版每台最多 6 源，每源保存聚合值、最近一次诊断和最近一次播放失败，不保存 5 条完整历史。若后续增加历史，必须以字节上限为最终约束。超限淘汰顺序固定为：非收藏且非最近播放台 → 最久未访问台 → 源历史较多者 → 最旧诊断；同一时间戳按 identity URL 字典序打破平局。收藏/最近播放优先保留必须通过显式集合和确定性排序实现。

透明分级规则：

```text
good：近 30 天成功率 >= 0.8，平均延迟 < 2500ms，连续失败 < 3
fair：近 30 天成功率 >= 0.5
poor：成功率 < 0.5 或连续失败 >= 3
unknown：样本少于 3 次
```

质量永远不能直接替代死台隐藏条件。

QualityStore 最小接口：

```text
GET  /api/quality?rev=<optional>       -> { rev, data } 或 { rev, notModified:true }
POST /api/quality                     -> { ok, rev, applied }
body: { baseRev, ops }
```

`baseRev` 只是客户端观测版本，不作为整段数据覆盖条件。服务端串行读取当前 sidecar，逐个应用 `ops`，成功后重新计算聚合并发放新 `rev`。同一 `op.id` 已处理过则跳过，保证网络重试、页面刷新和多标签重复提交不会重复计数。只有 schema 错误、单批操作数/字节数超限或无法合并时返回 `409`；普通版本落后不拒绝合并。

`GET /api/quality?rev=x` 命中当前版本时只返回 `{rev:x,notModified:true}`，不重复传输完整 data。POST 写入失败不能影响播放；客户端保留未确认 ops，重拉当前 rev 后继续重试。质量 sidecar 损坏只清空自身，不覆盖 `radio.health`。

操作事件骨架：

```json
{
  "baseRev": 5,
  "ops": [
    {
      "id": "tab-a:1731500000000:1",
      "identityUrl": "https://main.example/live",
      "sourceUrl": "https://main.example/live",
      "kind": "diagnostic",
      "trigger": "manual",
      "ok": true,
      "latencyMs": 320,
      "bytes": 12000,
      "mode": "direct",
      "at": 1731500000000
    }
  ]
}
```

服务端保存有限的 `op.id` 去重记录；去重记录与聚合数据一起受 2MB 硬上限约束，淘汰时不能淘汰仍在客户端 pending 的操作。客户端广播只通知“有新 rev”，不广播完整质量数据。

质量样本来源固定为：

- 手动逐源诊断：写入 `diagnostic` 事件；
- 开机静默体检、同步后增量体检和手动全量体检：同样写入 `diagnostic` 事件，并标注 `trigger=boot|sync|manual`；
- 真实播放成功、断流、重连、切源和播放失败：写入 `playback` 事件；
- 自动体检不得生成 `playback` 事件，不能把“探活成功”计作“用户实际播放成功”；
- `radio.health` 继续只表示死台/停运状态，不能被 QualityStore 聚合结果直接改写。

事件最小结构：

```json
{
  "identityUrl": "https://main.example/live",
  "sourceUrl": "https://main.example/live",
  "kind": "diagnostic|playback",
  "trigger": "manual|boot|sync|play|watchdog|switch|error",
  "ok": true,
  "latencyMs": 320,
  "bytes": 12000,
  "mode": "direct|hls|proxy",
  "at": 1731500000000
}
```

质量聚合不得把 `op.id`、浏览器标签页标识或服务端 rev 暴露到发现页或备份；它们只用于服务端幂等和并发控制。

### 6.2 同步候选管线

把 `update-sources.js` 的同步过程拆成可测试的纯函数：

```js
async function buildCandidates(rawInputs, ctx) {
  const parsed = rawInputs.flatMap(parseUpstream);
  const normalized = parsed.map(normalizeCandidate).filter(Boolean);
  const deduped = dedupeCandidates(normalized);
  const validated = await validateCandidates(deduped, ctx);
  return applyReplacementPolicy(validated, ctx);
}
```

URL 只做保守归一化：去空白、scheme/host 小写、删除默认端口、保留 path/query/尾斜杠语义；不盲删 query，不用重定向后的 URL 替换原 URL。

去重分三层：精确 URL、归一化 URL、同分类同名多源合并。不同分类同名不能强行合并。

### 6.3 来源追踪旁车文件

不改变 `radio.txt` 行格式，新增生成文件：

```text
radio-meta.json
```

```json
{
  "v": 1,
  "generatedAt": 1731500000000,
  "stations": {
    "https://main.example/live": {
      "name": "示例台",
      "category": "华语音乐",
      "sources": [
        {
          "url": "https://main.example/live",
          "upstream": "gao",
          "upstreamId": "optional-id",
          "kind": "main",
          "firstSeenAt": 1731400000000
        }
      ]
    }
  }
}
```

`radio-meta.json` 是 Android 同步资产。Web 与 Android 必须消费同一份文件；Android 更新流程下载/复制时必须验证其版本和 hash，缺失或校验失败时保留旧 meta，并继续允许主库播放。Android 的资产包、更新器和测试 fixture 必须明确包含该文件，不能只更新 `radio.txt`。元数据缺失不能影响播放；同步失败时旧 `radio.txt`、`radio-data.js`、`logos.txt` 和 `radio-meta.json` 一起保留。

体积预算：目标不超过 1MB，硬上限 2MB。每次同步报告记录字节数、电台数、源数、平均每台大小和最大单台记录；超过目标只告警，超过硬上限阻止发布。实现优先从 `radio-meta.json` 删除可由 `radio.txt` 反解的 `name/category` 冗余，不削弱来源追踪字段。

### 6.4 替换前质量门

候选集不能直接覆盖旧库，至少检查：

- 国内格式有效行比例 >= 95%（只检查可解析、分类/台名非空、URL 为 http(s)、无非法字段和重复；不等同于可播率，不触发国内全量探活）；
- 总台数下降超过 20% 时阻止替换；
- 分类数量变为 0 时阻止；
- 欧美层有效数低于上次 60% 时保留旧欧美层；
- 无名称/无分类项不超过 5%；
- 生成物全部成功后才替换。

CLI 增加：

```bash
node update-sources.js --check-only
node update-sources.js --report
node update-sources.js
```

`--check-only` 只生成候选报告，不覆盖正式数据。

增加强制同步路径：

```bash
node update-sources.js --force
```

CLI 路径默认要求交互确认。Web 路径采用两步协议：

```text
POST /api/sync/force-token
  body: { reportHash }
  -> { token, expiresAt, reportHash }

POST /api/sync
  body: { forceToken: token }
  -> token 消费一次后执行本次强制同步
```

服务端生成 token 时绑定当前候选质量报告的 SHA-256 指纹，过期时间为 5 分钟；token 只允许消费一次，并且消费时再次比较当前报告指纹，报告发生变化就拒绝。token 不写入 `radio.*`、localStorage 或长期配置。普通 `/api/sync` 不接受 `force` 字段；前端确认界面必须展示质量报告、触发原因、旧/新数量和即将绕过的规则，用户确认后才申请 token。

CLI 和 Web 强制路径都只能绕过数量下降、分类缩水等“替换决策”质量门，不能绕过 `safeTarget`、`guardLookup`、格式过滤、生成失败、manifest 校验或写盘失败。返回报告使用 `replacement: "forced"`，记录 `forcedReasons`、`reportHash` 和入口类型 `cli|web`。

同步输出统一包含：

```json
{
  "ok": true,
  "total": 1646,
  "added": 32,
  "removed": 14,
  "deduped": 21,
  "invalid": 8,
  "replacement": "accepted",
  "quality": { "oldTotal": 1628, "newTotal": 1646 },
  "addedCheck": [],
  "removedNames": [],
  "sourceMeta": "radio-meta.json"
}
```

### 6.5 B2 测试

新增 `test/sources.js` 和 fixtures：

```text
test/fixtures/sync-good.txt
test/fixtures/sync-drop-80-percent.txt
test/fixtures/sync-empty-category.txt
test/fixtures/sync-bad-lines.txt
test/fixtures/sync-eu-collapse.txt
```

测试 URL 归一化、重复删除、同名多源合并、来源保留、质量聚合、容量裁剪、候选质量不足时旧库完全不变，以及正式替换时 `radio.txt/radio-data.js/logos.txt/radio-meta.json` 同批生成。还必须测试两个标签页同一 `baseRev` 提交不同 ops 时最终两条样本都存在、同一 `op.id` 重试不重复计数、GET `?rev=` 命中只返回 `notModified`、质量 API 2MB/批量操作上限和损坏恢复。

同步实现应先写 `.tmp/sync-<timestamp>/`，质量门通过后发布到根目录现有生成物。多文件 rename 在 Windows 上不是真正事务，因此采用“根目录生成物 + manifest 提交标记 + 启动校验回退”协议：先生成所有文件和 SHA-256，保存上一批根目录生成物及 manifest，再写 `sync-manifest.json.tmp`，确认文件齐全后替换根目录生成物，最后 rename 为根目录 `sync-manifest.json`。manifest 是最后提交的文件。启动/同步前校验 manifest；缺文件或 hash 不匹配时自动恢复上一份完整生成物和 manifest，不能声称多文件 rename 具有全局原子性。发布前不得删除上一批回滚副本；至少保留当前批次和上一批。

## 7. B3：元数据 v2、收听统计和本地发现

B3 是本次迭代范围内的独立发布单元。它的代码、测试和文档必须可以单独回滚；B3 未完成时，B0+B1+B2 仍可作为核心版本发布。使用三个发布开关：`metadataV2Enabled`、`listenStatsEnabled`、`discoveryEnabled`。

开关不新增 `radio.*`：Web 放在独立的 `features.js` 发布配置中，加载顺序为 `store → player → logos → radio-data → features → app → sync`；Android 放在 `FeatureFlags.kt`，由版本发布配置提供默认值。开发构建默认全开，核心版本默认关闭 B3；只有 B3 独立门槛通过后才把对应默认值改为 true。

`metadataV2Enabled` 只控制新增 MetadataNormalizer、MetadataPipeline 及其新增消费方，不关闭基础曲讯。播放层始终发出兼容格式的 `MetadataEvent`；开关关闭时由 `LegacyMetadataSink` 保留现有曲讯显示、icy-br、MediaSession 和 `radio.songs` 行为，开关开启时切换为 `MetadataV2Sink`，两者不得同时写历史。这样 B3 可独立关闭新增管线，但不会让核心版本相对现状回归。

`listenStatsEnabled` 关闭时停止统计事件消费和 sidecar flush，但不停止播放事件产生；`discoveryEnabled` 关闭时隐藏发现入口和派生计算。关闭任一开关都不能清除已有数据，也不能影响主列表、播放、健康、QualityStore 和备份 v3 主流程。

B3 的共同边界：

- 不新增 `radio.*` 持久键；
- 元数据只通过事件进入 App/Library，不让 Player 直接写歌曲历史或统计；
- 收听统计只记录真实播放时间，不把诊断成功当作收听；
- 发现页是本地派生视图，不联网、不改变主列表排序、不创建第二套播放决策；
- 任一 sidecar 损坏、写入失败或超限，只降级对应 B3 能力，不影响普通播放；
- B3 的所有输入和输出都必须有 Web/Android 共享黄金样本。

### 7.1 元数据事件管线

新增 Web `metadata.js`，Android 新增 `MetadataEvent.kt` 和 `MetadataNormalizer.kt`。

```js
function parseIcyTitle(raw) {
  const text = String(raw || '').trim();
  if (!text) return { artist: '', track: '', title: '' };
  const i = text.indexOf(' - ');
  return i > 0
    ? { artist: text.slice(0, i).trim(), track: text.slice(i + 3).trim(), title: text }
    : { artist: '', track: text, title: text };
}

function normalizeMetadata(raw, ctx = {}) {
  const p = parseIcyTitle(raw.title);
  return {
    stationIdentityUrl: ctx.identityUrl,
    title: p.title,
    artist: p.artist,
    track: p.track,
    program: raw.program || '',
    bitrateKbps: Number(raw.bitrateKbps) || 0,
    source: raw.source || 'none',
    confidence: p.artist ? 'parsed' : 'stream',
    at: raw.at || Date.now()
  };
}
```

`PlayerHolder` 的 `IcyInfo/IcyHeaders` 只产生事件并回调 `onMetadata`；Web 的 `/api/nowplaying` 结果也先转换成同一 `MetadataEvent`；`AppVm/Library` 决定当前曲讯、历史和统计。播放引擎不要直接操作 `radio.songs`。Legacy sink 负责兼容现有行为，MetadataV2 sink 负责规范化后的新消费，两者共享同一事件入口。

实现文件和职责：

```text
Web:      metadata.js、player.js 事件适配、app.js 当前曲讯/历史适配、LegacyMetadataSink/MetadataV2Sink
Android:  MetadataEvent.kt、MetadataNormalizer.kt、PlayerHolder 回调、AppVm/Library 消费、LegacyMetadataSink/MetadataV2Sink
契约:     contracts/metadata-event.json、contracts/fixtures/metadata-golden.json
测试:     test/metadata.js、MetadataNormalizerTest.kt、MetadataEventTest.kt
```

规则：清理空白、支持半角/全角连接号、去除重复台名前缀、空曲讯不覆盖有效曲名、切台/刷新/全部失败清空、短时间重复曲名不重复入史。HLS 没有 ICY 时保持空曲讯，不猜歌名。`title` 保留清洗后的完整显示文本；`artist`、`track` 只是可选拆分字段，拆分失败时 `artist=''`、`track=title`。

曲讯事件处理顺序固定为：校验 identityUrl/世代 token → 清洗 → 丢弃过旧事件 → 更新当前曲讯 → 与上一曲比较 → 必要时写入 `radio.songs` → 更新 MediaSession/UI。切台、刷新、全部失败必须先清空旧曲讯，再接受新世代事件，防止旧连接串台。

### 7.2 本地收听统计

统计使用 sidecar：

```text
Web HTTP：本机 sidecar（首版复用 sidecar 读写层，文件为 `data/listen-stats.json`）
Web file://：localStorage 临时降级
Android：filesDir/listen-stats.json
```

```json
{
  "v": 1,
  "days": {
    "2026-11-14": {
      "ms": 1820000,
      "stations": { "https://main.example/live": 1200000 },
      "categories": { "华语音乐": 1200000 },
      "sessions": 3
    }
  }
}
```

保留 90 天，每日一条；暂停、后台无播放、连接中和失败不计入；使用单调时钟计算增量，跨午夜拆分到两个日期；每 30 秒或页面隐藏时 flush；超过 512KB 先删除最早日期；多次 flush 必须幂等。统计写入失败只保留内存增量并在下次 flush/启动重试，不能暂停或中断播放。

代码骨架：

```js
const ListenStats = {
  current: null,
  start(s, source, clock = { mono: () => performance.now(), wall: () => Date.now() }) {
    this.flush();
    this.current = { u0: s.u[0], cat: s.c, source, monoAt: clock.mono(), wallAt: clock.wall() };
  },
  tick(clock = { mono: () => performance.now(), wall: () => Date.now() }) {
    if (!this.current) return;
    const nowMono = clock.mono(), nowWall = clock.wall();
    const delta = Math.max(0, nowMono - this.current.monoAt);
    if (delta >= 1000) { this.add(this.current, delta, nowWall); this.current.monoAt = nowMono; this.current.wallAt = nowWall; }
  },
  stop(clock) { this.tick(clock); this.current = null; this.flush(); },
  add(session, ms, wallNow) {},
  flush() {},
  summary(days = 7) {}
};
```

Android 侧使用同样的纯函数聚合器：

```kotlin
object ListenStats {
  fun add(state: StatsState, session: ListeningSession, now: Long): StatsState
  fun trim(state: StatsState, keepDays: Int = 90): StatsState
  fun summary(state: StatsState, days: Int = 7): StatsSummary
}
```

统计状态机必须区分：`IDLE`、`CONNECTING`、`PLAYING`、`PAUSED`、`FAILED`。只有 `PLAYING` 累加；切源时结束旧 session 并在新源真正进入 `PLAYING` 后创建新 session；同一自然日的连续切源可以累计到同一台。`sessions` 计数口径（AIbot review P2-6 拍板为精确定义，双端实现/测试/android CONTRACTS.md 同文验收）：**session = 从非 `PLAYING` 状态进入 `PLAYING`、且不属于「同一台同一源」的暂停恢复**——play、切台、切源、断流重连后首次到达 `PLAYING` 均计一次；暂停后续播（同台同源 resume 重锚）不开新 session、暂停时长不计；连接中/失败/停机彻底关会话。Android 使用 `SystemClock.elapsedRealtime()` 计算增量，另取 wall clock 做日期分桶；Web 使用 `performance.now()` 计算增量，另取 `Date.now()` 做日期分桶。系统时间回拨不能产生负时长；跨午夜必须把一个 tick 拆分到两个自然日。

### 7.3 本地发现页

发现页不引入在线推荐。第一版使用本地字段：

```text
稳定直连：quality.stability == good 且 directCount > 0
最近新增：radio-meta 的 firstSeenAt 或同步 added
最近恢复：health 从 dead 变为可用
有曲讯：metadata == icy
未听过：不在 radio.recents
精选：`STARTER` 中 identity URL 集合命中的台；不要假设 `radio-meta.json` 自动知道硬编码精选层。若未来需要运营维护精选，再新增明确的 `curated-radio.json`，本轮不在 meta 中伪造 `curated=true`。
```

Web 新增 `App.buildDiscovery()`，Android 使用 `AppVm` 派生 StateFlow。它是独立入口，不改变主列表排序，也不复制播放逻辑，点击结果统一调用 `Player.play`/`PlayerHolder.play`。

发现页的派生规则固定为：

1. 先过滤手动隐藏台；
2. `dead` 台默认过滤，除非产品沿用现有“正在播放例外”口径；发现页首版不提供死台开关；
3. QualityStore 无记录时归入“暂无质量数据”，不得归入 `poor`；
4. 精选使用 Web/Android 同源的 STARTER identity URL 集合；
5. 最近新增优先使用 `radio-meta.firstSeenAt`，没有 meta 时该分组为空；
6. 最近恢复必须有明确的 health 状态转移记录，没有转移记录时不猜测；
7. 领域模型不使用未定义的 `lastSeenAt`；排序字段统一为 `lastObservedAt = max(lastOkAt, lastFailAt, lastPlaybackAt)`，最近新增仍使用 `firstSeenAt`。每个分组最多返回 20 台，组内按对应时间字段降序，再按 identityUrl 字典序稳定排序；
8. 同一台可出现在多个分组，但每个分组内部不得重复。

精选判定使用运行时 `originMask`，不直接按当前 `s.u[0]` 与 STARTER URL 比较。装配层在 STARTER 与主列表按现有精确台名去重时，给运行时 Station 保留 `originMask += starter`；该字段不写入 `radio.txt`、`radio.*` 或备份。这样同名但 URL 已由主列表提供的精选台仍能出现在发现页精选分组。

### 7.4 B3 测试

新增 `test/metadata.js`、`test/listen-stats.js`、`test/discovery.js` 和 Android `MetadataNormalizerTest.kt`、`MetadataEventTest.kt`、`ListenStatsTest.kt`、`DiscoveryTest.kt`。B3 测试必须能单独运行，不依赖真实网络、系统时间或已存在的用户 Store。

黄金样本覆盖 `Artist - Title`、全角连接号、空曲讯、重复台名、同曲去重、旧世代事件、切台后迟到事件、跨午夜、暂停不计时、连接中不计时、90 天裁剪、损坏 sidecar、写盘失败、无质量数据和隐藏/死台过滤。Web/Android 对同一输入必须产生相同的 title/artist/track、统计日桶、累计毫秒、sessions 和发现页分组结果。

B3 独立验收门槛：

- B3-A 元数据：所有黄金样本双端一致；旧事件不能覆盖新台曲讯；HLS 空曲讯不猜歌；`radio.songs` 现有格式不变；
- B3-B 统计：fake clock 覆盖播放/暂停/连接中/失败/切源/跨午夜；重复 flush 结果一致；sidecar 损坏或写失败不影响播放；
- B3-C 发现：不产生网络请求；质量未知不误判；隐藏/死台过滤一致；STARTER 精选一致；主列表排序不变；
- B3 所有测试通过后，才允许开启对应 feature flag；B3 任一子项失败时可关闭对应开关并保留 B0+B1+B2 正常运行。

## 8. B4：PLS/XSPF/ASX 导入和备份 v3

### 8.1 统一导入模型

新增 Web `playlist-import.js`，Android `data/PlaylistParser.kt` 和 `model/ImportedStation.kt`。

```js
{
  name: '台名',
  category: '自定义',
  url: 'https://stream.example/live.mp3',
  logo: '',
  externalId: '',
  sourceFormat: 'pls|xspf|asx|m3u|url'
}
```

入口：`parsePlaylist(text, { format, baseUrl })`。格式识别按显式扩展名/MIME、文件头、内容特征、纯 URL 顺序执行。

### 8.2 格式规则

PLS：读取 `FileN` 和 `TitleN`，`NumberOfEntries` 只作提示，缺标题使用 URL host，最多 500 条。

XSPF：Web 用 `DOMParser`，Android 用 `XmlPullParser`；读取 `location/title/image/album`；禁用外部实体和外部 DTD；相对 URL 按 `baseUrl` 解析。

ASX/WAX/WMX：读取 `ENTRY/TITLE/REF@HREF`，兼容大小写；`ENTRYREF` 不自动递归网络下载；XML 最大 2MB、深度和文本长度封顶。

所有导入 URL 只接受 `http(s)`，不自动探活。导入流程：

```text
读取 → 识别 → 解析清洗 → 预览新增/已知/重复/非法 → 确认 → 已知 URL 回绑，未知 URL 批量追加 my-radio → 后续体检
```

### 8.3 备份 v3

```json
{
  "format": "vradio-backup",
  "version": 3,
  "createdAt": 1731500000000,
  "app": "web|android",
  "data": {
    "radio.favs": "...",
    "radio.recents": "...",
    "radio.health": "...",
    "radio.cfg": "...",
    "radio.songs": "...",
    "radio.volperst": "...",
    "radio.srcmem2": "...",
    "radio.vol": "90",
    "radio.view": "grid",
    "radio.showdead": "0",
    "radio.theme": "auto",
    "radio.baseline": "done",
    "radio.baselineProg": "[]"
  },
  "myRadio": ["自建,#genre#", "我的电台,https://example.test/live"],
  "extensions": {}
}
```

默认不包含 `radio.logos`、`radio.storeDirty`、quality、listen-stats、临时诊断和时移缓冲。导出界面增加“包含本机 sidecar”复选项，默认关闭；开启后才写入：

```json
"extensions": {
  "sidecars": {
    "quality": { "v": 1, "data": {} },
    "listenStats": { "v": 1, "data": {} }
  }
}
```

sidecar 导出只保留迁移所需字段：identityUrl、sourceUrl、聚合结果、时间和收听时长；删除 raw response、DNS/IP、临时 token、浏览器实例标识、服务端 rev 和网络响应正文。导出必须经过 schema 校验和硬上限裁剪。导入预览明确列出是否包含 sidecar；用户未勾选恢复 sidecar 时，目标设备原有 sidecar 保持不变。未知扩展字段忽略但不失败。

导入必须是 `parse → validate/preview → commit` 三阶段，不能解析后立刻覆盖 Store。提交前保存 Store、`my-radio.txt` 和被选择恢复的 sidecar 快照；任一步失败都回滚。版本映射固定为：v1 没有 `my`，不修改现有 `my-radio.txt`；v2 读取 `my` 数组；v3 读取 `myRadio` 数组；Web 和 Android 导出统一写 `myRadio`。导出统一为 v3。

### 8.4 B4 测试

新增：

```text
test/playlist-import.js
test/backup-v3.js
test/fixtures/demo.pls
test/fixtures/demo.xspf
test/fixtures/demo.asx
android/.../PlaylistParserTest.kt
android/.../BackupV3Test.kt
```

测试非法 XML、XXE、递归引用、大小和数量封顶、相对 URL、重复 URL、未知字段、导入失败回滚、v2 兼容和 Web↔Android 固定样本 round-trip。文件导入测试必须确认没有自动网络请求。

## 9. B5：Android Widget 和网络/流量保护

### 9.1 Widget

第一版只做当前电台、台标/首字母、曲讯、播放/暂停、上一收藏、下一收藏和打开应用。使用 `RemoteViews`，不引入 Glance。进程回收后的展示状态写入 Android 私有 `Prefs`，键名使用 `widget.*`，不进入 `radio.*`、v3 默认备份或 Web/Android 共享契约；Widget 不主动联网。

新增：

```text
android/.../widget/RadioWidgetProvider.kt
android/app/src/main/res/layout/widget_radio.xml
android/app/src/main/res/xml/radio_widget_info.xml
```

```kotlin
class RadioWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    ids.forEach { update(context, manager, it) }
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    when (intent.action) {
      ACTION_PLAY_PAUSE -> WidgetCommands.toggle(context)
      ACTION_NEXT -> WidgetCommands.stepFav(context, 1)
      ACTION_PREV -> WidgetCommands.stepFav(context, -1)
    }
    updateAll(context)
  }
}
```

控制动作必须进入现有 PlaybackService/MediaSession，不直接假设 `PlayerHolder` 在进程中初始化。状态更新由 `PlayerHolder.ui` 触发，进程被回收时显示最近快照。

### 9.2 网络策略和流量保护

| 操作 | 移动数据默认 | Wi-Fi 默认 |
|---|---|---|
| 播放 | 允许 | 允许 |
| 单台探活 | 允许但提示 | 允许 |
| 全量体检 | 确认或禁止 | 允许 |
| 主库同步 | 确认或禁止 | 允许 |
| 台标补全 | Wi-Fi 优先 | 允许 |
| Widget 状态 | 不主动联网 | 不主动联网 |

新增 `network/NetworkPolicy.kt` 和 `TrafficEstimator.kt`：

```kotlin
class NetworkPolicy(private val cm: ConnectivityManager) {
  fun state(): State = TODO()
  fun allow(op: Operation, overrideCellular: Boolean): Decision = TODO()
}

object TrafficEstimator {
  fun bytesFor(kbps: Int, durationMs: Long): Long =
    kbps.coerceAtLeast(32) * 1000L / 8L * durationMs / 1000L
}
```

播放不被策略静默阻断；同步和全量体检在移动网络下按设置确认或拒绝。无码率时显示“估算”，不冒充精确计费。

### 9.3 B5 测试和验收

JVM 测试 `WidgetStateTest.kt`、`NetworkPolicyTest.kt`、`TrafficEstimatorTest.kt`：覆盖空台、连接中、播放中、暂停、收藏为空、Wi-Fi、移动数据、离线、码率边界和溢出。

实机验收：添加/删除 Widget、锁屏点击、进程回收后显示最近快照和控制、Android 12/13/14+、Wi-Fi/移动数据切换、断流重试不无限消耗流量、国产 ROM 桌面刷新。Widget action 只携带固定 action 和本地 identity key，最终控制统一进入现有 `PlaybackService/MediaSession`。

## 10. B6：Android Auto / 车载模式

必须先做 MediaLibrary Spike，再产品化。目标是车机发现应用、显示收藏、点击播放、使用上一台/下一台、更新台名和曲讯。

服务层目标形态：

```kotlin
class PlaybackService : MediaLibraryService() {
  private lateinit var librarySession: MediaLibrarySession
  override fun onCreate() {
    super.onCreate()
    librarySession = MediaLibrarySession.Builder(this, PlayerHolder.player, LibraryCallback()).build()
  }
  override fun onGetSession(info: MediaSession.ControllerInfo): MediaLibrarySession = librarySession
}
```

实现前必须以当前 Media3 1.11.1 API 编译确认；若需保留现有 `MediaSessionService`，采用兼容组合，不盲目替换。

媒体树固定为：

```text
root / favorites / recents / categories / custom
```

不在车机提供维护、导入、体检、源地址和复杂搜索。`mediaId` 固定使用 `u:<Base64URL(identityUrl UTF-8，无 padding)>`，不使用会变化的分类和台名；解析后仍必须检查 identity URL 是否存在于本地库，车机不接受任意 URL。

JVM 测试媒体树、收藏/最近/分类映射、隐藏台、dead 台和稳定 mediaId；DHU/实机测试发现服务、播放、断网恢复、源级联和重复建流。

成本 8–15 人日，难度 4/5。若 Spike 阶段出现服务抢控制、媒体树刷新丢播放状态、必须复制播放决策链或没有可用验收环境，则暂停产品化。

## 11. B7：回听与时移 Spike

当前 `CONTEXT.md` 和 ADR-0003 将时移定义为暂不做。本计划不直接推翻该决定，只定义可被否决的 Android 技术 Spike；Spike 通过后另写 ADR 决定是否产品化。

范围：Android、单 MP3 直流、单源、最近 60 秒、不支持 HLS、不支持代理分片、不写永久录音、不改 Web、不进备份和统计。

首选方案是流字节环形缓冲：网络 DataSource 同时提供 ExoPlayer 和有限环形文件；回听时从最近合法 MP3 帧边界建立本地播放。必须记录帧边界，不能随意从字节中间切入。

状态机：

```text
OFF → CAPTURING → REPLAYING → CATCHING_UP → CAPTURING
                    ├→ FAILED
切台/刷新/源切换 → OFF
```

3–5 人日 Spike 验收：播放 60 秒后回退 15 秒、声音连续、回到直播头、环形淘汰正确、切台/刷新/断流清空或重建、暂停/睡眠不破坏、占用有上限、HLS 明确拒绝、删除实验代码不影响普通播放。

5 人日内无法稳定从合法帧边界回放就停止投入，不转向 PCM AudioSink 或本地 relay。Web 端暂不做时移。

## 12. 共享测试矩阵

### 12.1 Web

建议新增：

```text
test/contracts.js
test/diagnostic.js
test/source-lifecycle.js
test/sources.js
test/playlist-import.js
test/metadata.js
test/quality.js
test/listen-stats.js
test/discovery.js
test/backup-v3.js
```

继续保持零依赖。`test/smoke.js` 负责服务端安全护栏和 API 冒烟，新增测试负责纯函数和 fixture。B0/B2 必须点名覆盖 `/api/quality` 和 `/api/sync/force-token`：方法/405、Host/Origin、请求体封顶、质量 API rev 条件获取、ops 并发合并、force token 过期/重复消费/reportHash 不匹配，以及响应不返回流响应体。

### 12.2 Android

新增 JVM 测试：

```text
ContractTest.kt
DiagnosticModelTest.kt
CfgSourceLifecycleTest.kt
QualityAggregateTest.kt
SyncCandidateTest.kt
MetadataNormalizerTest.kt
ListenStatsTest.kt
PlaylistParserTest.kt
BackupV3Test.kt
WidgetStateTest.kt
NetworkPolicyTest.kt
MediaTreeTest.kt
TimeshiftIndexTest.kt
```

真实 ExoPlayer、Widget 桌面、Android Auto 和网络连接不强行塞进 JVM 单测，使用 fake RawHttp、fake Clock、固定流 fixture、DHU 和实机验收。

### 12.3 双端黄金样本

新增：

```text
contracts/fixtures/
  metadata-golden.json
  backup-v2.json
  backup-v3.json
  playlist-pls.txt
  playlist-xspf.xml
  playlist-asx.xml
  diagnostic-results.json
```

Web 和 Android 都读取这些资源，验证 identity URL、曲讯拆分、备份双向读取、导入解析、源配置规范化以及健康/质量分离。

## 13. 数据迁移、回滚和安全

### 13.1 `radio.cfg`

增加版本字段：

```json
{
  "v": 2,
  "moves": {},
  "names": {},
  "hideS": {},
  "hideC": {},
  "renames": {},
  "srcs": {},
  "tag": {},
  "srcManualOrder": {},
  "srcDisabled": {},
  "srcLabels": {},
  "cats": []
}
```

无 `v` 视为 v1，执行 `migrateCfgV1()`；未知字段忽略；坏结构回退空配置并提示用户。

### 13.2 备份和 sidecar

备份导入先预览、再确认、再事务提交；`my-radio.txt` 用临时文件 + rename；任一步失败恢复 Store、文件和被选择恢复的 sidecar。sidecar 损坏只清空自身，不阻塞主库、不覆盖 `radio.health`、不进入 `/api/store` 的 2MB 主 Store。

sidecar 导入规则固定如下：

1. 默认只恢复 `data`、`myRadio` 和 `radio.*`，保留目标设备现有 quality/listen-stats；
2. 用户勾选“包含本机 sidecar”后，才恢复 `extensions.sidecars.quality` 和 `extensions.sidecars.listenStats`；
3. 恢复前先做 schema、字节数、字段数量、URL 和日期范围校验，并执行同一套 trim；
4. Web 通过 sidecar API 提交，Android 通过临时文件提交；
5. 任何一步失败都回滚整个导入，不允许出现 Store 已恢复而 sidecar 半恢复的状态；
6. sidecar 不跨设备自动合并，导入语义是明确覆盖选中的 sidecar。

### 13.3 同步原子替换

以下根目录生成物必须作为一个批次处理：

```text
radio.txt
radio-data.js
logos.txt
radio-meta.json
sync-manifest.json
```

`sync-manifest.json` 保留在仓库根目录并纳入 Git，与已跟踪的 `radio.txt`、`radio-data.js`、`logos.txt`、`radio-meta.json` 表示同一批资产；接受每次同步产生的 diff。`.tmp`、`.bak`、上一批回滚副本和 `data/last-sync-report.json` 按实际部署策略加入 `.gitignore`；`data/` 仍不能被静态服务暴露。

manifest 至少记录 `version`、`generatedAt`、每个资产文件的相对路径、字节数和 SHA-256；写入顺序必须是：临时目录生成全部资产文件 → 校验质量门 → 备份上一份 manifest/生成物 → 替换根目录生成物 → 最后 rename `sync-manifest.json.tmp` 为 `sync-manifest.json`。启动或 Android 更新前先校验 manifest；失败时恢复上一份完整 manifest/生成物，缺少 `radio-meta.json` 时 Android 保留旧 meta 并继续播放。`data/last-sync-report.json` 是可丢失的运行时报告，只用于诊断和 UI 展示，不列入 manifest 资产清单，也不参与启动阻断条件。

冷启动规则：新克隆或历史仓库没有 `sync-manifest.json` 时，如果四个资产文件齐全且可解析，则按当前文件计算 SHA-256，写出 `version:"bootstrap"` 的 manifest 后继续启动；任一资产文件缺失或不可解析时，不静默使用混态，Web 显示“数据资产不完整，请运行 npm run sync”，Android 保留 APK 内置资产或上一份完整缓存并提示更新失败。任何失败只清理临时目录，不覆盖上一批已提交数据。

### 13.4 安全要求

- PLS/XSPF/ASX 导入不自动联网；
- XML 禁用外部实体和 DTD；
- URL 只接受 `http(s)`；
- 诊断继续使用 SSRF 双层护栏；
- 质量报告不返回响应正文；
- Android Auto 不接受任意 URL；
- Widget action 不携带可执行脚本或外部 URL；
- 备份导入不执行字段内容；
- 不增加远端收听行为上传。

## 14. 每批次交付模板

每个批次必须按以下顺序提交，接手者可直接照此拆任务：

1. 先更新契约、fixture 和迁移说明，再改实现；
2. 先写纯函数和离线测试，再接 Web/Android UI；
3. Web 变更同时保留 `file://` 降级路径，HTTP 专属能力必须有明确提示；
4. Android 变更同时更新 `android/CONTRACTS.md`，涉及根目录数据时补 Gradle/CI 资产校验；
5. 每个写盘功能必须定义临时文件、提交点、失败回滚和容量上限；
6. 每批次完成后运行 `npm test`、`cd android && ./gradlew test`，再做对应手工验收；
7. 不允许把未完成的 sidecar API、契约门禁或 manifest 发布协议留在半可用状态后继续开发上层功能。

核心发布单元门禁（B0+B1+B2）：

```text
核心版本可发布 = B0.done && B1.done && B2.done
          && npm test 通过
          && cd android && ./gradlew test 通过
          && 根目录 sync-manifest 校验通过
          && 上一批回滚副本存在
```

任何条件不满足都只能作为开发构建或内部测试构建，不能标记为核心版本正式发布。

B3 独立发布单元门禁：

```text
B3 可发布 = B3-A.done && B3-B.done && B3-C.done
           && B3 Web 测试通过
           && B3 Android 测试通过
           && metadata/listen-stats/discovery fixture 双端一致
           && sidecar 损坏/写失败降级通过
           && B3 feature flags 可独立关闭
```

B3 发布有两种合法形态：

1. 核心版本先发布，B3 后续作为兼容版本开启；
2. 同一版本同时发布 B0–B2 和 B3，但只有满足 B3 独立门槛时才开启 B3 开关。

B3 任一子项未完成时，不得以“部分可用”状态默认开启；可以合入代码但必须默认关闭对应开关，并保留独立回滚提交。

首个可执行提交序列：

```text
B0-1 contracts/fixtures + radio-keys.json + backup schema
B0-2 test/run.js + contracts.js + Android sourceSets 接线
B0-3 cfg v2 迁移 + Web v1/v2 备份读取
B0-4 sidecar codec/API 契约（先 fake 文件后接 UI）
B1-1 diagnostic model/API，不改 UI
B1-2 source lifecycle Web/Android 对齐
B2-1 QualityStore 聚合/trim + quality API
B2-2 candidate pipeline + quality gate + --force CLI
B2-3 radio-meta + root sync-manifest + Android 消费
B3-1 FeatureFlags + MetadataEvent 契约/黄金样本
B3-2 元数据双端消费和歌曲历史回写
B3-3 ListenStats 单调时钟聚合/sidecar/flush
B3-4 Discovery 派生视图和双端一致性
B3-5 B3 独立开关、回滚和发布验收
```

B3 远程 issue 规格：B3 已纳入本次开发迭代；远程 issue 用于拆分实施和跟踪，必须完整记录技术方案、依赖、测试、手工验收、风险、回滚和成本。至少拆为三个 issue：

```text
B3-A 元数据管线 v2
范围：MetadataEvent、ICY 规范化、Web/Android 黄金样本、radio.songs 回写边界
依赖：B0 契约、B2 QualityStore
验收：同一输入双端 title/artist/track 一致；HLS 空曲讯不猜测；切台/断流清理正确
成本：3–5 人日

B3-B 最小本地收听统计
范围：ListenStats sidecar、90 天裁剪、暂停/后台/连接中排除、可选 v3 导出
依赖：B0 sidecar codec、B2 sidecar 写入协议、播放状态事件
验收：fake clock 幂等、跨午夜、容量上限、Web/Android 聚合一致
成本：3–4 人日

B3-C 本地发现页
范围：稳定直连/最近新增/最近恢复/有曲讯/未听过/STARTER 精选
依赖：B2 quality、radio-meta、现有 favorites/recents/health
验收：纯本地计算、不联网、不改变主列表排序、隐藏/死台过滤一致
成本：2–4 人日
```

Issue 需要标记为 `in-current-iteration`，并分别标明：

- “不阻塞 B0+B1+B2 核心版本发布”；
- “满足 B3 独立门槛后才可开启对应 feature flag”；
- “关闭 B3 开关后，主列表、播放、健康、QualityStore 和 v3 主备份流程必须继续工作”；
- 完整技术方案、影响文件、迁移策略、自动化测试、手工验收、风险和成本。

每个批次开始前，PR 或小计划必须写清：

```text
目标
影响的 Web 文件
影响的 Android 文件
新增/修改的数据契约
迁移策略
纯函数测试
HTTP/文件测试
手工验收清单
风险与回滚方式
```

推荐提交顺序：

```text
1. docs + contract fixtures
2. 纯函数/模型/迁移
3. Web 数据层和服务端
4. Web UI
5. Android 数据层和播放服务
6. Android UI/系统集成
7. 双端样本回归
8. README/AGENTS/CONTRACTS/ADR 同步
```

不要在一个提交里同时做新持久键、备份协议升级、播放状态机改动、Android Auto 服务改造和时移实验；这些功能必须能独立回滚。

## 15. 实际开工清单

### 第一批：守住契约

- [ ] `contracts/radio-keys.json`
- [ ] `test/contracts.js`
- [ ] backup v3、metadata、diagnostic、quality 样本
- [ ] `radio.cfg` 版本迁移入口（含 `tag/cats/srcManualOrder`）
- [ ] Web v1/v2 备份读取、Android v2 样本互读
- [ ] sidecar API 骨架与 QualityStore ops/rev/并发/幂等测试
- [ ] MetadataEvent legacy/v2 sink 兼容策略和 feature flag 契约
- [ ] 固定 Web/Android 测试命令和 `contracts/fixtures` Gradle 接线

### 第二批：解决源失败

- [ ] 结构化 `checkStream` / `CheckStream.Verdict`
- [ ] `/api/check?detail=1`
- [ ] Web 电台详情面板
- [ ] Android 源详情 Sheet
- [ ] `srcManualOrder/srcDisabled/srcLabels`
- [ ] 源排序、禁用、删除和恢复默认
- [ ] 逐源诊断和配置回归测试

### 第三批：提高同步质量

- [ ] QualityStore sidecar（`/api/quality`，本机共享，非 `/api/store`）
- [ ] 质量聚合和稳定性文案
- [ ] URL 归一化和候选去重
- [ ] `radio-meta.json`
- [ ] `radio-meta.json` 体积预算：目标 <=1MB，硬上限 2MB；报告记录字节数、电台数、源数、平均每台大小和最大单台记录；超过目标告警，超过硬上限阻止发布
- [ ] 替换前质量门
- [ ] 同步报告、根目录 `sync-manifest.json` 和失败回滚
- [ ] `/api/quality` 与 `/api/sync/force-token` smoke：方法、Host/Origin、体积、409、token 过期/重放/reportHash 不匹配、GET rev 命中不传 data
- [ ] sync-manifest 冷启动 bootstrap、缺文件提示、上一批自动恢复和 `.tmp/.bak` 忽略策略

### 第四批：信息、发现和迁移

- [ ] MetadataEvent 和规范化器
- [ ] 最小收听统计
- [ ] 本地发现页
- [ ] PLS/XSPF/ASX 解析器
- [ ] backup v3 双端互通（默认不带 sidecar，可选导出/导入 sidecar）
- [ ] 导入预览和事务式恢复

### B3 独立交付清单（与 B4 及以后解耦）

- [ ] B3-A：MetadataEvent 契约、Web/Android 规范化器、世代 token、防迟到事件
- [ ] B3-A：统一事件入口 + LegacyMetadataSink/MetadataV2Sink，关闭开关不回归现有曲讯
- [ ] B3-A：曲讯、歌曲历史、MediaSession 回写边界测试
- [ ] B3-B：ListeningSession 状态机、单调时钟、跨午夜分桶、幂等 flush
- [ ] B3-B：Web/Android listen-stats sidecar 读写、损坏恢复、512KB 裁剪
- [ ] B3-C：发现页纯本地派生、20 台分组上限、稳定排序和过滤
- [ ] B3-C：STARTER 精选双端一致、无质量数据降级、隐藏/死台测试
- [ ] B3 feature flags 默认关闭、独立开启/关闭和回滚验证
- [ ] B3 Web/Android 黄金 fixture 全部通过

### 第五批：Android 原生增强

- [ ] RemoteViews Widget
- [ ] Widget 控制命令接入 MediaSession
- [ ] 网络策略和流量估算
- [ ] Wi-Fi/移动数据设置与测试

### 第六批：车载和高风险实验

- [ ] MediaLibrary Spike
- [ ] Android Auto 收藏/最近/分类树
- [ ] 车机验收
- [ ] MP3 时移 Spike
- [ ] 通过 ADR 决定是否产品化

## 16. 完成定义

这组扩展完成的标准不是所有按钮都能点，而是：

1. 共享键漂移能被契约测试拦截，Android 常量声明与 `C.KEYS` 引用也能被拦截，比较不受声明顺序影响；
2. 详情中心能解释每个源的状态；
3. 用户能在不破坏台身份的前提下修复和管理源；
4. 同步质量不足时不会覆盖旧库；CLI 或 Web 一次性 token 强制路径只绕过数量缩水类质量门，并留下 forced 报告；
5. 质量、统计和诊断历史都有容量上限，QualityStore 多标签 ops 重试不重复计数；
6. Web/Android 能互读 v1/v2/v3 备份和黄金样本，v3 可选择是否携带 sidecar；
7. 导入不会自动造成网络放大；
8. Widget、网络策略和 Auto 都复用现有播放引擎；
9. 核心版本发布只要求 B0+B1+B2；B3 有独立发布门槛和独立回滚能力，时移失败不会影响普通播放；
10. B0–B2 自动化测试和手工验收通过；若开启 B3，则 B3 独立自动化测试、手工验收、legacy/v2 曲讯兼容和 feature flag 回滚也必须通过；
11. `radio-meta.json` 能作为 Android 同步资产被校验和消费；
12. README、AGENTS、`android/CONTRACTS.md` 和 ADR 与实现一致。

时移在 Spike 和新增 ADR 之前只能视为实验能力，不能写入产品已支持清单。
