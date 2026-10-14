# 0001 安卓版采用纯原生路线（Kotlin + Compose + Media3）

VRadio 安卓版（2026-10 立项）面临是否复用已打磨的 Web 前端做 WebView 壳的抉择。拍板：纯原生，不复用 Web UI——播放引擎与播放决策链（prefer > srcmem > 启发式 > 级联顺延 + 断流自愈）必须在原生侧同属一个运行时，UI 跟随核心走原生，避免跨 JS/Kotlin 异步桥（2026-10-14 owner 问答轮拍板，D1）。

## 考虑过的选项（否决理由留档，防日后再提）

- **B1 纯 WebView（连音频一起）**：三事实判死——① WebView 的 Media Session API 被 Chromium 官方禁用（无法接系统锁屏，crbug 40765779）；② `<audio>` 音频焦点行为失控（来电/导航后恢复不一致，Android 12+ 连禁用开关都失效）；③ hls.js 在后台 WebView 数小时后冻结（JS 定时器节流致分片停摆），命中央广系 m3u8 × 睡前收听场景。
- **B2 WebView UI + 原生播放桥**：决策链跨异步边界不可靠（世代令牌竞态在桥上重现；WebView 冻结时后台自愈断线），终局形态 = 写完全部原生核心再背一座 15-20 方法的桥。
- **C 原生核心 + 无状态 WebView 岛**：保留为未来「低频重编辑屏」（维护面板）上安卓时的候选形态，不作整体起点。

## 后果

Web 与安卓 UI 永久双实现（语义契约单源于 AGENTS.md 与 docs/plan-android.md 5.3 映射表）；换取播放/后台/锁屏的平台一等公民质量，widget/Android Auto 顺路演进。证据链接与完整论证见 docs/plan-android.md 3.3。
