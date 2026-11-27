// Node 原生 fetch + 回环 HTTP 真流；不是浏览器或手机测试，不访问公网/写资产。
const assert = require('assert'), http = require('http'), crypto = require('crypto');
const S = require('../discovery-sidecar');

async function main() {
  if (typeof fetch !== 'function') { console.log('discovery-http-api: 跳过（Node 原生 fetch 需 Node 18+）'); return; }
  const payload = Buffer.from(JSON.stringify({v:1,source:'recommended-radio-streams',license:'CC0-1.0',commit:'a'.repeat(40),generatedAt:'2026-11-26T00:00:00.000Z',items:[{name:'previous',url:'https://example.invalid/stream'}]}));
  const previous = crypto.createHash('sha256').update(payload).digest('hex'), current = 'b'.repeat(64);
  const sockets = new Set(), requests = [], aborted = []; let mode = 'stall', closed;
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/snap/current.json') return res.end(JSON.stringify({v:1,current,previous}));
    if (req.url === '/snap/' + current + '/manifest.json') return res.end(JSON.stringify({v:1,sha256:current,bytes:payload.length}));
    if (req.url === '/snap/' + current + '/radio-discovery.json') {
      res.write('{');
      if (mode === 'stall') { res.on('close', () => { if (closed) closed(); }); }
      else res.socket.destroy();
      return;
    }
    if (req.url === '/snap/' + previous + '/manifest.json') return res.end(JSON.stringify({v:1,sha256:previous,bytes:payload.length}));
    if (req.url === '/snap/' + previous + '/radio-discovery.json') return res.end(payload);
    res.statusCode = 404; res.end('{}');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + server.address().port + '/snap';
    const fetcher = (url, opts) => { opts.signal.addEventListener('abort', () => aborted.push(new URL(url).pathname)); return fetch(url, opts); };
    const disconnected = new Promise(resolve => { closed = resolve; });
    let rows = await S.loadSnapshot(fetcher, base, 300);
    assert.deepStrictEqual(rows.map(x => x.name), ['previous'], '慢流超时后返回经哈希验证的上一代');
    assert(aborted.includes('/snap/' + current + '/radio-discovery.json'), '慢流请求的 signal 已取消');
    assert(!aborted.includes('/snap/' + previous + '/radio-discovery.json'), '成功的上一代不被取消');
    let timer;
    try { await Promise.race([disconnected, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('服务端未观察到慢流连接关闭')), 2000); })]); }
    finally { clearTimeout(timer); }
    assert(requests.indexOf('/snap/' + previous + '/manifest.json') > requests.indexOf('/snap/' + current + '/radio-discovery.json'));
    mode = 'interrupt'; requests.length = 0; aborted.length = 0;
    rows = await S.loadSnapshot(fetcher, base, 1000);
    assert.deepStrictEqual(rows.map(x => x.name), ['previous'], '上游中断后回退上一代');
    assert(requests.includes('/snap/' + current + '/radio-discovery.json'));
    assert(requests.includes('/snap/' + previous + '/radio-discovery.json'));
    console.log('discovery-http-api: Node 本地 HTTP 慢流取消与中断回退通过');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
