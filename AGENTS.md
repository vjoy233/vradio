# AGENTS.md

VRadio — 零依赖本地网络电台 Web 播放器（国内电台为主、欧美音乐台为辅，面向国内直连环境）。共 7 个源码文件 + 2 个数据文件，**无 npm 依赖、无构建步骤、无测试/lint 配置**。背景与实测记录详见 README.md，评审与实施依据见 docs/review.md。

## 常用命令

```bash
npm start        # = node server.js，启动后访问 http://localhost:8137（换端口：PORT=9000）
npm run sync     # = node update-sources.js，同步电台源（约 1 分钟，含欧美台逐个实测 + 台标随行更新）
npm run sync -- --logos   # = node update-sources.js --logos，只重建 logos.txt 台标（数秒）
```

- **零依赖是核心设计**：只用 Node ≥ 14 内置模块 + 本地化的 hls.min.js，不要引入任何 npm 依赖。
- 没有可跑的 test / lint / typecheck；验证改动 = 启动服务后在浏览器里实际点播。

## 文件与职责

| 文件 | 职责 |
|---|---|
| `index.html` | 结构壳：DOM + 样式（浅/深主题、双视图/台标/无效源开关、⚙ 维护面板、safe-area）；逻辑全部外置四文件，经典 script 顺序引入 |
| `player.js` | 播放引擎：audio/hls/播放态/睡眠定时/MediaSession（台名+曲讯）的唯一所有者（世代令牌防串台；断流自愈看门狗 + 成功源记忆 `radio.srcmem`） |
| `logos.js` | 台标数据唯一所有者：三级来源（STARTER 内置 → logos.txt → 运行时解析）/永久缓存/收藏+正在播优先补全/负缓存 7 天 |
| `app.js` | 应用层：列表/搜索/分类/收藏/最近播放/导入导出/网格+列表双视图渲染/无效源默认隐藏/明暗主题切换/⚙ 维护面板（个人分类与电台调整 + 添加自定义电台）/曲讯轮询+歌曲历史/键盘快捷键；集中 state 对象 + 单一 render 入口 |
| `sync.js` | 同步/体检编排（手动全量 + 开机静默体检，`busy` 互斥手动优先）：只调用 App/Player 暴露的接口，不改对方状态 |
| `server.js` | 静态服务 + `/proxy?url=` 流代理（绕 CORS）+ `POST /api/sync` + `/api/check?url=` 探活（≤4 源）+ `POST /api/mystation`（添加电台：探活先行 + 原子写 my-radio.txt）+ `/api/nowplaying?url=`（ICY 曲讯旁路） |
| `update-sources.js` | 源同步引擎 + 网络安全护栏（`safeTarget`/`guardLookup` 导出供 server.js 复用）+ 欧美台台标提取（tvg-logo→logos.txt）；可独立作 CLI 运行（改它时两种入口都不能坏，另有 `--logos` 只重建台标） |
| `radio.txt` | 电台数据库（1600+ 台）。**数据文件，由同步生成**，不要手工维护 |
| `logos.txt` | 台标数据（欧美音乐/国际新闻·谈话两分类，同步自动生成/`--logos` 重建），行格式 `分类|台名,图片URL`。**数据文件，勿手工维护** |
| `hls.min.js` | 本地化的 hls.js v1.5.20（Apache-2.0 第三方库），勿改 |
| `my-radio.txt` | 用户个人补充列表（gitignored），同步/导入后常驻重并，永不被覆盖 |

## 架构要点

- **前端模块契约**（改代码前必读，详见 docs/review.md 十一节债务 2）：player 拥有 audio/hls/播放态，logos 拥有台标数据（三级来源/缓存/按需补全），app 拥有 stations/渲染/收藏，sync 只编排；跨模块只走暴露接口，UI 反馈经 Player 的 onstate/onstatus 回调注入。**用经典 script 而非 ES modules 是硬约束**（file:// 下 module 加载受 CORS 限制必挂），且 **logos.js 必须先于 app.js 装载**（boot 渲染行内入口时即引用）。
- **身份公理**：URL = 持久身份，名字 = 显示层。收藏/最近（`radio.favs`/`radio.recents`）记录源 URL，电台改名/换分类后按 URL 回绑；带 URL 的休眠条目永不回收。
- **数据装配管线**（`app.js` 的 `applySources`）：主列表 replace → STARTER 精选层按精确名去重并入 → my-radio.txt 个人层常驻并入 → **维护层套用**（`applyCfg`，radio.cfg，owner 两轮拍板）：电台移动/重命名/手动隐藏按「任一源 URL 命中」回绑（同步重建后自动复用），分类重命名最后映射（改名时移动目标/隐藏标记级联改写）；手动隐藏 = 彻底消失（全部/收藏/搜索/体检一律不可见，无正在播例外——与死台隐藏的自动例外口径不同）。装配默认口径留底在 `s.dCat/dName`（面板 ↺ 恢复/删自建分类撤回移动用），面板改动经 `reapplyCfg` 回滚重套即时生效。电台重命名禁止同分类撞名（keyOf 串台防护）；配置导入 = 全量覆盖 + confirm；失配（URL 漂移）在面板顶部出清单。
- **播放三级策略**（`player.js` 的 `variants()`/`load()`，顺序不能乱）：① mp3/AAC 直流（`<audio>` 原生跨域；蜻蜓 `ls.qingting.fm/live/{id}.m3u8` 自动换算成同 id 的 `lhttp.../64k.mp3`）→ ② m3u8 直连 hls.js → ③ 本地 `/proxy` 兜底。央广 ngcdn 系 CDN 锁了 CORS，只走得通第 ③ 级。**断流自愈**（A-1）：error 级联（onerror/HLS fatal）自动顺延备选源之外，stalled/waiting 看门狗（12s 无进展）与 ended（直播不该 ended）也自愈——先重连当前源一次再顺延；成功源序号按台主 URL 持久化（`radio.srcmem`，FIFO 300），下次点播该源先行。
- **曲讯链路**（B-6/B-7）：ICY meta 只存在于 Icecast/Shoutcast 形态 mp3/AAC 直流，**HLS 结构性没有**（央广系全 m3u8 → 显示为空，不是 bug）。server.js `/api/nowplaying` 按台建旁路会话 keep-open 持续读（换歌近实时；空闲 30s 回收/并发封顶 2/失败 60s 冷却/noIcy 负缓存）；app.js 15s 轮询（暂停/后台空转，切台清零防串台），曲名写 MediaSession（`Player.setSong`）；换歌时旧歌入史 `radio.songs`（每台 12 首、台数 50 FIFO），点 footer 曲名行看本台历史。
- **代理分片重写**：走代理播 m3u8 时，hls.js 的 `xhrSetup` 必须把相对分片 URL 拼回远端 base 再包 `/proxy`，否则分片会被解析到 localhost。
- **无效源隐藏**（`app.js`）：体检标记 `health:'dead'` 的台默认不进 `visible()`（正在播/连接中的台例外——明明活着不该消失）；开关持久化在 `radio.showdead`（默认隐藏），出现死台即亮「✗ 无效源」按钮；体检中 `patchHealth` 对死台行当场移除（与 `visible()` 口径一致）。**死台标记持久化** `radio.health`（键 → {u:URL 快照, t}；TTL 7 天对齐 Logos 负缓存、FIFO 500 封顶、URL 身份回绑——上游改名/换分类仍对得上；✓ 标记不持久化；`patchHealth` 只改内存，`Sync.health` 收尾统一落盘一次防逐台全量写卡主线程）；体检用 `visible(true)` 连默认隐藏的死台一起复查，复活即撤销标记回归列表。同步源不产健康标记（欧美台在同步期已实测过滤、国内台不测）。**开机静默体检**（B-10）：boot 首屏后 4s 静默复查「收藏+最近」范围（`App.scopeFavRecent(30)`，手动隐藏的台不测），不碰按钮/状态栏；与手动体检 `busy` 互斥（手动优先，静默让位不落盘不渲染）。
- **明暗主题**：CSS 变量双套（`:root` 深色 / `:root[data-theme="light"]` 浅色），app.js 按手动选择（`radio.theme`：auto/light/dark，默认 auto）或系统 `prefers-color-scheme` 写 `<html data-theme>`；auto 态监听 matchMedia 变化实时跟随。
- **台标数据链**（`logos.js`）：`Logos.get/peek` 同步渲染（绝不发请求），三级来源 = STARTER 的 `l` 字段 → logos.txt（欧美系台，同步按流 URL 确定性匹配、双分类前缀）→ 运行时解析（**只对「收藏 + 正在播」的台**：蜻蜓台取频道页封面 `<img class="img">`、其它台查 Radio Browser `byurl` favicon，经 /proxy，负缓存 7 天）。图片本体 `<img>` 直连加载不受 CORS 限制（file:// 也能显示），坏图 onerror 移除回退纯文字；勿改成全量抓取（1600+ 台请求量不可控，owner 明确「收藏优先」）。
- **同步双上游 + 内容分类体系**（`update-sources.js`）：国内源拉取 gaotianliuyun/gao 的 radio.txt 后**不再透传上游分类**，由 `classifyCn` 按台名关键词重分类（`CN_RULES` 顺序即优先级，兜底 `综合·其他`）——对上游改版免疫；藏在国内外表里的国际台（BBC Radio 系/NPR News/CGTN…）会被捞回欧美系分类。欧美台从 AlonDrilich/radio-playlists（Radio Browser 镜像，官方 API 国内不可达）top-500 过滤欧美国家后**逐个实测重建**，并按类型榜（`genres/` 的 news/talk/sports/religious，每类封顶 300）拆成 `欧美音乐` + `国际新闻·谈话` 两分类——关联键 = m3u 每条目前的 72FM 电台 UUID（比 URL 可靠，同台不同码率变体常见），`EU_TALK_NAMES` 是类型榜榜外漏网品牌兜底。旧「世界」分类已撤销（新闻向并入国际新闻·谈话、其余进 `亚洲·港台`）。radio.txt 分类装配顺序 = `CAT_ORDER`（= 界面分类条顺序，`华语音乐`/`欧美音乐` 由 app.js `order` 置顶）；`欧美音乐`/`国际新闻·谈话` 每次同步整体重建，手工编辑会被覆盖。
- GitHub 取文件：api.github.com 直连，失败回退 `gh` CLI（异步 `execFile`，不阻塞事件循环）。
- **服务端安全护栏**：`safeTarget`（字符串级）+ `guardLookup`（连接级 DNS 校验，防 rebinding/TOCTOU）双层校验，重定向逐跳复查；`/api/sync`、`/api/check`、`/api/mystation`、`/api/nowplaying` 拒跨源（CSRF/跨源驱动）；`/api/mystation` 只写固定文件 my-radio.txt（tmp+rename 原子替换 + 串行写队列；台名/分类去 csv 分隔符，500 行/64KB 封顶）；`/api/nowplaying` 旁路连接同样过双护栏且并发封顶 2；静态服务拒 dotfile 与 `*.bak`；`/proxy` 不加 ACAO。改这些时安全回归见 docs/review.md G 组清单。
- **快捷键**（A-5）：`/` 聚焦搜索、空格 播放/暂停、`←`/`→` 收藏间切台；焦点在 INPUT/TEXTAREA/SELECT/BUTTON/列表行/⚙ 面板内一律让位原生行为。

## radio.txt 格式

```text
分类名,#genre#
电台名,http://流地址
电台名,http://备选地址      ← 同名多行 = 同一电台多源，播放失败自动切换
```

- 同步写入用 CRLF；电台名内不能含逗号（同步时会替换为空格）。
- 同步前自动备份为 `radio.txt.bak`（gitignored）。
- 双击 `index.html` 以 file:// 打开是降级模式（http:// 才是支持形态）：代理/同步/体检/my-radio 均不可用（体检会明确提示而非标死台），仅剩内置精选 + 手动导入 + 双视图，调试播放务必走 `npm start` 的 http://。

## 已知坑（改代码前必读）

- **`live.xmcdn.com`（喜马拉雅 CDN）是假流**：返回 206 / audio/aac 但只有 ~336 字节。探活逻辑（`checkStream`）必须按「持续吐数据 ≥ 阈值字节」验收，不能信状态码或 Content-Type。
- 蜻蜓 mp3 建流慢，点播后 5–10 秒才出声属正常，不是卡死。
- 流地址天然漂移：某台播不了先怀疑源失效（换源 / 重新同步 / 体检），再怀疑代码。

## 代码风格

中文注释、UI 文案全中文、极度紧凑的短行风格；改动时保持一致。
