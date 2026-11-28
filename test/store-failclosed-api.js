'use strict';
// Store 首次读盘故障：独立临时应用根，绝不读取或操作宿主用户数据。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const { boot, makeRoot } = require('./harness/api-client');
const waitFile = async p => { for (let i = 0; i < 500; i++) { if (fs.existsSync(p)) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('超时等待注入标记: ' + p); };
async function queuedRace(mutant) {
  const root = makeRoot(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vradio-store-gate-'));
  let h;
  try {
    if (mutant) {
      const p = path.join(root, 'server.js'); let s = fs.readFileSync(p, 'utf8');
      const guard = "    if (!Object.keys(data).length && Object.keys(current.data).length) return done({ ok: false, status: 409, code: 'empty-overwrite', error: '拒绝以全空快照覆盖非空存储（合法删除请以空值表达：favs \"[]\"/cfg \"{}\"）' });";
      assert.ok(s.includes(guard)); s = s.replace(guard, '');
      const route = '        storeWrite(clean).then(r => json(r.status || (r.ok ? 200 : 500), r));';
      assert.ok(s.includes(route)); s = s.replace(route, "        if (!Object.keys(clean).length && Object.keys(storeRead().data).length) return json(409, { ok: false, code: 'empty-overwrite' });\n" + route);
      fs.writeFileSync(p, s);
    }
    h = await boot({ root, env: { NODE_OPTIONS: '--require="' + path.join(__dirname, 'harness', 'store-queue-inject.js').replace(/\\/g, '/') + '"', VR_TEST_STORE_QUEUE_DIR: dir } });
    const first = post(h, { 'radio.vol': '0.7' }); await waitFile(path.join(dir, 'held'));
    const second = post(h, {}); await waitFile(path.join(dir, 'second'));
    fs.writeFileSync(path.join(dir, 'release'), '1');
    const a = await first, b = await second;
    assert.strictEqual(a.status, 200);
    if (mutant) { assert.strictEqual(b.status, 200); assert.deepStrictEqual(parse(await get(h)).data, {}); }
    else { assert.strictEqual(b.status, 409); assert.strictEqual(parse(b).code, 'empty-overwrite'); assert.deepStrictEqual(parse(await get(h)).data, { 'radio.vol': '0.7' }); }
  } finally { if (h) await h.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
}
const post = (h, data) => h.req('POST', '/api/store', { 'Content-Type': 'application/json' }, JSON.stringify({ data }));
const get = h => h.req('GET', '/api/store');
const file = h => path.join(h.root, 'data', 'store.json');
const parse = r => JSON.parse(r.body);
function failed(r) { assert.strictEqual(r.status, 500); const j = parse(r); assert.strictEqual(j.ok, false); assert.strictEqual(j.code, 'store-read-failed'); assert.ok(!('data' in j)); }
async function main() {
  for (const raw of ['{broken', 'null', '[]', '{"rev":1,"data":null}', '{"rev":1,"data":[]}', '{"rev":"1","data":{}}', '{"rev":-1,"data":{}}', '{"rev":1.5,"data":{}}', '{"rev":9007199254740992,"data":{}}', '{"rev":1,"data":{"radio.vol":3}}', '{"rev":1,"data":{"radio.future":"x"}}']) {
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
  // 发号上限：GET 可读，POST 拒绝且原文件字节不变。
  const max = await boot();
  try {
    fs.mkdirSync(path.dirname(file(max)), { recursive: true });
    const raw = JSON.stringify({ rev: Number.MAX_SAFE_INTEGER, data: { 'radio.vol': '0.3' } }); fs.writeFileSync(file(max), raw);
    assert.strictEqual(parse(await get(max)).rev, Number.MAX_SAFE_INTEGER);
    const r = await post(max, { 'radio.vol': '0.4' }); assert.strictEqual(r.status, 500); assert.strictEqual(parse(r).code, 'store-rev-exhausted'); assert.strictEqual(fs.readFileSync(file(max), 'utf8'), raw);
  } finally { await max.close(); }
  // 悬空符号链接：只在系统允许创建时测试；不删除或触碰其目标。
  const link = await boot();
  try {
    fs.mkdirSync(path.dirname(file(link)), { recursive: true });
    let supported = true;
    try { fs.symlinkSync(path.join(link.root, 'missing-target'), file(link)); } catch (e) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) supported = false; else throw e; }
    if (supported) { failed(await get(link)); failed(await post(link, { 'radio.vol': '0.4' })); assert.ok(fs.lstatSync(file(link)).isSymbolicLink()); }
    else console.log('SKIP 悬空链接：系统禁止创建符号链接');
  } finally { await link.close(); }
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
  await queuedRace(false); await queuedRace(true); // 真修复阻止覆盖；旧队列外检查变体确定性重现覆盖
  console.log('PASS store-failclosed-api: 坏文件原字节保护、GET/POST 拒绝、修复重试与队列并发');
}
main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
