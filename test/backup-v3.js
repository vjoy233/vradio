// 备份 v3 纯逻辑测试（B4，plan-expansion-r4 §8.3/§8.4）：导出形状对照 contracts/backup-v3.schema.json、
// v1/v2/v3 三版本读取（键白名单取 contracts/radio-keys.json——契约单一来源）、未知扩展忽略、坏 JSON 回退、
// 质量聚合迁移字段裁剪、commitImport 提交段（AIbot review P1-2：三步覆盖 + 失败回滚——「replace 写成功
// 响应丢」经 io 注入 fake 复现，断言旧质量快照回写与文案如实）。Web↔Android 一致性：Android BackupV3Test.kt
// 消费同一批 fixtures 断言同款期望。
const assert = require('assert'), fs = require('fs'), path = require('path');
const B = require('../backup.js');

const ROOT = path.join(__dirname, '..');
const FIX = p => fs.readFileSync(path.join(ROOT, 'contracts', 'fixtures', p), 'utf8');
const KEYS = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'radio-keys.json'), 'utf8')).keys);
let pass = 0, fail = 0, pend = [];
const ok = (name, fn) => pend.push(Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); }));

ok('build：v3 导出形状对照 schema shape 五字段', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'backup-v3.schema.json'), 'utf8'));
  const o = B.build({ at: 1731500000000, app: 'web', data: { 'radio.vol': '90' }, myRadio: ['自建,#genre#'], extensions: {} });
  assert.deepStrictEqual(Object.keys(o).sort(), Object.keys(schema.shape).sort()); // 形状键集一致
  assert.strictEqual(o.format, 'vradio-backup');
  assert.strictEqual(o.version, 3);
  assert.strictEqual(o.createdAt, 1731500000000);
  assert.strictEqual(o.app, 'web');
  assert.deepStrictEqual(o.myRadio, ['自建,#genre#']);
  assert.deepStrictEqual(o.extensions, {});
  assert.strictEqual(typeof o.data['radio.vol'], 'string'); // data 值一律字符串
});
ok('v3 黄金样本：ver=3、myRadio→my、extensions 空则无 sidecar', () => {
  const r = B.read(FIX('backup-v3.json'), KEYS);
  assert.strictEqual(r.ver, 3);
  assert.strictEqual(r.app, 'web');
  assert.strictEqual(r.n, 13);
  assert.deepStrictEqual(r.my, ['自建,#genre#', '我的电台,https://example.test/live']);
  assert.strictEqual(r.quality, null);
});
ok('v2 黄金样本：ver=2、读 my 数组、键全在白名单', () => {
  const r = B.read(FIX('backup-v2.json'), KEYS);
  assert.strictEqual(r.ver, 2);
  assert.strictEqual(r.n, 13);
  assert.deepStrictEqual(r.my, ['自建,#genre#', '我的电台,https://example.test/live']);
  for (const k of Object.keys(r.data)) assert.ok(KEYS.includes(k), `非白名单键 ${k}`);
});
ok('v1 兼容：无 my 字段 → my=null（不动 my-radio.txt）', () => {
  const r = B.read('{"v":1,"at":1,"data":{"radio.favs":"[]","radio.vol":"90"}}', KEYS);
  assert.strictEqual(r.ver, 1);
  assert.strictEqual(r.my, null);
  assert.strictEqual(r.data['radio.vol'], '90');
});
ok('v3 含质量 sidecar：判定 + 迁移字段裁剪（嵌套形态、未知字段剔除、数值归一）', () => {
  const j = JSON.parse(FIX('backup-v3.json'));
  j.extensions = { sidecars: { quality: { v: 1, data: {
    'https://main.example/live': { cf: 1, sources: { 'https://main.example/live': { okCount: 5, failCount: 1, lastOkAt: 99, modes: ['direct', 'proxy', 'bogus'], rawResponse: 'SECRET', dns: '1.2.3.4' } } },
    'ftp://bad.example/x': { cf: 0, sources: {} },
  } } } };
  const r = B.read(JSON.stringify(j), KEYS);
  const q = r.quality.data['https://main.example/live'].sources['https://main.example/live'];
  assert.strictEqual(q.okCount, 5);
  assert.deepStrictEqual(q.modes, ['direct', 'proxy']); // modes 只收合法枚举、去重
  assert.ok(!('rawResponse' in q) && !('dns' in q)); // 响应正文/DNS 类字段绝不迁移
  assert.ok(!('ftp://bad.example/x' in r.quality.data)); // 非 http(s) 键丢弃
});
ok('未知扩展字段忽略不失败（extensions.foo / sidecars.listenStats / 顶层杂字段）', () => {
  const j = JSON.parse(FIX('backup-v3.json'));
  j.extensions = { foo: { bar: 1 }, sidecars: { listenStats: { v: 1, data: { x: 1 } } } };
  j.futureField = { anything: true };
  const r = B.read(JSON.stringify(j), KEYS);
  assert.strictEqual(r.ver, 3); assert.strictEqual(r.quality, null); // listenStats（B3 未落地）忽略
});
ok('键白名单过滤：白名单外键/非字符串值丢弃；无有效键 → n=0（调用方提示）', () => {
  const r = B.read('{"v":3,"version":3,"data":{"radio.vol":"90","radio.junk":"x","my":"nope","radio.favs":123}}', KEYS);
  assert.deepStrictEqual(Object.keys(r.data), ['radio.vol']);
  assert.strictEqual(B.read('{"version":3,"data":{"radio.junk":"x"}}', KEYS).n, 0);
});
ok('坏 JSON / 非 vradio 备份 → null', () => {
  assert.strictEqual(B.read('不是json', KEYS), null);
  assert.strictEqual(B.read('[1,2]', KEYS), null);
  assert.strictEqual(B.read('{"version":3}', KEYS), null); // 无 data
  assert.strictEqual(B.read('{"data":"str"}', KEYS), null);
});
ok('qualityTrim：条目 2000 封顶、负数丢弃、字符串数字收敛、空条目丢弃（嵌套形态）', () => {
  const data = {};
  for (let i = 0; i < 2100; i++) data['https://a.example/' + i] = { cf: 1, sources: {} }; // cf>0 空源也保留
  assert.strictEqual(Object.keys(B.qualityTrim(data)).length, 2000);
  const t = B.qualityTrim({
    'https://a.example/1': { cf: -2, sources: { 'https://src.example/s': { okCount: -3, failCount: '12', lastOkAt: 1.9 } } }, // cf 负归 0；-3 丢、'12'→12、1.9→1
    'https://a.example/2': { cf: 0, sources: { 'https://src.example/s': { unknown: 9 } } }, // 源裁空 + cf=0 → 整条丢弃
  });
  assert.deepStrictEqual(t['https://a.example/1'], { cf: 0, sources: { 'https://src.example/s': { failCount: 12, lastOkAt: 1 } } });
  assert.ok(!('https://a.example/2' in t));
});
ok('v2 my 缺字段按不动处理（空数组才是恢复为空）', () => {
  assert.strictEqual(B.read('{"v":2,"data":{"radio.vol":"90"}}', KEYS).my, null);
  assert.deepStrictEqual(B.read('{"v":2,"data":{"radio.vol":"90"},"my":[]}', KEYS).my, []);
});

// —— commitImport 提交段（AIbot review P1-2 抽离可测）：三步覆盖 + 失败回滚（含质量旧快照回写）。
//    io 注入 fake 复现「replace 写成功响应丢」等失败路径——DOM/网络真实现留在 app.js，此处零依赖 ——
const oldQ = { 'https://old.example/live': { cf: 0, sources: { 'https://old.example/live': { okCount: 3, failCount: 1, lastOkAt: 77 } } } };
const impInfo = () => ({ ver: 3, app: 'web', data: { 'radio.vol': '30' }, my: ['我的,#genre#', '台X,http://x/1'],
  quality: { v: 1, data: { 'https://new.example/live': { cf: 0, sources: { 'https://new.example/live': { okCount: 9 } } } } }, n: 1 });
const ioFake = over => Object.assign({
  http: true,
  storeSnap: () => ({ 'radio.vol': '90' }),
  storeApply: () => {}, storeFlush: () => {},
  getMy: async () => '我的,#genre#\r\n台C,http://c/1',
  postMy: async () => true,
  getQuality: async () => oldQ,
  postQuality: async () => true,
  refreshQuality: () => {},
}, over);
ok('commitImport 成功路径：Store→my→quality 顺序提交 + 缓存刷新 + 成功文案', async () => {
  const seq = [];
  const r = await B.commitImport(impInfo(), true, ioFake({
    storeApply: d => seq.push('store:' + d['radio.vol']),
    postMy: async lines => { seq.push('my:' + lines.length); return true; },
    postQuality: async d => { seq.push('q:' + Object.keys(d).length); return true; },
    refreshQuality: () => seq.push('refresh'),
  }));
  assert.strictEqual(r.ok, true);
  assert.ok(r.msg.includes('已恢复完整备份') && r.msg.includes('含质量 sidecar'));
  assert.deepStrictEqual(seq, ['store:30', 'my:2', 'q:1', 'refresh']);
});
ok('commitImport「replace 写成功响应丢」：回滚 Store/my 并回写旧质量快照，文案如实不夸大', async () => {
  const applied = [], qPosts = [];
  const r = await B.commitImport(impInfo(), true, ioFake({
    storeApply: d => applied.push(d['radio.vol']),
    postQuality: async d => { qPosts.push(d); return qPosts.length > 1; }, // 第一次（导入数据）写成功但响应丢；第二次（旧快照回写）成功
  }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.msg.includes('已回滚到导入前状态') && !r.msg.includes('可能停留')); // 回写成功 → 不点名风险
  assert.deepStrictEqual(applied, ['30', '90']);       // 先应用导入 data，失败后恢复快照
  assert.strictEqual(qPosts.length, 2);
  assert.deepStrictEqual(qPosts[0], impInfo().quality.data); // 第一次提交的是导入数据
  assert.deepStrictEqual(qPosts[1], oldQ);            // 回滚回写的是旧快照（服务端已写导入态时的唯一兜底）
});
ok('commitImport 回写也失败：文案点名「质量数据可能停留在导入状态」', async () => {
  const r = await B.commitImport(impInfo(), true, ioFake({ postQuality: async () => false }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.msg.includes('已回滚到导入前状态'));
  assert.ok(r.msg.includes('质量数据可能停留在导入状态，可重试导入'));
});
ok('commitImport 无快照不提交：GET 旧质量失败 → 零写入', async () => {
  const applied = [];
  const r = await B.commitImport(impInfo(), true, ioFake({ storeApply: d => applied.push(d), getQuality: async () => null }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.msg.includes('无法读取当前质量数据'));
  assert.deepStrictEqual(applied, []);                 // Store 一件都没动（无快照不提交纪律）
});
ok('commitImport my 失败：回滚 Store/my，sidecar 未提交（无 quality 回写）', async () => {
  const qPosts = [];
  const r = await B.commitImport(impInfo(), true, ioFake({
    postMy: async () => false,
    postQuality: async d => { qPosts.push(d); return true; },
  }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.msg.includes('个人电台恢复失败') && r.msg.includes('已回滚到导入前状态'));
  assert.deepStrictEqual(qPosts, []);                  // 失败发生在质量提交前：sidecar 未动，无需回写
});
ok('commitImport file://（http=false）：零网络调用，文案注明个人列表不恢复', async () => {
  const calls = [];
  const r = await B.commitImport(impInfo(), false, ioFake({
    http: false,
    getMy: async () => { calls.push('getMy'); return 'x'; },
    postMy: async () => { calls.push('postMy'); return true; },
    getQuality: async () => { calls.push('getQ'); return oldQ; },
    postQuality: async () => { calls.push('postQ'); return true; },
  }));
  assert.strictEqual(r.ok, true);
  assert.ok(r.msg.includes('file:// 形态无法恢复个人电台列表'));
  assert.deepStrictEqual(calls, []);                   // file:// 无后端通道：my/质量零触碰
});

Promise.all(pend).then(() => {
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
});
