// VRadio — 最简静态服务器 + 流媒体代理：node server.js（或 npm start）后访问 http://localhost:8137
// /proxy?url=...   同源转发远端音频流/HLS，绕开浏览器 CORS 限制（配合前端 hls.js 使用；同源无需 ACAO）
// /api/sync        一键同步最新源（update-sources.js，进行中重复触发返回 409）
// /api/check?url=  可用性探测（url 参数可重复=多源、任一活即 OK，最多 4 个；服务端检测无 CORS 限制）
// /api/mystation   添加自定义电台（POST JSON {n,u,c}：先探活拒绝假流/死链，再原子写入 my-radio.txt）
// /api/nowplaying?url=  曲讯（ICY StreamTitle）：对 mp3/AAC 直流旁路建会话持续读取；HLS 结构性无 ICY 直接返回空
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
    const dup = lines.find(l => l.trim().endsWith(',' + u)); // 同 URL 换名也不双开（AIbot P3-7：applySources 按 keyOf 合并，不同名会出两行）
    if (dup) return done({ ok: false, error: `该流地址已存在（「${dup.split(',')[0]}」），同一地址请直接使用现有电台` });
    const head = `${c},#genre#`, at = lines.findIndex(l => l.trim() === head);
    if (at >= 0) lines.splice(at + 1, 0, `${n},${u}`); // 已有该分类节：节内插入
    else lines.push('', head, `${n},${u}`); // 新分类：尾部开节
    const out = lines.join('\r\n').replace(/^\r\n/, '') + '\r\n';
    const tmp = MY_FILE + '.tmp';
    fs.writeFile(tmp, out, e => e ? done({ ok: false, error: '写入失败' })
      : fs.rename(tmp, MY_FILE, e2 => done(e2 ? { ok: false, error: '写入失败' } : { ok: true })));
  })).catch(() => ({ ok: false, error: '写入失败' }));
}

// ---------- 曲讯旁路会话（B-6）：ICY meta 只存在于 Icecast/Shoutcast 形态的 mp3/AAC 直流 ----------
// 模型：keep-open 持续读（ICY 帧随音频内联到达，换歌近实时，优于周期重连只能拿连接时刻曲名）；
// 会话按 url 缓存曲名，前端 15s 轮询只读缓存；空闲 30s 回收（切台后旧连接自动关）、并发旁路封顶 2
const npSess = new Map(); // url → {title, hit, req, noIcy, deadAt}
const NP_MAX = 2, NP_IDLE = 30000, NP_RETRY = 60000; // 并发上限 / 空闲回收 / 连接失败冷却重试
const NP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
function npEvictOldest() {
  let old = null;
  for (const [u, x] of npSess) if (!old || x.hit < old[1].hit) old = [u, x];
  if (old) { if (old[1].req) old[1].req.destroy(); npSess.delete(old[0]); }
}
function npStart(url) { // 建会话（或复用已有）；并发封顶时 LRU 淘汰最久未访问
  let s = npSess.get(url);
  if (s) { s.hit = Date.now(); return s; }
  for (const [u, x] of [...npSess]) if (Date.now() - x.hit > NP_IDLE) { if (x.req) x.req.destroy(); npSess.delete(u); } // 空闲回收
  if (npSess.size >= NP_MAX) npEvictOldest();
  s = { title: '', hit: Date.now(), req: null, noIcy: false, deadAt: 0, br: 0 };
  npSess.set(url, s);
  const go = (t, depth) => { // 重定向逐跳复查（旁路连接同样过 SSRF 护栏，不豁免）
    if (depth > 3) { s.deadAt = Date.now(); return; }
    const creq = (t.startsWith('https') ? https : http).get(t, { timeout: 15000, lookup: guardLookup, headers: { 'User-Agent': NP_UA, Accept: '*/*', 'Icy-MetaData': '1' } }, r => {
      if ([301, 302, 303, 307].includes(r.statusCode) && r.headers.location) {
        r.resume();
        const nx = safeTarget(new URL(r.headers.location, t).href);
        if (nx) go(nx, depth + 1); else s.deadAt = Date.now();
        return;
      }
      s.req = creq;
      const mi = parseInt(r.headers['icy-metaint'], 10);
      const br = parseInt(r.headers['icy-br'], 10); // 码率（③/grill 拍板）：ICY 响应头随曲讯一起返回，footer 曲名旁显示「· Nkbps」
      s.br = br > 0 ? br : 0;
      if (!(mi > 0)) { s.noIcy = true; r.destroy(); creq.destroy(); return; } // 协议无曲讯（普通文件流/部分服务器）：请求+响应双销毁防双倍带宽（resume 会把整条音频流在服务端放空下载——AIbot P1-1），Map 条目即负缓存
      // ICY 帧状态机：mi 个音频字节 → 1 字节长度(值×16) → meta 载荷，取 StreamTitle='…'（\' 转义）
      let pos = 'a', left = mi, mlen = 0, mbuf = [];
      r.on('data', d => {
        let i = 0;
        while (i < d.length) {
          if (pos === 'a') { const use = Math.min(left, d.length - i); i += use; left -= use; if (!left) pos = 'l'; }
          else if (pos === 'l') {
            mlen = d[i++] * 16;
            if (!mlen) { left = mi; pos = 'a'; } else { mbuf = []; pos = 'm'; }
          } else {
            const use = Math.min(mlen, d.length - i); mbuf.push(d.slice(i, i + use)); i += use; mlen -= use;
            if (!mlen) {
              const raw = Buffer.concat(mbuf);
              let txt = raw.toString('utf8'); // 多数欧美台 meta 是 UTF-8（AIbot P3-5）；含替换符再回退 latin1（老 Icecast 字节流）
              if (txt.includes('\uFFFD')) txt = raw.toString('latin1');
              const t2 = txt.match(/StreamTitle='((?:\\'|[^'])*)'/);
              if (t2) s.title = t2[1].replace(/\\'/g, "'").trim();
              left = mi; pos = 'a';
            }
          }
        }
      });
      r.on('end', () => { s.deadAt = Date.now(); });   // 上游断连：保留最后曲名，冷却期后下次访问重建
      r.on('error', () => { s.deadAt = Date.now(); });
    });
    creq.on('timeout', () => creq.destroy(new Error('upstream timeout')));
    creq.on('error', () => { s.deadAt = Date.now(); });
    if (!s.req) s.req = creq;
  };
  go(url, 0);
  return s;
}
// 全局回收器（AIbot P2-4）：空闲回收只在 npStart 入口触发不够——暂停/停止后无人再发请求，
// 挂着的旁路连接要靠这里 30s 一扫兜底销毁，否则最多 2 条 ICY 流在 upstream 永久下载
setInterval(() => {
  const now = Date.now();
  for (const [u, x] of [...npSess]) if (now - x.hit > NP_IDLE) { if (x.req) x.req.destroy(); npSess.delete(u); }
}, NP_IDLE);

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
    let urls, sp;
    try { sp = new URL(req.url, `http://${req.headers.host || 'localhost'}`); urls = [...sp.searchParams.getAll('url')]; }
    catch (_) { return json(400, { ok: false, detail: 'bad request' }); }
    if (urls.length > 4) return json(400, { ok: false, detail: '最多 4 个源' }); // 放大面封顶（P2-9）
    const targets = [...new Set(urls.map(safeTarget).filter(Boolean))];
    if (!targets.length) return json(400, { ok: false, detail: '仅允许公网 http(s) 地址' });
    // 探活窗口可调（AIbot P1-1）：批量体检不传 → checkStream 默认 4.5s（ETA 按最坏校准，不能放慢）；
    // 追加备选源传 t=12000 —— 蜻蜓系救援源建流 5-10s 属正常，与 /api/mystation 同口径。钳到 [1s, 30s] 防滥用
    const tms = Math.min(Math.max(parseInt(sp.searchParams.get('t'), 10) || 0, 0), 30000);
    const opt = tms >= 1000 ? { timeout: tms } : {};
    (async () => {
      for (const t of targets) { const r = await checkStream(t, 0, opt); if (r.ok) return json(200, { ok: true, detail: r.detail }); }
      json(200, { ok: false, detail: `${targets.length} 个源均不可用` });
    })();
    return;
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/mystation') { // 添加自定义电台（A-2）：探活通过才写 my-radio.txt
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' }); // 写文件接口，防 CSRF 与 check/sync 同口径
    let body = '', big = false;
    req.on('data', c => { body += c; if (body.length > 2048) { big = true; json(413, { error: '请求体过大' }); req.destroy(); } }); // 超限先写响应再断连（destroy 后无 end，socket 已毁时补写会静默失败——AIbot P3-8）
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
      checkStream(target, 0, { timeout: 12000 }).then(async r => { // 探活先行：假流（xmcdn 336B 类）与死链一律拒绝入库；窗口放宽到 12s——蜻蜓系建流 5-10s 属正常（AIbot P1-2），单 URL 手动添加不涉 /api/check 的放大面
        if (!r.ok) return json(200, { ok: false, detail: '探活失败：' + r.detail });
        json(200, await myStationWrite(n, target, c));
      }).catch(e => json(500, { error: String(e && e.message || e) }));
    });
    return;
  }
  if (req.url.startsWith('/api/nowplaying?')) { // 曲讯（B-6）：带副作用 GET（驱动服务端上行连接），与 check 同口径防跨源驱动
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' });
    let u;
    try { u = [...new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.getAll('url')][0]; }
    catch (_) { return json(400, { title: '' }); }
    const target = u && safeTarget(u);
    if (!target) return json(400, { title: '' }); // 仅公网 http(s)
    if (/\.m3u8(\?|$)/.test(target)) return json(200, { title: '' }); // HLS 结构性无 ICY，不建旁路不耗探活
    const old = npSess.get(target);
    if (old && old.deadAt && Date.now() - old.deadAt > NP_RETRY) { if (old.req) old.req.destroy(); npSess.delete(target); } // 失败冷却后允许重建
    const s = npSess.get(target) || npStart(target);
    return json(200, { title: s.title || '', br: s.br || 0 });
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
  fs.readFile(p, (e, buf) => {
    if (e) return res.writeHead(404).end('404');
    const h = { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' };
    // radio-data.js 是同步才变的生成物（~200KB），http 模式每次刷新都会白拉一遍（列表实际走 radio.txt）——
    // 定向给一天缓存（AIbot P3-5）；file:// 读本地文件不经 HTTP 缓存，不受影响。其余文件不缓存：开发改动即刷即生效
    if (p === path.join(ROOT, 'radio-data.js')) h['Cache-Control'] = 'public, max-age=86400';
    res.writeHead(200, h).end(buf);
  });
}).listen(PORT, HOST, () => console.log(`VRadio: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}（仅本机监听；局域网需 HOST=0.0.0.0 自行承担风险）`));
