// VRadio — 最简静态服务器 + 流媒体代理：node server.js（或 npm start）后访问 http://localhost:8137
// /proxy?url=...  同源转发远端音频流/HLS，绕开浏览器 CORS 限制（配合 index.html 的 hls.js 使用）
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const ROOT = __dirname, PORT = process.env.PORT || 8137;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain; charset=utf-8' };

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

http.createServer((req, res) => {
  if (req.url.startsWith('/proxy?url=')) {
    const target = decodeURIComponent(req.url.slice('/proxy?url='.length));
    if (!/^https?:\/\//.test(target)) return res.writeHead(403).end('http(s) only');
    return proxy(target, req, res);
  }
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, buf) => e ? (res.writeHead(404).end('404')) : (res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }).end(buf)));
}).listen(PORT, () => console.log(`VRadio: http://localhost:${PORT}`));
