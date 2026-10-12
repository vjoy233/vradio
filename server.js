// VRadio — 最简静态服务器 + 流媒体代理：node server.js（或 npm start）后访问 http://localhost:8137
// /proxy?url=...   同源转发远端音频流/HLS，绕开浏览器 CORS 限制（配合 index.html 的 hls.js 使用）
// /api/sync        一键同步最新源（update-sources.js，进行中重复触发返回 409）
// /api/check?url=  可用性探测（url 参数可重复=多源，任一活即 OK；服务端检测无 CORS 限制）
// 安全：默认仅监听 127.0.0.1；proxy/check 仅允许公网 http(s) 目标，拒绝环回/RFC1918/链路本地（防 SSRF）
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const { syncSources, checkStream } = require('./update-sources');
const ROOT = __dirname, PORT = process.env.PORT || 8137, HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain; charset=utf-8' };

// 目标地址校验：仅 http(s) 且非内网/环回
function safeTarget(raw) {
  let u; try { u = new URL(raw); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]' || h.endsWith('.local')) return null;
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return null;
  return u.href;
}

function proxy(target, req, res, depth = 0) {
  if (depth > 5) return res.writeHead(508).end('too many redirects');
  const mod = target.startsWith('https') ? https : http;
  mod.get(target, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': '*/*' } }, r => {
    if ([301, 302, 303, 307].includes(r.statusCode) && r.headers.location)
      return r.resume(), proxy(new URL(r.headers.location, target).href, req, res, depth + 1);
    const h = { 'Content-Type': r.headers['content-type'] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' };
    if (r.headers['content-range']) h['Content-Range'] = r.headers['content-range'];
    res.writeHead(r.statusCode, h); r.pipe(res);
  }).on('error', () => res.writeHead(502).end('upstream error'));
}

let syncInFlight = null;
http.createServer((req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'POST' && req.url.split('?')[0] === '/api/sync') {
    if (syncInFlight) return json(409, { error: '同步已在进行中，请稍候' });
    syncInFlight = syncSources(m => console.log('[sync]', m));
    syncInFlight.then(s => json(200, s)).catch(e => json(500, { error: String(e.message || e) })).finally(() => { syncInFlight = null; });
    return;
  }
  if (req.url.startsWith('/api/check?')) {
    let urls;
    try { urls = [...new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.getAll('url')]; }
    catch (_) { return json(400, { ok: false, detail: 'bad request' }); }
    const targets = [...new Set(urls.map(safeTarget).filter(Boolean))];
    if (!targets.length) return json(400, { ok: false, detail: '仅允许公网 http(s) 地址' });
    (async () => {
      for (const t of targets) { const r = await checkStream(t); if (r.ok) return json(200, { ok: true, detail: r.detail }); }
      json(200, { ok: false, detail: `${targets.length} 个源均不可用` });
    })();
    return;
  }
  if (req.url.startsWith('/proxy?url=')) {
    let target;
    try { target = safeTarget(decodeURIComponent(req.url.slice('/proxy?url='.length))); }
    catch (_) { return res.writeHead(400).end('400 bad url'); }
    if (!target) return res.writeHead(403).end('403 公网 http(s) only');
    return proxy(target, req, res);
  }

  // 静态文件（拒绝目录穿越）
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); } catch (_) { return res.writeHead(400).end('400'); }
  const p = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) return res.writeHead(403).end('403');
  fs.readFile(p, (e, buf) => e ? res.writeHead(404).end('404') : (res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' }).end(buf)));
}).listen(PORT, HOST, () => console.log(`VRadio: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}（仅本机监听；局域网需 HOST=0.0.0.0 自行承担风险）`));
