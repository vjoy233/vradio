// 探活结构化结果测试（B1，契约 contracts/source-diagnostic.json + fixtures/diagnostic-results.json）：
// 本地回环 fixture 服务器（node http）+ checkDetail 的 testHook 测试专用缝（仅测试用——顶替 safeTarget/guardLookup
// 判定放行回环目标，生产路径绝不传）。覆盖：直流成功/HTML 错误页/大 HTML 谎报 Content-Type（内容嗅探兜底，review P2）/
// 336B 假流（SHORT_BODY）/直流 404 字节法两态（小响应 SHORT_BODY、真吐流 OK——AGENTS 已知坑不信状态码）/清单 404（HTTP）/HLS 无分片/
// 分片拉不到（NO_SEGMENT）/分片不吐字节/相对分片路径解析/master→variant 递归/畸形重定向（REDIRECT_REJECTED）/
// 重定向深度上限/网络失败（NETWORK）/INVALID_URL；checkStream 旧签名兼容。每例断言完整结构字段（code 精确 +
// httpStatus/bytes/latencyMs 存在性 + 字段集合与契约一致）。零依赖离线，npm test 随跑。
const assert = require('assert'), http = require('http'), net = require('net'), dns = require('dns');
const { checkDetail, checkStream, safeTarget } = require('../update-sources');

const FIELDS = ['url', 'ok', 'code', 'hls', 'mode', 'httpStatus', 'contentType', 'bytes', 'latencyMs', 'why', 'checkedAt'].sort();
let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// fixture 载荷：够阈值的假音频/分片字节（验收口径 = 持续吐数据 ≥ 阈值，见 AGENTS.md 已知坑）
const BIG = Buffer.alloc(12000, 1), SEG = Buffer.alloc(8000, 2), FAKE = Buffer.alloc(336, 3), SHORT = Buffer.alloc(100, 4), HTMLBIG = Buffer.from('<html>' + 'x'.repeat(9000) + '</html>'), HTMLSMALL = Buffer.from('<html>' + 'x'.repeat(300) + '</html>');
const m3u8 = lines => lines.join('\n') + '\n';

let deadPort = 0; // 空闲端口（建服后即关）：分片指向它 = 建连必拒
const fixture = (port) => http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/ok.mp3') { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(BIG); }
  if (p === '/html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HTMLBIG); }
  if (p === '/htmloct') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(HTMLBIG); } // ≥8000B HTML 谎报 CT（review P2：字节达标后内容判定兜底）
  if (p === '/fakeoct') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(HTMLSMALL); } // <8000B HTML 谎报 CT：判序冻结仍 SHORT_BODY（HTML 不前置于字节阈值）
  if (p === '/fake') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(FAKE); } // 336B 假流（黄金样本同型）
  if (p === '/code404') { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
  if (p === '/code404big') { res.writeHead(404, { 'Content-Type': 'audio/mpeg' }); return res.end(BIG); } // 非 2xx 但真吐流：字节法认活（AGENTS 已知坑）
  if (p === '/ok.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(m3u8(['#EXTM3U', `http://127.0.0.1:${port}/segok.ts`])); }
  if (p === '/rel.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(m3u8(['#EXTM3U', 'seg.ts'])); } // 相对分片
  if (p === '/seg.ts' || p === '/segok.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(SEG); }
  if (p === '/empty.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(m3u8(['#EXTM3U'])); }
  if (p === '/pl404.m3u8') { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); } // 清单拉取非 200 → HTTP（HLS 路径唯一 HTTP 归法）
  if (p === '/badseg.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(m3u8(['#EXTM3U', 'http://['])); } // 分片地址畸形：new URL 抛 TypeError（双端冻结：归 NO_SEGMENT 不崩）
  if (p === '/noseg.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(m3u8(['#EXTM3U', `http://127.0.0.1:${deadPort}/dead.ts`])); }
  if (p === '/shortseg.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(m3u8(['#EXTM3U', `http://127.0.0.1:${port}/segshort.ts`])); }
  if (p === '/segshort.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(SHORT); }
  if (p === '/master.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(m3u8(['#EXTM3U', `http://127.0.0.1:${port}/variant.m3u8`])); }
  if (p === '/variant.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end(m3u8(['#EXTM3U', `http://127.0.0.1:${port}/segok.ts`])); }
  if (p === '/redirbad') { res.writeHead(302, { Location: 'http://[::1' }); return res.end(); } // 畸形 Location 头（audit-r2 P2-1 同型）
  if (p === '/redirloop') { res.writeHead(302, { Location: `/redirloop?d=${(req.url.split('d=')[1] | 0) + 1}` }); return res.end(); } // 自指重定向 → 深度上限
  res.writeHead(404).end();
});

// 结构断言：字段集合与契约一致 + code 精确 + 数值字段存在 + ok 与 code 同步
const shape = (d, url, code, okv) => {
  assert.deepStrictEqual(Object.keys(d).sort(), FIELDS, `字段集合漂移：${JSON.stringify(Object.keys(d).sort())}`);
  assert.strictEqual(d.code, code, `code 应为 ${code}`);
  assert.strictEqual(d.url, url, 'url 回显');
  assert.strictEqual(d.ok, okv, 'ok 与 code 同步');
  for (const k of ['httpStatus', 'bytes', 'latencyMs', 'checkedAt']) assert.ok(typeof d[k] === 'number' && Number.isFinite(d[k]), `${k} 须为有限数值`);
  assert.ok(typeof d.why === 'string' && d.why.length > 0, 'why 非空');
};

(async () => {
  deadPort = await freePort(); // 先占后关：留一个必拒端口给 /noseg.m3u8 的分片
  let port = await freePort();
  while (port === deadPort) port = await freePort(); // 端口防撞：分片“必拒”语义要确定
  await new Promise(r => fixture(port).listen(port, '127.0.0.1', r));
  const B = `http://127.0.0.1:${port}`;
  const H = { // testHook（仅测试用）：safe 放行回环（生产 safeTarget 拒 127.0.0.1）、lookup 裸解析（跳过 guardLookup 内网拒）
    safe: u => { try { return new URL(u).href; } catch (_) { return null; } },
    lookup: (host, opts, cb) => dns.lookup(host, opts, cb),
  };
  const T = { timeout: 2500, testHook: H };
  const probe = (path, code, okv, extra) => checkDetail(B + path, 0, T).then(d => { shape(d, B + path, code, okv); if (extra) extra(d); });

  console.log('[1] 直流分支');
  await ok('直流成功 → OK/direct（阈值字节 + 非 HTML）', () => probe('/ok.mp3', 'OK', true, d => {
    assert.strictEqual(d.hls, false); assert.strictEqual(d.mode, 'direct');
    assert.strictEqual(d.httpStatus, 200); assert.strictEqual(d.bytes, 12000); assert.ok(d.latencyMs >= 0);
  }));
  await ok('HTML 错误页 → HTML（字节够但内容是 HTML）', () => probe('/html', 'HTML', false, d => assert.strictEqual(d.httpStatus, 200)));
  await ok('大 HTML 错误页谎报 Content-Type → 仍 HTML（字节达标后内容嗅探兜底，review P2 回归）', () =>
    probe('/htmloct', 'HTML', false, d => assert.strictEqual(d.contentType, 'application/octet-stream')));
  await ok('小 HTML 谎报 Content-Type → 仍 SHORT_BODY（判序冻结：HTML 判定不前置于字节阈值）', () =>
    probe('/fakeoct', 'SHORT_BODY', false, d => assert.strictEqual(d.contentType, 'application/octet-stream')));
  await ok('336B 假流 → SHORT_BODY（字节不足先于 HTML 判，黄金样本同型）', () => probe('/fake', 'SHORT_BODY', false, d => {
    assert.strictEqual(d.bytes, 336); assert.strictEqual(d.contentType, 'text/html');
  }));
  await ok('直流 404 小响应 → SHORT_BODY（字节法不信状态码，AGENTS 已知坑；httpStatus 照常上报）', () =>
    probe('/code404', 'SHORT_BODY', false, d => assert.strictEqual(d.httpStatus, 404)));
  await ok('直流 404 但持续吐数据 → OK（非 2xx 不参与 ok 判定，与 Android 冻结口径）', () =>
    probe('/code404big', 'OK', true, d => assert.strictEqual(d.httpStatus, 404)));

  console.log('[2] HLS 分支');
  await ok('清单 + 分片吞吐 → OK/hls（绝对分片）', () => probe('/ok.m3u8', 'OK', true, d => {
    assert.strictEqual(d.hls, true); assert.strictEqual(d.mode, 'hls'); assert.strictEqual(d.bytes, 8000);
  }));
  await ok('相对分片路径解析（seg.ts 按清单 base）→ OK', () => probe('/rel.m3u8', 'OK', true));
  await ok('清单无分片条目 → EMPTY_PLAYLIST', () => probe('/empty.m3u8', 'EMPTY_PLAYLIST', false, d => assert.strictEqual(d.httpStatus, 200)));
  await ok('清单拉取 404 → HTTP（HLS 路径唯一 HTTP 归法）', () => probe('/pl404.m3u8', 'HTTP', false, d => assert.strictEqual(d.httpStatus, 404)));
  await ok('分片建连被拒 → NO_SEGMENT（清单 200 是最终收到的响应；分片未建连）', () => probe('/noseg.m3u8', 'NO_SEGMENT', false, d => assert.strictEqual(d.httpStatus, 200)));
  await ok('分片不吐字节（100B < 6000 阈）→ NO_SEGMENT', () => probe('/shortseg.m3u8', 'NO_SEGMENT', false, d => assert.strictEqual(d.bytes, 100)));
  await ok('分片地址畸形不可解析 → NO_SEGMENT（清单侧观察值，不抛 TypeError）', () => probe('/badseg.m3u8', 'NO_SEGMENT', false, d => assert.strictEqual(d.httpStatus, 200)));
  await ok('master → variant 递归解一层 → OK（url 回显原始地址）', () => probe('/master.m3u8', 'OK', true, d => assert.strictEqual(d.url, B + '/master.m3u8')));

  console.log('[3] 护栏与网络分支');
  await ok('畸形重定向（Location: http://[::1）→ REDIRECT_REJECTED（tryUrl 归 null 不抛）', () => probe('/redirbad', 'REDIRECT_REJECTED', false));
  await ok('重定向深度上限（自指循环）→ REDIRECT_REJECTED', () => probe('/redirloop', 'REDIRECT_REJECTED', false));
  await ok('网络失败（连不上端口）→ NETWORK（httpStatus=0/contentType 空）', async () => {
    const d = await checkDetail(`http://127.0.0.1:${deadPort}/live.mp3`, 0, T);
    shape(d, `http://127.0.0.1:${deadPort}/live.mp3`, 'NETWORK', false);
    assert.strictEqual(d.httpStatus, 0); assert.strictEqual(d.contentType, '');
  });

  console.log('[4] 字符串层与兼容口');
  await ok('INVALID_URL：私网目标被 safeTarget 字面拒绝（真护栏、无 hook）', async () => {
    const d = await checkDetail('http://127.0.0.1/x.mp3', 0, { timeout: 1000 });
    shape(d, 'http://127.0.0.1/x.mp3', 'INVALID_URL', false);
  });
  await ok('INVALID_URL：非 http 协议', async () => {
    assert.strictEqual(safeTarget('ftp://example.com/'), null);
    const d = await checkDetail('ftp://example.com/x', 0, { timeout: 1000 });
    assert.strictEqual(d.code, 'INVALID_URL');
  });
  await ok('checkStream 旧签名兼容：{ok, detail} 形态不变（既有消费口 server.js/mystation/sync）', async () => {
    const r = await checkStream(B + '/ok.mp3', 0, T);
    assert.strictEqual(r.ok, true); assert.strictEqual(typeof r.detail, 'string');
    const r2 = await checkStream(B + '/fake', 0, T);
    assert.strictEqual(r2.ok, false); assert.ok(r2.detail.length > 0);
  });

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('diagnostic 测试异常：', e); process.exit(1); });
