# VRadio 📻

> 零依赖的本地网络电台播放器 —— 国内电台为主、海外电台为辅，无需翻墙，`npm start` 即听。

在浏览器里收听 1400+ 电台：央广/国际台全系、全国省市地方台、音乐/文艺频率，以及新加坡、日本等海外电台。全部代码约 300 行，无 npm 依赖，不收集任何数据，纯本地运行。

## 特性

- 🎧 **开箱即听**：预置 1484 个电台（央广 / 地方 / 音乐 / 世界 / 中国广播分类），来自社区持续维护的公开直播源列表
- 🔍 **搜索**：按电台名即时过滤（试试搜「中国之声」「Love」「NHK」）
- ⭐ **收藏**：一键收藏，localStorage 持久化，刷新不丢
- 🔄 **多源自动切换**：同一电台常有多个流地址，一个失败自动换下一个，还在蜻蜓 m3u8 与 mp3 直流之间自动换算
- 🛡️ **m3u8 本地代理**：内置同源流代理 + hls.js 分片重写，绕开国内电台 CDN 的 CORS 限制（央广系 CDN 的 CORS 锁了特定 origin，直连必挂——本项目靠代理解决）
- 🖥️ **零依赖**：Node 内置模块 + 一个本地化的 hls.js，没有 `npm install`，没有构建步骤

## 快速开始

```bash
git clone https://github.com/vjoy233/vradio.git
cd vradio
npm start          # 或 node server.js
```

浏览器打开 **http://localhost:8137**，点击任意电台即播。

<details>
<summary>环境要求 / 端口修改</summary>

- Node.js ≥ 14（只用内置模块 `http`/`https`/`fs`/`path`）
- 换端口：`PORT=9000 npm start`（Windows PowerShell：`$env:PORT=9000; npm start`）
</details>

<details>
<summary>不想跑服务器？直接双击 index.html 也能用（功能受限）</summary>

file:// 模式下可用内置精选电台和「导入列表」手动加载 radio.txt；但 m3u8 代理路径不可用，央广系等仅 m3u8 的电台无法播放。推荐 `npm start`。
</details>

## 使用

- **搜索**：顶部输入框按名称过滤；**分类**：顶部 chip 切换（全部 / ★收藏 / 央广 / 地方…）
- **收藏**：行首 ☆ ⇄ ★；**播放控制**：底部栏 播放/暂停、音量、当前台与连接状态
- **导入自己的列表**：右上「导入列表」选择 txt/m3u 文件即时加载（见下方格式）
- 点播后等 5–10 秒属正常（直播流建流慢，非卡死）

## 工作原理

### 1. 网络电台 = 一个永不结束的音频流 URL

所谓「听电台」，本质是把一个持续产生音频数据的 HTTP 地址交给 `<audio>` 播放。最基础的收音机只需一行：

```html
<audio src="http://lhttp.qingting.fm/live/273/64k.mp3" controls></audio>
```

### 2. 但现实有三道墙，VRadio 的三级播放策略逐一化解

| 层级 | 机制 | 说明 |
|---|---|---|
| ① MP3/AAC 直流优先 | `<audio>` 原生跨域播放 | 媒体元素播放**不需要** CORS 许可。蜻蜓 `lhttp.qingting.fm/live/{id}/64k.mp3` 是国内台最优解；遇到 `ls.qingting.fm/live/{id}.m3u8` 会自动换算成同 id 的 mp3 直流 |
| ② m3u8 直连 | hls.js (MSE) | 仅当 CDN 允许跨域时成功（部分海外台可以） |
| ③ 本地代理兜底 | `server.js` 的 `/proxy?url=` | 同源转发清单与分片（hls.js `xhrSetup` 把相对分片拼回远端 base），任何 CORS 限制都失效——央广 ngcdn CDN 实测必须走这条 |

每个电台按 ①→②→③ 依次尝试，全失败才报错。

### 3. 电台数据从哪来

`radio.txt` 来自开源项目 [gaotianliuyun/gao](https://github.com/gaotianliuyun/gao)，社区持续维护。格式极简：

```text
分类名,#genre#
电台名,http://流地址
电台名,http://备选地址
```

同名多行 = 同一电台的多个备选源（自动故障切换的基础）。更新列表：

```bash
gh api repos/gaotianliuyun/gao/contents/radio.txt --jq .content | base64 -d > radio.txt
```

## 实测记录与已知坑（2026-10，国内直连环境）

- ✅ 实测浏览器可播：Love Radio FM103.7（mp3 直流）、CNR 中国之声（代理 + hls.js）、动感 101 / 经典 947 / 东广新闻台 / 交通台 105.7（mp3 直流）、YES 933 / Class 95 新加坡（AAC 直流）
- ⚠️ **`live.xmcdn.com`（喜马拉雅 CDN）是假流**：返回 `206 / audio/aac` 但只有 336 字节，探活时勿信状态码，要按「持续吐数据」验收
- ⚠️ 蜻蜓 mp3 建流慢，点击后 5–10 秒出声属正常
- ⚠️ 流地址会漂移：某台播不了时先换源/更新 radio.txt，再怀疑代码

## 目录结构

```text
vradio/
├── index.html    # 单页应用：搜索/分类/收藏/播放与多源切换（~200 行）
├── server.js     # 静态服务 + 流媒体代理（~30 行）
├── radio.txt     # 电台数据库（1484 台，分类分节）
├── hls.min.js    # 本地化的 hls.js v1.5.20（Apache-2.0）
├── package.json
└── LICENSE       # MIT
```

## Roadmap

- [ ] 节目回听（蜻蜓有回听接口）
- [ ] 睡眠定时 / 闹钟
- [ ] 手机布局（PWA）
- [ ] 电台连通性体检（批量探测标记死链）
- [ ] 收藏导出/导入

## 致谢与许可

- 电台数据：[gaotianliuyun/gao](https://github.com/gaotianliuyun/gao) 及其上游直播源社区
- [hls.js](https://github.com/video-dev/hls.js) v1.5.20（Apache-2.0），已本地内置，离线可用
- 本项目代码以 [MIT](LICENSE) 许可发布

## 免责声明

本项目不存储、不上传、不转授权任何音频内容，仅聚合互联网上公开的电台流地址并在本机代理播放，供个人学习研究使用。各电台内容的版权归其所有者；流地址由第三方提供，随时可能失效。请勿将本项目用于公共分发或商业用途。
