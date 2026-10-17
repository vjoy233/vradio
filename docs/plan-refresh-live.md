# 方案：播放手动刷新回直播头（Web + Android 两侧）

2026-10-15 立项。需求原话：暂停一段时间再继续，流会先接上刚才的内容、随后自动跳到最新——期望「暂停续播接旧流（维持），手动刷新才跳最新」。经评估（见第 1 节）拆为两半：**暂停续播维持现状**（上限=客户端已缓冲窗口，物理不可扩展，否决时移见 [adr/0003](adr/0003-no-client-timeshift.md)）；**本方案只做手动刷新**——用户主动一键回到直播头。两侧（Web / Android）同步实现，行为完全镜像。

## 0. 结论速览

| 项 | 拍板 |
|---|---|
| 语义 | 刷新 = 用**当前正在用的源**重开整条装载链，新连接必落直播头；不动成功源记忆 |
| 入口（Web） | footer `#pp` 旁 ↻ 按钮 + 快捷键 R（#keys 表同步加行） |
| 入口（Android） | 播放栏「刷新」TextButton + 通知栏 MediaSession 自定义 action |
| 暂停中按刷新 | 直接重开并**起播**（刷新=「我要听最新的」；只装不播对直播流无意义） |
| 空台/全失败 | 无响应（不做失败态重试，语义不外溢） |
| 持久化 | 不新增、不改动任何 `radio.*` 键（两侧 13 键契约不动） |
| 交付 | 同分支分侧提交：docs → Web 实现 → Android 实现 |

## 1. 背景与机理（为什么只能这么做）

**现状链路**：暂停即停拉流（Web `audio.pause()` / Android `exo.pause()`），已缓冲音频保留；恢复后先播完缓冲（= 用户看到的「接上刚才的内容」），缓冲耗尽触发既有断流自愈（Web stalled/waiting 看门狗 12s → `retryOrNext`，player.js:229-250；Android 看门狗 `C.WATCHDOG_MS` → `retryOrNext`，PlayerHolder.kt:427-445）重连当前源——新连接落在直播头，即用户看到的「马上自动刷新到最新」。暂停期间上游断连的，走 halt 守卫挂起（heldNext），恢复时立即重连直播头，连「旧流一段」都没有。

**物理约束**：直播服务器不保留过去。Icecast/直流无 seek/Range，重连必落直播头；HLS 电台 playlist 滑动窗口普遍只留几个分片。「暂停续播旧流」的时长上限 = 恢复时客户端已缓冲量（浏览器/Media3 内部策略，应用层对直流台无抓手）；缓冲耗尽后除「回直播头」外只有静默卡死一条路——既有自动兜底是正确行为，保留不动。

**结论**：暂停续播无操作空间（ADR 0003）；用户真正缺的是「主动回直播头」的入口——本方案。

## 2. 语义定义（与近邻动作的边界）

| 动作 | 触发 | 源选择 | 记忆 |
|---|---|---|---|
| **刷新（本方案）** | 用户主动（按钮/R 键/通知栏） | **当前源**重开整链（prefer=curSi 提首） | 不碰 srcmem |
| 恢复默认源 | 用户主动（选源浮层 ↺） | 清 srcmem 后按启发式重选 | 删 srcmem 条目 |
| 断流自愈 | 被动（error/看门狗/ended） | 先重连当前源一次，再顺延备选源 | 成功后写 srcmem |
| 切台 | 用户主动 | 完整决策链 | 正常写 srcmem |

**状态矩阵（两侧一字不差）**：

| 状态 | 行为 |
|---|---|
| 播放中 | 重开整链并起播 |
| 连接中（级联在飞） | 允许——世代令牌作废在飞旧链，从头再来 |
| 暂停中（halt：用户暂停/多标签让位/睡眠定时） | 重开整链并**直接起播**（清 halt/heldNext） |
| 空台（未播 / 全部源失败 station=null） | 无响应 |
| 成功源记忆 | 不写（onAir 同源早退）；源若已死由既有 error 级联顺延兜底 |

## 3. Web 方案

### 3.1 引擎（player.js）

新增公开方法 `refresh()`（约 6 行，复用 `play()` 整链，全部既有机制自动生效——token 作废在飞链、清 halt/heldNext（player.js:134）、决策链 prefer 提首（:138）、台记忆音量重套（:145-148）、MediaSession 重设（:149-152）、connecting 指示）：

```js
refresh() { // 手动回直播头：当前赢家源整链重开（暂停态直接起播；语义边界见 docs/plan-refresh-live.md §2）
  const s = this.station, si = this.curSi;
  if (!s) return;
  this.play(s, si >= 0 ? si : undefined);
}
```

`si < 0` 分支是防御（station 非 null 时 curSi 恒已设，见审计 R1-1）。

### 3.2 UI（index.html + app.js）

- **footer 按钮**：`#pp`（index.html:271）与 `#eq` 之间插 `<button class="btn" id="refreshBtn" title="刷新：断开当前连接，回到直播最新处">`，图标**复用现有 `i-sync` symbol**（与 header「同步源」同形不同语境，title 消歧；不新增 symbol，图标集保持封闭——审计 R1-6）。
- **接线**：`#pp` 接线块内（app.js:1236 一带）：

```js
$('refreshBtn').onclick = () => this.doRefresh();
doRefresh() { // 刷新入口（按钮与 R 键共用）：清曲讯尾巴再重开——同台重播不清 songFor，旧歌名会挂到下一轮 15s 轮询
  if (!Player.station) return;
  this.songFor = ''; this.lastSong = ''; $('song').hidden = true;
  Player.refresh();
}
```

  主动清 `songFor/lastSong` 后，play 链 `emit(true)` → `playerNow()`（app.js:552-555）按「新台」分支再清一遍，幂等；曲讯由 15s 轮询自然补新（`curUrl` 经 `load()` 重写同值，轮询无感）。
- **快捷键 R**：主键盘处理器（app.js:1014-1025）加 `if (e.key === 'r' || e.key === 'R') { e.preventDefault(); this.doRefresh(); }`——自动落在既有修饰键守卫（:1015）与焦点让位守卫（:1020，焦点在输入框/列表行/面板内让位）之内。index.html `#keys` 表加一行 `<kbd>R</kbd> 刷新（回到直播最新处）`（改键位两处同步纪律）。
- **路由层级**：按钮/R 键都走 app 层 `doRefresh()`（清曲讯属 app 私有状态）→ 引擎 `refresh()`；**不走** `startPlay` 同族包装（不重复记 recents/台标预取——见审计 R1-7）。

### 3.3 与既有机制交互核对

- 多标签防双播：refresh → play → 建流成功 playing 广播 'on'（player.js:38），他页让位——「后来者赢」语义正确。
- 睡眠定时：不动 sleepId/sleepEnd；渐弱最后 30s 内刷新会把音量重置为台记忆值，下一秒渐弱 interval 继续压低——可接受（审计 R1-16）。
- 选源浮层（#srcMenu）开着时刷新：不换源不动徽标，浮层不专门关闭（审计 R1-记录）。
- file:// 模式：curPlay 不会是 /proxy 形态（variants 在 file:// 下不含 proxy），直流重开可用。
- 空台/全失败：`Player.station === null` 早退，按钮安静无响应。

## 4. Android 方案

### 4.1 引擎（PlayerHolder.kt）

新增公开方法 `refresh()`，镜像 Web——重走 `play(s, prefer=curSi)`（决策链重建 + token 作废在飞链 + 清 halt/heldNext + 全套 UI 态/音量/MediaSession，全部既有机制）：

```kotlin
fun refresh() { // 手动回直播头：当前源整链重开（镜像 Web Player.refresh，语义见 docs/plan-refresh-live.md §2）
    val s = /* 当前台 */ ?: return          // 空台无响应
    play(s, curSi.takeIf { it in s.u.indices }) // prefer=当前源提首
}
```

实现核对点：`play()` 链内 `next()`/`loadVariant()` 已重置 `retried` 与 `lastPos=-1L`（看门狗簿记，PlayerHolder.kt:304）——refresh 不得绕过 `play()` 直呼 `loadVariant`（那会漏 halt/heldNext/级联上下文重建；`loadVariant` 仍是私有原语）。

### 4.2 播放栏（PlayerBar.kt）

「源」按钮后（:115 行后、Row 收口前）新增 `TextButton("刷新")`，显隐条件同选源按钮（`st != null`）；文案硬编码中文（CONTRACTS.md:12 纪律）；点击直呼 `PlayerHolder.refresh()`（同 `PlayerHolder.toggle()` 直呼先例，PlayerBar.kt:64；**不走** `vm.startPlay` 路径避免重复记 recents/台标预取）。连接中指示（spinner + ui.status「连接中… 源i/n」）由 play 链既有链路自动驱动，无需额外反馈。

### 4.3 通知栏自定义 action

现状：通知栏由 Media3 经 `PlaybackService` 自动构建（无手写通知），先例是「占标准命令位改语义」（⏮⏭→收藏切台），custom command 无先例但 CONTRACTS.md:189 已预留合规路径。方案：

1. `SessionCommand` 自定义 action（如 `ACTION_REFRESH`）+ `CommandButton`（customIcon 需 drawable、displayName「刷新」）；
2. `MediaSession.setCustomLayout(listOf(btn))`——按钮出现在通知栏标准 action 之后；
3. `MediaSession.Callback.onCustomCommand` → `PlayerHolder.refresh()`（session 与 Holder 同进程直调）；
4. 实现注意（审计 R1-9）：`onConnect` 默认 `ConnectionResult` 须放行该 sessionCommand，否则按钮不显示；icon 优先复用现有 drawable，无则自绘 24dp vector（不引第三方资源）。

行为镜像核对：焦点让位态（halt）下通知栏刷新 → play 链 `exo.play()` → Media3 自动重请求焦点（平台默认行为接管）；通话中焦点被占属极端场景，接受平台裁决（审计 R1-10）。

### 4.4 不做的（Android 侧）

锁屏 MediaStyle 的 seekbar/快进快退按钮不加（直播无 seek 语义，Fwd 已显式禁用 SEEK_* 命令）；不加 refresh 的 Android Auto/wear 投射。

## 5. 测试与验收

**现实约束（两侧一致，不破纪律）**：Web player.js 无浏览器外测试面（test/smoke.js 只测 server/update-sources 安全矩阵）；Android PlayerHolder 在「纯 JVM 无 robolectric」纪律（CONTRACTS.md:16-17）下不可单测。refresh 是纯编排（复用已存在路径 play/loadVariant），无可抽纯函数的新逻辑——**两侧都不新增自动化测试**，不为它破纪律。

- 回归门槛：`npm test` 零依赖冒烟（不触 server/store 应零影响）；`cd android && ./gradlew test` 94/94 仍绿。
- **手动验收清单（Web，npm start 后浏览器实操）**：
  1. 播放中按 ↻：状态栏「连接中… 源1/n」→「直播中」，音量保持台记忆，曲名行清空、15s 内出新歌名；
  2. 暂停 ≥2 分钟按 ↻ **或 R**：直接起播，内容为最新（不再回放暂停期间错过的部分）；
  3. 空台（未播/全部源失败）按 R：无响应；
  4. 焦点在搜索框打「r」：不触发刷新（让位守卫）；
  5. 双标签：A 播放中，B 打开同台按刷新 → A 自动让位暂停；
  6. `?` 帮助浮层有 R 行，与实际行为一致；
  7. m3u8 直流双形态各验一台（hls.js 路径与 audio 路径都重开成功）。
- **手动验收清单（Android，assembleDebug 装机）**：
  1. 播放栏「刷新」与通知栏自定义 action 同效：CONNECTING spinner → PLAYING，status 走「连接中…」→「直播中」；
  2. 暂停中两入口刷新都直接起播；
  3. 空台时播放栏无「刷新」按钮（随 st==null 隐藏）；
  4. 多源台刷新后仍用当前源（选源对话框高亮不变）；
  5. 锁屏通知栏按钮可见可点（onConnect 放行验证）。

## 6. 文档同步（实现提交内完成）

- android/CONTRACTS.md：PlayerHolder API 冻结表（:163-178）补 `refresh()` 行；语义硬点（:180-193）补一条「刷新=当前源整链重开、暂停中直接起播、不写 srcmem2」。
- AGENTS.md：player.js 职责行与 Android 行各补「手动刷新」短语（一句，不展开）。
- CONTEXT.md / docs/adr/0003：已随本方案落地（本次提交）。

## 7. 交付切分

同分支（feat/android）分侧提交：① docs（本方案 + ADR 0003 + CONTEXT.md）→ ② Web 实现（player.js/index.html/app.js + AGENTS.md 一句）→ ③ Android 实现（PlayerHolder.kt/PlayerBar.kt/PlaybackService 侧 session callback + CONTRACTS.md 补行）。②过 `npm test`，③过 `./gradlew test`，各自浏览器/装机冒烟。

## 8. 审计记录（对抗自审 R1，2026-10-15）

对初稿做一轮挑剔视角审查，发现与裁决如下（P1=须改、P2=实现注意、P3=留档）：

- **R1-1（P3）`si < 0` 分支是死代码防御**：station 非 null 时 curSi 恒已设（play→next 同步设值，无窗口）。保留 `si >= 0` 守卫防未来路径变化，不删。正文 §3.1 已注。
- **R1-6（P3）i-sync 图标复用的歧义**：footer↻ 与 header「同步源」同形。挑战后维持复用：语境分离（footer=播放控制）、title 消歧、图标集封闭优先。
- **R1-7（P1，已修）路由层级**：初稿 Android 走 `AppVm.refresh()` 包装——会诱使实现者顺手挂 startPlay 同族副作用（recents 重记）。修订：两侧 refresh 都在**引擎层**收口（Player.refresh / PlayerHolder.refresh），UI 直呼，app/vm 不加包装方法（曲讯清尾巴是 Web 侧 app 私有状态，留在 app 的 doRefresh）。
- **R1-9（P2）通知栏按钮不显示的坑**：setCustomLayout 的 CommandButton 若 sessionCommand 未在 `onConnect` 的 ConnectionResult 放行，按钮静默不渲染。已在 §4.3 列为实现核对点；验收清单第 5 条覆盖。
- **R1-10（P3）焦点让位态刷新**：Android halt 含音频焦点让位（与用户暂停同标志），通知栏刷新会重请求焦点，交 Media3 自动焦点处理裁决。极端场景（通话中）不特判。
- **R1-15（P1，已修）验收清单缺口**：初稿漏「暂停态 R 键与按钮同效」「通知栏 action 暂停态起播」「多源台刷新不换源」三条，已补 §5。
- **R1-16（P3）睡眠渐弱期刷新音量重置**：play() 重套台记忆音量，渐弱 interval 下一秒继续压——瞬态可接受，两侧同构不特判。
- **R1-A（P2）Android play() 签名核对**：§4.1 伪码按「prefer 可空」写，实现时对齐 PlayerHolder.play(s, prefer) 实际签名与 pctx 重建路径（agent 报告 :142-162），若 play 不接受空 prefer 则传 curSi 恒有值分支。
- 未发现推翻性缺陷：语义边界（§2）与三个近邻动作无重叠；世代令牌/级联兜底/多标签广播全部复用既有已验证机制。
