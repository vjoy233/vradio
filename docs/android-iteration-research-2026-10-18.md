# VRadio 安卓版迭代方向调研（2026-10-18）

> 供 owner 审查拍板。两条线：**①内部**——基于 `feat/android@ac7b18f` 全量代码通读（27 个 Kotlin 源文件 + README/CONTRACTS/plan-android/CI/Manifest）梳理的缺口与优化点；**②外部**——GitHub 同类开源项目调研采集的借鉴方向（agent-reach 路由：gh CLI + Codeberg raw，9 个项目卡片见附录 A，星数/许可/活跃度已逐一 API 复核）。
> 每条按「功能 / 说明 / 实现方式与成本 / 解决什么问题」列出。成本为 AI 辅助人日口径（对齐 plan-android §六习惯）：**小 ≤1d / 中 2–5d / 大 周级**。

## 〇、结论摘要

- **现状判断**：v1（M0–M4）完成度高、架构干净——播放决策链/自愈/体检分档/同步引擎全量平移，94/94 单测，release 2.7MB，无 blocker 级问题。迭代空间集中在三类：**移动形态独有能力**（小部件/闹钟/快捷方式/链接接流）、**v1 有意裁剪的编辑面**（cfg 维护面板）、**差异化大件**（时移/录音）。
- **防重复立项勘误**（调研中发现但本项目已实现）：拔耳机自动暂停（`PlayerHolder.kt:116` setHandleAudioBecomingNoisy）、m3u 收藏导出/导入（Backup 五件套）、全局目录与个人数据分离的双库架构（radio.txt vs store 13 键）——外部清单已据此剔除。
- **重议题已全部裁决（2026-10-18 grill 审查轮，逐条标注见 §六）**：N1 维护面板回摆 D2 → 做极简四操作（批次二）；N9 D7 自动检查、E15 镜像级联**驳回**维持原拍板（E15 只吸收「失败重试+文案」小改进并入快赢批）；E16 截图回归守白名单纪律（不引 roborazzi，改走 JVM 纯函数测试扩面）；E14 Android Auto 不排期留观察。
- **已定节奏（§五）**：批次一快赢 12 项**全收放行**（约 1 周）；批次二定位增强（小部件已定 **RemoteViews 零依赖**路线、闹钟、N1 维护精简编辑、APK 更新检查=设置页手动形态）；批次三 **E8 时移、N6 拼音搜索、E9 歌词（LRCLIB 起步）已立项排期**，E7 录音留观察（版权口径未过）。
- **契约口径**：新持久键**只开 `radio.notes`**（Web 侧先行立项）；`radio.eq` 等均衡器真做时再议；OLED 主题档（`radio.theme` 软扩展）随批次一落地。三侧同步纪律不变。
- **借鉴纪律（owner 2026-10-18 拍板）**：所有外部项目只借鉴功能与实现原理，**不直接抄代码**（含 MIT/Apache 项目）。

## 一、现状基线（2026-10-18，防重复立项）

已具备：列表/搜索（多词 AND）/分类/收藏/最近、网格+列表双视图、多源决策链（prefer>srcmem2>启发式>顺延）+ 世代令牌 + 12s 看门狗 + halt 守卫断流自愈、每台音量 + 全局锚点、睡眠定时渐弱、MediaSession 通知/锁屏/⏮⏭ 收藏切台/媒体键续播上次、音频焦点全自动处理（transient 暂停/can_duck/永久停止）+ 拔耳机暂停、ICY 曲讯 + icy-br 码率 + 换歌入史、歌史 sheet、台标三级来源（STARTER→logos.txt→运行时解析，仅收藏+正在播，负缓存 7 天）、体检三通道（手动全量可取消/boot 静默 WiFi-only/同步后增量）+ 死台分档（疑似/停运）徽标、my-radio 探活先行添加、cfg 数据层全兼容（Web 导入即生效）、backup v2 五件套 SAF 互通、D7 轻更新（commits 判新）、M4 端内全量同步（classifyCn 金样平价 + 欧美逐台实测）、双主题（auto/light/dark）、高刷 hint、CI（test + debug/release 双包 + 体积哨兵）。

架构面已达标（外部项目背书，勿改）：双库分离（AMARadio 同构）、零 GMS 依赖（xueshi86 的 Free flavor 追求的正是本项目默认形态）、assets 打包 + GitHub 直连更新（优于 RadioBrowser 在线目录——国内不可达）。

## 二、内部缺口与优化方向（自主梳理）

### A. 功能缺口

| # | 功能 | 说明 | 实现方式与成本 | 解决什么问题 |
|---|------|------|--------------|------------|
| N1 | **维护面板精简编辑** ✅已拍板（2026-10-18 grill）：做极简四操作 | v1 拍板裁剪编辑 UI（D2）——2026-10-18 回摆：纯安卓用户对 cfg 四能力（隐藏/改名/移动分类/追加备选源）完全不可达，Web 导出配置只能被动生效。只做「长按行弹出四操作」的极简版，不做全面板（「重编辑仍引导 Web」边界保持） | Compose 长按菜单（combinedClickable）→ 写 `radio.cfg`（CfgCodec 已有编解码）→ `lib.reapplyCfg()` 即时生效。数据层零新增（全兼容是现成的）。**中–大（4–6d）**，UI 面为主 | 无桌面 Web 环境的用户（恰恰是目标人群）失去列表自治能力；追加源是「台坏了换条流」的自救手段 |
| N2 | **任意 m3u 导入为自定义电台** | 现有 m3u 导入只恢复收藏（匹配库内台），第三方播放器导出的 m3u 里的新台被丢弃 | Imp.M3U 路径扩展：`RadioTxt.parse` 已能解析 m3u，未命中库的条目逐条（或批量确认后）走 `MyRadio.append`（可跳过探活或复用 12s 探活）。**小–中（1–2d）** | 从蜻蜓/其它 app 迁移用户的整包搬家路径；m3u 是播放器界通用格式 |
| N3 | **省电策略白名单引导** | plan §七风险 3 明确承诺「设置页省电策略白名单引导不分工况照做」，当前 SettingsScreen 没有这一项——**计划内未落地项** | 设置页「后台播放被杀？」条目：文字引导去系统设置加白名单（MIUI/ColorOS 各一句口径）+ GitHub issue 反馈入口。**小（0.5d）** | 国产 ROM 后台查杀是收听场景头号中断源（D12 无小米系实机，引导是唯一缓解） |
| N4 | **启动自动续播上次台** ✅批次一放行（2026-10-18 拍板：**默认关**，设置页开关） | 冷启动后需手动点播；多数电台 app 默认或可选恢复上次会话 | boot 完成后若开关开且 recents 非空 → `resumeLast()`。注意从通知/桌面快捷方式冷启动时 Activity 在前台，起播无 FGS 限制。**小（0.5–1d）** | 「打开就继续听」是高频惯性操作；消灭一次点击 |
| N5 | **APK 版本更新检查** ✅批次二放行（2026-10-18 拍板：**设置页手动**触发，与 D7 同口径） | app 自身升级全靠用户手动刷 Release；数据更新（D7）与应用更新是两回事 | 设置页「检查新版本」：GitHub Releases latest API（api.github.com，与 Gh 同客户端）对比 versionName → toast 提示 + 附 sha256 校验指引文案（M5「先验后装」口径移植）。不做自动下载安装。**中（2–3d）** | 自装用户升级链路太长是新版本触达率的实际瓶颈 |
| N6 | **拼音/首字母搜索** ✅已立项（2026-10-18，批次三） | 1600+ 中文台名只能精确子串匹配；「cctv」搜不到「中央人民广播电台」 | 零依赖无拼音库：自研 GB2312 一二级常用字→全拼/首字母映射表（约 6763 字，可由仓库根 node 脚本生成静态表打进 assets，两端共享数据源）；搜索管线并入 OR 分支。**中–大（4–7d）** | 中文电台名的母语搜索习惯；列表检索体验的最大单项提升 |
| N7 | **长按列表行收藏** | Web 移动端有 500ms 长按收藏、双击播+收（audit-r2 四-2）；安卓版只有点星标 | `combinedClickable(onLongClick = toggleFav)` + 震动反馈（HapticFeedback）+ toast。**小（0.5d）** | 与 Web 手感对齐；单手操作大屏时星标 48dp 不如整行长按好按 |
| N8 | **分享电台** | 无法把台分享给朋友/其它应用 | `ACTION_SEND` 文本：「台名 - VRadio」+ 主源 URL（http 直链任何播放器能开）。**小（0.5d）** | 口碑传播的最短路径 |
| N9 | **D7 定期自动检查** ❌已拍板（2026-10-18 grill）：不做，维持 D7 纯手动 | D7 拍板「设置页手动触发，不做启动自动检查」——2026-10-18 复议维持原拍板；数据新鲜度靠用户主动性 + N5 版本更新提示顺带引导 | — | — |

### B. 体验打磨

| # | 功能 | 说明 | 实现方式与成本 | 解决什么问题 |
|---|------|------|--------------|------------|
| N10 | **启动屏与图标品牌化** | 冷启动白屏一瞬（windowBackground 纯色）+ launcher 图标是默认模板感 | windowBackground 换品牌色 drawable（防启动闪白）；图标按 VRadio 视觉重绘自适应前景。**小（1d）** | 第一印象；每次冷启动可见 |
| N11 | **通知栏「★ 收藏当前台」按钮** | 通知栏只有播控；听到好台想收藏必须回 app | MediaSession custom command（`SessionCommand`+`setCustomLayout`）→ 接 `lib.toggleFav`；星标态随曲讯刷新。**小–中（1–2d）** | 收藏动作的最低摩擦路径（后台/锁屏场景） |
| N12 | **横屏/平板两栏** | 现状「竖屏为主横屏不崩」（达标）；平板单栏浪费 | 列表 + 详情/播放面板双栏（WindowSizeClass 思路手写，不引新库）。**中（3–5d）** | 平板/折叠屏用户；后置无妨 |
| N13 | **无障碍/TalkBack pass** | 自绘图标无 contentDescription、列表行语义未分组（外部 AMARadio 证明电台 app 受众确实有视障/长辈用户） | Compose `semantics`/`contentDescription` 补齐 + TalkBack 实测一轮。**中（2–3d）** | 收音机受众含长辈；基础可及性 |
| N17 | **收听统计**（本地） | 歌史只记曲名，无「听了多久/最常听哪些台」 | recents 基础上按 u0 累计时长（onAir↔pause 区间），纯本地 store 或独立文件。**中（2–3d）** | 个人回顾趣味；无账号无上传，不违本地优先 |
| N18 | **纯黑 OLED 主题档** | 深色档是 #101418 灰底，OLED 屏纯黑更省电 | `radio.theme` 加 "oled" 值：Web 侧 `['auto','light','dark'].includes` 未知值回退 auto（app.js:236 已核），备份互通不炸，属良性软扩展。**小（0.5d）** | OLED 屏夜间收听续航（睡眠定时场景恰好是暗环境） |

### C. 工程与韧性

| # | 功能 | 说明 | 实现方式与成本 | 解决什么问题 |
|---|------|------|--------------|------------|
| N14 | **CI 附 release artifact** | CI 已构建 release（R8+哨兵）但 artifact 只传 debug | upload-artifact 加一项（或换传 release 包）。**小（0.2d）** | PR 合并即可拿到可装 release 包，省本地构建 |
| N15 | **设置页问题反馈引导** | 出问题只能自己猜；plan 风险 3 的「社区反馈渠道」未落地 | 「关于」节加 GitHub issue 链接 + 常见问题（后台被杀/同步失败）一句话引导。**小（0.5d）** | MIUI 系问题收集（D12 无实机的补偿通道） |
| N16 | **依赖例行升级窗口** | AGP 8.13.2/Kotlin 2.2.21/compose-bom 2026.06.01/Media3 1.11.1 全钉死（钉版是对的） | 季度例行：升版 + 94 单测 + 双出包回归，README 版本基线节随改。**运维（每次 0.5–1d）** | 安全补丁与 compose 生态修复的跟进；防版本鸿沟积累 |

## 三、外部借鉴清单（GitHub 调研，已按内部现状校正）

> 校验说明：调研 agent 初稿含 3 条本项目已实现项（拔耳机暂停/m3u 互导/双库架构），已剔除；2 条与既有拍板冲突项（Material You 动态取色——plan §5.2 明示不做；上游镜像级联——Q7/R2 明示仅 api.github.com）移入重议题标注。
> **借鉴纪律（owner 2026-10-18 拍板）：所有外部项目一律只借鉴功能与实现原理，不直接抄代码**——GPL 项目（RadioDroid 系/NextPlayer/AMARadio 等）是许可硬约束（plan 风险 5 隔离纪律）；Transistor(MIT)、Aerial/deutsia-radio/androidx-media(Apache-2.0) 许可可容但仍按同一纪律执行（防实现风格趋同与隐性衍生），每项立项与验收均按此口径。

| # | 功能 | 来源 | 说明 | 实现方式与成本 | 解决什么问题 |
|---|------|------|------|--------------|------------|
| E1 | **闹钟定时开台**（音量渐增/重复日） | morckx/RadioDroid、xueshi86/RadioDroid | 指定时间自动播放指定台，音量渐强唤醒，可按日重复——收音机的经典形态 | AlarmManager setExactAndAllowWhileIdle + AlarmManagerBroadcastReceiver 起播（闹钟属 FGS 启动豁免场景）+ VolumeShaper 渐增；Android 12+ 需 SCHEDULE_EXACT_ALARM（运行时引导）。选台界面复用收藏列表。**中（3–5d）** | 「起床听新闻台」是电台 app 不可替代用途；与已有睡眠定时（停）正好配对成双向定时 |
| E2 | **桌面小部件** ✅已定 **RemoteViews 零依赖**路线（2026-10-18 拍板，Glance 不入白名单） | AMARadio（Glance，踩坑文档详尽——仅借鉴其同步/防 ghost 思路） | 正在播控制 + 常听台一击直达，实时曲讯。plan §四本就把 widget 列为原生路线的长期演进项 | 传统 RemoteViews（零新依赖，白名单封闭制零突破，代码重但小部件需求简：文字+按钮+小图）。状态从 MediaController/PlayerHolder.ui 读。**中（3–5d）** | 电台 app 最高频路径的零导航触达；防盗版 ROM 用户桌面单手换台 |
| E3 | **桌面快捷方式（收藏台直达）** | Transistor（ShortcutManager 实现思路可循，不抄代码） | 长按 app 图标出收藏前 4 台 + 继续上次收听，点按直接起播 | ShortcutManager 动态 shortcut（收藏变更时更新 ranking）+ intent 带 extra → MainActivity 解析直达 play。**小（1d）** | 高频台零导航；成本极低收益明显 |
| E4 | **系统链接接流加台** | Transistor | 浏览器/文件管理器点 m3u/pls/mp3 流链接 → 系统菜单出现 VRadio → 预填添加电台页 | manifest intent-filter（http/https + audio/* mime）+ onNewIntent 解析（singleTask 已配）→ 预填 AddStationScreen。探活先行口径不变。**小（1–2d）** | 「网上看到流地址」从复制粘贴变一键；第三方 m3u 文件同理 |
| E5 | **音频卸载（audio offload）** | xueshi86/RadioDroid | DSP 硬解显著降播放耗电；实验性开关，不支持自动置灰 | Media3 `setAudioOffloadPreferences` + `isOffloadedPlaybackEnabled` 能力探测；注意与均衡器互斥（offload 时 audiofx 不可用）需提示。**小（1d）** | 长时间收听（睡眠定时整夜）的电量敏感用户 |
| E6 | **均衡器 + 每台 EQ 记忆** ⚠契约（已拍板缓：radio.eq 等本功能真立项时再议开键） | xueshi86（人声/音乐双预设+每台 EQ）、CassetteCat（5-band 全家桶） | 新闻台要人声清晰、音乐台要动态——与本项目已有的「每台音量」是同一洞察的延伸 | `android.media.audiofx.Equalizer` attach `exo.audioSessionId`；内置「人声/新闻」「音乐」双预设起步。每台参数是**新持久键（如 radio.eq）→ 三侧契约同步，Web 先立项**（Web 无 audiofx，仅白名单占位）。**中（3–5d）** | 国产 ROM 系统 EQ 常被阉割；新闻/音乐双形态是电台 app 特有矛盾 |
| E7 | **流录音**（2026-10-18 留观察：版权口径未过，立项前先拍） | xueshi86（含 HLS 按分片拼接，2026-10 刚修）、morckx、InternetRadio（定时录制）、deutsia | 录当前台存 MediaStore，可回听/分享。**版权注记：个人留档灰区、勿做分享传播功能化，建议仅「本机录音 + 系统分享」且默认关** | 播放旁路 tee：okhttp 拉流同时写 MediaStore（scoped storage 免存储权限）；HLS 需分片下载拼接（直流台先做）。**中–大（5–8d）** | 错过节目补听；央广新闻/谈话类内容价值高 |
| E8 | **时移回听（时光机 −15s）** ✅已立项（2026-10-18，批次三，先做技术 spike） | morckx/RadioDroid 0.86.905 | 直播边听边回退 15s 重听，「回到直播沿」按钮（通知栏也有）——**差异化大件** | progressive 直流环形缓冲自定义 DataSource + seek 改造；**仅 mp3/AAC 直流台可用**（央广系 m3u8 结构性不可）；与 Web 远期「回听（节目单点播）」是两回事，后者取决于电台侧能力。**大（周级）** | 新闻/谈话台「刚才说什么了」刚需；同类 app 极少有 |
| E9 | **歌词（LRCLIB）** ✅已立项（2026-10-18，批次三；拍板**只挂 LRCLIB**、不带网易云非官方源） | xueshi86（多源降级链）、CassetteCat、InternetRadio(LrcLib) | ICY 曲讯命中后查歌词，本地缓存 30 天 | okhttp 手写 JSON API + logos-cache 同款文件缓存（零依赖可守）。**中（3–5d）** | 音乐台听歌场景的延伸；LRCLIB 曲库偏英文，中文命中率有限属预期内 |
| E10 | **电台自定义备注（可搜索）** ✅已拍板开键（2026-10-18）：`radio.notes`，**Web 侧先行立项** | xueshi86/RadioDroid | 每台一条主观备注（「爵士」「晚间听」），列表显示并参与搜索 | 新持久键 `radio.notes`（URL→备注）→ 三侧契约同步（store.js KEYS + server.js STORE_KEYS + android C.KEYS）；搜索管线并入一个 OR 分支。**小–中（1–2d）** | 1600+ 台光靠分类不够记，补个人记忆 |
| E11 | **曲讯封面增强（iTunes Search API）** | InternetRadio | 曲讯 artist+track → iTunes Search 拉专辑封面做通知/锁屏 artwork | 一个 GET JSON + LRU 缓存；itunes.apple.com 国内可达性尚可，失败静默回退台标。**中（2–3d）** | 锁屏从台标升级为正在播曲目封面，音乐台体验档次差 |
| E12 | **Ogg/Opus 流 ICY 元数据** | AMARadio | 部分国际台是 Ogg Vorbis/Opus 流（含链式），当前只解析 Icecast ICY | Media3 onMetadata 已给到 vorbis comment 事件，补一类解析分支。**小–中（1–2d）** | 欧美台里 Ogg 形态台的曲讯显示 |
| E13 | **同步前置条件检查** | xueshi86/RadioDroid | 同步前电量 <5% 拒绝/<20% 警告（WiFi 检查本项目已有） | BatteryManager 一判 + 文案。**小（0.5d）** | 同步中途断电半途而废的体面护栏 |
| E14 | **Android Auto** ❌已裁决（2026-10-18）：不排期留观察，等真实 Auto 诉求再立项 | morckx（全套）、deutsia、InternetRadio、CassetteCat | 车机浏览分类/收藏树 + 播控。**注记：国内车机主流是 HiCar/CarLink/原生车机，不走 Android Auto 协议——对目标人群实际价值存疑** | （若未来立项）Media3 MediaLibrarySession（media3-session 已在依赖内，零新增）+ automotive_app_desc.xml + 按分类建 browse tree。**中（4–6d）** | 有 Auto 车机的少数用户 + 海外侨胞；架构上顺路 |
| E15 | **上游可达性小改进** ❌已拍板（2026-10-18 grill）：不做镜像级联，维持仅 api.github.com | xueshi86 的镜像级联（最近成功镜像复用、5s 短超时、7 天重测速）——复议后维持 Q7/R2 原拍板（第三方镜像 = 数据完整性信任面扩大，投毒前科）；仅吸收两个无信任面代价的小改进 | Gh 层失败重试一次 + 失败文案更明确（「GitHub 不可达，稍后再试」补重试建议）。**小（0.5d，可并入快赢批随手做）** | 「同步失败」体感的最低成本缓解；信任面零扩大 |
| E16 | **UI 回归防线** ❌已裁决（2026-10-18）：不引 roborazzi（守白名单与纯 JVM 纪律），改走 **JVM 纯函数测试扩面**——决策链/过滤逻辑抽纯函数，随各功能落地随手补，不单独立项 | Aerial（`./gradlew quality`：lint+ktlint+单测+JaCoCo 门禁——仅借鉴工程思路） | UI 回归目前全靠手点；Web 侧有 smoke.js 冒烟文化，安卓侧对应物缺位 | 数据层/纯函数测试扩面（零新依赖）。**小–中（随功能摊销）** | 列表/浮层改动的回归防线，以数据层测试覆盖间接兜底 |
| E17 | **免 GMS 声明** | xueshi86（Free/Play 双 flavor） | 本项目本就零 GMS——只需 README 与设置页「关于」一句话声明「无任何 Google 服务依赖，国产 ROM 全功能可用」 | 文档级。**小（0.2d）** | 给目标人群的明确承诺信号（与 #1 调研项合并落地） |

## 四、不建议照搬 / 慎做清单

- **外部代码一律不抄**（owner 2026-10-18 拍板）：GPL 项目（RadioDroid 系/NextPlayer/InternetRadio/AMARadio/CassetteCat）思路可学、代码不可抄是许可硬约束；Transistor(MIT)、Aerial/deutsia-radio/androidx-media(Apache-2.0) 许可虽宽，同样只借鉴功能与实现原理、不复制代码。
- **Tor/I2P 多网络**（deutsia）：依赖外部 app、国内无意义，与「直连可用」定位相反。
- **RadioBrowser 在线目录为主数据源**（RadioDroid 系）：国内不可达；GitHub 上游 + assets 打包是更优解，勿改。
- **Android TV / Leanback 全套**：周级成本，手机场景收益极低，除非未来有 TV 用户反馈。
- **SQLCipher 全库加密 + 生物识别应用锁**（deutsia）：引入原生 .so 与复杂度，与依赖白名单封闭制冲突。
- **GMS/Play Services 集成、FCast/Chromecast 投屏**：与国内生态和零 GMS 定位双冲突。
- **Last.fm/ListenBrainz scrobble**（CassetteCat）：境外账号服务，违背「无账号无跟踪」。
- **Material You 动态取色**：plan §5.2 已拍板不做——保持 Web 色板双端一致是有意决策，若未来重议须连 Web 主题契约一起审。
- **流录音的传播功能化**（定时录制分享等）：版权风险随功能增强而升高，只做本机录音保守形态（E7 注记）。

## 五、建议排期（供拍板，非既定计划）

原则：先低风险高感知的快赢项 → 再定位增强 → 大件按需立项；**任何动 `radio.*` 键或推翻既有拍板的项单独走重议流程**（§六）。

- **批次一 · 快赢 ✅已拍板全收（2026-10-18），合计约 1 周，全小成本**：N3 省电引导、N7 长按收藏、N8 分享电台、N4 启动续播开关（**默认关**）、E3 桌面快捷方式、E4 链接接流、E5 音频卸载开关、N2 m3u 泛导入、N14 CI release artifact、N15 反馈引导 + E17 免 GMS 声明、E13 同步电量检查、N18 OLED 主题档、E15 拆出的「同步失败重试一次+文案」小改进。
  验收口径：每项独立 PR 粒度、94 单测不红 + 实机冒烟；快捷方式/链接接流需冷热启动两路径实测。
- **批次二 · 定位增强（1–2 周）**：E2 桌面小部件（✅已定 **RemoteViews 零依赖**路线，Glance 不入白名单）、E1 闹钟、N1 维护面板精简编辑（✅已拍板做极简四操作）、N5 APK 更新检查（✅已定**设置页手动**形态，与 D7 同口径）、N11 通知栏收藏键、N13 无障碍 pass、N10 启动屏/图标、E12 Ogg/Opus 曲讯、N17 收听统计。
- **批次三 · 已立项待排期（2026-10-18 拍板立项）**：E8 时移 −15s（先做技术 spike 验环形缓冲可行性）、N6 拼音搜索（自建常用字→拼音/首字母表，两端共享数据源）、E9 歌词（**只挂 LRCLIB**，不带网易云非官方源）。
- **留观察（不立项、不淘汰）**：E7 流录音（版权口径未过，做前先拍）、E11 曲讯封面、E14 Android Auto（等真实 Auto 诉求）、N12 平板两栏、E16 已裁决改道——不引 roborazzi，JVM 纯函数测试扩面随各功能落地随手补，不单独立项。（N9 D7 自动检查、E15 镜像级联两重议题已驳回，维持原拍板。）

## 六、契约与拍板影响汇总（审查重点）

**三侧契约变更项**（动 `radio.*` 键须同步 store.js KEYS + server.js STORE_KEYS + android C.KEYS，且 Web 功能面先行）：

| 项 | 变更 | 建议 |
|---|------|------|
| E10 电台备注 | 新键 `radio.notes` | ✅已拍板（2026-10-18）：开键，**Web 侧先行立项** |
| E6 每台 EQ | 新键 `radio.eq` | ✅已拍板（2026-10-18）：缓——等均衡器功能真立项时再议 |
| N18 OLED 主题 | `radio.theme` 值域 + "oled" | ✅已拍板（2026-10-18）：随批次一落地（软扩展：Web 未知值回退 auto，app.js:236 已核） |

**推翻/回摆既有拍板的重议题**：

| 项 | 相撞的拍板 | 重议要点 |
|---|------|---------|
| N1 维护面板精简编辑 | D2「裁剪编辑 UI，重编辑引导桌面 Web」 | ✅已裁决（2026-10-18）：回摆 D2，做极简四操作（长按菜单），「重编辑仍引导 Web」边界保持 |
| N9 D7 自动检查 | D7「不做启动自动检查」 | ✅已裁决（2026-10-18）：驳回，维持 D7 纯手动 |
| E15 镜像级联 | Q7/R2「仅 api.github.com，不引第三方 raw 镜像」 | ✅已裁决（2026-10-18）：驳回，维持仅直连；只吸收「失败重试一次+文案」小改进 |
| E16 截图回归 | 「不引 robolectric」+依赖封闭清单 | ✅已裁决（2026-10-18）：不引 roborazzi，改走 JVM 纯函数测试扩面（随功能落地随手补） |
| E14 Android Auto | 无相撞（plan §四列为长期演进顺路项） | ✅已裁决（2026-10-18）：不排期留观察，等真实 Auto 诉求 |

## 附录 A：调研项目卡片（9 + 官方参考，2026-10-18 API 复核）

| 项目 | 地址 | 星/许可 | 定位与核心亮点 |
|------|------|---------|--------------|
| morckx/RadioDroid | github.com/morckx/RadioDroid | 80★ GPL-3.0，2026-09 活跃 | RadioDroid 活跃续作（本体 segler-alex 2024 停更）：Android Auto 全套、**直播时移 −15s**、TV 适配、闹钟/录音/代理、m3u 导入导出、镜像容错 |
| xueshi86/RadioDroid | github.com/xueshi86/RadioDroid | 46★ GPL-3.0，2026-10 活跃 | **国人魔改线，与本项目场景重合度最高**（同样绕 radio-browser 国内不可达）：离线库全量+增量同步、电量前置检查、歌词降级链、每台 EQ、音频卸载、Free/Play 双 flavor、OLED 纯黑、电台备注 |
| Transistor | codeberg.org/y20k/transistor（GH 镜像只读） | 478★(GH) **MIT**，2026-10 活跃 | 极简电台（哲学同类）：桌面快捷方式、**系统链接接流**、M3U/PLS 开放备份、证书 SHA-256 公布验签（仍只借鉴思路，不抄代码） |
| NextPlayer | github.com/anilbeesetti/nextplayer | 4565★ GPL-3.0 | 视频播放器，**Media3+Compose 工程化最佳参考**（单 Activity、模块化、软硬解切换文档） |
| Aerial | github.com/shapeshed/aerial | 165★ **Apache-2.0**，2026-10 活跃 | "Just radio" 无账号无分析：策展合集、ICY 工具类、**截图回归+覆盖率门禁工程规范**（Apache-2.0，仍只借鉴原理） |
| InternetRadio | github.com/armanmaurya/InternetRadio | 151★ GPL-3.0，2026-10 活跃 | Compose 电台新秀功能最全：Auto/TV/FCast、录音+定时录制、**iTunes 封面+LrcLib 歌词元数据增强**、Weblate |
| deutsia-radio | github.com/deutsia/deutsia-radio | 78★ **Apache-2.0** | 审查抵抗型：每台独立代理（47 单测守护）、应用锁+SQLCipher、**「完全禁用 API 纯本地库」开关**（与本项目本地优先同构）、Auto |
| AMARadio | github.com/ounben/AMARadio | 26★ GPL-3.0，2026-10 活跃 | 单点设计文档极详尽：**Glance 小部件踩坑实录**、TalkBack 全优化、双库架构、Ogg/Opus 链式流元数据、Compact→XL 四档 UI 缩放 |
| CassetteCat | github.com/samyyy2311/CassetteCat | 19★ GPL-3.0，2026-10 活跃 | 隐私优先音乐播放器：EQ 全家桶+AutoEq、响度归一+**护耳音量上限**、断连即停、LRCLIB 歌词 |
| androidx/media | github.com/androidx/media | Apache-2.0 | Media3 主仓：session/cast demo，做 Auto/时移/闹钟前先读 demo |

> 勘误留档：调研任务书中的 `SegmentationFault/radio-droid-3` 不存在（404）；RadioDroid 真正的活跃续作即上表 morckx 与 xueshi86 两线。

## 附录 B：调研方法与可信度

- 内部：`feat/android@ac7b18f` 全量源码通读（README/CONTRACTS/plan-android/Manifest/build.gradle/CI + 27 个 Kotlin 文件），交叉核对 plan §六里程碑与 §八决策记录找「计划了但没落地」项（找到 N3 省电引导一处）。
- 外部：agent-reach 路由（gh CLI 搜索 + GitHub/Codeberg API 读 README），9 项目星数/许可/最近提交已由主线逐一 `gh api` 复核（2026-10-18）；外部清单中 3 条与内部实现重复的已剔除并留档勘误。
- 成本口径为 AI 辅助人日估计，立项时按 plan-android §六的「段间可停」习惯拆验收。

## 更新记录

- 2026-10-18：首版（内部全量梳理 + 外部 9 项目调研合并校正），供 owner 审查。
- 2026-10-18（二）：**grill 审查轮（owner 逐题拍板）全部结论回写**：① 借鉴纪律——所有外部项目只借鉴功能与实现原理、不直接抄代码（含 MIT/Apache，§三前言/§四已固化）；② 批次一快赢 12 项全收放行（N4 启动续播默认关）；③ N1 维护面板回摆 D2 → 做极简四操作（批次二）；④ N9 D7 自动检查、E15 镜像级联两案驳回维持原拍板（E15 拆出「重试+文案」小改进并入批次一）；⑤ E16 截图回归不引 roborazzi、改 JVM 纯函数测试扩面；⑥ E14 Android Auto 不排期留观察；⑦ 契约新键只开 `radio.notes`（Web 先行）、`radio.eq` 缓、oled 值域随批次一；⑧ E2 小部件定 RemoteViews 零依赖路线；⑨ N5 APK 更新检查定设置页手动形态；⑩ 批次三立项 E8 时移（先 spike）/ N6 拼音搜索 / E9 歌词（只挂 LRCLIB），E7 录音留观察（版权口径未过）。§〇摘要/§五排期/§六两表/相关条目均已随裁决更新。
