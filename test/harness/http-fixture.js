// 本地可控上游 fixture server（P0a 最小版，方案 §3 L2.2 接口草案落地）：路由表 = { status, headers, body, stream, delay }。
// 所有上游流必须本地可控——禁止测试连公网。P1 归拢时扩 ICY meta 换歌/HLS master-variant/断流场景。
// review#37 P2-3 修订：close 是闭合协议——先取消 delay 定时器与流生产器（onTeardown 注册表），再销毁连接、
// 关 server；延迟窗口内客户端断连后不再启动响应；listen 失败 reject（端口被占/权限错误有报告）。
const http = require('http');

function fixture(routes) {
  const conns = new Set();   // 活动响应（close 时统一销毁；响应 close 即出集，不留陈旧引用）
  const timers = new Set();  // delay 路由挂起的定时器（close 时全部取消——close 后延迟响应不得再执行）
  const teardowns = [];      // 流生产器注册的资源回收（interval 句柄等）：onTeardown(fn) 注册，close 先于连接销毁执行
  const server = http.createServer((req, res) => {
    conns.add(res);
    res.on('close', () => conns.delete(res));
    let r = null;
    try { r = routes[new URL(req.url, 'http://fixture').pathname]; } catch (_) {}
    if (!r) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no route'); }
    res.writeHead(r.status || 200, r.headers || {});
    if (r.delay) {
      const t = setTimeout(() => {
        timers.delete(t);
        if (res.destroyed || res.writableEnded) return; // 延迟窗口内客户端已断连：不再创建响应/流生产器
        if (r.stream) r.stream(res); else res.end(r.body || '');
      }, r.delay);
      timers.add(t);
      return;
    }
    return r.stream ? r.stream(res) : res.end(r.body || '');
  });
  server.on('clientError', () => { /* 连接层错误由框架静默处理（RST 等），不崩 fixture 进程 */ });
  return {
    server, conns,
    onTeardown(fn) { teardowns.push(fn); },
    listen: () => new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); ok(server.address().port); });
    }),
    close: () => new Promise(ok => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const fn of teardowns.splice(0)) { try { fn(); } catch (_) {} }
      for (const c of conns) { try { c.destroy(); } catch (_) {} }
      conns.clear();
      server.close(ok);
    }),
  };
}

module.exports = { fixture };
