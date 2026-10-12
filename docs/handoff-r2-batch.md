# VRadio r2 批次交接文档（10 件，可直接落地）

> **给接手人**：本文档是自包含的实施包——背景、方案、决策由来、逐件实施卡（含代码锚点/坑/验收剧本）全在此。读完本文 + 补读 AGENTS.md「架构要点」一节即可开工，不需要重新调研。
> 定稿日期：2026-10-12（grilling 三轮 frontier 问答 + 一轮平行调研吸收裁决，全部 owner 拍板）。
> **产出纪律：单 PR、功能分 10 commits、从 ui-polish 合并后的 main 拉新分支。**

---

## 一、背景速览（30 秒版）

VRadio = 零依赖本地网络电台 Web 播放器（国内电台为主、欧美音乐台为辅，面向国内直连环境）。`npm start` 起 server.js（127.0.0.1:8137），浏览器即客户端。无 npm 依赖、无构建、无测试体系（验收 = 浏览器实测）。

**硬边界（不可破）**：
1. 零依赖无构建：只用 Node 内置模块 + 本地 hls.min.js；**经典 script 顺序引入**（ES modules 在 file:// 下必挂）；`logos.js` 必须先于 `app.js` 装载。
2. 国内直连：运行时不依赖境外不可达服务。
3. file:// 降级形态合法：依赖后端的新功能在 file:// 下静默降级或明确提示，不许报错崩坏。
4. EPG 已砍不回头。

**模块契约（改动前必读）**：
- `player.js` 拥有 audio/hls/播放态的唯一所有权；UI 反馈经回调注入（`onstate/onstatus/onfail/ontick/onplaylast`，声明在 player.js:17-21，注入在 app.js:648-653、853）。**player 不反向伸手进 app/logos——新需求要数据就走同款回调注入。**
- `app.js` 拥有列表/渲染/收藏/localStorage；`logos.js` 拥有台标数据；`sync.js` 只编排同步/体检。
- **身份公理：URL = 持久身份，名字 = 显示层**。收藏（radio.favs）/最近（radio.recents）/成功源记忆（radio.srcmem）/死台标记（radio.health）全部按源 URL 回绑——任何「改电台数据」的功能都不许断这条链。

**代码风格**：中文注释、UI 文案全中文、极度紧凑短行；注释讲「为什么」不讲「是什么」。

## 二、决策由来（为什么这么定）

1. **一轮调研**（docs/roadmap-research.md，已全量实施完毕）：确立五簇功能地图，交付 6 件。
2. **二轮调研**（docs/roadmap-research-r2.md）：GitHub 12+ 同类项目取样 + 候选数据源国内直连实测（iTunes 可达、LRCLIB 不稳、radio.garden 不可达）。
3. **grilling 三轮 frontier 问答**（r2 文档决策记录）：拍板 A2/A3 + N 系列 6 件；砍 A1 封面/A4 自动同步/B8 歌词/N6/N9。
4. **平行调研吸收裁决**（docs/expansion-analysis.md，r2 文档决策记录第四轮）：吸收 P1-a 追加备选源 + artwork 填台标；维持砍随机漫游/合并备份；砍 B6 分组导航。

关键拍板原话：「这是电台又不是某张 CD 专辑」（封面砍）；「N8 留着其他砍」；「只写当前台记忆」（音量语义①）。

## 三、批次总览

| # | 功能 | 成本 | 主战场 | 实施卡 |
|---|---|---|---|---|
| 1 | A2 MediaSession 切台键 | ~15 行 | player.js + app.js | §4.1 |
| 2 | A3 每台音量记忆 | ~35 行 | player.js + app.js | §4.2 |
| 3 | N1 file:// 全量列表 | ~40 行 | update-sources.js + app.js + index.html | §4.3 |
| 4 | N2 歌曲历史导出 | ~25 行 | app.js | §4.4 |
| 5 | N3 多标签页防双播 | ~20 行 | player.js | §4.5 |
| 6 | N4 同步 diff 摘要 | ~30 行 | update-sources.js + sync.js + app.js | §4.6 |
| 7 | N5 回到正在播 | ~20 行 | app.js | §4.7 |
| 8 | N8 快捷键帮助 | ~30 行 | app.js | §4.8 |
| 9 | P1-a 维护面板追加备选源 | **150~200 行（本批唯一大件）** | app.js | §4.9 |
| 10 | artwork 填台标 | ~10 行 | player.js + app.js | §4.10 |

**开工前提**：`feature/ui-polish` 合并进 main 后 `git checkout -b feature/r2-batch`。本批与 ui-polish 同重度触碰 app.js/index.html 渲染区，串行是 owner 拍板，不要并行开工。

**建议实施顺序**（每步一个 commit）：⑩ → ① → ⑦ → ④ → ⑤ → ②（小件先行）→ ③ → ⑥（数据管线两件连着做）→ ⑨（大件，可拆 cfg 层 + 面板 UI 两 commit）→ ⑧（最后做，键位集合以 ui-polish 落地后为准）。

**提交纪律**：commit message 沿用仓库风格（中文、带决策编号引用，如 `feat: A2 MediaSession 切台键`）。

---

## 四、逐件实施卡

### 4.1 A2 MediaSession 切台键（锁屏 ⏮⏭ = 收藏间切台）

- **目标**：锁屏/蓝牙耳机/键盘媒体键的 ⏮⏭ 当前是死的（player.js:36-43 只注册了 play/pause/stop），注册 `previoustrack`/`nexttrack` → 收藏间切台。
- **现状基线**：切台逻辑现成——`App.stepFav(d)`（app.js:377，一轮 A-5 交付）；回调注入模式现成——player.js:21 声明 `onplaylast`、:39 使用、app.js:853 注入。
- **实现**：player.js 声明区加 `onstepfav: null`；MediaSession 注册块（:38-42 的 try 内）加两行 `ms.setActionHandler('previoustrack', () => this.onstepfav && this.onstepfav(-1))` 与 `nexttrack` (+1)。app.js boot 注入区（:648-653 旁）加 `Player.onstepfav = d => this.stepFav(d)`。
- **坑**：个别浏览器不支持这两个 action 会 throw——现有整个注册区已被 try/catch 包住，沿用即可；无收藏台时 stepFav 自身静默（接手时验证 app.js:377 空收藏分支，若无兜底则 stepFav 入口处加一个）。
- **验收**：播放中按键盘 ⏭（或锁屏界面下一首）→ 切到下一个收藏台；无收藏时按键无事发生不报错。

### 4.2 A3 每台音量记忆（语义①：只写当前台）

- **目标**：台间电平差异（央广 vs 欧美）每天都在咬人。按台主 URL 记音量，点播自动套用。
- **现状基线**：全局单音量 `radio.vol`；唯一出入口 player.js:23-24（init vol0）与 :48（setVolume）；滑杆 app.js:867；静音按钮 app.js:859-865（lastVol 语义）。
- **拍板语义（owner 2026-10-12）**：**调音量只写当前台记忆 `radio.volperst`**；全局 `radio.vol` 仅在「无记忆台」上调整时才写。
- **实现**：新增 `radio.volperst` {台主URL: 0-100 整数}，FIFO 300（对齐 srcmem 的写法 player.js:167-169）。`Player.play(s)`（player.js:62）内套用：`volperst[s.u[0]]` 有则用，无则全局——注意同步 `this.vol` 基准（睡眠渐弱恢复 player.js:193/198/205 依赖它）并回写滑杆 UI。app.js:867 滑杆 oninput 分流：有正在播台 → 写 volperst；无 → 写 radio.vol。
- **坑**：①**静音按钮不写记忆**（mute 是瞬态；unmute 恢复时若当前台有记忆，lastVol 取记忆值而非旧全局）；②手动隐藏/改名不影响（URL 身份公理天然兼容）；③localStorage 读写全部 try/catch（现有风格）。
- **验收**：A 台调 30% → 切 B 台（回全局音量）→ 切回 A 台自动 30% 且滑杆显示 30；静音→取消静音不冲掉记忆；刷新页面后记忆仍在。

### 4.3 N1 file:// 全量列表（同步生成 radio-data.js）

- **目标**：双击 index.html（file:// 降级）从「~40 个内置精选」升级为「浏览/播放全库 1600+」。
- **现状基线**：file:// 下 fetch 被拦，`reloadMain` 直接 return false（app.js:154）；boot 回退在 app.js:900-906；经典 script 本地加载已被 hls.min.js 证明可行；radio.txt 写盘点 update-sources.js:348-350（tmp+rename 原子替换）。
- **实现**：①update-sources.js 写 radio.txt 后同步生成 `radio-data.js`（内容 = `window.RADIO_DATA=` + JSON.stringify(radio.txt 全文)），同走 tmp+rename；②index.html 在 app.js **之前**加 `<script src="radio-data.js"></script>`（文件不存在时静默，`window.RADIO_DATA` 为 undefined）；③app.js boot：reloadMain 返回 false 且 `window.RADIO_DATA` 存在 → `applySources(this.parse(window.RADIO_DATA), [])`。
- **坑**：①radio-data.js 是**生成物**，与 radio.txt 同策略跟踪进 git（clone 即用，file:// 用户不跑同步也有全库）；②`#hint`（app.js:901）的显示语义要调：现在「连 RADIO_DATA 都没有」才提示；③体积 ≈ radio.txt（~200KB），JSON.stringify 一次成型，无需分片。
- **验收**：双击 index.html 见到全库分类条与 1600+ 台；直流台（如蜻蜓 mp3）可播；代理级 m3u8 台点播失败时给既有失败提示不崩；`npm run sync` 后 radio-data.js 随行更新。

### 4.4 N2 歌曲历史导出

- **目标**：`radio.songs` 数据资产（app.js:426-434）导出为「听过的歌」清单，拿去音乐 App 搜。
- **现状基线**：弹层 `toggleSongHist`（app.js:435-445）；下载范式 `exportFavs`（app.js:449-460，Blob + a.click + 空态提示）。
- **实现**：弹层头部加「导出」按钮；收集全部台的历史按 `at` 倒序拼 `歌名（台名 · YYYY-MM-DD HH:mm）` 行；Blob 下载 `vradio-songs.txt`。台名按 URL 键从 stations 反解（解不到用 URL 截断兜底）。
- **坑**：当前曲不入史（口径同 pushSongHist，app.js:420 只入旧歌）；文本不过 HTML 转义（纯文本文件，exportFavs:454 注释有先例）；空历史走状态栏提示不下载空文件。
- **验收**：连听两首换歌后导出 → txt 两行内容/台名/时间正确；无历史时点导出给提示。

### 4.5 N3 多标签页防双播

- **目标**：两个标签页双播混音是真实防呆场景。后来者赢：新标签开播，旧标签自动暂停。
- **现状基线**：play() player.js:62；建流成功事件 player.js:25（'playing' 监听）；pause() player.js:178。
- **实现**：player.js init 建 `BroadcastChannel('vradio')`（try/catch 包裹，不支持/file:// 异常即静默降级）；'playing' 事件里 `bc.postMessage('on')`；`bc.onmessage` 收到且 `!this.isPaused()` → `this.pause()`（**暂停非 stop**，保留台位用户可续播）。
- **坑**：BroadcastChannel 规范保证不回发发送者自身，无需自过滤；消息只发一个字面量，别传对象（保持极简）。
- **验收**：开两个标签页先后点播两台 → 先播的自动暂停、footer 状态正确；file:// 下不报错（降级为各自独立）。

### 4.6 N4 同步 diff 摘要（含收藏台消失点名）

- **目标**：同步后用户需要知道列表变了什么；收藏台随上游消失必须可感知。
- **现状基线**：merge+写盘 update-sources.js:335-350；summary 已有 total/delta（:363-364，注意现有 delta 只是总数差）；前端展示 sync.js:18-20。
- **实现**：①update-sources.js 写盘前读旧 radio.txt 原文，与新 merged 按**台名**集合算 added/removed（分类变化不算，改名 = 消失+新增如实呈现），名单各封顶 50 进 summary；②sync.js doSync 展示「新增 N 台、消失 M 台」；③removed 名单交 App 与 favs 比对（**收藏在 localStorage，服务端碰不到，比对必须在前端做**），命中即状态栏点名「收藏台 X 已不在新列表」。
- **坑**：summary.aborted 时不产出 diff（保留旧列表口径一致）；名单字符串过状态栏前过 `esc()` 等效处理（状态栏用 textContent 天然安全，保持 textContent 不用 innerHTML）。
- **验收**：手工从 radio.txt 删一台后同步 → 状态栏含「消失 1 台」；若该台已收藏 → 单独点名。

### 4.7 N5 回到正在播（footer 台名可点定位）

- **目标**：1600 台列表滚深后，一键找回正在播的台。
- **现状基线**：footer 台名 `$('nowline')`（app.js:402）；行定位 `row.dataset.k`（app.js:699）；分类切换 `$('cats')` onclick（app.js:691）。
- **实现**：nowline 加 click：有正在播台 → 若当前分类/搜索词下不可见 → 切「全部」+ 清 keyword → render 后 `document.querySelector('[data-k="..."]')` → `scrollIntoView({block:'center',behavior:'smooth'})` + 加 flash 类（CSS ~1s 高亮后移除，reduced-motion 下跳过动画直接定位）。
- **坑**：render 是整表重建，定位必须放在 render 之后；台被手动隐藏/死台隐藏时找不到行——静默不跳（不报错）；dataset.k 含特殊字符，选择器用 `CSS.escape` 或改用 `querySelectorAll` 遍历比对。
- **验收**：列表滚深 + 切了分类 → 点 footer 台名 → 跳回正在播行并高亮一闪。

### 4.8 N8 快捷键帮助（`?` cheatsheet，本批最后做）

- **目标**：全部快捷键一览（ui-polish 落地后键位变多：全局 4 个 + 行内方向键导航一组）。
- **现状基线**：全局 keydown app.js:678-686（`?` 空闲；`?` = shift+/，按 `e.key === '?'` 判）；浮层模式可复用 songhist（app.js:435）或 manage 弹窗；焦点管理范式 P2-7（manageOpen/manageClose，app.js:467-468：记录归还点 + 打开移焦 + Esc 关）。
- **实现**：全局 keydown 加 `?` 分支弹 cheatsheet 浮层（列：全局 `/`、空格、`←`、`→`、`?` + 列表行 ↑↓/Home/End/Enter/Space + 搜索框 Esc/↓）；Esc/点外关闭，焦点归还。
- **坑**：INPUT 内不触发（现有让位逻辑 app.js:682 已覆盖，把 `#songhist` 同类把 cheatsheet id 加进让位选择器）；键位表写死即可，但**必须以 ui-polish 合并后的实际键位为准**（所以排最后）。
- **验收**：`?` 弹出/关闭正常、列全键位与实际一致；焦点在输入框按 `?` 不弹。

### 4.9 P1-a 维护面板「追加备选源」（本批唯一大件，150~200 行）

- **目标**：「流地址天然漂移」是本项目一号敌人；同步实测/体检/多源切换三层韧性之外，补**用户层手动救援**：给失效台手动追加新源。
- **拍板边界（owner 2026-10-12）**：**只追加、不动身份**——绝不改/删原源（改了主 URL，收藏/最近/srcmem/健康标记四处回绑全断）；「替换失效源」需求走「追加新源 + 隐藏旧台」组合替代。
- **现状基线**：cfg 结构 `{moves, names, hideS, renames}`（解构见 app.js:136）+ `normStrMap`（app.js:80）；套用 `applyCfg`（app.js:135-146）与回滚重套 `reapplyCfg`（:147-151）；维护面板 :463+；探活调用范式 sync.js:46-47（`/api/check?url=`，假流拦截验收现成）；cfg 导出/导入与失配清单机制现成（面板顶部）。
- **实现**：①cfg 加 `srcs`：{任一源URL: [追加源...]}，normCfg 加校验（数组、元素 `^https?://`、条数与长度封顶，对齐 mystation 护栏口径）；②`applyCfg` 内对命中台 `s.u` append 去重（任一源 URL 命中即挂——与移动/改名同机制，同步重建后自动回绑）；③面板电台页加源管理 UI：选中台 → 列出现有源（只读）+ 输入框「追加源」→ 先 `/api/check` 探活，通过才写入 cfg（拒绝假流/死链，口径同 A-2 添加电台）；④cfg 导出/导入/失配清单自动纳入（srcs 键对不上任何台时进失配清单）。
- **坑**：①追加源进 `s.u` 后 `variants()`（player.js:53）与 srcmem（键 = `s.u[0]` 主 URL，player.js:66/166）天然不受影响——不要为新源改身份键；②UI 做在 ui-polish 落地后的面板新结构上；③URL 输入去空白/换行，拒绝非 http(s)；④面板是全量 innerHTML 重渲，输入框状态注意别被重渲清掉（参考现有搜索框 kw 持久做法）。
- **验收**：失效台追加新源 → 刷新页面仍在 → 点播进 variants 多源切换序列；收藏不失绑；`npm run sync` 重建后追加源回绑生效；假流（如 xmcdn 336 字节型）被探活拒绝；导出配置 → 重置 → 导入，追加源恢复。

### 4.10 artwork 填台标（MediaSession 锁屏大图）

- **目标**：锁屏/蓝牙媒体通知从纯文字升级为显示台标大图。零外部依赖（**不是** iTunes 封面——那件已砍，owner 原话「这是电台又不是某张 CD 专辑」，勿复活）。
- **现状基线**：MediaMetadata 两处（player.js:73 播放时 / :127 setSong 曲讯时）只有 title/artist；`Logos.get(s)`（logos.js:33）是同步窥探——绝不发请求，直接可用；回调注入点 app.js:648-653。
- **实现**：player.js 声明 `onlogo: null`；两处 MediaMetadata 加 `artwork: logo ? [{ src: logo }] : []`（logo = `this.onlogo ? this.onlogo(this.station) : ''`）；app.js 注入 `Player.onlogo = s => Logos.get(s)`。
- **坑**：①`artwork` 的 sizes/type 是可选提示字段，台标 URL 后缀杂乱（jpg/png/无后缀），**只给 src 最稳**；②artwork URL 不经过 HTML 插值（浏览器直接取图），无 XSS 面，不需 esc；③无台标台给空数组不报错；④台标可能运行时后解析到（收藏+正在播优先补全）——曲讯 setSong 时再取一次即可覆盖。
- **验收**：有台标台播放 → 锁屏/媒体通知显示台标；无台标台 → 不报错正常显示文字。

---

## 五、验收与回归（无测试体系，全靠浏览器实测剧本）

**单件验收**：按各实施卡的「验收」条逐项过。
**批次回归矩阵**（ui-polish 已有截图取证流程可复用）：双主题（深/浅）× 双视图（网格/列表）× 播放态（播/停/连接中）× 双形态（http:// + file:// 降级）× 维护面板开合；移动端 390px 断点抽查。
**file:// 专项**：N1/N3/N8 在降级形态各按卡片口径验收；其余功能在 file:// 下不许报错。

## 六、明确不做（防止「顺手做」）

| 项 | 状态 | 一句话理由 |
|---|---|---|
| A1 曲讯封面（iTunes） | 备选池 | owner：「这是电台又不是某张 CD 专辑」；锁屏视觉已由 ⑩ 覆盖 |
| A4 定期自动同步 | 备选池 | 本期未选，可复议 |
| PLS/XSPF 导入 | 备选池 | 需求面窄 |
| B5 电台详情面板 / B7 收听统计 | **未来计划**（ui-polish 后再议） | 复制流地址已确认并入 B5 |
| B6 分组导航 / B8 歌词 / N6 提速 / N9 合并备份 / 随机漫游 | **砍** | 裁决记录见 roadmap-research-r2.md 决策记录三/四轮 |
| EQ 均衡器 | **砍，勿重提** | Web Audio MediaElementSource 一接入，CORS 未授权流直接静音，三级播放策略被毁 |
| EPG / 录音 / 频谱 / 拼音搜索 / PWA / 云同步 / 多房间 | **砍（前案）** | 见 roadmap-research-r2.md C 档 |

## 七、参考资料索引

- 决策全档：docs/roadmap-research-r2.md（调研 + 实测 + 四轮决策记录 + 审核核查表）
- 平行调研：docs/expansion-analysis.md（P1-a/artwork 来源文档，保持原样未动）
- 模块契约与安全回归清单：docs/review.md（G 组清单在改 server.js 时必过——本批只有 ⑨ 接近但不新增端点，复用 /api/check）
- 团队知识：AGENTS.md（架构要点/已知坑/代码风格）
- UI 基线：docs/ui-audit.md（本批开工前提 = 它落地合并）
