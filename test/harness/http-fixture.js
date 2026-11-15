// 本地可控上游 fixture server（P0a 最小版，方案 §3 L2.2 接口草案落地）：路由表 = { status, headers, body, stream, delay }。
// 所有上游流必须本地可控——禁止测试连公网。P1 归拢时扩 ICY meta 换歌/HLS master-variant/断流场景。
const http = require('http');

function fixture(routes) {
  const conns = [];
  const server = http.createServer((req, res) => {
    conns.push(res);
    let r = null;
    try { r = routes[new URL(req.url, 'http://fixture').pathname]; } catch (_) {}
    if (!r) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no route'); }
    res.writeHead(r.status || 200, r.headers || {});
    if (r.delay) return setTimeout(() => { if (r.stream) r.stream(res); else res.end(r.body || ''); }, r.delay);
    return r.stream ? r.stream(res) : res.end(r.body || '');
  });
  return {
    server, conns,
    listen: () => new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server.address().port))),
    close: () => new Promise(ok => { for (const c of conns.slice()) { try { c.destroy(); } catch (_) {} } server.close(ok); }),
  };
}

module.exports = { fixture };
