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
const s = { c: '分类', n: '电台', u: ['https://user:pass@example.com/secret?token=abc#frag', 'https://example.org/live'], dis: [] };
app.state.stations = [s];
const respond = (req, url) => req.resolve({ json: async () => ({ results: [{ url, code: 'OK', ok: true, why: 'secret' }] }) });
(async () => {
  app.openDetail(s); const old = pending.shift(); app.closeDetail(); app.openDetail(s); const fresh = pending.shift();
  respond(old, s.u[0]); await Promise.resolve(); await Promise.resolve(); assert.equal(records.length, 0);
  respond(fresh, s.u[0]); await new Promise(setImmediate); assert.equal(records.length, 1);
  const bulk = app.checkStationSources(s), a = pending.shift(); const single = app.recheckSource(s, 1), b = pending.shift();
  respond(a, s.u[0]); respond(b, s.u[1]); await Promise.all([bulk, single]); assert.equal(records.length, 2); assert.equal(app.detail.results[1].url, s.u[1]);
  const changed = app.recheckSource(s, 1), c = pending.shift(); s.u[1] = 'https://example.net/new'; respond(c, 'https://example.org/live'); await changed; assert.equal(records.length, 2);
  const closing = app.recheckSource(s, 1), d = pending.shift(); app.closeDetail(); d.reject(new Error('secret')); await closing; assert.equal(records.length, 2);
  let copied = ''; sb.navigator.clipboard = { writeText: async x => { copied = x; } }; app.detail.results[0] = { code: 'HTTP', why: 'password' };
  assert.equal(await app.copyDiagnostic(s), true); assert(copied.includes('https://example.com/')); for (const x of ['user', 'pass', 'secret', 'token', 'abc', 'frag', 'password']) assert(!copied.includes(x), x);
  sb.navigator.clipboard.writeText = async () => { throw Error('denied'); }; assert.equal(await app.copyDiagnostic(s), false); assert(toasts.pop().includes('失败'));
  console.log('诊断并发与脱敏通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
