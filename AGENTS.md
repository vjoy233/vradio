# AGENTS.md

VRadio — 零依赖本地网络电台 Web 播放器（国内电台为主、欧美音乐台为辅，面向国内直连环境）。共 8 个源码文件 + 2 个数据文件（另有可选的 `epg.txt` 手动节目单，gitignored），**无 npm 依赖、无构建步骤、无测试/lint 配置**。背景与实测记录详见 README.md，评审与实施依据见 docs/review.md。

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
| `index.html` | 结构壳：DOM + 样式（浅/深主题、双视图/节目单面板/台标、safe-area）；逻辑全部外置五文件，经典 script 顺序引入 |
| `player.js` | 播放引擎：audio/hls/播放态/睡眠定时/MediaSession 的唯一所有者（世代令牌防串台） |
| `epg.js` | 节目单（EPG）数据唯一所有者：蜻蜓 SSR 拉取/台名复核/缓存/时区换算/手动 epg.txt；不碰渲染不碰播放 |
| `logos.js` | 台标数据唯一所有者：三级来源（STARTER 内置 → logos.txt → 运行时解析）/永久缓存/收藏+正在播优先补全/负缓存 7 天 |
| `app.js` | 应用层：列表/搜索/分类/收藏/最近播放/导入导出/网格+列表双视图渲染；集中 state 对象 + 单一 render 入口 |
| `sync.js` | 同步/体检编排：只调用 App/Player 暴露的接口，不改对方状态 |
| `server.js` | 静态服务 + `/proxy?url=` 流代理（绕 CORS）+ `POST /api/sync` + `/api/check?url=` 探活（≤4 源） |
| `update-sources.js` | 源同步引擎 + 网络安全护栏（`safeTarget`/`guardLookup` 导出供 server.js 复用）+ 欧美台台标提取（tvg-logo→logos.txt）；可独立作 CLI 运行（改它时两种入口都不能坏，另有 `--logos` 只重建台标） |
| `radio.txt` | 电台数据库（1600+ 台）。**数据文件，由同步生成**，不要手工维护 |
| `logos.txt` | 台标数据（欧美音乐分类，同步自动生成/`--logos` 重建），行格式 `分类|台名,图片URL`。**数据文件，勿手工维护** |
| `hls.min.js` | 本地化的 hls.js v1.5.20（Apache-2.0 第三方库），勿改 |
| `my-radio.txt` | 用户个人补充列表（gitignored），同步/导入后常驻重并，永不被覆盖 |

## 架构要点

- **前端模块契约**（改代码前必读，详见 docs/review.md 十一节债务 2）：player 拥有 audio/hls/播放态，epg 拥有节目单数据（拉取/缓存/时区），logos 拥有台标数据（三级来源/缓存/按需补全），app 拥有 stations/渲染/收藏，sync 只编排；跨模块只走暴露接口，UI 反馈经 Player 的 onstate/onstatus 回调注入。**用经典 script 而非 ES modules 是硬约束**（file:// 下 module 加载受 CORS 限制必挂），且 **epg.js/logos.js 必须先于 app.js 装载**（boot 渲染行内入口时即引用）。
- **身份公理**：URL = 持久身份，名字 = 显示层。收藏/最近（`radio.favs`/`radio.recents`）记录源 URL，电台改名/换分类后按 URL 回绑；带 URL 的休眠条目永不回收。
- **数据装配管线**（`app.js` 的 `applySources`）：主列表 replace → STARTER 精选层按精确名去重并入 → my-radio.txt 个人层常驻并入；同步与导入都走它。
- **播放三级策略**（`player.js` 的 `variants()`/`load()`，顺序不能乱）：① mp3/AAC 直流（`<audio>` 原生跨域；蜻蜓 `ls.qingting.fm/live/{id}.m3u8` 自动换算成同 id 的 `lhttp.../64k.mp3`）→ ② m3u8 直连 hls.js → ③ 本地 `/proxy` 兜底。央广 ngcdn 系 CDN 锁了 CORS，只走得通第 ③ 级。
- **代理分片重写**：走代理播 m3u8 时，hls.js 的 `xhrSetup` 必须把相对分片 URL 拼回远端 base 再包 `/proxy`，否则分片会被解析到 localhost。
- **节目单数据链**（`epg.js`，实测细节见 README 实测记录）：源① `m.qtfm.cn/channels/{id}`（id 与流 URL `qingting.fm/live/{id}` 同空间、确定性映射，只含今天已开播档）为主；源② `search/{台名}→/radios/{id}` 全天档为辅——radios 页**按 id 取页内容会随机串台**，必须「搜索台名严格相等 + 页面 h1 复核」双闸，核不过退回源①，宁可没数据不给错数据；源③ `epg.txt` 手动条目（支持时区偏移与周几）。缓存按天存 localStorage（只留今昨两天，供「每天/每周循环」标注），列表行「正在播」用 `EPG.peek` 同步窥探绝不发请求；有数据源的台才渲染 🕐 入口，无数据安静忽略。
- **台标数据链**（`logos.js`）：`Logos.get/peek` 同步渲染（绝不发请求），三级来源 = STARTER 的 `l` 字段 → logos.txt（欧美台，同步按流 URL 确定性匹配）→ 运行时解析（**只对「收藏 + 正在播」的台**：蜻蜓台取频道页封面 `<img class="img">`、其它台查 Radio Browser `byurl` favicon，经 /proxy，负缓存 7 天）。图片本体 `<img>` 直连加载不受 CORS 限制（file:// 也能显示），坏图 onerror 移除回退纯文字；勿改成全量抓取（1600+ 台请求量不可控，owner 明确「收藏优先」）。
- **同步双上游**（`update-sources.js`）：国内源原样拉取 gaotianliuyun/gao 的 radio.txt；欧美台从 AlonDrilich/radio-playlists（Radio Browser 镜像，官方 API 国内不可达）top-500 过滤欧美国家后**逐个实测重建**。`欧美音乐` 分类每次同步整体重建，手工编辑会被覆盖。
- GitHub 取文件：api.github.com 直连，失败回退 `gh` CLI（异步 `execFile`，不阻塞事件循环）。
- **服务端安全护栏**：`safeTarget`（字符串级）+ `guardLookup`（连接级 DNS 校验，防 rebinding/TOCTOU）双层校验，重定向逐跳复查；`/api/sync`、`/api/check` 拒跨源（CSRF）；静态服务拒 dotfile 与 `*.bak`；`/proxy` 不加 ACAO。改这些时安全回归见 docs/review.md G 组清单。

## radio.txt 格式

```text
分类名,#genre#
电台名,http://流地址
电台名,http://备选地址      ← 同名多行 = 同一电台多源，播放失败自动切换
```

- 同步写入用 CRLF；电台名内不能含逗号（同步时会替换为空格）。
- 同步前自动备份为 `radio.txt.bak`（gitignored）。
- 双击 `index.html` 以 file:// 打开是降级模式（http:// 才是支持形态）：代理/同步/体检/节目单/my-radio 均不可用（体检会明确提示而非标死台，节目单入口直接不渲染），仅剩内置精选 + 手动导入 + 双视图，调试播放务必走 `npm start` 的 http://。

## 已知坑（改代码前必读）

- **`live.xmcdn.com`（喜马拉雅 CDN）是假流**：返回 206 / audio/aac 但只有 ~336 字节。探活逻辑（`checkStream`）必须按「持续吐数据 ≥ 阈值字节」验收，不能信状态码或 Content-Type。
- 蜻蜓 mp3 建流慢，点播后 5–10 秒才出声属正常，不是卡死。
- **蜻蜓 radios 目录按 id 取页会随机串台**（同一 `/radios/{id}` 先后吐出过三家电台内容）且偶发 no-content 桩页（约 1/9）——节目单链路靠台名 h1 复核 + 空页重试兜底，动 `epg.js` 解析逻辑时不要放宽这两道闸。
- 流地址天然漂移：某台播不了先怀疑源失效（换源 / 重新同步 / 体检），再怀疑代码。

## 代码风格

中文注释、UI 文案全中文、极度紧凑的短行风格；改动时保持一致。
