# AGENTS.md

VRadio — 零依赖本地网络电台 Web 播放器（国内电台为主、欧美音乐台为辅，面向国内直连环境）。共 3 个源码文件 + 1 个数据文件，**无 npm 依赖、无构建步骤、无测试/lint 配置**。背景与实测记录详见 README.md。

## 常用命令

```bash
npm start        # = node server.js，启动后访问 http://localhost:8137（换端口：PORT=9000）
npm run sync     # = node update-sources.js，同步电台源（约 1 分钟，含欧美台逐个实测）
```

- **零依赖是核心设计**：只用 Node ≥ 14 内置模块 + 本地化的 hls.min.js，不要引入任何 npm 依赖。
- 没有可跑的 test / lint / typecheck；验证改动 = 启动服务后在浏览器里实际点播。

## 文件与职责

| 文件 | 职责 |
|---|---|
| `index.html` | 单页应用（内联 CSS/原生 JS，无框架）：搜索/分类/收藏/多源播放/同步/体检 |
| `server.js` | 静态服务 + `/proxy?url=` 流代理（绕 CORS）+ `POST /api/sync` + `/api/check?url=` 探活 |
| `update-sources.js` | 源同步引擎，导出 `syncSources`/`checkStream` 供 server.js require；同时可独立作 CLI 运行（改它时两种入口都不能坏） |
| `radio.txt` | 电台数据库（1600+ 台）。**数据文件，由同步生成**，不要手工维护 |
| `hls.min.js` | 本地化的 hls.js v1.5.20（Apache-2.0 第三方库），勿改 |
| `my-radio.txt` | 用户个人补充列表（gitignored），同步永不覆盖，前端启动时自动合并 |

## 架构要点

- **播放三级策略**（`index.html` 的 `variants()`/`load()`，顺序不能乱）：① mp3/AAC 直流（`<audio>` 原生跨域；蜻蜓 `ls.qingting.fm/live/{id}.m3u8` 自动换算成同 id 的 `lhttp.../64k.mp3`）→ ② m3u8 直连 hls.js → ③ 本地 `/proxy` 兜底。央广 ngcdn 系 CDN 锁了 CORS，只走得通第 ③ 级。
- **代理分片重写**：走代理播 m3u8 时，hls.js 的 `xhrSetup` 必须把相对分片 URL 拼回远端 base 再包 `/proxy`，否则分片会被解析到 localhost。
- **同步双上游**（`update-sources.js`）：国内源原样拉取 gaotianliuyun/gao 的 radio.txt；欧美台从 AlonDrilich/radio-playlists（Radio Browser 镜像，官方 API 国内不可达）top-500 过滤欧美国家后**逐个实测重建**。`欧美音乐` 分类每次同步整体重建，手工编辑会被覆盖。
- GitHub 取文件：api.github.com 直连，失败回退 `gh` CLI（`execFileSync`）。

## radio.txt 格式

```text
分类名,#genre#
电台名,http://流地址
电台名,http://备选地址      ← 同名多行 = 同一电台多源，播放失败自动切换
```

- 同步写入用 CRLF；电台名内不能含逗号（同步时会替换为空格）。
- 同步前自动备份为 `radio.txt.bak`（gitignored）。
- `index.html` 双击以 file:// 打开是降级模式：代理路径不可用，仅剩内置精选 + 手动导入，调试播放务必走 `npm start` 的 http://。

## 已知坑（改代码前必读）

- **`live.xmcdn.com`（喜马拉雅 CDN）是假流**：返回 206 / audio/aac 但只有 ~336 字节。探活逻辑（`checkStream`）必须按「持续吐数据 ≥ 阈值字节」验收，不能信状态码或 Content-Type。
- 蜻蜓 mp3 建流慢，点播后 5–10 秒才出声属正常，不是卡死。
- 流地址天然漂移：某台播不了先怀疑源失效（换源 / 重新同步 / 体检），再怀疑代码。

## 代码风格

中文注释、UI 文案全中文、极度紧凑的短行风格；改动时保持一致。
