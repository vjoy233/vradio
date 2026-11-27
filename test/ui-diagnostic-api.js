// 真服务 URL 规范化结果回绑原始质量键（隔离服务与本机上游）。
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { fixture } = require('./harness/http-fixture'), { boot } = require('./harness/api-client');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), m = src.match(/\nApp\.boot\(\);\s*$/) || src.match(/\nif \(typeof document !== 'undefined'\) App\.boot\(\);[\s\S]*$/);
(async () => {
  const upstream = fixture({ '/': { headers: { 'Content-Type': 'audio/mpeg' }, body: 'x'.repeat(8000) } }); let server;
  try {
    const port = await upstream.listen(); server = await boot({ env: { VR_TEST_GUARD: '1' } });
    const original = 'http://127.0.0.1:' + port, normalized = new URL(original).href, records = [];
    assert.equal(require('../update-sources').safeTarget('HTTP://EXAMPLE.COM:80'), 'http://example.com/');
    const detail = { hidden: false }, sb = { URL, console, setTimeout, clearTimeout, location: { protocol: 'http:' },
      document: { getElementById: () => detail }, QualityStore: { recordDiagnostic: (...x) => records.push(x) },
      fetch: async p => { // 回环测试缝不归一，先模拟生产 safeTarget 再送真服务
        const q = new URL(p, 'http://local'); q.searchParams.set('url', new URL(q.searchParams.get('url')).href);
        const r = await server.req('GET', q.pathname + q.search); return { ok: r.status === 200, status: r.status, json: async () => JSON.parse(r.body) };
      } };
    vm.createContext(sb); vm.runInContext(src.slice(0, m.index) + '\nthis.App = App;', sb);
    const app = sb.App, s = { c: '真实服务', n: '真实服务', u: [original], dis: [] };
    app.renderDetail = () => {}; app.state.stations = [s]; app.detail.stationKey = s.c + '|' + s.n;
    await app.checkStationSources(s); assert.equal(app.detail.results[0].url, normalized); assert.equal(records[0][1].url, original); assert.equal(records[0][1].code, 'OK');
    await app.recheckSource(s, 0); assert.equal(records[1][1].url, original);
    console.log('真服务诊断原始身份回绑通过');
  } finally { if (server) await server.close(); await upstream.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
