# AGENTS.md

VRadio — 零依赖本地网络电台 Web 播放器（国内电台为主、欧美音乐台为辅，面向国内直连环境）。共 10 个源码文件（含 test/smoke.js）+ 3 个数据文件，**无 npm 依赖、无构建步骤**（`npm test` 零依赖测试总入口，lint/typecheck 无配置）。背景与实测记录详见 README.md，评审与实施依据见 docs/review.md，r2 批次决策见 docs/roadmap-research-r2.md，全面体检见 docs/audit-2026-10-13.md、docs/audit-2026-10-14.md 与 docs/audit-2026-10-14-r2.md（第四轮）。安卓版已立项拍板（2026-10-14，docs/plan-android.md + docs/adr/0001、0002）：原生 Kotlin+Compose+Media3、monorepo `android/` 子目录——**radio.txt/logos.txt 行格式、`radio.*` 持久键、vradio-backup.json 格式为 Web/安卓两侧共同契约，改契约须两侧同步**；r4 扩展批次（2026-11-14 起，docs/plan-expansion-r4.md）：`contracts/` 目录是双端契约单一来源（键白名单/诊断/质量/元数据/备份 v3 schema + fixtures 黄金样本），`radio.cfg` 升 v2（源生命周期三字段 srcManualOrder/srcDisabled/srcLabels）；**B1 已落地**：结构化探活（`checkDetail` + `GET /api/check?detail=1`，code 固定枚举为程序分支唯一依据）、电台详情中心（#detail 浮层）、源生命周期接线（srcorder.js 双端同语义纯函数）。

## 常用命令

```bash
npm start        # = node server.js，启动后访问 http://localhost:8137（换端口：PORT=9000）
npm run sync     # = node update-sources.js，同步电台源（约 1 分钟，含欧美台逐个实测 + 台标随行更新）
npm run sync -- --logos   # = node update-sources.js --logos，只重建 logos.txt 台标（数秒）
npm test         # = node test/run.js，零依赖测试总入口：契约键三侧比对 → 纯函数/fixture 各文件 → smoke 压轴（秒级）
```

- **零依赖是核心设计**：只用 Node ≥ 14 内置模块 + 本地化的 hls.min.js，不要引入任何 npm 依赖。
- lint / typecheck 无配置；改动先跑 `npm test` 烟雾回归，行为验证 = 启动服务后在浏览器里实际点播。

## 文件与职责

| 文件 | 职责 |
|---|---|
| `index.html` | 结构壳：DOM + 样式（浅/深主题、双视图/台标/无效源开关、⚙ 维护面板、#detail 详情浮层、safe-area）；逻辑全部外置（store/player/logos/features/srcorder/app/sync），经典 script 顺序引入 |
| `store.js` | 存储收敛层：radio.* 持久键的唯一读写出口。http 形态下 data/store.json（`/api/store`）为主源、localStorage 永远留镜像；file:// 或后端不可用纯 localStorage（与旧版行为一致）。仲裁 = 服务端唯一发号（rev 由 POST 成功分配，客户端不自造；后端写失败标 dirty、boot 先重推 pending 再对账，并发退化为显式 last-write-wins）。多标签 BroadcastChannel 'store' 重拉（debounce 三规则：flush 时读当前内存/收消息作废 pending/beforeunload+visibilitychange flush）。**⚠ 新增任何 radio.\* 持久键必须同步扩 store.js 的 KEYS、server.js 的 STORE_KEYS 与 android/ 侧 Store 白名单（`android/app/src/main/java/.../consts/Consts.kt` 的 C.KEYS）**（白名单外的键不落盘，漏扩表现为换浏览器丢该键；已知例外：`radio.logos` 台标缓存可重建不入主源、`radio.storeDirty` 是 Store 自身状态键）。写放大护栏：set 即写镜像 + 300ms debounce 攒批推后端（音量条拖动连续写安全） |
| `player.js` | 播放引擎：audio/hls/播放态/睡眠定时/MediaSession（台名+曲讯+台标 artwork+⏮⏭ 切台键）/每台音量记忆（`radio.volperst`）/多标签页防双播（BroadcastChannel）/默认源决策链（手动 `prefer` > 成功源记忆（须在启用序内）> 人工默认顺序 `s.mo` 头 > 直流优先启发式 `srcOrder`；禁用源（`s.dis`）播放与级联一律跳过、全禁返回 `NO_ENABLED_SOURCE` 不建连接；`forgetSrc(s)` 清指定台源记忆；`getSourceState()` 只读快照供详情中心）的唯一所有者（世代令牌防串台；断流自愈看门狗；手动刷新 `refresh` 当前源整链重开回直播头——暂停中直接起播、不写 srcmem；成功源记忆 `radio.srcmem2`，键升级即旧记忆一次性失效） |
| `logos.js` | 台标数据唯一所有者：三级来源（STARTER 内置 → logos.txt → 运行时解析）/永久缓存/收藏+正在播优先补全/负缓存 7 天 |
| `app.js` | 应用层：列表/搜索（多词空格 AND）/分类/收藏（行内 ☆ + 双击行/移动端长按行收藏）/最近播放/导入导出/网格+列表双视图渲染/无效源默认隐藏/明暗主题切换/⚙ 维护面板（个人分类与电台调整 + 添加自定义电台 + 追加备选源 + 行内 ▶ 用此源播放 + 源启停/上移下移/标签编辑）/footer 选源浮层（正在听的多源台切源/恢复默认，禁用源行不可点）/**电台详情中心 `#detail`**（B1：台信息 + 逐源诊断 code 徽标/延迟/字节/模式 + 源启停/播放/复制 + 恢复默认两动作 + 歌曲历史；入口 = 行/卡 ⓘ、footer ⓘ、⚙ 源管理「详情」）/曲讯轮询+码率显示+歌曲历史（含导出）/键盘快捷键+`?` 帮助/回到正在播；集中 state 对象 + 单一 render 入口 |
| `sync.js` | 同步/体检编排（手动全量 + 开机静默体检，`busy` 互斥手动优先；同步 diff 摘要 + 消失收藏台前端点名；体检四通道一律跳过手动禁用源、全禁台不测不落标记）：只调用 App/Player 暴露的接口，不改对方状态 |
| `features.js` | 发布开关（B3 独立发布单元，r4）：`window.FEATURES`（metadataV2/listenStats/discovery，默认全关）；发布配置非用户数据，不入 radio.*、可经 localStorage['feat.*'] 开发覆盖 |
| `srcorder.js` | 源顺序/禁用决策纯函数（B1，双端同语义单一来源）：`SrcOrder.effective(u, manual, disabled)` → 启用有效序 + 禁用索引（索引空间 = 原始 s.u[]，绝不物理重排）、`SrcOrder.pick(order, prefer, mem)` → 首选索引（order 空 → -1 = NO_ENABLED_SOURCE）；经典 script + CommonJS 双兼容，applyCfg 与 Player 决策链共用，Android 侧按同款语义镜像 |
| `contracts/` | 双端契约单一来源（r4/B0）：radio-keys.json（13 键白名单——store.js KEYS / server.js STORE_KEYS / Android C.KEYS 漂移由 test/contracts.js + Android ContractTest.kt 双端拦截）、source-diagnostic/quality-summary/metadata-event/backup-v3.schema 契约描述 + fixtures/ 黄金样本（backup-v2/v3、metadata-golden、playlist-pls/xspf/asx、diagnostic-results）。**改契约须两侧测试同步点名** |
| `server.js` | 静态服务（拒 dotfile/`.bak`/`data` 段——store.json 全量个人数据不可被直接 GET）+ `/proxy?url=` 流代理（绕 CORS）+ `POST /api/sync`（响应含 addedCheck 体检测名单）+ `/api/check?url=` 探活（≤4 源）+ **`/api/check?detail=1&url=u1&url=u2`**（B1 结构化探活：`{ok, results:[契约结构…]}`，不返回响应体，安全边界与旧口径一致）+ `POST /api/mystation`（添加电台：探活先行 + 原子写 my-radio.txt）+ `/api/nowplaying?url=`（ICY 曲讯 + icy-br 码率旁路）+ `/api/store`（GET 全量 / POST 覆盖写 data/store.json：Origin 校验 + 键白名单 + 2MB 封顶 + tmp+rename 串行队列 + rev 唯一发号）+ `/api/quality`（质量 sidecar：GET ?rev= 条件获取 / POST {baseRev,ops} 操作事件合并——op.id 幂等去重 + rev 唯一发号 + 409 仅限 schema/批量超限/2MB 超限，B0 骨架/B2 接 QualityStore）+ `/api/myradio`（my-radio.txt 全量替换：行形态清洗 + 500 行/64KB 封顶，v2+ 备份恢复通道） |
| `update-sources.js` | 源同步引擎 + 网络安全护栏（`safeTarget`/`guardLookup`/`tryUrl`（畸形重定向头归 null，audit-r2 P2-1）导出供 server.js 复用）+ **结构化探活 `checkDetail`**（B1 契约 contracts/source-diagnostic.json：`{url,ok,code,hls,mode,httpStatus,contentType,bytes,latencyMs,why,checkedAt}`，code 固定枚举 `OK/NETWORK/HTML/HTTP/EMPTY_PLAYLIST/NO_SEGMENT/SHORT_BODY/REDIRECT_REJECTED/INVALID_URL` 是程序分支唯一依据、UI 不得反推 why；`checkStream` 旧 {ok,detail} 形态不变；`opt.testHook={safe,lookup}` 仅测试用）+ 欧美台台标提取（tvg-logo→logos.txt）+ 同步 diff 摘要（台名集合 added/removed）+ radio-data.js 随行产出；可独立作 CLI 运行（改它时两种入口都不能坏，另有 `--logos` 只重建台标） |
| `test/smoke.js` | 零依赖冒烟测试（audit R1）：静态拦截矩阵（大小写/尾点变形、方法、nosniff）/ 跨源与 Host 白名单 / safeTarget+guardLookup+tryUrl（畸形 Location 不抛）/ classifyCn 幂等 / store 白名单+发号 round-trip / 探活与曲讯 API 的 405 / `/api/check?detail=1` 的 405·403·400·不含响应体；离线秒级，已有 data/store.json 自动备份还原。`test/run.js` 是总入口（逐文件子进程执行 test/*.js），`test/contracts.js`（键契约三侧比对 + fixtures 形态）、`test/quality.js`（质量 sidecar API：rev/幂等/合流/409/损坏恢复）、`test/diagnostic.js`（B1：回环 fixture + testHook 全分支）、`test/source-lifecycle.js`（B1：SrcOrder 纯函数 + normCfg 三字段）随批新增 |
| `radio.txt` | 电台数据库（1600+ 台）。**数据文件，由同步生成**，不要手工维护 |
| `radio-data.js` | radio.txt 的经典 script 包装（`window.RADIO_DATA`=全文，同步随行生成，tmp+rename 原子写）。**数据文件，由同步生成**，file:// 降级模式的全库数据源 |
| `logos.txt` | 台标数据（欧美音乐/国际新闻·谈话两分类，同步自动生成/`--logos` 重建），行格式 `分类|台名,图片URL`。**数据文件，勿手工维护** |
| `hls.min.js` | 本地化的 hls.js v1.5.20（Apache-2.0 第三方库），勿改 |
| `my-radio.txt` | 用户个人补充列表（gitignored），同步/导入后常驻重并，永不被覆盖 |
| `android/` | 安卓原生版（Kotlin+Compose+Media3，monorepo 子目录，ADR-0002）。分层/环境搭建/国内镜像/命令见 [android/README.md](android/README.md)，并行开发契约见 [android/CONTRACTS.md](android/CONTRACTS.md)；依赖白名单封闭清单制（okhttp 是 D6 唯一破例）。radio.txt/logos.txt 由仓库根数据文件经 gradle task 打包进 assets，**两侧共同消费同一份数据**；播放行为两侧镜像、以 Web 为准（手动刷新回直播头等能力两侧同步，方案与语义见 docs/plan-refresh-live.md）；改动 android/ 后跑 `cd android && ./gradlew test`（CI 另有干净环境验证，path filter `android/**`） |

## 架构要点

- **前端模块契约**（改代码前必读，详见 docs/review.md 十一节债务 2）：player 拥有 audio/hls/播放态/音量，logos 拥有台标数据（三级来源/缓存/按需补全），app 拥有 stations/渲染/收藏，sync 只编排；跨模块只走暴露接口，UI 反馈与数据回流经 Player 的 onstate/onstatus/onlogo/onvol 等回调注入（player 不反向伸手进 app/logos）。**用经典 script 而非 ES modules 是硬约束**（file:// 下 module 加载受 CORS 限制必挂），且装载顺序 = **store**（存储收敛层，player/app 的持久化出口）→ player → logos → **radio-data**（同步生成的数据全局，缺失时仅控制台 404）→ **features**（发布开关，r4/B3）→ **srcorder**（源顺序/禁用纯函数，B1）→ app（boot 渲染行内入口时即引用 logos/数据；applyCfg 即消费 SrcOrder.effective）→ sync。
- **身份公理**：URL = 持久身份，名字 = 显示层。收藏/最近（`radio.favs`/`radio.recents`）记录源 URL，电台改名/换分类后按 URL 回绑；带 URL 的休眠条目永不回收。
- **数据装配管线**（`app.js` 的 `applySources`）：主列表 replace → STARTER 精选层按精确名去重并入 → my-radio.txt 个人层常驻并入 → **维护层套用**（`applyCfg`，radio.cfg，owner 三轮拍板）：电台移动/重命名/手动隐藏/**追加备选源**按「任一源 URL 命中」回绑（同步重建后自动复用），分类重命名最后映射（改名时移动目标/隐藏标记级联改写）；追加源（P1-a，cfg.srcs）**只挂台尾不动身份键**（`s.u[0]` 是 srcmem/收藏/健康标记的键），每台封顶 6 条、先 `/api/check` 探活再收（拒绝假流/死链，口径同 mystation）；**源生命周期接线（B1，双端冻结口径）**：applyCfg 末尾经 `SrcOrder.effective` 给每台挂 `s.mo`（启用有效序，禁位已剔——Android 侧 mo=含禁位完整序+派生有效序，语义等价）/`s.dis`（禁用索引）/`s.moManual`（存在人工排序）——**绝不物理重排 s.u[]**；cfg 三字段中 **srcManualOrder/srcDisabled 键 = 身份 URL u[0] 严格命中**（排序/禁用是台属性，与 srcs 的「任一源命中」口径不同）、srcLabels 键 = 源 URL（标签属具体源，仅展示），normCfg 清洗同款（URL 键/数组值/http(s) 元素/6 条封顶）；上移/下移把当前完整顺序（含禁位殿后）材料化写进 srcManualOrder；手动隐藏 = 彻底消失（全部/收藏/搜索/体检一律不可见，无正在播例外——与死台隐藏的自动例外口径不同）。装配默认口径留底在 `s.dCat/dName/dU`（面板 ↺ 恢复/撤回移动/撤回追加源用；`reapplyCfg` 回滚 c/n/u 三项后重套），面板改动经 `reapplyCfg` 即时生效。电台重命名禁止同分类撞名（keyOf 串台防护）；配置导入 = 全量覆盖 + confirm（srcs 走 normCfg 清洗：键须 URL、值数组、元素 http(s)、条数/长度封顶）；失配（URL 漂移，含 srcs）在面板顶部出清单。
- **播放三级策略**（`player.js` 的 `variants()`/`load()`，顺序不能乱）：① mp3/AAC 直流（`<audio>` 原生跨域；蜻蜓 `ls.qingting.fm/live/{id}.m3u8` 自动换算成同 id 的 `lhttp.../64k.mp3`）→ ② m3u8 直连 hls.js → ③ 本地 `/proxy` 兜底。央广 ngcdn 系 CDN 锁了 CORS，只走得通第 ③ 级。**默认源决策链**（单次点播内从高到低）：手动指定 `play(s, prefer)` > 成功源记忆（`radio.srcmem2`，FIFO 300；键升级一次性失效旧记忆，防存量「代理旧路」压住启发式）> 静态启发式（`srcOrder`：直流形态优先——首个 variant 非 m3u8 即 mp3/aac 直达或蜻蜓换算 64k mp3；稳定排序同级保持行序）> 级联自愈顺延，onAir 把赢家写回 srcmem。**手动选源**双入口（grill 拍板）：footer 选源浮层（`#srcMenu`，正在听的多源台主入口：整行点选/「默认」「正在用」「追加」徽标/↺ 恢复默认源=清 srcmem 立即按启发式重播）+ ⚙ 备选源管理行内 ▶（未播态预选源）；一律立即切换并起播，不新增持久存储。**断流自愈**（A-1）：error 级联（onerror/HLS fatal）自动顺延备选源之外，stalled/waiting 看门狗（12s 无进展）与 ended（直播不该 ended）也自愈——先重连当前源一次再顺延；成功源序号按台主 URL 持久化（见上方决策链），下次点播该源先行。**每台音量**（A3/r2）：`play()` 套用 `radio.volperst[s.u[0]]`，无记忆用全局 `gvol`（`radio.vol`，仅无记忆台首调时随行更新——语义①）；静音态切台保持静音，取消静音按「当前台记忆→全局」恢复；0 不入记忆。**多标签防双播**（N3）：BroadcastChannel('vradio') 'playing' 广播、他页让位暂停（建流期让位要清 connecting 指示），不支持/file:// 异常静默降级。
- **曲讯链路**（B-6/B-7）：ICY meta 只存在于 Icecast/Shoutcast 形态 mp3/AAC 直流，**HLS 结构性没有**（央广系全 m3u8 → 显示为空，不是 bug）。server.js `/api/nowplaying` 按台建旁路会话 keep-open 持续读（换歌近实时；空闲 30s 回收/并发封顶 2/失败 60s 冷却/noIcy 负缓存）；app.js 15s 轮询（暂停/后台空转，切台清零防串台），曲名写 MediaSession（`Player.setSong`），icy-br 码率随曲讯同帧返回、footer 曲名行显示「· Nkbps」（仅 ICY 直流有）；换歌时旧歌入史 `radio.songs`（每台 12 首、台数 50 FIFO），点 footer 曲名行看本台历史。
- **代理分片重写**：走代理播 m3u8 时，hls.js 的 `xhrSetup` 必须把相对分片 URL 拼回远端 base 再包 `/proxy`，否则分片会被解析到 localhost。
- **无效源隐藏·分档**（`app.js`，grill R1-R4 拍板，方案文档 docs/plan-health-and-storage.md）：体检标记 `health:'dead'` 的台默认不进 `visible()`（正在播/连接中的台例外）；开关持久化在 `radio.showdead`（默认隐藏），出现死台即亮「✗ 无效源」按钮。**死台标记持久化 `radio.health` 分两档**（键 → {u:URL 快照, t:最近确认, t0:首死, n:连续确认数, perm}）：疑似档（首死即入，兜底 TTL 180 天）/ 停运档（复测连续确认 ≥3 次且首死 ≥30 天升级，永不过期；保留「复测可达即撤销」保险通道——复活即 delete 从疑似档重来）；休眠孤儿（回绑失联）90 天清理；FIFO 分额度疑似 1000 + 停运 1000（停运档最后才挤）。旧数据按「疑似档、n=1、t0=旧 t」兼容读取。分档 UI：「已停运」灰徽标 + title 分文案（疑似不可达/长期确认停运）；手动体检完成态分档统计。**体检四通道**（`sync.js` 的 runCheck 共用执行器，busy 互斥手动优先）：手动全量（反馈走 #status）/ 开机静默复测（收藏+最近 ∪ 死标记台，节流：t>24h 入列、每 boot 封顶 200 最旧优先轮转、停运档 7 天一次）/ **同步后增量体检**（diff 新增国内台自动静默跑，update-sources 产 addedCheck 名单欧美节过滤 500 封顶）/ **首启基线**（未建基线 toast 确认门槛 → 后台全量排除欧美两分类 → 中断续跑 baselineProg）。后台任务反馈一律走 toast（`App.toast`，与 #status 分工不双写）。同步源不产健康标记（欧美台在同步期已实测过滤、国内台不测）。**开机静默体检**（B-10）：boot 首屏后 4s 静默复查「收藏+最近」范围（`App.scopeFavRecent(30)`，手动隐藏的台不测），不碰按钮/状态栏；与手动体检 `busy` 互斥（手动优先，静默让位不落盘不渲染）。
- **明暗主题**：CSS 变量双套（`:root` 深色 / `:root[data-theme="light"]` 浅色），app.js 按手动选择（`radio.theme`：auto/light/dark，默认 auto）或系统 `prefers-color-scheme` 写 `<html data-theme>`；auto 态监听 matchMedia 变化实时跟随。
- **台标数据链**（`logos.js`）：`Logos.get/peek` 同步渲染（绝不发请求），三级来源 = STARTER 的 `l` 字段 → logos.txt（欧美系台，同步按流 URL 确定性匹配、双分类前缀）→ 运行时解析（**只对「收藏 + 正在播」的台**：蜻蜓台取频道页封面 `<img class="img">`、其它台查 Radio Browser `byurl` favicon，经 /proxy，负缓存 7 天）。图片本体 `<img>` 直连加载不受 CORS 限制（file:// 也能显示），坏图 onerror 移除回退纯文字；勿改成全量抓取（1600+ 台请求量不可控，owner 明确「收藏优先」）。
- **同步双上游 + 内容分类体系**（`update-sources.js`）：国内源拉取 gaotianliuyun/gao 的 radio.txt 后**不再透传上游分类**，由 `classifyCn` 按台名关键词重分类（`CN_RULES` 顺序即优先级，兜底 `综合·其他`）——对上游改版免疫；藏在国内外表里的国际台（BBC Radio 系/NPR News/CGTN…）会被捞回欧美系分类。欧美台从 AlonDrilich/radio-playlists（Radio Browser 镜像，官方 API 国内不可达）top-500 过滤欧美国家后**逐个实测重建**，并按类型榜（`genres/` 的 news/talk/sports/religious，每类封顶 300）拆成 `欧美音乐` + `国际新闻·谈话` 两分类——关联键 = m3u 每条目前的 72FM 电台 UUID（比 URL 可靠，同台不同码率变体常见），`EU_TALK_NAMES` 是类型榜榜外漏网品牌兜底。旧「世界」分类已撤销（新闻向并入国际新闻·谈话、其余进 `亚洲·港台`）。同步 diff 摘要含 `addedCheck`（新增国内台名单，欧美节过滤、500 封顶，供前端增量体检）；radio.txt 分类装配顺序 = `CAT_ORDER`（= 界面分类条顺序，`华语音乐`/`欧美音乐` 由 app.js `order` 置顶）；`欧美音乐`/`国际新闻·谈话` 每次同步整体重建，手工编辑会被覆盖。
- GitHub 取文件：api.github.com 直连，失败回退 `gh` CLI（异步 `execFile`，不阻塞事件循环）。
- **服务端安全护栏**：`safeTarget`（字符串级）+ `guardLookup`（连接级 DNS 校验，防 rebinding/TOCTOU）双层校验，重定向逐跳复查（畸形 `Location` 头经 `tryUrl` 归 null 一并拒绝——裸 `new URL` 在回调里抛 TypeError 即崩进程，audit-r2 P2-1）；`/api/sync`、`/api/check`、`/api/mystation`、`/api/nowplaying` 拒跨源（CSRF/跨源驱动），全 API 方法校验收口（探活/曲讯仅 GET，audit-r2 P3-1）；`/api/mystation` 只写固定文件 my-radio.txt（tmp+rename 原子替换 + 串行写队列；台名/分类去 csv 分隔符，500 行/64KB 封顶）；`/api/nowplaying` 旁路连接同样过双护栏且并发封顶 2；静态服务拒 dotfile 与 `*.bak`；`/proxy` 不加 ACAO。改这些时安全回归见 docs/review.md G 组清单。
- **快捷键**（A-5 + N8）：`/` 聚焦搜索、空格 播放/暂停、`←`/`→` 收藏间切台、`?` 快捷键帮助浮层（键位表写死在 index.html `#keys`，改键位两处同步）；焦点在 INPUT/TEXTAREA/SELECT/BUTTON/列表行/⚙ 面板/footer 可点行（`#nowline`/`#song`，audit-r2 P3-2 补键盘可达）内一律让位原生行为。锁屏/媒体键：⏮⏭ 经 `onstepfav` 回调转 `App.stepFav`（与 ←/→ 同语义，注册独立 try 容错）。鼠标/触屏：**双击列表行 = 播放并收藏**（单击第二次 click 按 `e.detail>1` 跳过防「播了又暂停」；移动端长按行 500ms = 收藏、位移 >10px 取消；audit-r2 四-2，配套 `touch-action:manipulation` 关双击缩放）。

## radio.txt 格式

```text
分类名,#genre#
电台名,http://流地址
电台名,http://备选地址      ← 同名多行 = 同一电台多源，播放失败自动切换
```

- 同步写入用 CRLF；电台名内不能含逗号（同步时会替换为空格）。
- 行格式是 Web/安卓两侧契约（安卓端解析取前两字段、3+ 字段容错跳过）——将来扩展列（如回听）时两侧同步改（docs/plan-android.md 5.2）。
- 同步前自动备份为 `radio.txt.bak`（gitignored）；同步随行产出 radio-data.js（radio.txt 全文包成 `window.RADIO_DATA` 经典 script）与 diff 摘要（按台名集合算 added/removed，名单封顶 50，收藏台消失在前端 `favsGone` 点名——收藏在 localStorage，服务端碰不到）。
- 双击 `index.html` 以 file:// 打开是**部分降级**模式（http:// 才是支持形态）：列表走 radio-data.js 全库（最后跑过同步时的快照），直流台可播；代理/同步/体检/my-radio/追加源探活不可用（体检会明确提示而非标死台），仅 m3u8 的台点播失败给既有提示不崩坏。调试播放务必走 `npm start` 的 http://。

## 已知坑（改代码前必读）

- **`live.xmcdn.com`（喜马拉雅 CDN）manifest 锁 CORS（直连必挂、仅 /proxy 可播）且分片时好时坏**：部分频道是真 AAC 可播、部分已死/漂移，不能一律当假流也不能信状态码/Content-Type——探活逻辑（`checkStream`）必须按「持续吐数据 ≥ 阈值字节」验收。
- 蜻蜓 mp3 建流慢，点播后 5–10 秒才出声属正常，不是卡死。
- 流地址天然漂移：某台播不了先怀疑源失效（换源 / 重新同步 / 体检），再怀疑代码。

## 代码风格

中文注释、UI 文案全中文、极度紧凑的短行风格；改动时保持一致。
