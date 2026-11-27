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
  respond(a, s.u[0]); await bulk; assert.equal(app.detail.loading, true); respond(b, s.u[1]); await single; assert.equal(app.detail.loading, false); assert.equal(records.length, 2); assert.equal(app.detail.results[1].url, s.u[1]);
  const changed = app.recheckSource(s, 1), c = pending.shift(); s.u[1] = 'https://example.net/new'; respond(c, 'https://example.org/live'); await changed; assert.equal(records.length, 2); assert.equal(app.detail.loading, true); // URL 已变：旧请求不得改当前状态
  const next = app.checkStationSources(s), c2 = pending.shift(); c2.resolve({ status: 400, json: async () => ({ detail: '仅允许公网 http(s) 地址' }) }); await next; assert.equal(app.detail.loading, false);
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
  const legacy = { c: '旧', n: '旧', u: ['HTTP://EXAMPLE.COM:80'], dis: [] };
  sb.QualityStore.stations = { [legacy.u[0]]: { sources: { 'http://example.com/': { lastOkAt: 20 } } } };
  assert.equal(app.successfulSource(legacy), 0);
  legacy.u.push('http://example.com/'); assert.equal(app.successfulSource(legacy), undefined); // 规范化键存在歧义，无法确定历史归属
  legacy.u[1] = 'http://EXAMPLE.com'; assert.equal(app.successfulSource(legacy), undefined);
  app.state.stations.push(legacy); app.detail.stationKey = legacy.c + '|' + legacy.n; els.detail.hidden = false;
  const before = records.length, collision = app.checkStationSources(legacy), request = pending.shift();
  respond(request, 'http://example.com/'); await collision;
  assert.equal(records.length, before + 1); assert.equal(records[before][1].url, legacy.u[0]);
  const canonical = { c: '碰撞', n: '碰撞', u: ['http://example.com/', 'HTTP://EXAMPLE.COM:80'], dis: [] };
  app.state.stations.push(canonical); app.detail.stationKey = canonical.c + '|' + canonical.n;
  const singleCollision = app.recheckSource(canonical, 0), req = pending.shift(); respond(req, canonical.u[0]); await singleCollision;
  assert.equal(records[records.length - 1][1].url, canonical.u[0]);
  sb.QualityStore.stations = { [canonical.u[0]]: { sources: { [canonical.u[0]]: { lastOkAt: 30 } } } };
  assert.equal(app.successfulSource(canonical), undefined); // 新记录与旧规范化键不可区分，保守不推荐
  const fact = { stationUrl: s.u[0], sourceUrl: 'https://user:pass@example.org/private?token=abc#frag', sourceIndex: 1, mode: 'direct', reason: 'watchdog', attempts: 2, at: 1700000000000 };
  const history = app.failureHtml(s, fact);
  assert(history.includes('历史播放失败（非当前状态、非诊断）')); assert(history.includes('发生于'));
  assert(history.includes(new Date(fact.at).toLocaleString())); assert(history.includes('断流自愈')); assert(history.includes('https://example.org/（路径已隐藏）'));
  for (const secret of ['user', 'pass', 'private', 'token', 'abc', 'frag']) assert(!history.includes(secret), secret);
  assert(app.failureHtml(s, Object.assign({}, fact, { sourceUrl: 'bad URL' })).includes('地址已隐藏'));
  assert.equal(app.failureHtml(canonical, fact), '');
  console.log('诊断并发、脱敏与质量投影通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
