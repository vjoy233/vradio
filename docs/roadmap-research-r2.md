# VRadio 二轮扩展方向调研（同类项目对标 r2）

> 调研日期：2026-10-12（feature/ui-polish 分支）
> 调研方法：agent-reach（gh CLI）搜索 GitHub 六组查询取样 12+ 仓库，读 README 提功能清单；**候选数据源全部在本机（国内直连环境）做了可达性实测**；映射回本项目硬边界筛选。
> 状态：**已定稿（2026-10-12，grilling 三轮 frontier 问答全部收敛，决策记录见文末）**——本期交付 10 件（清单见文末；第 9–10 号来自 docs/expansion-analysis.md 平行调研的吸收裁决）；未动任何代码，等 ui-polish 合并后开工。
> 与一轮的关系：一轮调研（docs/roadmap-research.md）交付清单 6 项已全量实施（PR #7 + PR #8 处置完毕），README roadmap 勾选为证。本文档不重复已交付项，只找**下一批**。

---

## 硬边界（筛选前提，一轮边界全部继承）

1. **零依赖、无构建**：只用 Node 内置模块 + 本地 hls.min.js，经典 script 顺序引入。
2. **国内直连**：运行时不依赖任何境外不可达服务；同步期走 GitHub 镜像是既有合法模式。
3. **file:// 降级形态**：依赖代理/服务端的新功能在降级下不可用属正常，口径与现状一致。
4. **EPG 已砍**（owner 实测拍板），不再回头。
5. **模块契约**：player 拥有播放态、logos 拥有台标、app 拥有列表/渲染，sync 只编排。
6. **移动端**：方向已定「单独的安卓原生 app」，Web 端不做响应式深化（在途 ui-polish 只做断点修补）。
7. **单用户本地工具**：不做账号/云同步/遥测。

**勿重复提案（已交付）**：断流自愈+成功源记忆、添加自定义电台 UI、键盘快捷键、ICY 曲讯完整版、歌曲历史、开机静默体检（一轮 6 项）；MediaSession/睡眠定时/最近播放/收藏导入导出/浅色主题/均衡器动画（更早批次）。

**在途勿撞车**：feature/ui-polish 已拍板 A–E 五批（修复包/信息降噪/交互升级/视觉语言/微动效）——方向键导航、图标统一、网格密度、首字母色块、chip 角标、静音按钮、睡眠 popover 等均在其中。

**已砍勿再提**：EPG、闹钟、PWA/响应式深化、随机漫游、拼音首字母搜索、频谱可视化、录音、暂停缓冲、Last.fm、多房间/AirPlay、云同步、台标全量抓取（owner 拍板收藏优先）。

---

## 本轮样本（GitHub 2026-10 快照）

| 项目 | 形态 | 对本调研的启发 |
|---|---|---|
| jailsonsb2/RadioPlayer（36★，纯前端） | 单台嵌入式播放器 | **曲讯信息链的完整形态：曲名 → iTunes 专辑封面 → LRCLIB 歌词 → YouTube MV**；音量淡入淡出防爆音；重连 backoff |
| tsirysndr/tunein-cli（113★，Rust TUI） | TuneIn + Radio Browser 双库 | TuneIn 是另一个全球电台库（国内不可达，仅记录） |
| dancnb/sonicradio（87★，Go TUI） | Radio Browser 客户端 | **station info 详情面板**（码率/编码/国家/票数）；autoplay 开机自动播 |
| jonasrmichel/radio-garden-openapi（91★） | Radio Garden API 规范 | Radio Garden 有全量中国台 + 地理浏览——**但实测 radio.garden 国内不可达，排除** |
| mcplayer9999/radio-garden-m3u（32★） | Radio Garden 全量 m3u dump | 文件在 GitHub 上可达（镜像模式可行），但 2026-04 后停更迹象，与现有 top-500 重叠度高 |
| deroverda/recommended-radio-streams（386★） | 人工精选流清单 | 一轮已识别的第三上游首选，仍在活跃更新（2026-10-12） |
| ubuntu-flutter-community/musicpod（672★） | 桌面电台+播客 | radio+podcast 合体形态参照——podcast 超本项目边界，仅记录 |
| ebruck/radiotray-ng（301★，Linux 托盘） | 桌面托盘 | 关机定时、每电台独立通知图标——桌面原生能力，Web 不可比 |
| TheJoeFin/Traydio（196★，Windows 托盘） | 桌面托盘 | 全局热键/托盘常驻——浏览器形态做不到，仅参照 |
| nevermore23274/AetherTune（125★，Rust TUI） | 终端播放器 | 实时音频频谱为卖点——频谱已砍（AnalyserNode 受 CORS 限制），确认不回头 |
| CCSH/IPTV（496★） | 直播源/台标/EPG 采集工具 | 国内台标有采集生态，但以 TV 为主；本项目台标策略已拍板，不动 |
| Kingtous/RustPlayer（196★，Rust TUI） | 中文终端 m3u8 播放器 | 中文圈同类是终端形态——**「零依赖中文 Web 电台」这个生态位在 GitHub 上没有近身竞品**，VRadio 占的是一个真空 |

**共性观察**：一轮的五簇结论（曲讯/自愈/发现/个性化/录制）仍成立。两轮下来 VRadio 已齐自愈、个性化、曲讯；同类项目的**曲讯信息链是三级递进的——曲名 → 专辑封面 → 歌词/MV**，VRadio 目前只到第一级，封面是最自然的下一环。

## 候选数据源实测（本机国内直连，2026-10-12）

| 服务 | 用途 | 实测 | 结论 |
|---|---|---|---|
| **itunes.apple.com** Search API | 曲名 → 专辑封面 | 200 / 3.0s，`ACAO: *`（**前端可直调，零代理零接口**）；欧美曲命中好（Daft Punk ✓ 含 artworkUrl），中文曲命中差（周杰伦 0 结果） | **可用**。与 ICY 曲讯覆盖面恰好重合（曲讯只在欧美 Icecast 台有，欧美曲库正是 iTunes 强项） |
| **lrclib.net** | 曲名 → 歌词 | 200 / 1.8s，`ACAO: *`；但复测间歇 503 ServerOverloaded | 可达但稳定性存疑；中文曲库弱。降级为谨慎候选 |
| radio.garden | 全球电台发现 | **超时不可达** | 排除（含其 API 生态） |
| twj.es | 聚合曲讯 API（RadioPlayer 在用） | 400 / 4.1s 服务在线 | 黑盒第三方 + 已有自建 ICY 链路，排除 |

---

## A 档：低成本高价值，建议下一批

### r2-A1 曲讯专辑封面（iTunes，本档核心）—— ❌ 本期未选（owner 拍板 2026-10-12，入备选池，调研内容留档）

> **同类项目曲讯链的第二级，VRadio 信息层级的下一个「台标级」功能。**

- **现状基线**：曲讯链路完整（server.js `/api/nowplaying` 旁路 + app.js 15s 轮询 + `radio.songs` 历史 + `Player.setSong` 写 MediaSession，player.js:127）。**无封面**，锁屏只有文字。
- **功能**：换歌时以曲讯的「Artist - Title」查 iTunes Search API（`?term=…&media=music&limit=1`，实测 ACAO:* **前端直调，不走 /proxy、不加服务端接口**），取 `artworkUrl100`（URL 改尺寸参数可得 600px）：footer 曲名旁显示小封面 + MediaSession `artwork`（**锁屏/蓝牙耳机显示专辑封面**）。按曲名 key 缓存 + 未命中负缓存，不切歌不重复请求。
- **为什么是它**：曲讯的受益面是欧美 Icecast 台，iTunes 的曲库强项恰好是欧美音乐——两个覆盖面天然重合，中文曲命中差也不构成问题（国内台 m3u8 本无曲讯，不会出现「有曲名没封面」的尴尬）。
- **成本**：~50 行（app.js 为主 + player.js artwork 字段），零依赖零新接口，file:// 下也可用（纯前端直调）。
- **风险**：ICY 曲名脏（广告/台呼串）→ 未命中回退无图即可，不报错；iTunes 有频率限制但单用户换歌频率远低于阈值。

### r2-A2 MediaSession 切台键（锁屏「下一首」= 下一个收藏台）—— ✅ owner 已拍板（2026-10-12）

- **现状基线**：player.js:39-41 只注册了 `play/pause/stop` 三个 action——**锁屏/蓝牙耳机上的 ⏮⏭ 键当前是死的**；app.js 已有 ←→ 收藏间切台的现成逻辑。
- **功能**：注册 `previoustrack`/`nexttrack` → 复用收藏间切台。
- **成本**：~10 行。**收益/成本比全场最高**：锁屏场景（VRadio 一半使用场景）直接多一个核心操作。
- **风险**：无收藏台时静默忽略；浏览器对这两个 action 的支持有差异，注册失败 try/catch 即可（现有代码已有此模式）。

### r2-A3 每台音量记忆 —— ✅ owner 已拍板（2026-10-12）

- **现状基线**：全局单音量 `radio.vol`（app.js:596,775；player.js:24,48）。
- **功能**：电台间电平差异是每日真实痛点（央广系与欧美台音量感受差一截）。按台主 URL 存音量（`radio.volperst`，FIFO 对齐既有存储风格）：点播时该台有记忆用记忆、无记忆用全局；调音量时写当前台记忆。**待拍板**：调音量是否同步更新全局默认（建议：只写当前台，全局仅在「无记忆台」上调整时写——语义最直觉）。
- **成本**：~30 行（player.js 挂载点现成）。**已拍板语义①（2026-10-12）**：调音量只写当前台记忆，全局默认仅在「无记忆台」上调整时写（锚点稳定，记忆越积越准）。
- **风险**：低；纯本地行为，注意台被维护面板改名后按 URL 回绑不受影响（身份公理天然兼容）。

### r2-A4 定期自动同步（保持列表新鲜不靠人记）—— ❌ 本期未选（owner 拍板 2026-10-12，入备选池，调研内容留档）

- **现状基线**：同步全手动（页面按钮 / `npm run sync`）；开机只有静默体检（一轮 B-10），**不会自动同步**。
- **功能**：boot 时若距上次同步 >7 天（`radio.lastsync` 时间戳），首屏渲染后静默触发 `/api/sync`；与手动同步/体检的 `busy` 互斥沿用现有机制；完成仅状态栏一句话，失败静默保留旧列表（现有护栏已有）。频率三档可选（7 天/30 天/关，默认 7 天）。
- **为什么**：流地址漂移是本项目的一号敌人，死台率随时间单调上升；目前列表新鲜度完全依赖用户记得点按钮。
- **成本**：低（sync.js 编排 + 一个时间戳 + 一个设置项）。
- **风险**：同步约 1 分钟且含欧美台逐个实测的流量开销——必须「静默不打扰」（不抢状态栏叙事、可关闭）；file:// 无声跳过（口径同一轮 B-10）。

---

## N 档：grilling 审计新候选（脱离同类项目参照，从本项目资产/场景推导）

> 来源：不看同类项目做什么，只看 VRadio 自己的数据资产（radio.txt 全库 / radio.songs 歌曲历史 / radio.txt.bak 备份）、形态事实（hls.min.js 证明经典 script 在 file:// 下可加载）、真实场景（锁屏听、找歌、长时间挂机）。**N1–N5 + N8 已由 owner 拍板进本期（2026-10-12）；N6/N9 砍（见 C 档）。**

### N1 file:// 全量列表 —— ✅ 进本期

- **功能**：同步时把 radio.txt 包装成 `radio-data.js`（`window.RADIO_DATA="…"`），index.html 多一个经典 `<script src="radio-data.js">`，file:// 模式 boot 直读全局变量 → 双击打开也能浏览/播放全库 1600+ 台（代理级 m3u8 台仍播不了，直流台照常）。
- **现状基线**：file:// 下 fetch 被拦，`reloadMain` 直接 return（app.js:154），stations 停留 ~40 个内置精选（app.js:31）；经典 script 本地加载已被 hls.min.js 证明可行。
- **成本**：~40 行（update-sources.js 加输出 ~10 行 + app.js boot 回退 ~20 行 + index.html 一个标签）。
- **口径**：repo 多一个同步生成的大文件；手工改 radio.txt 没跑同步时，file:// 数据以最后一次同步为准。

### N2 歌曲历史导出 —— ✅ 进本期

- **功能**：歌曲历史弹层（点 footer 曲名）加「导出」按钮，`radio.songs` 全部历史拼「Artist - Title（台名 · 时间）」下载为 txt——听电台发现的好歌拿去音乐 App 搜，音乐场景定位的最后一公里。
- **现状基线**：`radio.songs` 数据资产已存在（app.js:428-433）。
- **成本**：~20 行，纯现有数据导出，无新数据链。

### N3 多标签页防双播 —— ✅ 进本期

- **功能**：`BroadcastChannel('vradio')`——开播时广播「我在播」，另一标签页正在播的收到后自动让位暂停。防两个标签页双重混音。
- **成本**：~25 行；file:// 下按浏览器行为静默降级（try/catch）。

### N4 同步 diff 摘要 —— ✅ 进本期

- **功能**：同步完成时对比 `radio.txt.bak` 与新列表，状态栏输出「新增 12 台、消失 8 台」；**消失台里若有收藏台，单独点名**（收藏按 URL 还回绑着，但源已死，用户该知道）。
- **成本**：~20 行，bak 文件现成。

### N5 回到正在播 —— ✅ 进本期

- **功能**：footer 当前台名变可点——点击切到该台所在分类、滚动定位、高亮一闪。1600 台列表滚深后一键找回。
- **成本**：~15 行。

### N8 快捷键帮助 —— ✅ 进本期（owner 从砍项捞回，原话「N8 留着其他砍」）

- **功能**：按 `?` 弹 cheatsheet 列全部快捷键。
- **注意**：键位集合以 ui-polish 落地后为准（方向键导航并入），**排本批最后做**。
- **成本**：~25 行（弹层 + 键位表）。

---

## B 档：中成本，价值取决于 owner 取舍

### r2-B5 电台详情面板（sonicradio `i` 键同款）—— ✅ 进未来计划（ui-polish 合并后做，owner 拍板 2026-10-12）

- **功能**：行的右键/长按/ⓘ 入口打开详情：该台全部源列表 + **逐源体检状态**（现在只有整体 ✓/✗，看不到是哪个源死）、台标大图、本台歌曲历史（`radio.songs` 数据已有，从 footer 弹层收拢）、维护操作入口（移动/重命名/隐藏直达）、复制流地址。
- **解决**：信息现散在三处（行内 badge / ⚙ 面板 / footer 弹层），详情面板收拢一处；「逐源状态」对多源台排障有真实价值。
- **成本**：中（新弹窗 + 全部复用现有数据，无新数据链）。
- **协同**：弹窗焦点管理在 ui-polish C 批落地，**建议排在其后**直接复用。

### r2-B6 「综合·其他」/大分类内分组导航 —— ❌ 砍（owner 拍板 2026-10-12 四轮：与「省份筛选不做」同一逻辑收口——给列表加维度让列表更难用，找台靠搜索框）

- **现状基线**：REVIEW.md 历史条目，ui-audit 对账确认未做且需求增强（重分类后「综合·其他」519 台平铺）。
- **功能**：省份/地名前缀 sticky 分组头，或右侧字母索引条。
- **成本**：中（地名词表 + render 分组改造）。
- **⚠️ 排序约束**：ui-polish 正在动 render 与网格/列表模板，**必须等 ui-polish 合并后开工**，否则双向撞车。

### r2-B7 收听统计（本地，防 dashboard 化）—— ✅ 进未来计划（owner 拍板 2026-10-12，克制在「一行总结」形态）

- **功能**：localStorage 累计每台/每分类收听时长，一个极简「本周常听」视图。
- **价值**：中低——自用小趣，与「本地优先不收集数据」自洽（纯 localStorage）。
- **成本**：低中。**谨慎**：克制在「一行总结」形态，别滑向图表 dashboard。

### r2-B8 歌词（LRCLIB，随行曲讯）—— ❌ 砍（owner 拍板 2026-10-12：间歇 503 + 中文曲库弱 + 电台歌词是「瞟一眼」需求）

- **实测**：LRCLIB 国内直连可达且 ACAO:*，但复测间歇 503，中文曲库弱。
- **判断**：电台场景歌词是「瞟一眼」需求，价值比封面低一档；稳定性存疑。若做，只接在曲讯历史/详情里懒加载，**不进主界面常驻**。B 档偏 C，可不做。

---

## 数据侧与独立立项

### 第三上游（roadmap 在列项，维持原判）

- **首选仍是** deroverda/recommended-radio-streams（386★，2026-10-12 仍在更新）——一轮结论不变。
- 新增候选 mcplayer9999/radio-garden-m3u：GitHub 可达（镜像模式可行），但 2026-04 后停更 + 与现有 top-500 重叠度高，**优先级低**。
- **前提不变**：现有欧美列表洗净后再议（README roadmap 原话）。

### 安卓原生 app（roadmap 在列项，形态建议）

独立立项而非 Web 端迭代，本调研只给形态锚点：
- **数据管线可整体复用**：radio.txt/logos.txt 是现成的产物文件，app 可直接消费（打包内置 + 可选在线更新）。
- **安卓无 CORS 问题**：三级播放策略简化为「ExoPlayer 原生吃 mp3/aac/m3u8」，服务端代理层在端上完全不需要——本项目最复杂的部分在安卓上恰好消失。
- 服务端探活/自愈逻辑（`checkStream` 字节级验收）值得平移到端上，是对 xmcdn 假流免疫的核心资产。

---

## C 档：明确不建议（本轮新增实测依据）

| 方向 | 参照 | 排除原因 |
|---|---|---|
| Radio Garden 生态接入 | radio-garden-openapi 等 | **实测 radio.garden 国内不可达**（超时），数据与 API 双死 |
| YouTube MV 联动（曲讯 → MV） | jailsonsb2/RadioPlayer 卖点 | YouTube 国内不可达 + 版权面，硬边界排除 |
| twj.es 聚合曲讯 | 同上 | 第三方黑盒依赖；自建 ICY 链路已覆盖欧美台，国内台它也没有 |
| podcast / 点播库 | musicpod 形态 | 直播工具 → 媒体库是换产品，超边界 |
| 台标全量抓取提覆盖 | CCSH/IPTV 生态 | owner 已拍板「收藏+正在播优先」，不翻案 |
| 均衡器（EQ） | expansion-analysis | **架构硬冲突**：Web Audio MediaElementSource 一接入，CORS 未授权的流（第①级直流全部优势）直接静音，三级播放策略被毁（与频谱同根因，论据更锐利，留档防重提） |
| N6 点播提速（preconnect / hover 预载） | 审核推导 | 蜻蜓建流 5–10s 慢在**服务端吐数据**，preconnect 只省握手 ~0.3s（<10%）；hover 预载为这点收益对每次悬停开流，流量/连接代价不值，且与断流自愈、世代令牌纠缠 |
| N9 个人数据合并导出 | 审核推导 | 收藏 m3u + 配置 JSON 两个入口各在其场景（顶栏/维护面板），合并只是挪位置无新能力 |
| 频谱/录音/EPG/随机漫游/拼音搜索 | 前案 | 一轮 C 档与 roadmap 已撤销项，不重复开列 |

---

## 决策记录（grilling 三轮 frontier 问答，2026-10-12，全部拍板）

### 第一轮（AskUserQuestion 卡片）

- **r2-A1 曲讯封面：不进**（入备选池，调研留档）。
- **r2-A4 定期自动同步：不进**（入备选池，调研留档）。
- **r2-A3 音量语义：语义①**——调音量只写当前台记忆，全局默认仅在「无记忆台」上调整时写。
- **B 档：B5 / B6 / B7 进未来计划**（B5/B6 排 ui-polish 合并后）；**B8 歌词砍**。

### 第二轮（N 系列细节确认后）

- **N1–N5：五件全进**。
- **砍项：N6 / N9 砍；N8 留着**（owner 原话「N8 留着其他砍」——从建议砍单中捞回快捷键帮助）。
- **安卓 app：Web 端收敛后再议**（roadmap 在列项维持）。

### 第三轮（批次与时机）

- **单 PR、功能分 commits；等 ui-polish 合并进 main 后拉新分支开工**（本批与 ui-polish 同重度触碰 app.js/index.html 渲染区，串行避免双向撞车）。

### 第四轮（docs/expansion-analysis.md 平行调研的吸收裁决）

背景：另一份同日同方法的平行调研，大面结论与本档收敛一致（封面砍 / 第三上游同候选 recommended-radio-streams / 安卓后议）；其三个关键前提经代码核查属实（维护面板无源编辑、导入只认 txt/csv/m3u、MediaSession 无 artwork）。裁决：

- **P1-a 维护面板「追加备选源」：吸收，并进本批（第 9 件，本批唯一大件 150~200 行）**——「流地址漂移」一号敌人的用户层手动救援，同步实测/体检/多源切换之外的第四层韧性。身份公理约束：**只追加不动身份**（收藏/最近/srcmem/健康标记全不受影响），首版不做替换/删除；存储走 radio.cfg 维护层 srcs 覆盖（同步重建后按台身份回绑，与移动/改名同机制，纳入配置导出/导入）；先 /api/check 探活再收。
- **artwork 填台标：吸收，进本批（第 10 件）**——MediaSession `artwork` 填 Logos 已解析的台标（src/sizes/type 给全），零外部依赖。对方「一行」口径修正：模块契约要求 player 不伸手进 Logos，走 onplaylast 同款回调注入，~10 行。
- **复制当前流地址：并入 B5 详情面板**（footer 不加独立按钮，避免将来挪位）。
- **PLS/XSPF 导入：进备选池**（VLC/RadioDroid 生态格式，需求面窄）。
- **随机漫游：维持一轮 A-3 砍单**（对方「采纳」无新论据，不翻案）。
- **合并备份（N9）：维持砍**（「搬家一次搞定」论据弱，两个入口各在其场景）。
- **B6 分组导航：砍**——与「省份筛选不做」同一逻辑收口（维度越多列表越难用，找台靠搜索框）。
- EQ 不做论据并入 C 档（MediaElementSource 毁三级播放策略）。

### 过程备注

- grill-me = grilling 的别名 skill（其 SKILL.md 仅一行转发）；一轮问答曾以纯 markdown 输出，owner 指出后**本轮起 frontier 问答统一走 AskUserQuestion 卡片交互**。

## 本期交付清单（定稿，单 PR、功能分 10 commits）

| # | 功能 | 范围要点 | 验收口径（浏览器实测剧本） | 主战场 |
|---|---|---|---|---|
| 1 | A2 MediaSession 切台键 | `previoustrack`/`nexttrack` → 回调注入复用 `App.stepFav`（app.js:377，onplaylast 同款模式）；无收藏台静默忽略；注册失败 try/catch | 锁屏/蓝牙媒体键 ⏮⏭ 在收藏间切台 | player.js + app.js |
| 2 | A3 每台音量记忆 | `radio.volperst` 按台主 URL（FIFO 对齐既有风格）；语义①只写当前台；点播时套用记忆，无记忆用全局 | A 台调小 → 切 B 台回全局 → 切回 A 台自动恢复小音量 | player.js + app.js |
| 3 | N1 file:// 全量列表 | 同步生成 radio-data.js（`window.RADIO_DATA`）；index.html 加经典 script；file:// boot 直读 | 双击 index.html 见到全库 1600+；直流台可播，代理级台失败提示不报错 | update-sources.js + app.js + index.html |
| 4 | N2 歌曲历史导出 | 歌曲历史弹层加导出：「Artist - Title（台名 · 时间）」txt 下载 | 连听两首歌后导出 txt 内容正确、当前曲不入史 | app.js |
| 5 | N3 多标签页防双播 | BroadcastChannel 开播广播，旧标签页自动让位暂停；file:// 静默降级 | 开两个标签页先后点播，先播的自动暂停不混音 | player.js + app.js |
| 6 | N4 同步 diff 摘要 | 对比 radio.txt.bak：状态栏「新增 N 台、消失 M 台」；消失台中含收藏台单独点名 | 同步后出摘要；手工删一台再同步，点名正确 | update-sources.js + sync.js |
| 7 | N5 回到正在播 | footer 台名可点 → 切到该台分类 + 滚动定位 + 高亮一闪 | 列表滚深后一键找回正在播行 | app.js |
| 8 | N8 快捷键帮助 | `?` 弹 cheatsheet 列全部快捷键；**排本批最后做**，键位集合以 ui-polish 落地后为准 | `?` 弹出/关闭正常，键位与实际一致 | app.js |
| 9 | P1-a 维护面板追加备选源（吸收自 expansion-analysis，**本批唯一大件 150~200 行**） | cfg 层 srcs 覆盖 + 面板电台页源管理 UI；只追加不动身份；先 /api/check 探活再收；纳入配置导出/导入 | 给失效台追加新源 → 刷新仍在 → 点播进 variants 多源切换；收藏/最近/srcmem 不失绑；同步重建后回绑生效 | app.js |
| 10 | artwork 填台标（吸收自 expansion-analysis） | MediaMetadata `artwork` 填 Logos 已解析台标（src/sizes/type 给全）；onplaylast 同款回调注入；无台标静默缺省 | 锁屏/蓝牙显示台标大图；无台标台不报错 | player.js + app.js（注入） |

**开工前提**：ui-polish 合并进 main 后拉新分支；N8 排本批最后。

**本期明确不做（备选池，可复议）**：r2-A1 曲讯封面、r2-A4 定期自动同步、PLS/XSPF 导入。
**未来计划（ui-polish 后）**：r2-B5 电台详情面板（含复制当前流地址）、r2-B7 收听统计（一行总结形态）。
**已砍**：r2-B8 歌词、r2-B6 分组导航（同省份筛选逻辑收口）、N6 点播提速、N9 合并备份（四轮维持）+ C 档全部。

## 审核记录（grilling 一轮事实核查，2026-10-12）

对本文档关键代码锚点逐项复核（非照单全收），结论：

| # | 文档主张 | 核查结果 |
|---|---|---|
| 1 | r2-A2「~10 行、复用收藏间切台」 | ✅ 成立且路径精确化：`App.stepFav(d)` 存在于 app.js:377 且为暴露方法；player.js:39 已有 `onplaylast` 回调注入先例——实施走同款回调（如 `onstepfav`），**不破模块契约**（player 不反向伸手进 app） |
| 2 | r2-A3 挂载点 | ✅ 成立：player.js:24（init vol0）/48（setVolume）为唯一音量出入口，每台记忆只需在这两处 + 点播入口挂钩子 |
| 3 | r2-A1 基线「MediaSession 无 artwork」 | ✅ 成立：player.js:73/127 两处 `MediaMetadata` 均只有 title/artist；`radio.songs` 历史已存在（app.js:428-433），封面缓存可平行挂载 |
| 4 | r2-A4 基线「同步全手动、有 busy 互斥先例」 | ✅ 成立：sync.js:13 唯一入口为手动 POST /api/sync；一轮 B-10 已建立「静默让位手动」互斥先例可直接套用 |
| 5 | file:// 降级形态只有内置精选（app.js:154 reloadMain 直接 return） | ✅ 成立，且由此验证新候选 **N1 可行**：经典 script 本地加载已被 hls.min.js 证明在 file:// 下可用，「同步时把 radio.txt 包装成 radio-data.js（`window.RADIO_DATA=…`）→ file:// boot 直读」路径成立，无需 fetch |

**审核新推导（脱离同类项目参照、从本项目资产/场景长出的候选）**：N1–N5 + N8 已进本期（见 N 档与交付清单）；N6 / N9 砍入 C 档。

## 附：调研命令留档

```bash
gh search repos "internet radio player" --sort stars --limit 15
gh search repos --topic internet-radio --sort stars --limit 15
gh search repos "webradio" / "radio browser" / "radio player" --language JavaScript …
gh repo view <repo>   # 各样本 README
# 数据源可达性实测（本机国内直连）：
curl -sI https://lrclib.net/api/search?track_name=hello        # 200, ACAO:*
curl -sI "https://itunes.apple.com/search?term=hello"          # 200, ACAO:*
curl -sI https://radio.garden/                                  # 超时不可达
curl -sI https://twj.es/                                        # 400（服务在线）
```
