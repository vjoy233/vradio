// SSRF 回归：真实服务、真实回环监听；不启用任何 guard 放行测试缝。
const assert = require('assert'), http = require('http'), dns = require('dns');
const { safeTarget, guardLookup, tryUrl } = require('../update-sources');
const { boot } = require('./harness/api-client');

async function main() {
  const denied = ['::ffff:7f00:1', '0:0:0:0:0:ffff:127.0.0.1', '::ffff:a00:1', '::ffff:6440:1', '::ffff:a9fe:1', '::ffff:c0a8:1', '::ffff:ac10:1', '::ffff:0:1', '::1', '::', 'fc00::1', 'fdff::1', 'fe80::1', 'febf::1'];
  const allowed = ['::ffff:808:808', '::ffff:6440:0'.replace('6440', '643f'), '::ffff:ac20:1', '2001:4860:4860::8888', 'fec0::1'];
  for (const ip of denied) assert.strictEqual(safeTarget('http://[' + ip + ']/'), null, ip);
  for (const ip of allowed) assert.ok(safeTarget('http://[' + ip + ']/'), ip);
  for (const ip of ['100.64.0.1', '127.0.0.1', '10.0.0.1']) assert.strictEqual(safeTarget('http://' + ip), null, ip);
  // 模拟 DNS 的地址结果（不放行 guard），逐一核对连接级和字面量策略。
  const original = dns.lookup;
  try {
    for (const ip of denied.concat(allowed)) {
      dns.lookup = (host, opts, cb) => cb(null, ip, 6);
      const rejected = await new Promise(resolve => guardLookup('fixture.invalid', {}, e => resolve(!!e)));
      assert.strictEqual(rejected, denied.includes(ip), 'lookup ' + ip);
    }
  } finally { dns.lookup = original; }
  let hits = 0;
  const fixture = http.createServer((req, res) => { hits++; res.end('secret'); });
  await new Promise((resolve, reject) => fixture.listen(0, '127.0.0.1', resolve).on('error', reject));
  let app;
  try {
    app = await boot({ env: { VR_TEST_GUARD: '' } });
    const target = 'http://[::ffff:7f00:1]:' + fixture.address().port + '/';
    const response = await app.req('GET', '/proxy?url=' + encodeURIComponent(target));
    assert.strictEqual(response.status, 403);
    assert.strictEqual(hits, 0, '不得触及回环 fixture');
    assert.strictEqual(safeTarget(tryUrl(target, 'http://example.com/')), null, '重定向目标拒绝');
  } finally {
    if (app) await app.close();
    await new Promise(resolve => fixture.close(resolve));
  }
  console.log('ssrf-mapped: ok');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
