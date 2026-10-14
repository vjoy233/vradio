# 交接文档：VRadio 安卓版立项 → 落地执行（2026-10-14）

> 面向接手人（人或 agent）。目标：读完本文 + 三份主档即可直接开工编码，无需回放立项会话。过程完整日志见 plan-android.md「更新记录（一）～（七）」。

## 一、状态一句话

安卓版**立项调研全部完成、13 项决策全部拍板、两轮外部 review 吸收完毕、方案文档口径一致（无开口项）**；代码一行未写，下一步是两个可立即开工的队列（§五）。Web 侧代码现状 = `fix/audit-r4` 分支，npm test 27/27。

## 二、决策状态（无开放项，全部 2026-10-14 拍板）

| 决策 | 结论 | 权威出处 |
|---|---|---|
| D1 技术路线 | 原生 Kotlin + Compose + Media3（混合壳 B1 三事实判死/B2 终局=A+桥税/C 留后手） | plan §3.3 + [ADR-0001](adr/0001-android-native-route.md) |
| D9 仓库形态 | 本仓 monorepo `android/` 子目录 | plan §5.1 + [ADR-0002](adr/0002-monorepo-android-subdir.md) |
| D2 v1 范围 | 裁维护面板编辑；**歌曲历史进 v1**（owner 加码）；不跑首启基线 | plan §八/§六 |
| D3 minSdk 26；D5 包名 `io.github.vjoy233.vradio`；D4 直装 APK+GitHub Releases；D6 okhttp 破例；D7 轻更新通道（**review 轮修订为仓库 main 直取**，非 Releases）；D8 iOS 不承诺不设限；D10 静默体检仅 WiFi；D12 验收设备 = OV 系实机+原生/模拟器（无小米系） | | plan §八 |
| D11+R2 | backup v2 含 my-radio（owner 加码一步到位），**Web 侧先行独立小批**（基于 fix/audit-r4 合并后拉分支） | plan §八/§十 |

## 三、文档地图（接手先读，按序）

1. [docs/plan-android.md](plan-android.md) —— **主档**。现状盘点/路线对比/架构框架（5.2 分层、5.3 播放机制映射表是编码时的语义契约源）/里程碑与验收（§六，M-1～M5）/决策记录（§八）/风险（§七）。
2. [docs/adr/0001](adr/0001-android-native-route.md)、[0002](adr/0002-monorepo-android-subdir.md) —— 两条难逆决策的否决理由留档（防日后再提 WebView 壳/拆仓）。
3. `AGENTS.md` —— 本仓行为准则（头段落立项段 + radio.txt 格式节的两侧契约注是本立项新增）；编码风格 = 中文注释/文案、极度紧凑短行。
4. `README.md` roadmap 安卓项已挂 plan-android.md。

## 四、环境与 git 现状（接手必知）

- **本机（Windows 10 + Git Bash）无 JDK、无 Android SDK、无 gradle，JAVA_HOME/ANDROID_HOME 全空**（已实证）——这正是 M-1 闸口立项的原因，装环境是第一件实体工作。
- git：分支 `fix/audit-r4`；未提交 = `AGENTS.md`、`README.md`（modified）+ `docs/plan-android.md`、`docs/adr/`（untracked）+ `.zcode/`（本地，勿提交）。**入库方式（单独 docs PR 还是搭车）是 owner 未决事项**。
- ⚠ 本仓在会话期间会并行前进（本立项期间第四轮审计批次三个提交中途落地、app.js +38 行）：**任何队列开工前先 `git pull && git log --oneline -5` 核对**，D11-R2 尤其要避开 app.js/server.js 同文件区撞车。

## 五、可执行工作队列（按序，每条含验收出处）

### 队列 0（owner，非编码）：决定本批文档入库方式后提交。

### 队列 1：Web 侧 backup v2 先行小批（D11-R2，不等安卓）

- 分支：`fix/audit-r4` 合并后拉（撞车回避，plan §十）。
- Scope：
  1. `server.js` 新增 my-radio **读取**通道（GET /api/mystation 返回 my-radio.txt 内容或复用 /api/sync 载荷捎带；同口径拒跨源、仅 GET）；
  2. `app.js exportAll` 升 v2：`{ v: 2, at, data: {13 键}, my: [my-radio 行数组] }`（http 形态经读取通道取；file:// 时 my 置空并在状态栏说明）；
  3. `app.js importAll` 收 v2：store 键照旧走白名单，my 字段恢复；
  4. ⚠ **已知设计缺口（实现时定，方案未拍板）**：v2 导入的 my **写回服务端**通道——现有 POST /api/mystation 是单台添加语义，恢复备份需 bulk 写（建议扩 bulk 模式或新端点：tmp+rename 原子写 + 行数/体积封顶 + csv 清洗照抄；恢复已知数据可豁免逐条探活）。定案后在 plan §八 D11 行补一句。
- 验收：Web 收 v1（现状已满足）+ Web 收 v2 两方向实测；file:// 遇 my 明示不静默；`npm test` 27/27 全绿（可顺手为 v2 加冒烟项：my 是顶层字段、不进 STORE_KEYS 白名单）。
- 安卓侧两方向（安卓收 v1/v2）留安卓 M2 验（plan M2 行已挂）。

### 队列 2：M-1 环境闸口（0.5-1 天，验收后 3-4 周工期起算）

清单在 plan §六 M-1 行；落地要点：JDK 17 Temurin（清华镜像 `mirrors.tuna.tsinghua.edu.cn/Adoptium/`）、cmdline-tools（`dl.google.com/android/repository/` 国内可达）、gradle dist（腾讯镜像 `mirrors.cloud.tencent.com/gradle/`）、`settings.gradle.kts` 仓库序 Aliyun（`maven.aliyun.com/repository/{google,central}`）优先官方兜底；全部固化进 `android/README.md` 环境节（换机照抄）。验收 = 干净检出 gradle CLI 全链路 + 空壳 APK 装上 OV 实机。
补办项（随本队列）：AGENTS.md store.js 行 ⚠ 警告块扩「与 android/ 侧 Store 白名单同步扩」（plan §十已挂）。

### 队列 3：M-1.5 Media3 spike（半天，可并入队列 2）→ M0（含最小 CI，Actions path filter `android/**`）→ M1-M5

逐项 scope/验收都在 plan §六，不重复。编码期间两个高频引用：**5.3 播放机制映射表**（player.js 语义 → Media3 的对照，世代令牌/决策链/先重连再顺延/ICY 入史去重 `list[0].t !== title`）与 **5.2 分层**（行协议取前两字段、Store tmp+rename、体检四常数 8000/6000/text-html/4.5s）。依赖白名单是**封闭清单制**（plan §四），加依赖先议事。

## 六、过程沉淀（为什么是这些结论，一段话版）

三轮深挖（agent-reach/Exa+WebSearch 调研、仓库形态论证、原生 vs 混合壳三形态裁决）→ grill-with-docs 问答 13 项拍板（两项 owner 加码：D2/D11）→ 外部 review 两轮（第一轮 Q1-Q12+A1-A19 共 31 项全采纳无驳回，其中环境闸口/D7 通道修订/焦点验收三项价值最大；第二轮抓回写漏网 6 处已修）。全部证据链接在 plan §3.3 与 §九。

## 七、坑与纪律（接手前必读）

- **AGENTS.md 是唯一行为准则**，本档不重复其内容；改 Web 代码先跑 `npm test`，行为验证 = `npm start` 后浏览器点播。
- 两侧契约（改任一侧须同步另一侧）：radio.txt/logos.txt 行格式、13 个 `radio.*` 键、vradio-backup.json 格式。
- 网络事实：ghFile 实际 = api.github.com + `Accept: vnd.github.raw` + gh CLI 回退（update-sources.js:150-157），**不要引入 raw.githubusercontent.com**；流地址 = 不可信输入（xmcdn 假流、蜻蜓建流 5-10s 慢，探活按字节验收）。
- RadioDroid 是 GPL-3.0：只参照不抄码。
- Android 侧特有：Icecast `ICY 200 OK` 非标状态行必须走 okhttp DataSource（D6）；`usesCleartextTraffic=true` 是明知决定（国内流全是 http）。

## 八、建议技能（下一会话按需调用 Skill 工具）

- `agent-reach` —— 需要现势调研（镜像源核查、库版本、新证据）时。
- `grilling` / `grill-with-docs` —— owner 要求新一轮拍板问答或方案拷问时（本仓「grill 拍板」文化）。
- `browser-use:control-browser` —— Web v2 小批的导入导出浏览器实测。
- `handoff` —— 再次交接时。

## 九、未了事项（全部有主、有出处）

1. 文档入库方式（owner，队列 0）。
2. v2 导入的 my 写回通道设计缺口（队列 1 实现时定案并回写 plan）。
3. AGENTS.md store.js 警告块扩写（M-1/M0 时，plan §十）。
4. 远期池（不动）：F-Droid/Play 上架、维护面板上安卓（C 无状态岛形态）、回听 spike（Web 侧）、iOS。
