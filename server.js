// VRadio — 最简静态服务器 + 流媒体代理：node server.js（或 npm start）后访问 http://localhost:8137
// /proxy?url=...   同源转发远端音频流/HLS，绕开浏览器 CORS 限制（配合前端 hls.js 使用；同源无需 ACAO）
// /api/sync        一键同步最新源（update-sources.js，进行中重复触发返回 409）
// /api/check?url=  可用性探测（url 参数可重复=多源、任一活即 OK，最多 4 个；服务端检测无 CORS 限制）
// /api/mystation   添加自定义电台（POST JSON {n,u,c}：先探活拒绝假流/死链，再原子写入 my-radio.txt）
// 安全：默认仅监听 127.0.0.1；proxy/check 仅允许公网 http(s) 目标 —— safeTarget 字符串校验 + guardLookup
//       连接级 IP 校验（防 DNS rebinding/TOCTOU），重定向逐跳复查；/api/sync、/api/check 校验 Origin/
//       Sec-Fetch-Site（防跨源 CSRF/探活驱动）；静态服务拒绝目录穿越与 dotfile/备份文件。
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const { syncSources, checkStream, safeTarget, guardLookup } = require('./update-sources');
const ROOT = __dirname, PORT = process.env.PORT || 8137, HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain; charset=utf-8' };

// 跨源请求识别：Sec-Fetch-Site（现代浏览器全覆盖）+ Origin 与 Host 比对（兜底）
function crossOrigin(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return true;
  const o = req.headers.origin;
  if (!o) return false;
  try { return new URL(o).host !== (req.headers.host || ''); } catch (_) { return true; }
}

function proxy(target, req, res, depth = 0) {
  if (depth > 5) return res.writeHead(508).end('too many redirects');
  const mod = target.startsWith('https') ? https : http;
  const creq = mod.get(target, {
    timeout: 30000, lookup: guardLookup, // 超时（P2-3）+ 连接级 IP 校验：校验的就是本次连接实际使用的解析结果
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': '*/*' }
  }, r => {
    if ([301, 302, 303, 307].includes(r.statusCode) && r.headers.location) {
      r.resume();
      const next = safeTarget(new URL(r.headers.location, target).href); // 重定向逐跳复查（P2-6）
      if (!next) return res.writeHead(403).end('403 redirect target rejected');
      return proxy(next, req, res, depth + 1);
    }
    const h = { 'Content-Type': r.headers['content-type'] || 'application/octet-stream' }; // 同源代理，无需 ACAO（P2-4）
    if (r.headers['content-range']) h['Content-Range'] = r.headers['content-range'];
    res.writeHead(r.statusCode, h);
    r.on('error', () => res.destroy()); // 上游中途断流：终止响应，error 不逃逸（Node ≥14 防御性守卫）
    res.on('close', () => r.destroy()); // 浏览器侧断开（换源/暂停/关页）：销毁上游，直播流不再泄漏连接（P2-2）
    r.pipe(res);
  });
  creq.on('timeout', () => creq.destroy(new Error('upstream timeout'))); // 带错误对象 destroy：各版本 Node 都保证触发 error → 502
  creq.on('error', () => { if (res.headersSent) res.destroy(); else res.writeHead(502).end('upstream error'); });
}

// ---------- my-radio.txt 写入（A-2）：tmp+rename 原子替换 + 写段串行化（与前端 reloadMain/导入重并无半写竞争） ----------
const MY_FILE = path.join(ROOT, 'my-radio.txt'), MY_MAX_LINES = 500, MY_MAX_BYTES = 65536;
let myQ = Promise.resolve(); // 串行写队列：探活是异步的，两个并发添加不得互踩对方的读-改-写
function myStationWrite(n, u, c) {
  return myQ = myQ.then(() => new Promise(done => {
    let txt = '';
    try { txt = fs.readFileSync(MY_FILE, 'utf8'); } catch (_) {} // 不存在 = 首次创建
    const lines = txt ? txt.split(/\r?\n/) : [];
    if (lines.length >= MY_MAX_LINES || txt.length >= MY_MAX_BYTES) return done({ ok: false, error: `my-radio.txt 已达上限（${MY_MAX_LINES} 行），请清理后再添加` });
    if (lines.some(l => l.trim() === `${n},${u}`)) return done({ ok: false, error: '该电台已在个人列表中' });
    const head = `${c},#genre#`, at = lines.findIndex(l => l.trim() === head);
    if (at >= 0) lines.splice(at + 1, 0, `${n},${u}`); // 已有该分类节：节内插入
    else lines.push('', head, `${n},${u}`); // 新分类：尾部开节
    const out = lines.join('\r\n').replace(/^\r\n/, '') + '\r\n';
    const tmp = MY_FILE + '.tmp';
    fs.writeFile(tmp, out, e => e ? done({ ok: false, error: '写入失败' })
      : fs.rename(tmp, MY_FILE, e2 => done(e2 ? { ok: false, error: '写入失败' } : { ok: true })));
  })).catch(() => ({ ok: false, error: '写入失败' }));
}

let syncInFlight = null;
http.createServer((req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'POST' && req.url.split('?')[0] === '/api/sync') {
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' }); // 防 CSRF（P2-5）
    if (syncInFlight) return json(409, { error: '同步已在进行中，请稍候' });
    syncInFlight = syncSources(m => console.log('[sync]', m));
    syncInFlight.then(s => json(200, s)).catch(e => json(500, { error: String(e.message || e) })).finally(() => { syncInFlight = null; });
    return;
  }
  if (req.url.startsWith('/api/check?')) {
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' }); // 带副作用的 GET 同样防跨源驱动（P2-9）
    let urls;
    try { urls = [...new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.getAll('url')]; }
    catch (_) { return json(400, { ok: false, detail: 'bad request' }); }
    if (urls.length > 4) return json(400, { ok: false, detail: '最多 4 个源' }); // 放大面封顶（P2-9）
    const targets = [...new Set(urls.map(safeTarget).filter(Boolean))];
    if (!targets.length) return json(400, { ok: false, detail: '仅允许公网 http(s) 地址' });
    (async () => {
      for (const t of targets) { const r = await checkStream(t); if (r.ok) return json(200, { ok: true, detail: r.detail }); }
      json(200, { ok: false, detail: `${targets.length} 个源均不可用` });
    })();
    return;
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/mystation') { // 添加自定义电台（A-2）：探活通过才写 my-radio.txt
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' }); // 写文件接口，防 CSRF 与 check/sync 同口径
    let body = '', big = false;
    req.on('data', c => { body += c; if (body.length > 2048) { big = true; req.destroy(); } });
    req.on('close', () => { if (big) json(413, { error: '请求体过大' }); });
    req.on('end', () => {
      if (big) return;
      let j; try { j = JSON.parse(body); } catch (_) { return json(400, { error: 'bad request' }); }
      // 内容护栏：台名/分类去 csv 分隔符与换行（radio.txt 格式硬约束），长度封顶；地址须公网 http(s)
      const n = String(j.n || '').replace(/[,\r\n|]/g, ' ').trim().slice(0, 40);
      const c = String(j.c || '').replace(/[,\r\n|#]/g, ' ').trim().slice(0, 24);
      const u0 = String(j.u || '').trim().slice(0, 512);
      if (!n || !c) return json(400, { error: '电台名/分类不能为空' });
      const target = safeTarget(u0);
      if (!target) return json(403, { error: '流地址不合法（仅公网 http(s)）' });
      checkStream(target).then(async r => { // 探活先行：假流（xmcdn 336B 类）与死链一律拒绝入库
        if (!r.ok) return json(200, { ok: false, detail: '探活失败：' + r.detail });
        json(200, await myStationWrite(n, target, c));
      }).catch(e => json(500, { error: String(e && e.message || e) }));
    });
    return;
  }
  if (req.url.startsWith('/proxy?url=')) {
    let target;
    try { target = safeTarget(decodeURIComponent(req.url.slice('/proxy?url='.length))); }
    catch (_) { return res.writeHead(400).end('400 bad url'); }
    if (!target) return res.writeHead(403).end('403 公网 http(s) only');
    return proxy(target, req, res);
  }

  // 静态文件（拒绝目录穿越 + dotfile/备份文件——.git/.DS_Store/radio.txt.bak 不可读，P2-8）
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); } catch (_) { return res.writeHead(400).end('400'); }
  if (rel.split('/').some(seg => seg.startsWith('.') || seg.endsWith('.bak'))) return res.writeHead(403).end('403');
  const p = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) return res.writeHead(403).end('403');
  fs.readFile(p, (e, buf) => e ? res.writeHead(404).end('404') : (res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' }).end(buf)));
}).listen(PORT, HOST, () => console.log(`VRadio: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}（仅本机监听；局域网需 HOST=0.0.0.0 自行承担风险）`));
