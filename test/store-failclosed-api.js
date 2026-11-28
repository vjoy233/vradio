'use strict';
// Store 首次读盘故障：独立临时应用根，绝不读取或操作宿主用户数据。
const assert = require('assert'), fs = require('fs'), path = require('path');
const { boot } = require('./harness/api-client');
const post = (h, data) => h.req('POST', '/api/store', { 'Content-Type': 'application/json' }, JSON.stringify({ data }));
const get = h => h.req('GET', '/api/store');
const file = h => path.join(h.root, 'data', 'store.json');
const parse = r => JSON.parse(r.body);
function failed(r) { assert.strictEqual(r.status, 500); const j = parse(r); assert.strictEqual(j.ok, false); assert.strictEqual(j.code, 'store-read-failed'); assert.ok(!('data' in j)); }
async function main() {
  for (const raw of ['{broken', 'null', '[]', '{"rev":1,"data":null}', '{"rev":1,"data":[]}', '{"rev":"1","data":{}}']) {
    const h = await boot();
    try {
      fs.mkdirSync(path.dirname(file(h)), { recursive: true }); fs.writeFileSync(file(h), raw);
      failed(await post(h, { 'radio.vol': '0.4' })); failed(await get(h)); failed(await post(h, {}));
      assert.strictEqual(fs.readFileSync(file(h), 'utf8'), raw);
      const restored = '{"rev":7,"data":{"radio.vol":"0.8"}}'; fs.writeFileSync(file(h), restored);
      assert.deepStrictEqual(parse(await get(h)), JSON.parse(restored));
      const r = await post(h, { 'radio.vol': '0.5' }); assert.strictEqual(r.status, 200); assert.strictEqual(parse(r).rev, 8);
    } finally { await h.close(); }
  }
  // 并发到达顺序不保证：空写先入队则两次成功，非空先入队则空写必须 409；终态均非空。
  const h = await boot();
  try {
    const [a, b] = await Promise.all([post(h, { 'radio.vol': '0.7' }), post(h, {})]);
    assert.strictEqual(a.status, 200);
    const rev = parse(a).rev;
    if (rev === 1) { assert.strictEqual(b.status, 409); assert.strictEqual(parse(b).code, 'empty-overwrite'); }
    else { assert.strictEqual(rev, 2); assert.strictEqual(b.status, 200); assert.strictEqual(parse(b).rev, 1); }
    assert.deepStrictEqual(parse(await get(h)), { rev, data: { 'radio.vol': '0.7' } });
    // 明确确保非空先写，再验证空快照被拒且未改变落盘字节。
    const before = fs.readFileSync(file(h));
    const c = await post(h, {}); assert.strictEqual(c.status, 409); assert.strictEqual(parse(c).code, 'empty-overwrite');
    assert.deepStrictEqual(fs.readFileSync(file(h)), before);
  } finally { await h.close(); }
  console.log('PASS store-failclosed-api: 坏文件原字节保护、GET/POST 拒绝、修复重试与队列并发');
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
