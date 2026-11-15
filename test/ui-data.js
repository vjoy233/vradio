// 数据分区预览纯函数测试（ui-redesign P5，§5.5 + §9.1 B01 之 UI 侧）：uiCfgDiff 逐字段 增/删/改 计数
// （cats 集合差、空 incoming = 全清计数、键序无关、数组值整值比较）、uiBackupPreview 信息组装
// （v3/v1 版本行、my-radio 计数与 v1 说明、sidecar 可恢复性按形态分叉、file:// 不可用项清单）经 vm 沙箱
// 直测（剥尾部 boot 块，同 test/ui-maintenance.js 法）。真实网络事务不在此测——BackupV3.commitImport
// 的事务/回滚语义由 test/backup-v3.js 覆盖（B01 自证：本文件只测 UI 壳的纯逻辑，不重复造事务测试）。
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); }
};

const UP = path.join(__dirname, '..');
const { sandbox } = (() => {
  const src = fs.readFileSync(path.join(UP, 'app.js'), 'utf8');
  const m = src.match(/\nif \(typeof document !== 'undefined'\) App\.boot\(\);[\s\S]*$/);
  assert(m, 'app.js 尾部 boot 块可剥离（装载法依赖此前提）');
  const sandbox = { console, setTimeout, clearTimeout, SrcOrder: require('../srcorder') };
  vm.createContext(sandbox);
  vm.runInContext(src.slice(0, m.index) + `
this.uiCfgDiff = uiCfgDiff; this.uiBackupPreview = uiBackupPreview; this.UI_CFG_FIELDS = UI_CFG_FIELDS;`, sandbox);
  return { sandbox };
})();
const uiCfgDiff = sandbox.uiCfgDiff, uiBackupPreview = sandbox.uiBackupPreview, UI_CFG_FIELDS = sandbox.UI_CFG_FIELDS;
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

ok('v3 黄金样本 + http：13 键/个人电台 1 台/双 sidecar 计数，无不可用项', () => {
  const info = readInfo(FIX3, KEYS);
  const pv = uiBackupPreview(info, { http: true });
  assert.strictEqual(rowOf(pv, '备份版本').v, 'v3');
  assert.ok(rowOf(pv, 'Store 数据').v.includes('13'));
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

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
