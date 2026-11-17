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
ok('v3 黄金样本：ver=3、myRadio→my、双 sidecar（quality+listenStats）判定与读回', () => {
  const r = B.read(FIX('backup-v3.json'), KEYS);
  assert.strictEqual(r.ver, 3);
  assert.strictEqual(r.app, 'web');
  assert.strictEqual(r.n, 13);
  assert.deepStrictEqual(r.my, ['自建,#genre#', '我的电台,https://example.test/live']);
  assert.ok(r.quality && r.quality.data['https://main.example/live']); // 质量 sidecar：嵌套聚合形态
  assert.strictEqual(r.quality.data['https://main.example/live'].cf, 2);
  assert.ok(r.ls && r.ls.data['2026-11-14']);                          // 收听统计 sidecar：日桶形态
  assert.strictEqual(r.ls.data['2026-11-14'].ms, 1800000);
  assert.strictEqual(r.ls.data['2026-11-14'].stations['https://main.example/live'], 1800000);
  assert.strictEqual(r.ls.data['2026-11-13'].sessions, 2);
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
ok('未知扩展字段忽略不失败（extensions.foo / sidecars.timewarp / 顶层杂字段；listenStats 裁空=无）', () => {
  const j = JSON.parse(FIX('backup-v3.json'));
  j.extensions = { foo: { bar: 1 }, sidecars: { timewarp: { v: 1, data: { x: 1 } }, listenStats: { v: 1, data: { 'bad-day': { ms: 5 } } } } };
  j.futureField = { anything: true };
  const r = B.read(JSON.stringify(j), KEYS);
  assert.strictEqual(r.ver, 3); assert.strictEqual(r.quality, null);
  assert.strictEqual(r.ls, null); // 坏日键全裁 → 空 days 视为无 sidecar（「含 0 天」无确认意义）
});
ok('lsTrim：坏日期键丢弃、台/分类键校验、数值归一、空日丢弃', () => {
  const days = {};
  days['2026-02-30'] = { ms: 999 };                      // 非历法日：丢弃
  days['2026-02-29'] = { ms: 999 };                      // 2026 非闰年：丢弃
  days['2024-02-29'] = { ms: 888 };                      // 闰年：保留
  days['2026-01-01'] = { ms: -5, sessions: 0, stations: {}, categories: {} }; // 全空 → 丢弃
  days['2026-01-02'] = { ms: '3600', sessions: 2.9, stations: { 'ftp://x': 5, 'https://a/live': '7000.9', 'https://b/live': -1 }, categories: { ['长'.repeat(25)]: 1, '华语音乐': 3 } };
  const t = B.lsTrim(days);
  assert.ok(!('2026-02-30' in t) && !('2026-02-29' in t) && t['2024-02-29'].ms === 888);
  assert.ok(!('2026-01-01' in t));
  assert.deepStrictEqual(t['2026-01-02'], { ms: 3600, sessions: 2, stations: { 'https://a/live': 7000 }, categories: { '华语音乐': 3 } }); // 非法键/负值剔除、字符串数字收敛、超长分类（>24）剔除
});
ok('lsTrim：日 90 封顶（保留最新 90 日）+ 每日台/分类 64 条封顶', () => {
  const days = {};
  for (let i = 1; i <= 120; i++) days['2025-' + String(Math.floor((i - 1) / 30) + 1).padStart(2, '0') + '-' + String((i - 1) % 30 + 1).padStart(2, '0')] = { ms: 1, sessions: 1 };
  days['2025-05-01'] = { ms: 1 };                          // 121→122 键补位（05-01 已在循环内，覆盖为无映射形态）
  const t = B.lsTrim(days);
  assert.strictEqual(Object.keys(t).length, 90);
  assert.ok(!('2025-01-01' in t) && '2025-05-01' in t);    // 最旧被裁、最新保留
  const big = {};
  for (let i = 0; i < 80; i++) big['https://s' + i + '.example/live'] = 100;
  const t2 = B.lsTrim({ '2026-01-01': { ms: 1, sessions: 1, stations: big, categories: big } });
  assert.strictEqual(Object.keys(t2['2026-01-01'].stations).length, 64); // 每日台封顶
  assert.strictEqual(Object.keys(t2['2026-01-01'].categories).length, 64);
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
  storeApply: () => {}, storeFlush: async () => true,   // 可等待可判定成功（AIbot 三轮 P1-1 契约）
  getMy: async () => '我的,#genre#\r\n台C,http://c/1',
  postMy: async () => true,
  getQuality: async () => oldQ,
  postQuality: async () => true,
  refreshQuality: () => {},
  getListenStats: async () => null,                       // B4：默认惰性（info.ls 缺省不触发；LS 用例各自覆写）
  postListenStats: async () => true,
  refreshListenStats: () => {},
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
ok('commitImport storeFlush 拒绝（AIbot 三轮 P1-1）：三件回滚 + my/quality 未动，不再无声跨层半导入', async () => {
  const applied = [], myPosts = [], qPosts = [];
  const r = await B.commitImport(impInfo(), true, ioFake({
    storeApply: d => applied.push(d['radio.vol']),
    storeFlush: async () => false,                       // Store 落盘失败（真实现 = flush 后 dirty 仍 true）
    postMy: async l => { myPosts.push(l); return true; },
    postQuality: async d => { qPosts.push(d); return true; },
  }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.msg.includes('主数据写入失败') && r.msg.includes('已回滚到导入前状态'));
  assert.deepStrictEqual(applied, ['30', '90']);        // 应用导入 data 失败 → 回滚恢复快照
  assert.strictEqual(myPosts.length, 1);                 // 回滚把旧 my 行原样写回（已捕获的快照）
  assert.deepStrictEqual(myPosts[0].join('|'), '我的,#genre#|台C,http://c/1');
  assert.deepStrictEqual(qPosts, []);                    // quality 从未提交（qTried=false），无需回写
});
ok('commitImport 回滚 storeFlush 也失败：文案如实点名「仅写入本地镜像」', async () => {
  let n = 0;
  const r = await B.commitImport(impInfo(), true, ioFake({
    storeFlush: async () => ++n > 1,                     // 首次（提交）失败、第二次（回滚）成功
  }));
  assert.strictEqual(r.ok, false); assert.ok(!r.msg.includes('仅写入本地镜像'));
  n = 0;
  const r2 = await B.commitImport(impInfo(), true, ioFake({
    storeFlush: async () => false,                       // 提交与回滚都失败
  }));
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.msg.includes('主数据写入失败') && r2.msg.includes('主数据回滚仅写入本地镜像（服务端可能仍为导入状态，下次启动自动重推）'));
});
ok('readBackup 超大输入（>2M 字符）→ 直接 null（AIbot 三轮 P2-2 兜底）', async () => {
  const huge = '{"v":3,"data":{"radio.vol":"1"}}' + ' '.repeat(2 * 1024 * 1024);
  assert.strictEqual(B.read(huge, null), null);
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

// —— B4 收听统计 sidecar：四件事务（Store → my → quality → listenStats）——
const oldLs = { '2026-10-01': { ms: 60000, sessions: 1, stations: { 'https://old.example/live': 60000 }, categories: {} } };
const impInfoLs = () => Object.assign(impInfo(), {
  ls: { v: 1, data: { '2026-11-14': { ms: 1800000, sessions: 1, stations: { 'https://new.example/live': 1800000 }, categories: { '华语音乐': 1800000 } } } },
});
ok('commitImport 双 sidecar 成功：Store→my→quality→listenStats 顺序 + 双缓存刷新 + 文案点名天数', async () => {
  const seq = [];
  const r = await B.commitImport(impInfoLs(), true, ioFake({
    storeApply: d => seq.push('store:' + d['radio.vol']),
    postMy: async l => { seq.push('my:' + l.length); return true; },
    postQuality: async d => { seq.push('q:' + Object.keys(d).length); return true; },
    postListenStats: async d => { seq.push('ls:' + Object.keys(d).length); return true; },
    refreshQuality: () => seq.push('rq'),
    refreshListenStats: () => seq.push('rls'),
    getListenStats: async () => oldLs,
  }));
  assert.strictEqual(r.ok, true);
  assert.ok(r.msg.includes('含质量 sidecar') && r.msg.includes('含收听统计 1 天'));
  assert.deepStrictEqual(seq, ['store:30', 'my:2', 'q:1', 'rq', 'ls:1', 'rls']);
});
ok('commitImport 无收听统计快照不提交：getListenStats 失败 → 零写入（含 quality 也未动）', async () => {
  const applied = [], qPosts = [];
  const r = await B.commitImport(impInfoLs(), true, ioFake({
    storeApply: d => applied.push(d),
    postQuality: async d => { qPosts.push(d); return true; },
    getListenStats: async () => null,
  }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.msg.includes('无法读取当前收听统计'));
  assert.deepStrictEqual(applied, []);                 // 无快照不提交纪律对第四件同样成立
  assert.deepStrictEqual(qPosts, []);
});
ok('commitImport listenStats 提交失败：四件回滚 + 旧统计快照回写，文案如实点名', async () => {
  const lsPosts = [];
  const r = await B.commitImport(impInfoLs(), true, ioFake({
    getListenStats: async () => oldLs,
    postListenStats: async d => { lsPosts.push(d); return lsPosts.length > 1; }, // 导入数据写成功响应丢；旧快照回写成功
  }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.msg.includes('收听统计 sidecar 恢复失败') && r.msg.includes('已回滚到导入前状态'));
  assert.strictEqual(lsPosts.length, 2);
  assert.deepStrictEqual(lsPosts[0], impInfoLs().ls.data); // 第一次提交导入数据
  assert.deepStrictEqual(lsPosts[1], oldLs);               // 回滚回写旧快照
  const r2 = await B.commitImport(impInfoLs(), true, ioFake({
    getListenStats: async () => oldLs,
    postListenStats: async () => false,                    // 回写也失败
  }));
  assert.ok(r2.msg.includes('收听统计可能停留在导入状态，可重试导入'));
});
ok('commitImport sc=false：备份含双 sidecar 但未确认恢复 → 两者零触碰', async () => {
  const calls = [];
  const r = await B.commitImport(impInfoLs(), false, ioFake({
    getQuality: async () => { calls.push('gq'); return oldQ; },
    postQuality: async () => { calls.push('pq'); return true; },
    getListenStats: async () => { calls.push('gls'); return oldLs; },
    postListenStats: async () => { calls.push('pls'); return true; },
  }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls, []);                   // 未选恢复 = 本机 sidecar 保持不变（schema importRules）
  assert.ok(!r.msg.includes('sidecar') && !r.msg.includes('收听统计'));
});
ok('commitImport file:// 收听统计：走本地快照通道（get/post/refresh 全到、my/quality 零网络）', async () => {
  const seq = [];
  const r = await B.commitImport(impInfoLs(), true, ioFake({
    http: false,
    getListenStats: async () => { seq.push('gls'); return {}; },
    postListenStats: async d => { seq.push('pls:' + Object.keys(d).length); return true; },
    refreshListenStats: () => seq.push('rls'),
  }));
  assert.strictEqual(r.ok, true);
  assert.ok(r.msg.includes('含收听统计 1 天') && r.msg.includes('file:// 形态无法恢复个人电台列表'));
  assert.deepStrictEqual(seq, ['gls', 'pls:1', 'rls']); // LS 双形态：file:// 经 localStorage 注入（生产 io）
});

// —— 空 data 备份 × 空覆盖门兼容（review#43 P1-2）：commitImport 全量 storeApply(info.data)（缺键删），
//    data={} 是合法备份形态（全删后导出的极端备份）。服务端 /api/store 对「非空库上的空快照」回 409
//    empty-overwrite → storeFlush false → 必须走四件回滚（rollback 恢复旧快照非空，二次 flush 不会
//    再撞 409——自愈闭环）；data 空库则放行成功。产品语义：空备份恢复到非空库 = 被拒并如实回滚提示，
//    不会永久 dirty 卡死。
ok('commitImport 空 data 备份：storeFlush true（服务端 data 空放行/幂等空写）→ 成功路径', async () => {
  const applied = [];
  const info = Object.assign(impInfo(), { data: {} });
  const r = await B.commitImport(info, true, ioFake({
    storeApply: d => applied.push(Object.keys(d).length),
    storeFlush: async () => true,
  }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(applied, [0], 'storeApply({}) = 全键删除应用（合法空备份）');
  assert.ok(r.msg.includes('已恢复完整备份'));
});
ok('commitImport 空 data 备份恢复到非空库：flush 409 false → 回滚 + 文案如实（rollback 恢复非空快照不再撞 409）', async () => {
  const applied = [];
  const info = Object.assign(impInfo(), { data: {} });
  const r = await B.commitImport(info, true, ioFake({
    storeApply: d => applied.push(Object.keys(d).length),
    storeSnap: () => ({ 'radio.vol': '90', 'radio.favs': '["x"]' }), // 导入前库非空
    storeFlush: async () => false, // 服务端 409 empty-overwrite（非空库拒空快照）
  }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.msg.includes('已回滚到导入前状态'), '空备份×非空库必须被拒且如实回滚（不伪装成功）');
  assert.deepStrictEqual(applied, [0, 2], '失败后 storeApply(snap) 恢复非空快照（二次 flush 不会 409，自愈闭环）');
});

Promise.all(pend).then(() => {
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
});
