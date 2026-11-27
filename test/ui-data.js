// 数据分区预览纯函数测试（ui-redesign P5，§5.5 + §9.1 B01 之 UI 侧）：uiCfgDiff 逐字段 增/删/改 计数
// （cats 集合差、空 incoming = 全清计数、键序无关、数组值整值比较）、uiBackupPreview 信息组装
// （v3/v1 版本行、my-radio 计数与 v1 说明、sidecar 可恢复性按形态分叉、file:// 不可用项清单）经 vm 沙箱
// 直测（剥尾部 boot 块，同 test/ui-maintenance.js 法）。真实网络事务不在此测——BackupV3.commitImport
// 的事务/回滚语义由 test/backup-v3.js 覆盖（B01 自证：本文件只测 UI 壳的纯逻辑，不重复造事务测试）。
// AIbot review 补：[3] cfgCount × uiCfgDiff 字段集合同口径（tag 计入，P2）；[4] afterRestore 恢复即时生效
// （对账 + 主列表重拉重并：备份个人台不需整页刷新即入列，P1；http 真链路 + file:// 协议门两形态）。
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');

let pass = 0, fail = 0;
const pending = []; // 异步用例（afterRestore 走微任务）：先收集、末尾按序逐个执行等齐（App 是单例，桩替换须串行不并发）
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); }
};
const okA = (name, fn) => pending.push(async () => {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); }
});

const UP = path.join(__dirname, '..');
const { sandbox } = (() => {
  const src = fs.readFileSync(path.join(UP, 'app.js'), 'utf8');
  const m = src.match(/\nif \(typeof document !== 'undefined'\) App\.boot\(\);[\s\S]*$/);
  assert(m, 'app.js 尾部 boot 块可剥离（装载法依赖此前提）');
  const sandbox = { console, setTimeout, clearTimeout, SrcOrder: require('../srcorder') };
  vm.createContext(sandbox);
  vm.runInContext(src.slice(0, m.index) + `
this.App = App;
this.uiCfgDiff = uiCfgDiff; this.uiBackupPreview = uiBackupPreview; this.UI_CFG_FIELDS = UI_CFG_FIELDS;`, sandbox);
  return { sandbox };
})();
const App = sandbox.App, uiCfgDiff = sandbox.uiCfgDiff, uiBackupPreview = sandbox.uiBackupPreview, UI_CFG_FIELDS = sandbox.UI_CFG_FIELDS;
const snap = o => JSON.parse(JSON.stringify(o)); // vm 跨 realm 原型不同：经 JSON 快照后再 deepStrictEqual

// 与 App.normCfg 产出同构的 cfg 形状（字段全集），便于构造「当前配置」
const mkCfg = o => Object.assign({ v: 2, moves: {}, names: {}, tag: {}, renames: {}, hideS: {}, hideC: {},
  srcs: {}, srcManualOrder: {}, srcDisabled: {}, srcLabels: {}, cats: [] }, o);

/* ============================================================ [1] uiCfgDiff（§5.5 差异预览的计数内核） */
console.log('[1] uiCfgDiff：逐字段 增/删/改、cats 集合差、数组值整值比较');
ok('增/删/改计数：新键 add、失键 del、值变 chg、同值不计', () => {
  const cur = mkCfg({ moves: { 'http://a/1': '新闻', 'http://b/1': '音乐' }, names: { 'http://a/1': '新名' }, srcs: { 'http://a/1': ['http://x/1'] } });
  const inc = mkCfg({ moves: { 'http://b/1': '音乐2', 'http://c/1': '戏曲' }, names: { 'http://a/1': '新名' }, srcs: { 'http://a/1': ['http://x/1', 'http://x/2'] } });
  const d = uiCfgDiff(cur, inc);
  assert.deepStrictEqual(snap(d.fields.moves), { add: 1, del: 1, chg: 1 });
  assert.deepStrictEqual(snap(d.fields.names), { add: 0, del: 0, chg: 0 });
  assert.deepStrictEqual(snap(d.fields.srcs), { add: 0, del: 0, chg: 1 }); // 数组值整值比较（元素顺序/条数有意义）
  assert.strictEqual(d.total, 4); // 3 moves + 1 srcs
});
ok('cats 数组按去重集合差（无「改」态；重复项不计）', () => {
  const d = uiCfgDiff(mkCfg({ cats: ['A', 'B'] }), mkCfg({ cats: ['B', 'C', 'C'] }));
  assert.deepStrictEqual(snap(d.fields.cats), { add: 1, del: 1, chg: 0 });
  assert.ok(UI_CFG_FIELDS.some(([k]) => k === 'cats')); // cats 在展示清单内（预览逐字段列出）
});
ok('空 incoming = 全清计数（重置/空配置导入的「将清空 N 项」依据）', () => {
  const cur = mkCfg({ moves: { a: 1, b: 2 }, names: { c: 'x' }, hideS: { d: 1 }, cats: ['自建1', '自建2'], srcLabels: { e: '标签' } });
  const d = uiCfgDiff(cur, mkCfg({}));
  for (const [k] of UI_CFG_FIELDS) {
    const f = d.fields[k];
    if (['moves', 'names', 'hideS', 'srcLabels'].includes(k)) assert.deepStrictEqual(snap(f), { add: 0, del: k === 'moves' ? 2 : 1, chg: 0 });
    else if (k === 'cats') assert.deepStrictEqual(snap(f), { add: 0, del: 2, chg: 0 });
    else assert.deepStrictEqual(snap(f), { add: 0, del: 0, chg: 0 });
  }
  assert.strictEqual(d.total, 7); // 2 moves + 1 names + 1 hideS + 2 cats + 1 srcLabels
});
ok('键序无关：同内容不同键插入序 → 零差异（计数可交换）', () => {
  const a = mkCfg({ moves: { 'http://a/1': 'x', 'http://b/1': 'y' }, cats: ['A', 'B'] });
  const b = mkCfg({ cats: ['A', 'B'] });
  b.moves = { 'http://b/1': 'y', 'http://a/1': 'x' }; // 同内容、不同插入序
  const d = uiCfgDiff(a, b);
  assert.strictEqual(d.total, 0);
});
ok('缺字段容错：cur 缺该 map 视为空（不抛）；纯函数不读全局状态', () => {
  const d = uiCfgDiff({}, mkCfg({ hideS: { 'http://a/1': 1 } }));
  assert.deepStrictEqual(snap(d.fields.hideS), { add: 1, del: 0, chg: 0 });
  assert.strictEqual(uiCfgDiff(null, null).total, 0);
});

/* ============================================================ [2] uiBackupPreview（§5.5/图10 信息组装） */
console.log('[2] uiBackupPreview：版本行/个人电台计数/sidecar 形态分叉/file:// 不可用项');
const FIX3 = JSON.parse(fs.readFileSync(path.join(UP, 'contracts', 'fixtures', 'backup-v3.json'), 'utf8'));
const readInfo = (text, keys) => require('../backup.js').read(typeof text === 'string' ? text : JSON.stringify(text), keys);
const KEYS = Object.keys(JSON.parse(fs.readFileSync(path.join(UP, 'contracts', 'radio-keys.json'), 'utf8')).keys);
const rowOf = (pv, k) => pv.rows.find(r => r.k === k);

ok('v3 黄金样本 + http：14 键/个人电台 1 台/双 sidecar 计数，无不可用项', () => {
  const info = readInfo(FIX3, KEYS);
  const pv = uiBackupPreview(info, { http: true });
  assert.strictEqual(rowOf(pv, '备份版本').v, 'v3');
  assert.ok(rowOf(pv, 'Store 数据').v.includes('14'));
  assert.ok(rowOf(pv, '个人电台').v.includes('1 台') && rowOf(pv, '个人电台').v.includes('#genre#') === false);
  assert.ok(rowOf(pv, '质量 sidecar').v.includes('1 台'));
  assert.ok(rowOf(pv, '收听统计 sidecar').v.includes('2 天'));
  assert.deepStrictEqual(snap(pv.unavailable), []); // vm 跨 realm：数组经快照再比
  assert.deepStrictEqual(snap(pv.side), { qN: 1, lN: 2, hasQuality: true, hasLs: true, qualityOk: true, lsOk: true, any: true });
});
ok('file:// 形态：个人电台与质量 sidecar 进不可用项、收听统计仍可恢复（与 commitImport io.http 分支同口径）', () => {
  const info = readInfo(FIX3, KEYS);
  const pv = uiBackupPreview(info, { http: false });
  assert.strictEqual(pv.unavailable.length, 2);
  assert.ok(pv.unavailable[0].includes('个人电台') && pv.unavailable[1].includes('质量'));
  assert.ok(rowOf(pv, '个人电台').v.includes('file://'));
  assert.ok(rowOf(pv, '质量 sidecar').v.includes('本形态跳过'));
  assert.strictEqual(pv.side.qualityOk, false);
  assert.strictEqual(pv.side.any, true); // 收听统计走本地快照仍可恢复 → 勾选框仍需出现
});
ok('v1 备份：my=null → 「保持不动」行 + v1 版本说明；无 sidecar → any=false 不出勾选', () => {
  const info = readInfo('{"v":1,"at":1,"data":{"radio.favs":"[]","radio.vol":"90"}}', KEYS);
  const pv = uiBackupPreview(info, { http: true });
  assert.ok(rowOf(pv, '备份版本').v.startsWith('v1'));
  assert.ok(rowOf(pv, '个人电台').v.includes('保持不动'));
  assert.ok(pv.notes.some(n => n.includes('v1')));
  assert.strictEqual(pv.side.any, false);
  assert.strictEqual(pv.rows.some(r => r.k.includes('sidecar')), false); // 无 sidecar 不出对应行
});
ok('纯函数不 mutation：info 原对象不被触碰（预览可重复组装）', () => {
  const info = readInfo(FIX3, KEYS);
  const before = snap(info);
  uiBackupPreview(info, { http: false });
  uiBackupPreview(info, { http: true });
  assert.deepStrictEqual(snap(info), before);
});
ok('仅质量 sidecar + file://：any=false（无可恢复项不出勾选框，UI 层转明示文案的依据）', () => {
  const j = JSON.parse(JSON.stringify(FIX3));
  delete j.myRadio; delete j.extensions.sidecars.listenStats;
  const info = readInfo(j, KEYS);
  const pv = uiBackupPreview(info, { http: false });
  assert.strictEqual(pv.side.hasQuality, true);
  assert.strictEqual(pv.side.any, false);
});

/* ============================================================ [3] cfgCount × uiCfgDiff 字段集合同口径（AIbot P2） */
console.log('[3] cfgCount × uiCfgDiff：tag 计入后 预览明细与「当前/清空 N 项」总数一致');
const cfgCount = c => App.cfgCount(c);
ok('tag-only：cfgCount 计 1 项、清空侧 uiCfgDiff 也计 1（不再「列了明细、总数 0 项」）', () => {
  const cur = App.normCfg({ tag: { 'http://a/1': '旧名' } });
  assert.strictEqual(cfgCount(cur), 1);
  assert.deepStrictEqual(snap(uiCfgDiff(cur, App.normCfg(null)).fields.tag), { add: 0, del: 1, chg: 0 });
  assert.strictEqual(uiCfgDiff(cur, App.normCfg(null)).total, 1);
});
ok('tag-only incoming（增侧）：cfgCount 与 uiCfgDiff.add 同口径', () => {
  const inc = App.normCfg({ tag: { 'http://a/1': '名' } });
  assert.strictEqual(cfgCount(inc), 1);
  assert.strictEqual(uiCfgDiff(App.normCfg(null), inc).total, 1);
  assert.strictEqual(uiCfgDiff(App.normCfg(null), inc).fields.tag.add, 1);
});
ok('全空 incoming（重置预览）：uiCfgDiff(cur, 空).total === cfgCount(cur)（11 字段合计含 tag）', () => {
  const cur = App.normCfg({ moves: { 'http://a/1': '新闻' }, names: { 'http://a/1': '新名' }, tag: { 'http://a/1': '原台' },
    hideS: { 'http://b/1': 1 }, renames: { 老: '新' }, hideC: { 老: 1 }, srcs: { 'http://a/1': ['http://x/1'] },
    srcManualOrder: { 'http://a/1': ['http://a/2'] }, srcDisabled: { 'http://a/1': ['http://a/2'] },
    srcLabels: { 'http://a/1': '标' }, cats: ['自建1', '自建2'] });
  assert.strictEqual(cfgCount(cur), 12); // 10 个 map 各 1 键 + 2 自建分类
  assert.strictEqual(uiCfgDiff(cur, App.normCfg(null)).total, cfgCount(cur));
});

/* ============================================================ [4] afterRestore 恢复即时生效（AIbot P1） */
console.log('[4] afterRestore：对账 + 主列表重拉重并，备份个人台不需整页刷新');
okA('调用序：applyServerStore 先、reloadMain 后（不触发播放路径，importAll r.ok 专用）', async () => {
  const seq = [], o1 = App.applyServerStore, o2 = App.reloadMain;
  App.applyServerStore = () => seq.push('store');
  App.reloadMain = async () => { seq.push('main'); return true; };
  try { await App.afterRestore(); } finally { App.applyServerStore = o1; App.reloadMain = o2; }
  assert.deepStrictEqual(seq, ['store', 'main']);
});
okA('http 形态真链路：恢复后 stations 即时含备份个人台 B、旧个人台 A 随全量替换消失（不需 reload）', async () => {
  sandbox.location = { protocol: 'http:' }; // vm 全局按需注入（reloadMain 只读 protocol）
  sandbox.fetch = u => Promise.resolve({ ok: true, text: () => Promise.resolve(u.startsWith('radio.txt')
    ? '华语音乐,#genre#\r\n主库台,http://m/1\r\n' : '个人,#genre#\r\n个人台B,http://b/1\r\n') }); // my-radio 已是 commitImport 落盘后的备份内容
  sandbox.Store = { get: () => null, set: () => {} }; // rebind → save* 三落的存储出口
  sandbox.QualityStore = {}; sandbox.Player = { station: null }; // qualityKeep / applySources 的全局引用
  const oState = App.state, oCfg = App.cfg, oF = App.favs, oR = App.recents, oH = App.healthMarks,
    oRender = App.render, oLast = App.showLast, oAss = App.applyServerStore;
  App.state = { stations: [{ c: '个人', n: '个人台A', u: ['http://a/1'] }] }; // 恢复前：列表只有旧个人台 A
  App.cfg = App.normCfg(null); App.favs = []; App.recents = []; App.healthMarks = {};
  App.render = () => {}; App.showLast = () => {}; App.applyServerStore = () => {}; // 对账路径由上例覆盖；DOM 出口全桩
  try {
    await App.afterRestore(); // == importAll r.ok 分支（恢复成功，无整页 reload）
    const names = App.state.stations.map(s => s.n);
    assert.ok(names.includes('个人台B'), '备份个人台 B 即时入列');
    assert.ok(names.includes('主库台'), '主库台随重拉在列');
    assert.ok(!names.includes('个人台A'), '旧个人台 A 被 my-radio 全量替换（URL=身份，A 不在新个人层）');
  } finally {
    App.state = oState; App.cfg = oCfg; App.favs = oF; App.recents = oR; App.healthMarks = oH;
    App.render = oRender; App.showLast = oLast; App.applyServerStore = oAss;
    delete sandbox.location; delete sandbox.fetch; delete sandbox.Store; delete sandbox.QualityStore; delete sandbox.Player;
  }
});
okA('file:// 形态：reloadMain 协议门恒 false——不发请求不抛（个人台不可恢复的既有降级，文案已明示）', async () => {
  sandbox.location = { protocol: 'file:' };
  sandbox.fetch = () => { throw new Error('file:// 不应发请求'); };
  const oAss = App.applyServerStore;
  App.applyServerStore = () => {};
  let done = false;
  try { await App.afterRestore(); done = true; } finally { App.applyServerStore = oAss; delete sandbox.location; delete sandbox.fetch; }
  assert.ok(done);
});

/* ============================================================ [5] reloadMain 个人层三态（AIbot PR#33 P1） */
console.log('[5] reloadMain 个人层三态：404=合法空 / 5xx·网络错=保留当前显示+toast / 恢复后兜底缓存');
// 节内共用环境：radio.txt 恒成功、my 桩由 myFn 每轮可变；toast 计数桩 + 全 DOM/存储出口桩（同 [4] 法）
const envIn = myFn => {
  const orig = { location: sandbox.location, fetch: sandbox.fetch, Store: sandbox.Store, QualityStore: sandbox.QualityStore, Player: sandbox.Player };
  const origApp = { state: App.state, cfg: App.cfg, favs: App.favs, recents: App.recents, healthMarks: App.healthMarks,
    render: App.render, showLast: App.showLast, applyServerStore: App.applyServerStore, toast: App.toast, _myKeep: App._myKeep };
  sandbox.location = { protocol: 'http:' };
  sandbox.fetch = u => u.startsWith('radio.txt') // 主库恒成功（本节只测 my 层分叉）
    ? Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('华语音乐,#genre#\r\n主库台,http://m/1\r\n') })
    : myFn();
  sandbox.Store = { get: () => null, set: () => {} }; // rebind → save* 三落的存储出口
  sandbox.QualityStore = {}; sandbox.Player = { station: null }; // qualityKeep / applySources 的全局引用
  App.state = { stations: [] }; App.cfg = App.normCfg(null); App.favs = []; App.recents = []; App.healthMarks = {};
  App.render = () => {}; App.showLast = () => {}; App.applyServerStore = () => {}; App._myKeep = undefined;
  const toasts = []; App.toast = m => toasts.push(m);
  const restore = () => {
    for (const k of Object.keys(orig)) { if (orig[k] === undefined) delete sandbox[k]; else sandbox[k] = orig[k]; }
    for (const k of Object.keys(origApp)) { if (origApp[k] === undefined) delete App[k]; else App[k] = origApp[k]; }
  };
  return { restore, toasts };
};
const MY_A = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('个人,#genre#\r\n个人台A,http://a/1\r\n') });
okA('my 层 500/网络错：既有个人台保留在列（不按空列表 replace）+ 每轮恰一条 toast', async () => {
  let myFn = MY_A;
  const { restore, toasts } = envIn(() => myFn());
  try {
    await App.reloadMain();
    assert.ok(App.state.stations.some(s => s.n === '个人台A'), '前置：成功轮个人台 A 入列');
    myFn = () => Promise.resolve({ ok: false, status: 500 });
    await App.reloadMain();
    assert.ok(App.state.stations.some(s => s.n === '个人台A'), '500 后 A 仍在列（保留当前显示，非静默清空）');
    assert.ok(App.state.stations.some(s => s.n === '主库台'), '主 radio.txt 成功部分照常应用');
    assert.strictEqual(toasts.length, 1, '单轮单条 toast');
    assert.ok(toasts[0].includes('个人电台列表刷新失败'), '文案如实点名');
    myFn = () => Promise.reject(new Error('net down'));
    await App.reloadMain();
    assert.ok(App.state.stations.some(s => s.n === '个人台A'), '网络错（reject）同口径：A 仍在列');
    assert.strictEqual(toasts.length, 2, '第二轮也只加一条（无风暴）');
  } finally { restore(); }
});
okA('my 层 404：合法空个人层正常应用（旧个人台消失、无失败 toast）', async () => {
  let mode = 'ok';
  const { restore, toasts } = envIn(() => mode === 'ok' ? MY_A() : Promise.resolve({ ok: false, status: 404 }));
  try {
    await App.reloadMain();
    assert.ok(App.state.stations.some(s => s.n === '个人台A'), '前置：A 入列');
    mode = '404';
    await App.reloadMain();
    assert.ok(!App.state.stations.some(s => s.n === '个人台A'), '404 = 合法空：个人层为空正常应用（语义不变）');
    assert.ok(App.state.stations.some(s => s.n === '主库台'));
    assert.strictEqual(toasts.length, 0, '404 不提示失败');
    assert.deepStrictEqual(snap(App._myKeep), [], '空列表也刷新缓存（空也是磁盘真态）');
  } finally { restore(); }
});
okA('恢复成功后 my 层瞬态失败：备份个人台仍即时入列（afterRestore 预写缓存兜底）', async () => {
  const { restore, toasts } = envIn(() => Promise.resolve({ ok: false, status: 500 })); // my 恒 500（commitImport 落盘后的瞬态读失败）
  try {
    App._myKeep = App.parse('个人,#genre#\r\n个人台A,http://a/1\r\n'); // 前置：恢复前的内存个人层（旧台 A）
    await App.afterRestore(['个人,#genre#', '个人台B,http://b/1']); // == importAll r.ok 分支（info.my = 备份行）
    const names = App.state.stations.map(s => s.n);
    assert.ok(names.includes('个人台B'), '刚恢复的备份个人台 B 即时入列（fetch 失败不丢）');
    assert.ok(!names.includes('个人台A'), 'my-radio 已被备份全量替换，旧台 A 不复活');
    assert.ok(names.includes('主库台'), '主列表照常重拉');
    assert.strictEqual(toasts.length, 1, '单轮单条 toast');
  } finally { restore(); }
});

(async () => { for (const t of pending) await t(); console.log(`\n${pass} 通过，${fail} 失败`); process.exit(fail ? 1 : 0); })();
