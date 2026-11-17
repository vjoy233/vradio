# VRadio 自动化测试体系方案（2026-11）

> 状态：review 后修订版；2026-11-15 grilling 共识已回写。本文包含可直接接手的文件清单、代码骨架、CI 草案和验收标准。
>
> 适用范围：仓库根 Web 播放器、Node 服务、同步/数据管线、`android/` 原生客户端，以及两侧共同消费的契约和生成数据。
>
> 目标：以 Web 端为主要测试对象，在继续保持核心运行时零 npm 依赖的前提下，覆盖绝大多数当前 case，减少回归、串台、数据丢失、契约漂移和发布混态；Android 端承担共享契约、数据资产和关键原生路径的验证，并让未来新增功能有固定的测试落点。

## 0. 已确认的设计决策

本节是本轮 grilling 后达成的共识，后续实现按此执行：

- **测试重心是 Web**：优先补 `player.js`、`store.js`、`sync.js`、`logos.js`、`app.js`、Node API、生成资产和正式页面 E2E；Android 不替代 Web 主回归。
- **Android 覆盖级别**：保留现有纯 JVM 全覆盖，增加关键设备 Smoke；关键 Smoke 包含启动、播放控制、音频焦点、后台/进程恢复、Widget、备份导入。
- **Android 执行分层**：稳定模拟器进入 PR/夜间分层，实体设备只做发布前；本轮先搭 `androidTest` 骨架和 workflow 草案，下一批再接稳定模拟器。
- **播放测试输入**：PR 使用 Node 内置 HTTP 固定流/HLS/ICY fixture；夜间只抽查少量真实源，公网漂移不直接等价于代码回归。
- **跨端契约门禁**：所有共享契约和数据格式都要 Web/Android 同批验证，并对共享 fixture 逐字段比对，差异报告到字段路径。
- **PR 门禁强度**：确定性测试硬门；Web Chromium、Android JVM/构建按受影响范围触发；公网真实源、长时播放、实体设备属于夜间/发布前层。
- **测试证据**：JSON 和日志必留；浏览器截图、Android APK 按失败或指定任务上传。
- **Java 基线**：用户级 JDK 17，`JAVA_HOME` 与用户 PATH 指向 JDK 17；仓库 CI 继续使用 Temurin 17。

### Review 意见处置

| review 意见 | 处置 | 落地内容 |
|---|---|---|
| `logos.js` 没有 `peek` | 采纳 | 全文改为 `get/visual`，并把“同步读取不发请求”作为行为断言 |
| `/api/myradio` 未列入 API 矩阵 | 部分采纳 | 增加端点总表并补齐高风险场景；但“当前完全无 E2E”与代码不符，`test/quality.js` 已覆盖合法/非法行清洗和落盘，剩余缺口是超限、原子替换失败、并发串行化、损坏恢复和备份联动 |
| P0 使用 harness、P1 才建 harness | 采纳 | 改为 P0a 先建最小 harness；P1 只做归拢和扩展，避免两套桩并存 |
| CI Playwright 来源未定义 | 采纳 | 固定 `.ci/browser/package.json` + `npm ci` + `npx playwright install --with-deps chromium`，不进入根 `package.json` |
| Android 测试文件数写成 29 | 采纳 | 修正为当前 28 个 Kotlin/JVM 测试文件；数量以命令动态统计，不作为长期契约 |
| P0 一个迭代过大 | 采纳 | 拆为 P0a（harness/player/store）和 P0b（sync/logos/Web browser smoke） |
| API 35 模拟器 target 风险 | 采纳但保守 | 草案改 `target: google_apis`；首次 workflow dispatch 是镜像可用性验证，不宣称已通过 |
| Node 14 失败政策不明 | 采纳 | 默认保持 Node 14 支持；出现不兼容先修代码，只有显式 ADR/版本策略变更才升 `engines` |
| 现有测试混合 L1/L2 | 采纳 | 保留现有 `npm test` 稳定入口；用 profile/文件清单渐进拆分，不承诺一次性重构 |
| P6 性能门未承接 | 采纳 | Chromium PR smoke 保留 render 中位 `<100ms` sentinel，夜间扩大矩阵 |
| UI 触发文件不完整 | 采纳 | 增加 features/srcorder/backup/playlist/quality/metadata/listen-stats 等行为模块映射 |
| Android test 依赖未写白名单纪律 | 采纳 | 文档和 Android README 明确 test-only 依赖清单、运行时依赖白名单不因此扩大 |

本轮没有需要驳回的设计意见，但驳回一条事实表述：`/api/myradio` “零 E2E 覆盖”不成立，证据是 `test/quality.js` 的行清洗与落盘用例。其余 review 建议均已采纳或按风险拆分。需要持续观察的是模拟器镜像和公网 Playwright 下载的环境稳定性；它们按草案/夜间层处理，不作为已通过事实。

## 1. 现状基线

### 1.1 当前已经存在的能力

截至 2026-11-15，仓库已有以下测试资产：

| 范围 | 当前资产 | 已验证内容 |
|---|---|---|
| Web/Node | `test/run.js` + 17 个 `test/*.js` | 每个测试文件子进程隔离，失败聚合，`smoke.js` 压轴起真服务 |
| Web 纯逻辑 | `test/sources.js`、`diagnostic.js`、`source-lifecycle.js`、`quality-store.js`、`metadata.js`、`listen-stats.js`、`discovery.js`、`backup-v3.js`、`playlist-import.js`、多个 UI 测试 | 同步质量门、探活判定、源生命周期、质量聚合、曲讯、收听统计、发现页、备份迁移、导入、筛选和维护草稿 |
| Web 契约 | `test/contracts.js` + `contracts/` | `radio.*` 三侧白名单、备份/质量/诊断/曲讯契约、fixture 形状 |
| Web 服务 | `test/smoke.js`、`test/quality.js`、`test/listen-stats.js`、`test/diagnostic.js` | 静态文件安全、Host/Origin、SSRF 双层护栏、Store、Quality、ListenStats、诊断 API 的主要成功/拒绝路径 |
| 浏览器验收 | `ui-demo/capture.cjs`、`ui-demo/p6-verify.cjs` | Chromium 下桌面/窄屏/UI 开关/筛选/维护/主题/响应式/性能；P6 已记录 51 个断言通过 |
| Android | `android/app/src/test` 下当前 28 个 Kotlin/JVM 测试文件；`.github/workflows/android.yml` | 解析、分类、Store、配置、备份、健康、质量、曲讯、统计、发现、Widget、网络策略、时移等纯 JVM 逻辑；CI 还构建 debug/release APK 和体积哨兵 |
| 离线回归 | `npm test` | 当前实测 17 个测试文件、0 失败 |

本轮已在本机安装并配置用户级 JDK 17（`C:\Program Files\Microsoft\jdk-17.0.21.21-hotspot`），`android/` 的 `testDebugUnitTest` 已通过；Android 设备 Smoke 仍以 CI/实体设备环境为执行位置。

### 1.3 当前可执行范围与未落地前置

文中出现的目标命令、目录和 workflow 不等于当前已经存在。接手实施时按下表判断：

| 项目 | 当前状态（2026-11-15） | 首个落地动作 |
|---|---|---|
| `npm test` | 已存在，可在无网络环境执行；当前 17 个测试文件通过 | 保持 `test/run.js` 兼容，新增测试按独立文件加入 |
| `npm run test:contract/unit/api/browser/nightly` | **尚未写入 `package.json`，当前不可执行** | P1 建立对应脚本和 runner；在脚本落地前不得把这些命令写入 CI 必过门 |
| `test/harness/`、`test/player.js`、`test/store.js`、`test/sync.js`、`test/logos.js` | **尚未创建**，本文代码块是接口/实现骨架 | 按 P0a→P0b 顺序创建；每个文件先有失败用例，再接业务加载适配 |
| `.ci/browser/`、根 `.github/workflows/web.yml` | **尚未创建** | 固定 Playwright 版本、提交 lockfile 后再启用浏览器硬门 |
| `test/myradio.js` | **尚未创建**；`test/quality.js` 已覆盖行清洗/落盘/方法拒绝 | 补超限、并发、写失败、损坏恢复和备份联动，不重复已有用例 |
| Android `androidTest` | 当前只有启动和共享资产 Smoke；播放等关键路径未实现 | 先定义 fixture 启动协议和 instrumentation 参数，再扩展播放/生命周期/Widget/备份用例 |

接手者不得把上述“目标文件存在”当成验收条件；每一批必须同时提交代码、测试、命令入口和一次干净环境执行记录。

### 1.2 当前主要空白

以下空白会影响“能否稳定迭代”，优先级高于继续堆纯函数用例：

1. `player.js` 没有独立的确定性测试矩阵。播放世代令牌、三级源顺序、记忆源、自愈重连、watchdog、音量记忆、MediaSession、多标签让位是项目最密集的竞态区。
2. `store.js` 的核心状态机缺少独立 fake browser 测试。包括 dirty 重推、服务端 rev 对账、debounce、`beforeunload`/`visibilitychange`、BroadcastChannel、多标签 last-write-wins 和 file:// 降级。
3. `sync.js` 目前主要靠真实页面和手工行为验证。静默体检、手动体检互斥、同步后增量、首启基线、中断续跑、toast/状态栏分流需要可控时钟与 fake App/Player。
4. `logos.js` 只有渲染形状相关覆盖，三级来源、永久缓存、负缓存、收藏/正在播优先、运行时解析失败回退仍缺完整状态测试。
5. `server.js` 的 `/api/sync`、force-token、`/api/boot`、`/api/mystation`、`/api/nowplaying`、`/proxy` 重定向/断流/回收和并发上限没有形成统一的 API 矩阵；当前测试更多是安全拒绝和 sidecar API。
6. Web 端没有默认 CI workflow。Android 有 path filter CI，根目录 `npm test`、浏览器验收、生成资产一致性和跨平台契约尚未形成统一 PR 门禁。
7. 真实浏览器验收目前以 Chromium 为主；Firefox/Edge/Safari、读屏、200% 缩放、forced-colors、窄高窗口、真实多标签对抗仍是未覆盖或低频人工项。
8. 真实音频网络不适合成为每次 PR 的硬依赖；需要本地可控 HTTP/HLS/ICY fixture，把播放时序自动化，再保留少量实机/真实源抽查。

## 2. 设计原则

### 2.1 运行时零依赖，测试分层可选依赖

- Web 业务和生产命令继续只使用 Node 内置模块；不把 Jest、Vitest、Playwright 等加入 `package.json`。
- `npm test` 必须在无网络、无浏览器、无 Java 的 Node 环境中完成核心离线回归。
- 浏览器 E2E 使用仓库外已安装的 Playwright，通过 `VRADIO_PLAYWRIGHT` 指定路径；它是开发/CI 工具层，不进入播放器运行时。
- Android 测试继续由 Gradle 管理；纯 JVM 测试与 Android SDK/设备解耦，设备测试另设门禁。

### 2.2 纯逻辑优先，真实边界必须可替换

每个新增功能先抽出可注入的纯逻辑或边界适配器：

- 时间：生产逻辑优先注入 `now()`/timer adapter；若暂时无法改造，则测试 harness 在单个子进程内显式 patch `Date.now`、`setTimeout`、`clearTimeout`，并在 `finally` 恢复。本文的 `FakeClock` 代码块只展示调度核心，**不会自动替换全局时间 API**。
- 随机数：token、session id、端口和排序 tie-breaker 提供可控来源。
- 网络：Node fixture server、fake `fetch`、fake DNS lookup、固定 HTTP/HLS/ICY 响应。
- 文件：临时根目录、内存文件或注入 IO；禁止测试写仓库根用户数据。
- 浏览器：最小 DOM、fake audio、fake HLS、fake BroadcastChannel、fake MediaSession。
- Android：纯 JVM fake clock/fake RawHttp/fake file store；真实 ExoPlayer、Widget 和系统生命周期留给 instrumented/device 层。

### 2.3 契约只有一个来源，测试消费契约而不是复制口径

`contracts/` 是 Web/Android 共享契约的单一来源。新增或修改以下内容必须同时更新契约、fixture、两端测试和迁移说明：

- `radio.*` 持久键和备份覆盖范围；
- `radio.txt`、`logos.txt`、`my-radio.txt` 行格式；
- 诊断结果、质量聚合、曲讯事件、备份 v3、收听统计；
- 生成资产 `radio.txt`、`radio-data.js`、`logos.txt`、`radio-meta.json` 的批次/哈希关系。

### 2.4 测试隔离优先于测试速度

- 每个 Node 测试文件独立子进程；共享数据用 fixture，不共享可变全局。
- 真服务测试使用随机空闲端口和临时数据根；完成后恢复/删除临时目录。
- 浏览器验收默认 `git worktree` 自举临时实例，不能触碰宿主 `data/store.json`、`my-radio.txt`、质量和统计 sidecar。
- 任何会写用户数据的测试必须有快照、`try/finally` 清理和异常中断恢复路径。

## 3. 目标测试分层

### L0：静态与契约门禁（每次 PR，秒级）

入口：`npm run test:contract`（建议新增，初期可由 `npm test` 内部复用）。

检查项：

- Web `store.js` KEYS、`server.js` STORE_KEYS、Android `Consts.kt` C.KEYS 与 `contracts/radio-keys.json` 完全相等；
- 备份 schema、质量/诊断/曲讯/统计 fixture 可解析，未知字段/排除键不误入；
- 经典 script 装载顺序和生成 `radio-data.js` 的 `window.RADIO_DATA` 形状；
- `sync-manifest.json` 的四个生成资产存在、哈希和字节数匹配；
- `radio.txt`/`logos.txt`/`radio-meta.json` 可解析，行协议无空分类、坏 URL、重复主身份；
- Android 资源打包任务确实包含根数据文件和 `radio-meta.json`；
- feature flag 默认值、契约版本和迁移入口存在。

失败说明必须指出“哪个契约、哪一侧、哪一个键/字段漂移”，不能只输出 deep-equal 失败。

### L1：纯函数与状态机单元层（每次 PR，秒级）

延续现有 `test/*.js` 与 Android JVM 测试风格，新增模块按文件拆分，单测只使用 Node assert/Kotlin test：

| 模块 | 必测不变量 |
|---|---|
| `player.js` | `prefer > srcmem > srcOrder`；直流/HLS/proxy 变体顺序；token 使旧异步回调失效；error/stalled/waiting/ended 自愈；重连一次后顺延；成功源记忆 FIFO 300；手动 forget 恢复启发式；每台音量/静音恢复；多标签让位；耗尽后状态清理；曲讯不串台 |
| `store.js` | 白名单快照；set/remove 立即镜像、300ms 合批；POST 成功才清 dirty/rev；失败保 dirty 和镜像；启动先重推 pending 再对账；收到他页消息作废 pending；flush 读当前内存；file:///后端失败降级；beforeunload/visibility flush |
| `logos.js` | STARTER > logos.txt > runtime；同步 `get/visual` 不发请求；收藏/当前台才触发解析；永久命中、负缓存 7 天、坏图回退；分类 tone token 安全；同一 station 不重复请求 |
| `sync.js` | 手动任务优先于静默任务；busy 互斥；boot 4 秒静默范围和 200 上限；同步 diff 的国内新增名单；首启 baseline 确认门槛、中断续跑、完成清理；后台只 toast，手动才写 status |
| `app.js` | 身份 URL 不变、名字/分类只是显示；主库→STARTER→my-radio→cfg 装配；srcs/隐藏/分类级联；收藏/最近按 URL 回绑；dead 两档 TTL/升级/复活；搜索 AND、范围/分类计数；单一 render 不重复副作用 |
| `update-sources.js` | 分类幂等、候选去重、六条质量门、强制 token 单次消费、manifest 原子发布/回滚、欧美层塌陷保护、生成资产同批 |
| `server.js` 纯辅助 | `crossOrigin`、Host、body 上限、行清洗、日期/schema、并发队列、重定向 URL、坏文件自愈 |

新增单元必须至少有：正常路径、边界值、坏输入、重复/重试、并发或乱序、旧格式兼容（适用时）六类中的适用项。

### L2：本地边界集成层（每次 PR，秒到几十秒）

使用 Node 内置 `http`/`net` fixture server 和临时目录，覆盖真实模块边界：

1. **服务端 API 矩阵**：统一验证方法、Host、Origin、状态码、机器可读错误码、响应体形状、文件副作用和重启续发号。
2. **流媒体 fixture**：
   - MP3/AAC 直流持续吐字节；
   - 336B 假流、HTML 错误页、状态码与内容类型矛盾；
   - HLS master→variant、相对分片、无分片、分片断流、坏重定向；
   - ICY `StreamTitle` 换歌、重复歌、无曲讯、带 `icy-br`；
   - 延迟建流、stalled、ended、连接中途断开。
3. **文件/发布事务**：写入失败、rename 失败、半批生成物、manifest 损坏、进程重启，确认旧批完整保留。
4. **多标签模拟**：两个 Store/Quality/ListenStats 实例共享 fake BroadcastChannel，验证不同增量最终合并、同 op.id 不重复、旧 pending 不覆盖新服务端状态。
5. **同步编排**：注入 CN/EU 候选和 fake clock，验证手动/静默/增量/baseline 四通道以及质量门报告。

#### 当前 API 覆盖总表

| 端点 | 当前自动化 | 目标补齐 |
|---|---|---|
| `/api/store` | `smoke.js`：白名单、rev、超限、重启续发、方法/跨源 | 并发 last-write-wins、dirty/对账客户端链路 |
| `/api/quality` | `quality.js`：条件 GET、幂等、并发合流、409、replace、损坏恢复 | 浏览器多标签真实接线 |
| `/api/listenstats` | `listen-stats.js`：条件 GET、幂等、并发、schema/batch、replace、损坏恢复 | 浏览器多标签真实接线 |
| `/api/check` / `detail=1` | `smoke.js`、`diagnostic.js`：方法/跨源/SSRF/结构化结果；fixture 分支 | 多 URL 上限与延迟/断流 API 矩阵 |
| `/api/nowplaying` | `smoke.js`：方法、HLS 短路；部分旁路逻辑 | ICY 换歌、空闲回收、并发封顶、失败冷却 |
| `/api/sync` / `force-token` | `smoke.js`：跨源、方法、force 字段、无 stash/坏 JSON；`sources.js` 测 pipeline/token 纯逻辑 | 真 HTTP 成功、busy 409、gated→token→forced、报告副作用 |
| `/api/boot` | `smoke.js`：GET/POST 形状 | 损坏/缺失资产、bootstrap、prev 恢复真服务矩阵 |
| `/api/mystation` | 当前无完整真 HTTP 成功/封顶/原子写矩阵 | 探活通过写入、假流拒绝、重复 URL、500 行/64KB、并发串行化 |
| `/api/myradio` | `quality.js`：合法/非法行清洗、合法内容落盘、方法拒绝 | 404/空列表、500 行/64KB、tmp+rename 失败保持旧文件、并发串行化、损坏恢复、与备份导入联动 |
| `/proxy` | `smoke.js`：方法/跨源/私网；`diagnostic.js` 测上游护栏 | 重定向逐跳、断流、客户端断开回收、Content-Range |

建议统一新增 `test/harness/`（P0a 先落最小版本，P1 再归拢扩展）：

```text
test/harness/http-fixture.js      # 本地流、HLS、ICY、重定向、延迟、断流
test/harness/temp-root.js         # 临时根、快照、清理和故障注入
test/harness/fake-browser.js      # localStorage/document/audio/BC/mediaSession
test/harness/fake-clock.js        # 可推进时间、定时器和 Date.now
test/harness/api-client.js        # 请求、JSON、断连和状态断言
```

最小实现骨架：

```js
// test/harness/fake-clock.js
class FakeClock {
  constructor(t = 0) { this.t = t; this.q = []; }
  now = () => this.t;
  later(ms, fn) { const x = { at: this.t + ms, fn, dead: false }; this.q.push(x); return x; }
  cancel(x) { if (x) x.dead = true; }
  tick(ms) {
    this.t += ms;
    for (;;) {
      const x = this.q.filter(v => !v.dead && v.at <= this.t).sort((a, b) => a.at - b.at)[0];
      if (!x) break;
      x.dead = true; x.fn();
    }
  }
}
module.exports = { FakeClock };
```

```js
// test/harness/http-fixture.js（接口草案；所有上游流必须本地可控）
const http = require('http');
function fixture(routes = {}) {
  const s = http.createServer((req, res) => {
    const r = routes[new URL(req.url, 'http://fixture').pathname];
    if (!r) return res.writeHead(404).end();
    res.writeHead(r.status || 200, r.headers || {});
    if (r.delay) return setTimeout(() => r.body ? res.end(r.body) : r.stream(res), r.delay);
    return r.stream ? r.stream(res) : res.end(r.body || '');
  });
  return { server: s, listen: () => new Promise(ok => s.listen(0, '127.0.0.1', () => ok(s.address().port))), close: () => new Promise(ok => s.close(ok)) };
}
module.exports = { fixture };
```

```js
// test/player.js 的 fake audio 形态（实现时按此注入，不连接公网）
const audio = {
  paused: true, volume: 1, currentTime: 0, src: '',
  play() { this.paused = false; this.onplaying && this.onplaying(); return Promise.resolve(); },
  pause() { this.paused = true; this.onpause && this.onpause(); },
  load() {},
};
// 断言：旧 token 的 onerror/onplaying 不得改变当前台；同一源只重连一次再顺延。
```

`/api/myradio` 的接手实现骨架：

```js
// test/myradio-api.js（建议新增；临时根 + 真服务；以下为零依赖 ok() 风格骨架，非可执行合同——
// 实际接口以下方 harness 接口表为准，首个实现批次落地后回写真实签名）
const assert = require('assert');
const { boot } = require('./harness/api-client');

(async () => {
  const { srv, port, req, close, root } = await boot({ isolated: true });
  try {
    // 1. POST 合法分类/电台行 → 200，tmp+rename 后 root/my-radio.txt 可读；
    // 2. 非法行、逗号/竖线、非 http(s)、空名 → 清洗或丢弃；
    // 3. >500 行或 >64KB → 413，旧文件字节保持不变；
    // 4. 并发 POST → 写队列串行、最终态恰为**后入队者的完整列表**（/api/myradio 是全量替换，
    //    「不互相覆盖」是 mystation 追加读改写的语义，此处应断言无混合/半写的合法串行终态）；
    // 5. 写入/rename 注入失败 → 返回 ok:false，旧文件保持可解析。
    assert.ok(srv && port && root);
  } finally { await close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
```

#### 真服务 harness 接口表（api-client.js 唯一合同，实现批次以此为准）

| 接口 | 签名 | 语义 |
|---|---|---|
| `boot` | `boot(opts) → Promise<{srv, port, req, close, root}>` | `opts.env` 注入 `VR_TEST_*` 测试缝（PORT/HOST 钉死在后）；`opts.isolated` = 每次调用复制仓库骨架到独立临时应用根再起服（**宿主用户数据/生成资产零接触**，随机端口不是存储隔离）；`opts.root` = 复用既有临时根重启服务（资产操纵→重启矩阵用） |
| `req` | `req(method, path, headers?, body?) → Promise<{status, headers, body}>` | JSON/文本两用；有默认超时，超时/连接错误 reject（服务挂住 = 有报告的测试失败，不是 CI 全局超时） |
| `close` | `close() → Promise` | 幂等：先杀服、**等待子进程退出**、再删本轮自有的临时根；异常不上抛但记录 |
| `addCleanup` | `addCleanup(fn)` | SIGINT 兜底注册表（单监听器） |
| 快照类 | `snapshotAssets/restoreAssets`（显式操作仓库根，isolated boot 不使用） | 仅仓库根资产直读直写的场景（如 assets.js 一致性校验）；isolated 场景一律走 `root`，不靠跨进程备份还原 |

Store/播放器测试的最小断言模板：

```js
// test/store.js（伪代码：fakeBrowser/loadStore 由 harness 提供）
async function caseStoreWriteFailure() {
  const b = fakeBrowser({ protocol: 'http:', post: () => Promise.reject(new Error('disk')) });
  const s = loadStore(b);
  s.set('radio.favs', '["u1"]'); await s.flush();
  assert.equal(b.localStorage.getItem('radio.storeDirty'), '1');
  // 替换 fetch 为成功响应，boot() 应先 POST pending，再 GET 主源。
}
```

```js
// test/player.js（伪代码：fakeBrowser/loadPlayer/station 由 harness 提供）
async function caseStalePlayerEvent() {
  const p = loadPlayer(fakeBrowser());
  const a = station('A', ['http://fixture/a.mp3', 'http://fixture/a.m3u8']);
  const b = station('B', ['http://fixture/b.mp3']);
  p.play(a); const old = p.srcToken(); p.play(b);
  p.onAudioError(old); // 必须被忽略，当前台仍为 B
  assert.equal(p.current.n, 'B');
}
```

根目录 CI 接入骨架（实现时新增 `.github/workflows/web.yml`）：

```yaml
name: web
on: [push, pull_request]
jobs:
  node:
    strategy:
      matrix: { node: ['14', '18', '20'] }
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }} }
      - run: npm test
  browser:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci --prefix .ci/browser
      - run: npx --prefix .ci/browser playwright install --with-deps chromium
      - run: VRADIO_PLAYWRIGHT="$PWD/.ci/browser/node_modules/playwright" node ui-demo/p6-verify.cjs
        env: { CI: '1' }
      - if: failure()
        uses: actions/upload-artifact@v4
        with: { name: browser-report, path: docs/ui-redesign-assets/p6 }
```

该 YAML 是落地骨架，不应在 `.ci/browser/package.json` 锁定版本、正式页面 smoke 断言和报告路径确认前直接作为已通过 workflow 合并。

### L3：浏览器 E2E 与无障碍层（PR/夜间分级）

沿用 `ui-demo/p6-verify.cjs` 的隔离自举和报告格式，扩展为正式页面矩阵：

- **默认开关**：`FEATURES.uiRefresh` 关时旧壳零回归；开时侧栏、hero、维护、数据分区、筛选、主题、详情、播放 dock 均可用。
- **交互状态**：播放/暂停/切台/切源/刷新/睡眠/收藏/最近/双击收藏/移动端长按/键盘快捷键/MediaSession 键。
- **数据状态**：空库、无效源隐藏、正在播 dead 例外、手动隐藏彻底过滤、个人台 404/500/恢复、配置冲突三选、备份预览/导入/回滚。
- **响应式**：320/375/390/414/768/1023/1024/1280/1440/1920，横向溢出、窄高、200% 缩放。
- **浏览器矩阵**：Chromium 每 PR；Firefox/Edge 夜间；Safari 在 macOS 实机或托管 runner 抽查。
- **无障碍**：键盘完整路径、焦点回归、dialog/alertdialog/aria-expanded/aria-pressed/aria-current、颜色对比、forced-colors；NVDA/VoiceOver 保留人工 smoke，无法用 headless 可靠替代。
- **异常门**：pageerror、非预期 console error、未处理 promise、业务 API 意外请求、测试临时文件泄漏。
- **性能门**：Chromium PR smoke 对正式页面全库 `render()` 中位数设置 `<100ms` sentinel；夜间保存 3 轮中位数、P95、视口和数据规模，超过门槛只在稳定复现后判代码回归。

#### Playwright 供给和浏览器矩阵

根项目继续零 npm 依赖；CI 的浏览器工具放在独立目录：

```text
.ci/browser/package.json
.ci/browser/package-lock.json
```

```json
{
  "private": true,
  "devDependencies": { "playwright": "固定版本" }
}
```

CI 固定步骤：

```bash
cd .ci/browser
npm ci
npx playwright install --with-deps chromium
VRADIO_PLAYWRIGHT="$PWD/node_modules/playwright" node ../../ui-demo/p6-verify.cjs
```

浏览器矩阵切分：

| 层级 | 视口/浏览器 | 内容 |
|---|---|---|
| PR | Chromium；1280×800、390×844 | 启动、筛选、主题、播放 connecting/停止、维护三选、无 pageerror、render 中位 `<100ms` |
| PR 受影响扩展 | Chromium；320/768/1024/1440 | 仅当 CSS、`index.html`、`app.js`、`features.js`、UI 相关模块变化时运行 |
| 夜间 | Chromium 全 10 视口 + Firefox/Edge | 完整 P6 交互、响应式、200%/forced-colors、性能 P95 |
| 发布前 | Safari/macOS、NVDA/VoiceOver、实体 Android | 人工/托管 runner smoke，不伪装成 headless 通过 |

Playwright CI 缺包、浏览器下载失败或 runner 无法启动必须标记为环境失败并上传日志；不得静默跳过。

**执行预算与硬门失败判定细则**（PR/夜间共享 runner 的波动隔离）：PR 浏览器门总预算 ≤10 分钟，单 step 显式 `timeout-minutes`（启动 3 / 矩阵 5 / 上传 1），超预算判环境失败而非代码回归；性能哨兵（render 中位 `<100ms`）先跑 1 轮 warm-up 丢弃、再采样 5 轮取中位，失败自动重跑 1 次，**两轮同向超线且样本间无 >3× 离散才判代码回归**，否则记「环境波动-需人工复核」并保留原始样本与 runner 信息；夜间矩阵超预算时按「PR 受影响扩展 → 视口全量 → Firefox/Edge」顺序缩减并显式记录缩减项，不默默删除门禁。

真实公网电台播放不作为每次 PR 的硬门；PR 只使用本地流 fixture。真实源抽查单独列为夜间/发布前探测，并把漂移视为数据健康信号，不把网络偶发失败误判为代码回归。

### L4：Android JVM、instrumented 与发布层（Web 主回归的配套层）

- 每次 Android 变更：`testDebugUnitTest`，覆盖所有纯 JVM 测试和共享 fixture。
- Android 变更或契约/数据变更：`assembleDebug`、`assembleRelease`、APK 体积哨兵、资产 hash/版本检查。
- Android test-only 依赖：`androidx.test.ext:junit`、`androidx.test:runner`、`androidx.test:rules` 仅进入 `androidTestImplementation`，不改变运行时依赖白名单；新增测试依赖必须在 Android README/PR 中登记并说明原因。
- instrumented smoke 的最小关键路径：启动并装载共享资产、使用本地固定流完成播放/暂停/切台、音频焦点让位与恢复、后台/进程回收后恢复快照、Widget 播放/上一台/下一台、备份预览与确认导入。Compose 只验证关键语义和操作，不把像素级 UI 回归复制到 Android。
- 本地固定流由 Node 内置 HTTP fixture 提供；Android 通过模拟器可达地址访问。fixture 至少提供直流、HLS、ICY 曲讯、延迟建流和断流场景，避免 Android Smoke 依赖公网。接入协议固定为：workflow 在宿主机启动 `test/harness/android-fixture.js`，监听 `0.0.0.0` 的随机端口；模拟器使用 `10.0.2.2:<port>` 访问。参数传递按执行入口区分：`adb shell am instrument -e fixtureBaseUrl=http://10.0.2.2:<port> ...`（adb 直调口径）或 `gradlew connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.fixtureBaseUrl=http://10.0.2.2:<port>`（Gradle 口径，CI workflow 用这条）。真机执行时改用同一局域网地址，并在报告中记录 fixture URL 与版本（设备端反查 `/__health` 核对，不信客户端硬编码）。
- 执行分层：稳定模拟器作为 PR/夜间候选；实体设备只做发布前验收。当前批次只提交 `androidTest` 测试骨架和可手动触发的 workflow 草案，模拟器 API/镜像稳定后再接入 PR 硬门。
- Media3/真实网络/Widget/Android Auto 不塞进 JVM 单测；使用固定流 fixture、fake RawHttp、设备 smoke 和人工实机验收分层。
- Web/Android 黄金 fixture 必须逐字段或逐组等价；差异报告点名字段路径和端，不接受“整体不相等”。

#### Android instrumented Smoke 矩阵

| Smoke 组 | 关键断言 | 输入/隔离 | 当前门禁 |
|---|---|---|---|
| 启动与资产 | Activity 可启动；`radio.txt`/`logos.txt` 可解析；共享 fixture 版本可见。**已实现**：启动不 finish、radio.txt 生产解析器（≥1 台/≥2 分类/URL 形态）、logos.txt 行形态、radio-meta.json 契约形态；**未实现**：AppVm.boot 装配就绪的有界等待、共享 fixture 版本核对 | 临时 app 数据；本地资产 | 下一批模拟器接入 |
| 播放控制 | 固定流进入 playing；暂停/恢复/切台状态正确；不依赖公网 | Node fixture，模拟器可达地址 | 下一批模拟器接入 |
| 音频焦点 | transient loss 暂停；gain 恢复；永久 loss 清理 | fake/系统 AudioManager 场景 | 发布前设备优先 |
| 后台/进程恢复 | 回到前台状态不串台；进程回收后快照和最近台可恢复 | 系统后台、重启 Activity | 下一批模拟器接入 |
| Widget | 添加/更新；播放、上一收藏、下一收藏动作进入同一 MediaSession 播放链；Widget 不主动联网 | RemoteViews/固定快照 | 发布前实体设备优先 |
| 备份导入 | 预览→确认→提交；故障时 Store、个人台和 sidecar 回滚 | v1/v2/v3 共享 fixture | 下一批模拟器接入 |

Android Smoke 失败必须输出 instrumentation log、fixture 版本、设备 API、APK 版本和测试报告；截图只在失败或指定任务上传。

当前 `.github/workflows/android-instrumented-draft.yml` 只负责启动 API 35 `google_apis` 模拟器并执行现有骨架，**尚未启动 Node fixture，也未接入 `fixtureBaseUrl` 参数**；因此它不能证明播放 Smoke 已通过。首次扩展前必须先完成宿主 fixture 启动、端口注入、测试结束后的进程清理和失败日志上传。

### L5：夜间、发布前和故障演练层

不阻塞普通 PR，但必须能重复运行并产出报告：

- 真实来源抽样：国内/欧美/ICY/HLS/代理各固定样本，记录 URL、状态、耗时、字节数和诊断 code；不把单次网络失败直接视为代码失败。
- 长时播放 30–60 分钟：watchdog、自愈、曲讯轮询、内存/连接回收、睡眠定时器。
- 并发压力：多个 `/api/check`、`/api/nowplaying`、store/quality/listenstats 写入，确认封顶、队列和无数据竞争。
- 故障注入：上游 404/HTML/假流、DNS 解析变更、畸形 Location、写盘失败、kill -9/中断发布、损坏 sidecar。
- 资产同步演练：好批次→坏批次→恢复上一批→bootstrap→连续两代 prev 轮换。

## 4. 当前 case 覆盖矩阵

| 业务域 | 现在的自动化 | 目标补齐 | 通过标准 |
|---|---|---|---|
| 列表/搜索/分类/收藏/最近 | `ui-scope.js`、`ui-data.js`、P6 | 多浏览器、空/大数据、真实 reload | URL 身份不漂移，组合筛选和计数一致 |
| 维护面板/配置冲突 | `ui-maintenance.js`、P6 | 多标签冲突、save 失败、刷新/离开全路径 | stay/discard/save 三分支无丢草稿/误覆盖 |
| 播放/切源/自愈 | 基本无 `player.js` 单测；P6 只验证 connecting/停止 | L1 fake audio + L2 流 fixture + 长时夜测 | token、顺序、重连、断流、音量、曲讯无串台 |
| Store 主源 | smoke/sidecar 间接覆盖 | fake browser 多标签和失败重试矩阵 | rev 只由服务端产生，失败不丢本地镜像 |
| 台标 | `ui-phase.js` 渲染形状 | 来源优先级、缓存/负缓存、请求去重 | 同步渲染无网络副作用，收藏优先补全 |
| 源同步/生成资产 | `sources.js`、smoke | CLI 参数、网络失败、全资产 hash/重启恢复 | 质量门不误覆盖，发布不混态 |
| 服务安全/API | smoke、quality、listen-stats、diagnostic | 全端点统一矩阵、代理断流/重定向/并发 | SSRF/CSRF/Host/体积/方法/响应契约全固定 |
| 质量/统计/曲讯 | 已有较强纯函数和 API 覆盖 | 多标签浏览器接线、重启/损坏/长时 | 幂等、合流、裁剪和历史语义双端一致 |
| 备份/导入 | `backup-v3.js`、playlist、ui-data | 浏览器下载/文件选择、Android instrumented | parse→preview→commit，任一步失败四件回滚 |
| Android | 当前 28 个 JVM 测试文件 + CI | 设备 smoke、跨端资产/播放桥 | JVM 全绿、APK 可构建、契约/体积不漂移 |

## 5. 建议的测试命令和门禁

保持已有命令兼容，逐步增加可单独定位的入口：

```text
npm test                 # 默认离线核心：L0 + L1 + 轻量 L2，必须秒级、零网络
npm run test:contract    # 目标命令：只跑 contracts/生成资产/三侧白名单（当前尚未接入）
npm run test:unit        # 目标命令：纯函数、状态机、fake browser，不起长驻服务（当前尚未接入）
npm run test:api         # 目标命令：临时端口真服务 + fixture API 矩阵（当前尚未接入）
npm run test:browser     # 目标命令：Playwright；需 VRADIO_PLAYWRIGHT（当前尚未接入）
npm run test:nightly     # 目标命令：真实源抽样、长时播放、故障演练（当前尚未接入）
cd android && ./gradlew testDebugUnitTest
cd android && ./gradlew assembleDebug assembleRelease
cd android && ./gradlew compileDebugAndroidTestKotlin
cd android && ./gradlew connectedDebugAndroidTest # 需要已启动/可用模拟器；当前草案不进普通 PR
```

### PR 必过门

1. `npm test`；
2. 契约/生成资产检查；
3. 受影响模块的 L1/L2 定向测试；
4. 若改 `index.html`、`app.js`、`player.js`、`store.js`、`logos.js`、`sync.js`、`features.js`、`srcorder.js`、`backup.js`、`playlist-import.js`、`quality-store.js`、`listen-stats.js`、`metadata.js`：Chromium 浏览器 smoke；
5. 若改 `android/**` 或共享契约/数据：Android JVM + debug/release 构建；
6. 任一测试报告不得有未清理临时目录、宿主数据 hash 变化或未解释的 page error。

### 失败分类

- **代码回归**：确定性 fixture 失败、契约漂移、安全门失败、状态机不变量失败。
- **数据健康**：真实源探测失败、上游分类/URL 漂移；进入报告和健康看板，不直接阻塞普通代码 PR。
- **环境失败**：缺 Java、缺 Playwright、浏览器启动失败；必须明确标为环境未执行，不能伪报通过。

## 6. 测试数据和 fixture 规范

### 6.1 Fixture 命名

```text
contracts/fixtures/       # Web/Android 共享黄金样本，字段语义冻结
test/fixtures/             # Web/Node 专用输入、坏数据、网络场景
android/app/src/test/resources/  # Gradle 复制或读取共享 fixture 的稳定入口
test/harness/              # 只放测试基础设施，不放业务期望
```

每个 fixture 旁边写清：输入版本、预期输出、适用端、是否允许未知字段、时间基准和来源。禁止用当前系统时间生成不可复现的 expected 文件。

### 6.2 生成数据校验

同步生成的四资产必须通过：

- 行协议解析；
- 主 URL/分类/台名唯一性和数量 sanity；
- `radio-data.js` 与 `radio.txt` 内容等价；
- `radio-meta.json` 绑定 `radio.txt` hash；
- `logos.txt` 分类和 URL 形状；
- `sync-manifest.json` 四文件 hash/bytes 一致；
- 失败批次保持旧资产字节不变。

### 6.3 时间、随机数和排序

所有涉及 FIFO、TTL、30 天窗口、90 天裁剪、token 过期、重试冷却、负缓存、睡眠定时的测试必须注入时钟。排序遇到时间相等时必须断言规定的 URL/键字典序 tie-breaker，防止不同 Node/Locale 产生漂移。

## 7. 实施路线

### P0a：Web harness + 播放/存储（先做，约 1 个迭代）

- 建立 `test/harness/fake-clock.js`、`fake-browser.js`、`http-fixture.js`、`temp-root.js`、`api-client.js` 的最小版本；
- 新增 `test/player.js`：fake audio/HLS/MediaSession/BC，冻结播放状态机不变量；
- 新增 `test/store.js`：fake browser + 多标签 + dirty/rev/flush；
- `npm test` 仍保持现有逐文件子进程入口；新测试先独立文件加入，不拆已有混合测试。

验收：player/store 关键矩阵全绿；`npm test` 仍离线；无业务代码依赖测试框架。Android 只需保持现有 JVM 测试和共享契约绿灯。

### P0b：Web 编排、台标和正式页面 Smoke（紧接 P0a）

- 新增 `test/sync.js`：fake clock + fake App/Player，覆盖四通道编排；
- 新增 `test/logos.js`：`get/visual` 来源优先级、缓存和负缓存；
- 建立 `.ci/browser/` 独立 Playwright 工具目录；
- 复用 P6 的自举 worktree、报告格式和清理门；正式页面断言按上述 PR 矩阵重写，不把 ui-demo 专属样例数量当成正式页契约。

验收：sync/logos 关键矩阵全绿；Chromium PR smoke 可在隔离实例运行；真实网络仍不进入硬门。

### P1：统一 Web 边界集成和 CI 门禁（约 1 个迭代）

- 将 P0a 的 `test/harness/` 归拢为稳定公共接口，补齐 API client、故障注入和报告工具；
- 将 `/api/sync`、force-token、boot、mystation、myradio、nowplaying、proxy 纳入统一 API 矩阵；
- 增加生成资产/manifest 校验；
- 新增根目录 GitHub Actions：Node 版本矩阵（至少 14、18、20/当前 LTS）、`npm test`、契约和 API 测试；
- Android workflow 保留 path filter，并把 `contracts/**`、`radio.txt`、`logos.txt`、`radio-meta.json` 和 workflow 变更纳入触发条件；instrumented 模拟器任务先以手动/夜间草案存在，不立即阻塞 PR。

验收：干净 checkout 在无用户数据、无公网依赖下可复现；失败有 artifact（日志、JSON 报告、fixture 版本）。`myradio` 的既有清洗用例和新增高风险用例均通过后，才算不再是高风险未覆盖写端点。

Node 14 政策：当前 `engines` 为 `>=14`，CI 必须保留 Node 14 leg。若出现 Node 14 不兼容，默认修复代码或增加兼容分支；只有经单独 ADR/版本发布决策后才可提升 engines 并移除 Node 14。

### P2：Web 浏览器和跨端稳定性（约 1–2 个迭代）

- Chromium PR smoke；Firefox/Edge 夜间；
- 多标签真实页面对抗：Store、质量、统计、维护冲突；
- Android instrumented smoke 和共享 fixture 逐字段 diff；Web 正式页面仍是本阶段主验收对象；
- 无障碍、200% 缩放、forced-colors、窄高窗口矩阵。

验收：正式页面关键用户路径可在隔离实例完成；宿主数据和 worktree 零泄漏；跨端黄金样本无未解释差异。

### P3：长时与发布演练（持续）

- 真实源抽样、长时播放、自愈和连接回收；
- kill/写失败/坏 manifest/回滚/重启演练；
- 质量、统计、曲讯 sidecar 长时容量与裁剪；
- 发布前报告汇总到 `docs/test-reports/` 或 CI artifact，不把易漂移的公网结果写入稳定 fixture。

## 8. 新功能的“测试随行”规则

以后每个功能 PR 必须在描述中填写：

1. 影响的领域、持久键、契约和两端；
2. 选择 L0/L1/L2/L3/L4/L5 哪一层验证；
3. 正常、坏输入、边界、重试/并发、旧数据迁移中适用的 case；
4. 新增或修改的 fixture、时间基准和清理策略；
5. 运行命令和未执行项（例如本机没有 Java/Playwright）；
6. 是否需要更新 `contracts/`、Android 白名单、备份 schema、manifest 或 CI path filter。

以下改动不得只靠手工点播：

- 播放顺序、重连、曲讯、音量、睡眠、多标签；
- Store/sidecar/备份/导入/同步/生成资产；
- URL 安全护栏、Host/Origin、重定向、body 上限、原子写；
- 任何 `radio.*` 键、共享数据行格式或跨端契约；
- feature flag 开关两态行为。

## 9. 评审结论和取舍

这套方案不追求“所有公网流永远可测”，而是把可确定的业务不变量、边界协议、文件事务和 UI 状态全部变成可重复测试，把公网漂移和真实设备能力放到有报告的夜间/发布前层。这样既能覆盖当前项目绝大多数 case，又不会因为网络、浏览器或 Android SDK 的偶发不可用而让核心迭代失去反馈。

优先级应固定为：

1. 先补 `player.js`、`store.js`、`sync.js`、`logos.js` 的确定性状态测试；
2. 再统一服务端 fixture/API 和根目录 CI；
3. 然后扩展真实浏览器、多标签、Android 设备和长时发布演练。

在 P0/P1 完成前，项目仍可以继续开发，但涉及播放、持久化、同步和跨端契约的改动应视为高风险变更，必须附带定向测试和明确未覆盖项。

## 10. 附录：落地进度与欠账（2026-11-15 基线之后的实施状态）

> 状态表唯一入口：每批落地/修订后在**自己批次的行**追加记录（已落地 + 仍欠项），不改写 2026-11-15 的
> 历史基线正文。仍欠项必须写明接手批次/负责人视角与验收条件，不允许只写「待办」；本地无法完成的项
> （运维/远端环境）如实标注。接口/命令/覆盖事实变化必须同步回写，防止状态表长期停留在「尚未创建」。

| 批次 | 已落地 | 仍欠（验收条件） |
|---|---|---|
| P0a harness/player/store | （待批次落地后填写） | （待批次落地后填写） |
| P0b sync/logos/PR smoke | （待批次落地后填写） | （待批次落地后填写） |
| P1 统一 API 矩阵 + CI 门禁 | 真服务矩阵五件 + 资产校验全部落地：`station-api.js`（mystation/boot，isolated 临时应用根视角）、`np-proxy.js`、`sync-api.js`（token 单次消费/forced 真发布链/busy 409，宿主 last-sync-report 零接触有对照断言）、`myradio-api.js`（/api/myradio 高风险矩阵：全量替换语义/500 行与 64KB 封顶/replace 与 mystation 共用写队列并发/rename 失败保旧/空列表清空/备份恢复联动）、`assets.js`；listen-stats 拆层（纯状态机 `listen-stats.js` 进 unit、端点 `listen-stats-api.js` 进 api）；run.js 三个 profile 白名单同步；web.yml 结构修复（`if-no-files-found` 移入 upload-artifact 的 `with`）+ 证据面（Node 三版本日志/汇总 JSON `if: always()` 上传、浏览器轻量证据 always、截图仅失败上传，`set -o pipefail` 保留退出码）；本地全量与 unit/api profile 实跑 0 失败 | ① 分支保护 required checks 配置：把 web.yml 的 `node` / `browser` check 名登记为 PR 必过门——属仓库运维操作，本地无法完成，接手人在 GitHub 分支保护/规则集中配置后按一次真实 PR 验证缺失 check 会挡合并；② web.yml 远端首跑验证：workflow 结构本地仅做 YAML 解析与 with/step 层级自查，Linux runner + Node 14/18/20 矩阵 + Chromium 无法本地复现——push 后在远端 CI 实跑，确认全部矩阵 job 执行并产出结果与证据 artifact，方可认定「代码 job 可运行」，与 ① 的「合并必须通过这些 check」分别验收 |
| P2 浏览器/Android | （待批次落地后填写） | （待批次落地后填写） |
| P3 夜间/发布前 | （待批次落地后填写） | （待批次落地后填写） |
