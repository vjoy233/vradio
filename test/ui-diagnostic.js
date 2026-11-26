// 详情诊断世代与复制脱敏回归：延迟响应完全不可污染新会话。
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const m = src.match(/\nApp\.boot\(\);\s*$/) || src.match(/\nif \(typeof document !== 'undefined'\) App\.boot\(\);[\s\S]*$/);
const els = { detail: { hidden: false }, dClose: { focus() {} } }, records = [], pending = [], toasts = [];
const sb = { console, URL, setTimeout, clearTimeout, location: { protocol: 'http:' }, navigator: {},
  document: { activeElement: null, getElementById: id => els[id] || (els[id] = {}), body: { appendChild() {} }, createElement: () => ({ style: {}, select() {}, remove() {} }), execCommand: () => false },
  QualityStore: { recordDiagnostic: (...x) => records.push(x) }, fetch: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
vm.createContext(sb); vm.runInContext(src.slice(0, m.index) + '\nthis.App = App;', sb);
const app = sb.App; app.renderDetail = () => {}; app.mEditorRepaint = () => {}; app.toast = x => toasts.push(x);
const projection = require('../quality-store'); sb.qExplain = projection.qExplain; sb.diagnosticAction = projection.diagnosticAction;
const s = { c: '分类', n: '电台', u: ['https://user:pass@example.com/secret?token=abc#frag', 'https://example.org/live'], dis: [] };
app.state.stations = [s];
const respond = (req, url) => req.resolve({ ok: true, json: async () => ({ results: [{ url, code: 'OK', ok: true, why: 'secret' }] }) });
(async () => {
  app.openDetail(s); const old = pending.shift(); app.closeDetail(); app.openDetail(s); const fresh = pending.shift();
  respond(old, s.u[0]); await Promise.resolve(); await Promise.resolve(); assert.equal(records.length, 0);
  respond(fresh, s.u[0]); await new Promise(setImmediate); assert.equal(records.length, 1);
  const bulk = app.checkStationSources(s), a = pending.shift(); const single = app.recheckSource(s, 1), b = pending.shift();
  respond(a, s.u[0]); respond(b, s.u[1]); await Promise.all([bulk, single]); assert.equal(records.length, 2); assert.equal(app.detail.results[1].url, s.u[1]);
  const changed = app.recheckSource(s, 1), c = pending.shift(); s.u[1] = 'https://example.net/new'; respond(c, 'https://example.org/live'); await changed; assert.equal(records.length, 2); assert.equal(app.detail.loading, false);
  const closing = app.recheckSource(s, 1), d = pending.shift(); app.closeDetail(); d.reject(new Error('secret')); await closing; assert.equal(records.length, 2);
  let copied = ''; sb.navigator.clipboard = { writeText: async x => { copied = x; } }; app.detail.results[0] = { code: 'HTTP', why: 'password' };
  assert.equal(await app.copyDiagnostic(s), true); assert(copied.includes('https://example.com/')); for (const x of ['user', 'pass', 'secret', 'token', 'abc', 'frag', 'password']) assert(!copied.includes(x), x);
  sb.navigator.clipboard.writeText = async () => { throw Error('denied'); }; assert.equal(await app.copyDiagnostic(s), false); assert(toasts.pop().includes('失败'));
  sb.document.execCommand = () => true; assert.equal(await app.copyDiagnostic(s), true); assert(toasts.pop().includes('已复制'));
  app.detail.stationKey = s.c + '|' + s.n; // 重新打开使用真实 key
  app.openDetail(s); const first = pending.shift(); respond(first, s.u[0]); await new Promise(setImmediate);
  assert.equal(app.detail.results[1].code, 'INVALID_URL');
  const many = { c: '多源', n: '多源', u: Array.from({length: 5}, (_, i) => 'https://s' + i + '.example/live'), dis: [] };
  app.state.stations.push(many); app.openDetail(many); const p1 = pending.shift(); respond(p1, many.u[0]); await new Promise(setImmediate);
  const p2 = pending.shift(); p2.reject(Error('offline')); await new Promise(setImmediate);
  assert.equal(app.detail.results[0].code, 'OK'); assert.equal(app.detail.results[4], undefined); assert(app.detail.error.includes('失败')); assert.equal(app.detail.loading, false);
  sb.QualityStore.stations = { [s.u[0]]: { sources: { [s.u[1]]: { lastOkAt: 10 } } } };
  assert.equal(app.successfulSource(s), 1); s.dis = [1]; assert.equal(app.successfulSource(s), undefined); s.dis = [];
  sb.QualityStore.summary = () => ({ okCount: 4, failCount: 0, stability: 'good', lastObservedAt: 1, avgLatencyMs: 10, disconnects: 0, metadata: 'none' });
  const quality = app.qualityHtml(s); assert(quality.includes('质量未知')); assert(quality.includes('累计成功率'));
  assert.equal(sb.diagnosticAction('NETWORK', 403).action, 'configure');
  // 真服务 + 本机上游：safeTarget 返回规范化 URL，UI 与质量样本回绑原始源键。
  const upstream = require('./harness/http-fixture').fixture({ '/': { headers: { 'Content-Type': 'audio/mpeg' }, body: 'x'.repeat(8000) } });
  let server;
  try {
    const port = await upstream.listen(); server = await require('./harness/api-client').boot({ env: { VR_TEST_GUARD: '1' } });
    const original = 'http://127.0.0.1:' + port, normalized = new URL(original).href;
    const safeTarget = require('../update-sources').safeTarget;
    assert.equal(safeTarget('HTTP://EXAMPLE.COM:80'), 'http://example.com/');
    const real = { c: '真实服务', n: '真实服务', u: [original], dis: [] };
    app.state.stations.push(real); sb.fetch = async p => { // 测试缝不归一，先模拟生产 safeTarget 的归一再进真服务
      const q = new URL(p, 'http://local'); const raw = q.searchParams.get('url'); q.searchParams.set('url', new URL(raw).href);
      const res = await server.req('GET', q.pathname + q.search); return { ok: res.status === 200, status: res.status, json: async () => JSON.parse(res.body) }; };
    app.detail.stationKey = real.c + '|' + real.n; els.detail.hidden = false;
    const before = records.length; await app.checkStationSources(real);
    assert.equal(app.detail.results[0].url, normalized); assert.equal(records[before][1].url, original); assert.equal(records[before][1].code, 'OK');
    await app.recheckSource(real, 0); assert.equal(records[before + 1][1].url, original);
  } finally { if (server) await server.close(); await upstream.close(); }
  console.log('诊断并发、脱敏与质量投影通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
