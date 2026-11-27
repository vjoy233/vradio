# /proxy 主动内容安全边界（draft，不得合并）

上游响应体不可信且原先 Content-Type 原样透传：HTML/SVG 可作为同源文档，JS 可作为同源 script 执行。现仅保留列举的媒体和 HLS MIME（去参数、忽略大小写），其他归一为 application/octet-stream；响应加 `X-Content-Type-Options: nosniff` 和 `Content-Security-Policy: sandbox; default-src 'none'`。前者阻止非脚本类型作为 script/style，后者隔离可能被作为文档处理的响应；两者互补，不能仅依靠 CSP 响应头约束作为 script 引用的内容。响应体不改写，XHR 可读取 HTML/JSON 用于台标解析。未知或错标媒体归为 octet-stream，可能影响浏览器播放，须产品实测；不能以 URL 后缀推断安全类型。

离线真服务覆盖 HTML、SVG、JS、HTML 伪装脚本、缺失类型、音频、HLS 清单/分片和未知类型的响应头及部分响应体；原有逐跳重定向与断流测试继续执行。此前工作树手工 Playwright Chromium headless 验证：同源 script 引用 JS 上游被拒绝，变量未写入；1 秒 PCM WAV 经代理真实播放至 ended。本整合批次 npm test 32 文件通过。

# IPv4-mapped IPv6 与地址范围

规范化 IPv4-mapped 地址后按 IPv4 私网规则判定，字符串级和 DNS 连接级共用；包含 zone ID 的 IPv6 DNS 结果一律拒绝，避免 Node 接受 zone ID 而 WHATWG URL 抛异常导致进程崩溃。CGNAT 字面量现与 DNS 一样被拒，可能影响此前使用运营商内网地址的用户。非 mapped IPv6 只拦既有 ::、::1、fc00::/7、fe80::/10，并非完整全球可路由地址白名单；其他保留或特殊用途地址仍需独立评估。真实服务无放行缝验证 mapped 回环拒绝且本地 fixture 零命中，DNS 单值及 all 模拟验证 zone ID 拒绝。尚未验证无放行缝的真实上游重定向至 mapped 回环。

未验证：真实 HLS 端到端音视频播放（仅清单/分片 HTTP 字节测试）、MP3/AAC 及错标或缺失类型流的真实播放、Safari 原生 HLS、Firefox/移动浏览器、实际公网电台/重定向链。WAV 不代表这些格式或真实电台均可用。此分支为安全 draft，必须补齐媒体兼容验证并安全复审后才可考虑合并。
