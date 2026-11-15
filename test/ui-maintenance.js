// 维护重做测试（ui-redesign P4，§5/§6.4/§6.8/§6.9 + §9.1 M01–M04）：草稿引擎纯函数
// （uiReadCell/uiSameCell 的「删除属性 vs 空字符串」区分、uiApplyCells force 双模式、uiNewDraft 深拷贝）、
// uiResolveUnique 唯一回绑、校验规则（与旧 askName 语义等价但不静默裁切）、三份 buildNext（M01 只合并
// 本对象）与 uiCreateEditor 状态机（M01/M02 三选分支/M03 撤销盲撤拒绝/M04 失败留编辑）经 vm 沙箱直测
// （剥尾部 boot 块，同 test/source-lifecycle.js 法）。零依赖离线，npm test 随跑。
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');

let pass = 0, fail = 0;
const pending = []; // 异步用例（引擎 save/depart 走微任务）：先收集 promise，末尾统一等齐再汇总
const ok = (name, fn) => {
  try { const r = fn(); if (r && typeof r.then === 'function') throw new Error('异步用例请用 okA'); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); }
};
const okA = (name, fn) => pending.push((async () => {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); }
})());

const UP = path.join(__dirname, '..');
const { sandbox } = (() => {
  const src = fs.readFileSync(path.join(UP, 'app.js'), 'utf8');
  const m = src.match(/\nApp\.boot\(\);\s*$/) || src.match(/\nif \(typeof document !== 'undefined'\) App\.boot\(\);[\s\S]*$/);
  assert(m, 'app.js 尾部 boot 块可剥离（装载法依赖此前提）');
  const SrcOrder = require('../srcorder');
  const sandbox = { console, setTimeout, clearTimeout, SrcOrder, CSS: { escape: s => '"' + String(s).replace(/"/g, '\\"') + '"' } };
  vm.createContext(sandbox);
  vm.runInContext(src.slice(0, m.index) + `
this.App = App; this.keyOf = keyOf; this.SRC_CAP = SRC_CAP;
this.uiClone = uiClone; this.uiReadCell = uiReadCell; this.uiSameCell = uiSameCell; this.uiApplyCells = uiApplyCells;
this.uiNewDraft = uiNewDraft; this.uiSameProj = uiSameProj; this.uiResolveUnique = uiResolveUnique;
this.uiValidName = uiValidName; this.uiNameTaken = uiNameTaken; this.uiHasAdj = uiHasAdj;
this.uiStationProjection = uiStationProjection; this.uiCatProjection = uiCatProjection; this.uiSrcProjection = uiSrcProjection;
this.uiBuildStationNext = uiBuildStationNext; this.uiBuildSrcNext = uiBuildSrcNext; this.uiBuildCatNext = uiBuildCatNext;
this.uiCreateEditor = uiCreateEditor;`, sandbox);
  return { sandbox };
})();
const App = sandbox.App, keyOf = sandbox.keyOf, SRC_CAP = sandbox.SRC_CAP;
const uiClone = sandbox.uiClone, uiReadCell = sandbox.uiReadCell, uiSameCell = sandbox.uiSameCell,
  uiApplyCells = sandbox.uiApplyCells, uiNewDraft = sandbox.uiNewDraft, uiSameProj = sandbox.uiSameProj,
  uiResolveUnique = sandbox.uiResolveUnique, uiValidName = sandbox.uiValidName, uiNameTaken = sandbox.uiNameTaken,
  uiHasAdj = sandbox.uiHasAdj, uiStationProjection = sandbox.uiStationProjection, uiCatProjection = sandbox.uiCatProjection,
  uiSrcProjection = sandbox.uiSrcProjection, uiBuildStationNext = sandbox.uiBuildStationNext,
  uiBuildSrcNext = sandbox.uiBuildSrcNext, uiBuildCatNext = sandbox.uiBuildCatNext, uiCreateEditor = sandbox.uiCreateEditor;
const snap = o => JSON.parse(JSON.stringify(o)); // vm 跨 realm 原型不同：经 JSON 快照后再 deepStrictEqual

// —— 测试台集（dName/dCat/dU = 装配留底口径，buildNext 的默认值折算与 tag 依赖它们）——
const mkSt = (n, c, us) => ({ c, n, u: us.slice(), dCat: c, dName: n, dU: us.slice() });
const SA = mkSt('台A', '新闻', ['http://a/1', 'http://a/2']);
const SB = mkSt('台B', '新闻', ['http://b/1']);
const SC = mkSt('台C', '音乐', ['http://c/1']);

/* ============================================================ [1] 草稿引擎单元（§6.4） */
console.log('[1] 草稿引擎纯函数：exists 区分「删除属性 vs 空串」、force 双模式、深拷贝');
ok('uiReadCell：缺键 {exists:false}；有键含空字符串也 {exists:true}（清除语义不混淆）', () => {
  const cfg = { names: { 'http://a/1': '' }, moves: {} };
  assert.deepStrictEqual(snap(uiReadCell(cfg, 'names', 'http://a/1')), { exists: true, value: '' });
  assert.deepStrictEqual(snap(uiReadCell(cfg, 'names', 'http://x/9')), { exists: false });
  assert.deepStrictEqual(snap(uiReadCell(cfg, 'hideS', 'http://a/1')), { exists: false }); // map 缺失不抛
});
ok('uiSameCell：exists 不同即不同；同 exists 比较值（数组/对象同构等价）', () => {
  assert.strictEqual(uiSameCell({ exists: true, value: '' }, { exists: false }), false); // 空串 ≠ 删除属性
  assert.strictEqual(uiSameCell({ exists: false }, { exists: false }), true);
  assert.strictEqual(uiSameCell({ exists: true, value: ['http://x'] }, { exists: true, value: ['http://x'] }), true);
  assert.strictEqual(uiSameCell({ exists: true, value: 1 }, { exists: true, value: 1 }), true);
});
ok('uiApplyCells force=false：before 与最新不符 → 整体拒绝且不改 latest（M03 拒绝盲撤的底层）', () => {
  const latest = { v: 2, names: { 'http://a/1': '他页改的' }, moves: {} };
  const cells = [{ map: 'names', key: 'http://a/1', before: { exists: true, value: '旧名' }, after: { exists: false } }];
  const r = uiApplyCells(latest, cells, false);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflicts.length, 1);
  assert.strictEqual(latest.names['http://a/1'], '他页改的'); // 原对象不被触碰
});
ok('uiApplyCells：写入 + 删除属性混合生效；删不存在的键不抛；latest 不被原地改', () => {
  const latest = { v: 2, names: { 'http://a/1': 'x', 'http://a/2': 'y' }, moves: {} };
  const cells = [
    { map: 'names', key: 'http://a/1', before: { exists: true, value: 'x' }, after: { exists: true, value: '新名' } },
    { map: 'names', key: 'http://a/2', before: { exists: true, value: 'y' }, after: { exists: false } },
    { map: 'hideS', key: 'http://a/1', before: { exists: false }, after: { exists: false } }, // 删缺键 no-op
    { map: 'hideS', key: 'http://a/9', before: { exists: false }, after: { exists: true, value: 1 } },
  ];
  const r = uiApplyCells(latest, cells, false);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(snap(r.cfg.names), { 'http://a/1': '新名' });
  assert.deepStrictEqual(snap(r.cfg.hideS), { 'http://a/9': 1 });
  assert.strictEqual(latest.names['http://a/1'], 'x'); // 深拷贝：原对象不动
});
ok('uiApplyCells force=true：最新值已变仍覆盖（仅限显式确认传入）', () => {
  const latest = { v: 2, names: { 'http://a/1': '他页改的' }, moves: {} };
  const cells = [{ map: 'names', key: 'http://a/1', before: { exists: true, value: '旧名' }, after: { exists: true, value: '草稿名' } }];
  const r = uiApplyCells(latest, cells, true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cfg.names['http://a/1'], '草稿名');
});
ok('uiNewDraft：base 深拷贝（外部改投影不影响基线）+ 固定形态字段', () => {
  const proj = { kind: 'st', name: '台A', maps: { names: { 'http://a/1': 'x' } } };
  const d = uiNewDraft('http://a/1', proj);
  proj.maps.names['http://a/1'] = '改过'; proj.name = '改过';
  assert.strictEqual(d.base.name, '台A');
  assert.strictEqual(d.base.maps.names['http://a/1'], 'x');
  assert.deepStrictEqual(snap(d.patch), {});
  assert.strictEqual(d.dirty, false); assert.strictEqual(d.conflict, false);
  assert.strictEqual(d.pendingAction, null); assert.strictEqual(d.submitting, false);
});

/* ============================================================ [2] resolveUnique + 校验规则 */
console.log('[2] uiResolveUnique 唯一回绑 + uiValidName/uiNameTaken（askName 语义等价，不静默裁切）');
ok('唯一命中返回该台；零命中/多重匹配 throw（绝不猜同名台）', () => {
  const sts = [mkSt('台A', '新闻', ['http://a/1']), mkSt('台B', '新闻', ['http://b/1', 'http://a/1'])];
  assert.throws(() => uiResolveUnique(sts, 'http://a/1'), /多个/); // 同 URL 挂两台 → 拒绝
  assert.throws(() => uiResolveUnique(sts, 'http://ghost/9'), /失配/);
  const one = [SA];
  assert.strictEqual(uiResolveUnique(one, 'http://a/2').n, '台A'); // 任一源 URL 命中即可锚定
});
ok('共享流 URL 台：hintKey（begin 时刻 keyOf）→ 唯一锚定（App.resolve 键优先同语义）；键漂移仍拒绝', () => {
  // 精选层与主列表共享蜻蜓流 URL 的真实场景（同名合并不适用——两台名字不同）
  const sts = [mkSt('台A', '新闻', ['http://a/1']), mkSt('台B', '新闻', ['http://b/1', 'http://a/1'])];
  assert.strictEqual(uiResolveUnique(sts, 'http://a/1', '新闻|台A').n, '台A'); // 键优先唯一锚定
  assert.strictEqual(uiResolveUnique(sts, 'http://a/1', '新闻|台B').n, '台B');
  assert.throws(() => uiResolveUnique(sts, 'http://a/1', '新闻|幽灵'), /多个/); // 键不命中仍拒绝（不猜）
  const renamed = [mkSt('台A新名', '新闻', ['http://a/1']), mkSt('台B', '新闻', ['http://b/1', 'http://a/1'])];
  assert.throws(() => uiResolveUnique(renamed, 'http://a/1', '新闻|台A'), /多个/); // 他页改名后键失配 → 不猜
  const drift = [mkSt('台A', '新闻', ['http://new/9']), mkSt('台B', '新闻', ['http://b/1'])];
  assert.strictEqual(uiResolveUnique(drift, 'http://a/1', '新闻|台A').n, '台A'); // URL 全漂移但键仍在 → 救回
});
ok('uiValidName：空名/分隔符/超 24 字报错；24 字与常规名通过（不裁切由调用方内联报错）', () => {
  assert.match(uiValidName(''), /不能为空/);
  assert.match(uiValidName('  '), /不能为空/);
  assert.match(uiValidName('a|b'), /分隔符/);
  assert.match(uiValidName('a,b'), /分隔符/);
  assert.match(uiValidName('a\nb'), /分隔符/);
  assert.strictEqual(uiValidName('一'.repeat(24)), '');
  assert.match(uiValidName('一'.repeat(25)), /24/);
  assert.strictEqual(uiValidName('Love Radio FM103.7'), '');
});
ok('uiNameTaken：同分类同名（他人）→ true；自己/他分类 → false', () => {
  assert.strictEqual(uiNameTaken([SA, SC], SA, '新闻', '台B'), false); // 新闻分类无台B
  assert.strictEqual(uiNameTaken([SA, SB], SA, '音乐', '台B'), false); // 目标分类是音乐
  assert.strictEqual(uiNameTaken([SA, SB], SA, '新闻', '台B'), true);
  assert.strictEqual(uiNameTaken([SA, SB], SB, '新闻', '台B'), false); // 自己不算撞
});

/* ============================================================ [3] buildNext 三份（M01 形状） */
console.log('[3] uiBuildStationNext/uiBuildSrcNext/uiBuildCatNext：只写本对象、默认值撤键、tag 差量');
ok('st：改名写 names、改回默认名撤键；移动写 moves、选默认分类撤键；隐藏启停写 hideS', () => {
  const latest = App.normCfg({ v: 2, names: { 'http://a/1': '旧草稿名' } });
  let next = uiBuildStationNext(latest, SA, { name: '台A新名' }, { name: '台A' }, false);
  assert.strictEqual(next.names['http://a/1'], '台A新名'); // 双 URL 都挂键（变体换序免疫口径）
  assert.strictEqual(next.names['http://a/2'], '台A新名');
  next = uiBuildStationNext(latest, SA, { name: '台A' }, { name: '台A' }, false); // 等于默认名 = 撤键
  assert.strictEqual(next.names['http://a/1'], undefined);
  let n2 = uiBuildStationNext(App.normCfg(null), SA, { category: '音乐' }, { category: '新闻' }, false);
  assert.strictEqual(n2.moves['http://a/1'], '音乐');
  n2 = uiBuildStationNext(App.normCfg(null), SA, { category: '新闻' }, { category: '新闻' }, false); // 默认分类 = 撤 moves
  assert.strictEqual(n2.moves['http://a/1'], undefined);
  const n3 = uiBuildStationNext(App.normCfg(null), SA, { hidden: true }, { hidden: false }, false);
  assert.strictEqual(n3.hideS['http://a/1'], 1);
  const n4 = uiBuildStationNext(App.normCfg({ v: 2, hideS: { 'http://a/1': 1 } }), SA, { hidden: false }, { hidden: true }, false);
  assert.strictEqual(n4.hideS['http://a/1'], undefined);
});
ok('st：tag 差量——有任一调整写默认名、全清撤键（tag 只增有据）', () => {
  let next = uiBuildStationNext(App.normCfg(null), SA, { name: '新名' }, { name: '台A' }, false);
  assert.strictEqual(next.tag['http://a/1'], '台A');
  const base2 = { name: '新名' }; // base 名即新名 → 撤改名后全台无调整 → tag 撤键
  next = uiBuildStationNext(App.normCfg({ v: 2, names: { 'http://a/1': '新名', 'http://a/2': '新名' }, tag: { 'http://a/1': '台A', 'http://a/2': '台A' } }), SA, { name: '台A' }, base2, false);
  assert.strictEqual(next.tag['http://a/1'], undefined);
});
ok('st：M01 形状——无关台（B）的既有调整原样保留', () => {
  const latest = App.normCfg({ v: 2, moves: { 'http://b/1': '音乐' }, names: { 'http://c/1': '台C改' } });
  const next = uiBuildStationNext(latest, SA, { name: '台A新名' }, { name: '台A' }, false);
  assert.strictEqual(next.moves['http://b/1'], '音乐');
  assert.strictEqual(next.names['http://c/1'], '台C改');
});
ok('st：buildNext 的 before 取自 latest（本层无冲突概念——闸门在引擎投影比对），force 双模式结果一致', () => {
  const latest = App.normCfg({ v: 2, names: { 'http://a/1': '他页改的' } });
  const a = uiBuildStationNext(latest, SA, { name: '草稿名' }, { name: '台A' }, false);
  const b = uiBuildStationNext(latest, SA, { name: '草稿名' }, { name: '台A' }, true);
  assert.strictEqual(a.names['http://a/1'], '草稿名');
  assert.deepStrictEqual(snap(a), snap(b));
});
ok('src：追加并入 srcs[key]（已有键沿用）、移除过滤、清空撤键；空数组 manual/disabled 撤键', () => {
  let latest = App.normCfg({ v: 2, srcs: { 'http://a/2': ['http://app/1'] } }); // 键挂第二源 URL
  let next = uiBuildSrcNext(latest, SA, { manual: null, disabled: null, labels: {}, appends: ['http://app/2'], removes: [] }, { srcsKey: 'http://a/2', labels: {} }, false);
  assert.deepStrictEqual(snap(next.srcs['http://a/2']), ['http://app/1', 'http://app/2']); // 已有键 = 追加序在后
  next = uiBuildSrcNext(latest, SA, { manual: null, disabled: null, labels: {}, appends: [], removes: ['http://app/1'] }, { srcsKey: 'http://a/2', labels: {} }, false);
  assert.strictEqual(next.srcs['http://a/2'], undefined); // 清空 = 撤键
  next = uiBuildSrcNext(App.normCfg(null), SA, { manual: ['http://a/2', 'http://a/1'], disabled: ['http://a/2'], labels: {} }, {}, false);
  assert.deepStrictEqual(snap(next.srcManualOrder['http://a/1']), ['http://a/2', 'http://a/1']); // 键 = u[0] 严格命中
  assert.deepStrictEqual(snap(next.srcDisabled['http://a/1']), ['http://a/2']);
  next = uiBuildSrcNext(App.normCfg(null), SA, { manual: [], disabled: [], labels: {} }, {}, false); // [] = 撤销人工排序/清禁用
  assert.strictEqual(next.srcManualOrder['http://a/1'], undefined);
  assert.strictEqual(next.srcDisabled['http://a/1'], undefined);
});
ok('src：标签写入/空串删键（删除属性 ≠ 空字符串）；srcLabels 无键台不误挂', () => {
  const latest = App.normCfg({ v: 2, srcLabels: { 'http://a/1': '旧标签' } });
  let next = uiBuildSrcNext(latest, SA, { manual: null, disabled: null, labels: { 'http://a/1': '车机备用', 'http://a/2': '' } }, { labels: { 'http://a/1': '旧标签' } }, false);
  assert.strictEqual(next.srcLabels['http://a/1'], '车机备用');
  assert.strictEqual(next.srcLabels['http://a/2'], undefined); // 空串 = 删（本来无键）
  next = uiBuildSrcNext(latest, SA, { manual: null, disabled: null, labels: { 'http://a/1': '' } }, { labels: { 'http://a/1': '旧标签' } }, false);
  assert.strictEqual(next.srcLabels['http://a/1'], undefined); // 旧键被删
});
ok('src：有追加源时 tag 落默认名；源调整全清后 tag 撤键', () => {
  let next = uiBuildSrcNext(App.normCfg(null), SA, { manual: null, disabled: null, labels: {}, appends: ['http://app/9'], removes: [] }, {}, false);
  assert.strictEqual(next.tag['http://a/1'], '台A');
});
ok('cat：非自建改名 → renames 映射 + moves 目标级联 + hideC 键随名转移', () => {
  const latest = App.normCfg({ v: 2, renames: {}, moves: { 'http://a/1': '新闻' }, hideC: { '新闻': 1 }, cats: [] });
  const next = uiBuildCatNext(latest, '新闻', { name: '时事' }, { orig: '新闻' }, false, () => false);
  assert.strictEqual(next.renames['新闻'], '时事');
  assert.strictEqual(next.moves['http://a/1'], '时事'); // 移动目标级联改写
  assert.strictEqual(next.hideC['时事'], 1); assert.strictEqual(next.hideC['新闻'], undefined);
});
ok('cat：已重命名分类再改名 → 改映射值（保留原始键）；自建改名 → cats 内替换', () => {
  let latest = App.normCfg({ v: 2, renames: { '旧新闻': '新闻' } });
  let next = uiBuildCatNext(latest, '旧新闻', { name: '时事' }, { orig: '旧新闻' }, false, () => false);
  assert.strictEqual(next.renames['旧新闻'], '时事'); // 原始键不动，只改映射值
  latest = App.normCfg({ v: 2, cats: ['我的分类'] });
  next = uiBuildCatNext(latest, '我的分类', { name: '私藏' }, { orig: '我的分类' }, false, () => false);
  assert.deepStrictEqual(snap(next.cats), ['私藏']);
});
ok('cat：改名为已有分类 = 合并（自建让位消失、moves 级联）；隐藏开关套在最终名上', () => {
  const latest = App.normCfg({ v: 2, cats: ['甲'], moves: { 'http://a/1': '甲' } });
  const next = uiBuildCatNext(latest, '甲', { name: '乙', hidden: true }, { orig: '甲' }, false, () => true);
  assert.deepStrictEqual(snap(next.cats), []); // 甲并入乙 → 甲让位消失
  assert.strictEqual(next.moves['http://a/1'], '乙');
  assert.strictEqual(next.hideC['乙'], 1); // 隐藏落在最终名
  const n2 = uiBuildCatNext(App.normCfg({ v: 2, hideC: { '新闻': 1 } }), '新闻', { hidden: false }, { orig: '新闻' }, false, () => false);
  assert.strictEqual(n2.hideC['新闻'], undefined);
});

/* ============================================================ [4] 引擎状态机（M01/M02/M04） */
console.log('[4] uiCreateEditor：M01 无关对象合并 / M02 冲突三选 / M04 失败留编辑');
// 最小 io 组装（模拟 App boot 注入形态）：cfgBox.cfg 为「最新 cfg」，stations 为当前台集
const makeIo = (cfgBox, stations, hooks = {}) => ({
  resolve: (id, kind) => kind === 'cat'
    ? (() => { const name = cfgBox.cfg.renames[id] || id; if (![...new Set(stations.map(s => s.c))].includes(name)) throw new Error('该分类已被其他页面改名或删除，请重新加载'); return { orig: id, name }; })()
    : uiResolveUnique(stations, id),
  readCfg: () => cfgBox.cfg,
  project: (cfg, subj, kind) => kind === 'cat' ? uiCatProjection(cfg, subj) : kind === 'src' ? uiSrcProjection(cfg, subj) : uiStationProjection(cfg, subj),
  newPatch: kind => kind === 'src' ? { manual: null, disabled: null, labels: {}, appends: [], removes: [] } : {},
  dirtyOf: (p, base) => 'manual' in p
    ? p.manual !== null || p.disabled !== null || Object.keys(p.labels).some(u => (base.labels[u] || '') !== p.labels[u]) || p.appends.length > 0 || p.removes.length > 0
    : Object.keys(p).length > 0,
  fields: kind => kind === 'st' ? ['name', 'category', 'hidden'] : kind === 'cat' ? ['name', 'hidden'] : [],
  validate: hooks.validate || (() => ''),
  buildNext: (latest, subj, patch, base, force, kind) => kind === 'cat' ? uiBuildCatNext(latest, subj.orig, patch, base, force, () => false)
    : kind === 'src' ? uiBuildSrcNext(latest, subj, patch, base, force) : uiBuildStationNext(latest, subj, patch, base, force),
  beforeCommit: hooks.beforeCommit,
  commit: hooks.commit || (next => { cfgBox.cfg = App.normCfg(next); }),
  render: hooks.render || (() => {}),
  confirmLeave: hooks.confirmLeave || (async () => 'discard'),
  confirmConflict: hooks.confirmConflict,
});
const stIo = (cfgBox, stations, hooks) => makeIo(cfgBox, stations, hooks);

okA('M01：其他台（B）外部改动后保存本台（A）→ 其他改动保留，仅合并本对象字段', async () => {
  const cfgBox = { cfg: App.normCfg(null) };
  const sts = [mkSt('台A', '新闻', ['http://a/1']), mkSt('台B', '新闻', ['http://b/1'])];
  const ed = uiCreateEditor(stIo(cfgBox, sts));
  ed.begin('http://a/1', 'st');
  ed.change('name', '台A新名');
  assert.strictEqual(ed.getDraft().dirty, true);
  cfgBox.cfg = App.normCfg({ v: 2, moves: { 'http://b/1': '音乐' } }); // 外部：他页移动了台B（与 A 无关）
  assert.strictEqual(await ed.save(), true);
  assert.strictEqual(cfgBox.cfg.names['http://a/1'], '台A新名'); // 本对象合并
  assert.strictEqual(cfgBox.cfg.moves['http://b/1'], '音乐');    // 无关对象以最新值为准
  assert.strictEqual(ed.getDraft().dirty, false); // 基线推进、草稿清空
});
okA('M02：同对象外部变化 → 留草稿标 conflict 不默认覆盖；三选分支状态机正确', async () => {
  // stay：继续编辑，cfg 不动、草稿原样
  {
    const cfgBox = { cfg: App.normCfg(null) };
    const sts = [mkSt('台A', '新闻', ['http://a/1'])];
    const choices = [];
    const ed = uiCreateEditor(stIo(cfgBox, sts, { confirmConflict: async d => { choices.push(d.dirty); return 'stay'; } }));
    ed.begin('http://a/1', 'st');
    ed.change('name', '草稿名');
    cfgBox.cfg = App.normCfg({ v: 2, names: { 'http://a/1': '他页改的名' } });
    assert.strictEqual(await ed.save(), false);
    assert.strictEqual(cfgBox.cfg.names['http://a/1'], '他页改的名'); // 未覆盖
    const d = ed.getDraft();
    assert.strictEqual(d.conflict, true); assert.strictEqual(d.dirty, true); // 草稿保留
    assert.strictEqual(d.patch.name, '草稿名');
    assert.deepStrictEqual(choices, [true]);
  }
  // reload：丢弃草稿、基线重挂最新值
  {
    const cfgBox = { cfg: App.normCfg(null) };
    const sts = [mkSt('台A', '新闻', ['http://a/1'])];
    const ed = uiCreateEditor(stIo(cfgBox, sts, { confirmConflict: async () => 'reload' }));
    ed.begin('http://a/1', 'st');
    ed.change('name', '草稿名');
    cfgBox.cfg = App.normCfg({ v: 2, names: { 'http://a/1': '他页改的名' } });
    assert.strictEqual(await ed.save(), false);
    const d = ed.getDraft();
    assert.strictEqual(d.dirty, false); assert.strictEqual(d.conflict, false);
    assert.strictEqual(d.base.maps.names['http://a/1'], '他页改的名'); // 基线 = 最新投影（names 条目已入基线，补丁清空）
    assert.strictEqual(d.patch.name, undefined);
    assert.strictEqual(cfgBox.cfg.names['http://a/1'], '他页改的名');
  }
  // overwrite：明确覆盖也要重新过校验且只写本对象
  {
    const cfgBox = { cfg: App.normCfg({ v: 2, moves: { 'http://b/1': '音乐' } }) };
    const sts = [mkSt('台A', '新闻', ['http://a/1']), mkSt('台B', '新闻', ['http://b/1'])];
    let validated = 0;
    const ed = uiCreateEditor(stIo(cfgBox, sts, {
      confirmConflict: async () => 'overwrite',
      validate: () => { validated++; return ''; },
    }));
    ed.begin('http://a/1', 'st');
    ed.change('name', '草稿名');
    cfgBox.cfg = App.normCfg({ v: 2, moves: { 'http://b/1': '音乐' }, names: { 'http://a/1': '他页改的名' } });
    assert.strictEqual(await ed.save(), true);
    assert.strictEqual(cfgBox.cfg.names['http://a/1'], '草稿名'); // 覆盖本对象
    assert.strictEqual(cfgBox.cfg.moves['http://b/1'], '音乐');   // 无关对象不动
    assert.ok(validated >= 1, 'validate 针对将被提交的最新 cfg 执行（弹窗期间有变则下一轮重校验）');
  }
});
okA('M02：弹窗等待期间又收到外部更新 → 对最新对象重校验（重试后仍变 → 持续变化报错）', async () => {
  const cfgBox = { cfg: App.normCfg(null) };
  const sts = [mkSt('台A', '新闻', ['http://a/1'])];
  let n = 0;
  const ed = uiCreateEditor(stIo(cfgBox, sts, {
    confirmConflict: async () => { n++; cfgBox.cfg = App.normCfg({ v: 2, names: { 'http://a/1': '第' + n + '次外部改' } }); return 'overwrite'; },
  }));
  ed.begin('http://a/1', 'st');
  ed.change('name', '草稿名');
  cfgBox.cfg = App.normCfg({ v: 2, names: { 'http://a/1': '第一次外部改' } });
  assert.strictEqual(await ed.save(), false);
  assert.match(ed.getDraft().error, /持续变化|外部修改/);
  assert.notStrictEqual(cfgBox.cfg.names['http://a/1'], '草稿名'); // 从未盲写
});
okA('M04：校验失败（撞名）/保存异常 → 留在编辑、cfg 不动、pendingAction 不执行', async () => {
  const cfgBox = { cfg: App.normCfg(null) };
  const sts = [mkSt('台A', '新闻', ['http://a/1']), mkSt('台B', '新闻', ['http://b/1'])];
  const ed = uiCreateEditor(stIo(cfgBox, sts, {
    validate: () => '该分类下已有同名电台（重名会串台），请换个名字',
    confirmLeave: async () => 'save', // 离开时选「保存并继续」：保存失败必须停在编辑
  }));
  ed.begin('http://a/1', 'st');
  ed.change('name', '台B');
  let ran = false;
  assert.strictEqual(await ed.depart(() => { ran = true; }), false); // depart('save') 内保存失败 → 不执行 next
  assert.strictEqual(ran, false);
  assert.strictEqual(cfgBox.cfg.names['http://a/1'], undefined); // cfg 未动
  const d = ed.getDraft();
  assert.strictEqual(d.dirty, true); assert.match(d.error, /同名/); // 留在编辑+就地错误
  // URL 失配：对象消失 → resolve throw → 保存失败留草稿
  sts.length = 0;
  assert.strictEqual(await ed.save(), false);
  assert.match(ed.getDraft().error, /失配/);
});
okA('离开流程：dirty 时三选——stay 不执行 next；discard 执行；save 成功才执行', async () => {
  const cfgBox = { cfg: App.normCfg(null) };
  const sts = [mkSt('台A', '新闻', ['http://a/1'])];
  // stay
  {
    const ed = uiCreateEditor(stIo(cfgBox, sts, { confirmLeave: async () => 'stay' }));
    ed.begin('http://a/1', 'st'); ed.change('category', '音乐');
    let ran = false;
    assert.strictEqual(await ed.depart(() => { ran = true; }), false);
    assert.strictEqual(ran, false);
  }
  // discard
  {
    const ed = uiCreateEditor(stIo(cfgBox, sts, { confirmLeave: async () => 'discard' }));
    ed.begin('http://a/1', 'st'); ed.change('category', '音乐');
    let ran = false;
    assert.strictEqual(await ed.depart(() => { ran = true; }), true);
    assert.strictEqual(ran, true);
    assert.strictEqual(cfgBox.cfg.moves['http://a/1'], undefined); // 放弃 = 不落盘
  }
  // save 成功
  {
    const ed = uiCreateEditor(stIo(cfgBox, sts, { confirmLeave: async () => 'save' }));
    ed.begin('http://a/1', 'st'); ed.change('category', '音乐');
    let ran = false;
    assert.strictEqual(await ed.depart(() => { ran = true; }), true);
    assert.strictEqual(ran, true);
    assert.strictEqual(cfgBox.cfg.moves['http://a/1'], '音乐'); // 保存并继续 = 先落盘再走
  }
});
okA('externalChanged：同对象外部变化标 conflict；无关变化不标；失配标 conflict+错误', async () => {
  const cfgBox = { cfg: App.normCfg(null) };
  const sts = [mkSt('台A', '新闻', ['http://a/1']), mkSt('台B', '新闻', ['http://b/1'])];
  const ed = uiCreateEditor(stIo(cfgBox, sts));
  ed.begin('http://a/1', 'st');
  cfgBox.cfg = App.normCfg({ v: 2, moves: { 'http://b/1': '音乐' } }); // 无关台变化
  ed.externalChanged();
  assert.strictEqual(ed.getDraft().conflict, false);
  cfgBox.cfg = App.normCfg({ v: 2, moves: { 'http://b/1': '音乐' }, hideS: { 'http://a/1': 1 } }); // 同对象变化
  ed.externalChanged();
  assert.strictEqual(ed.getDraft().conflict, true);
  sts.length = 0; // 对象消失（同步重建失配）
  ed.externalChanged();
  assert.strictEqual(ed.getDraft().conflict, true);
});
ok('change 字段白名单：越权字段 throw；值回基线自动撤补丁', () => {
  const cfgBox = { cfg: App.normCfg(null) };
  const sts = [mkSt('台A', '新闻', ['http://a/1'])];
  const ed = uiCreateEditor(stIo(cfgBox, sts));
  ed.begin('http://a/1', 'st');
  assert.throws(() => ed.change('srcs', []), /不允许编辑此字段/);
  ed.change('name', '新名'); ed.change('name', '台A'); // 回基线 → 撤键
  assert.strictEqual(ed.getDraft().dirty, false);
  assert.strictEqual(ed.getDraft().patch.name, undefined);
});

/* ============================================================ [5] M03 撤销隐藏 + App 校验接线 */
console.log('[5] M03 撤销隐藏（反转补丁 force=false）+ App.mValidate/mSrcValidate 接线');
ok('M03：隐藏键未变 + 无关字段已变 → 撤销成功且无关字段保留；隐藏键已变 → 拒绝盲撤', () => {
  const undo = SA.u.map(u => ({ map: 'hideS', key: u, before: { exists: true, value: 1 }, after: { exists: false } }));
  // 场景一：撤销前他页移动了台B（无关字段）→ 撤销成功、无关字段保留
  let latest = App.normCfg({ v: 2, hideS: { 'http://a/1': 1, 'http://a/2': 1 }, moves: { 'http://b/1': '音乐' } });
  let r = uiApplyCells(latest, undo, false);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cfg.hideS['http://a/1'], undefined);
  assert.strictEqual(r.cfg.moves['http://b/1'], '音乐'); // 无关字段保留
  // 场景二：撤销前他页已取消隐藏该台（隐藏键变化）→ 拒绝
  latest = App.normCfg({ v: 2, hideS: { 'http://a/2': 1 } }); // a/1 的隐藏被他页撤了
  r = uiApplyCells(latest, undo, false);
  assert.strictEqual(r.ok, false);
});
ok('App.mValidate（st）：空名/分隔符/超长/撞名/目标分类失配内联报错（vm 沙箱直调）', () => {
  App.cfg = App.normCfg(null);
  App.state = { stations: [mkSt('台A', '新闻', ['http://a/1']), mkSt('台B', '新闻', ['http://b/1'])] };
  assert.match(App.mValidate(App.state.stations[0], { name: '' }, App.cfg, 'st'), /不能为空/);
  assert.match(App.mValidate(App.state.stations[0], { name: 'x|y' }, App.cfg, 'st'), /分隔符/);
  assert.match(App.mValidate(App.state.stations[0], { name: '台B' }, App.cfg, 'st'), /同名/);
  assert.match(App.mValidate(App.state.stations[0], { category: '已消失分类' }, App.cfg, 'st'), /重新选择/);
  assert.strictEqual(App.mValidate(App.state.stations[0], { name: '台A新名', category: '新闻' }, App.cfg, 'st'), '');
  assert.match(App.mValidate({ orig: '新闻', name: '新闻' }, { name: 'a|b' }, App.cfg, 'cat'), /分隔符/);
  assert.strictEqual(App.mValidate({ orig: '新闻', name: '新闻' }, { hidden: true }, App.cfg, 'cat'), '');
});
ok('App.mSrcValidate：重复/他台占用停止归属/超 6 封顶/未知地址（§6.9 步骤4/6）', () => {
  App.cfg = App.normCfg(null);
  App.state = { stations: [mkSt('台A', '新闻', ['http://a/1']), mkSt('台B', '新闻', ['http://b/1'])] };
  const A = App.state.stations[0];
  const P = over => Object.assign({ manual: null, disabled: null, labels: {}, appends: [], removes: [] }, over);
  assert.match(App.mSrcValidate(A, P({ appends: ['http://a/1'] }), 'src'), /重复/); // 与本台现有源重复
  assert.match(App.mSrcValidate(A, P({ appends: ['http://b/1'] }), 'src'), /其他电台/); // 他台占用 → 停止自动归属
  assert.match(App.mSrcValidate(A, P({ appends: ['ftp://x'] }), 'src'), /http/); // URL 合法性
  const many = []; for (let i = 0; i < SRC_CAP; i++) many.push('http://new/' + i);
  assert.match(App.mSrcValidate(A, P({ appends: many }), 'src'), /最多/); // 条数封顶
  assert.match(App.mSrcValidate(A, P({ manual: ['http://ghost/9'] }), 'src'), /未知源地址/);
  assert.match(App.mSrcValidate(A, P({ disabled: ['http://ghost/9'] }), 'src'), /未知源地址/);
  assert.strictEqual(App.mSrcValidate(A, P({ appends: ['http://new/1'], removes: ['http://a/2'] }), 'src'), '');
});

/* ============================================================ [6] 投影（M02 完整性） */
console.log('[6] 对象投影完整性：同对象任一可编辑字段变化都能被投影比对捕获');
ok('uiStationProjection：台级字段 + 命中 map 条目全纳入（tag/srcs/生命周期/标签）', () => {
  const cfg = App.normCfg({ v: 2, names: { 'http://a/1': '新名' }, tag: { 'http://a/1': '台A' },
    srcs: { 'http://a/1': ['http://app/1'] }, srcManualOrder: { 'http://a/1': ['http://a/2'] },
    srcDisabled: { 'http://a/1': ['http://a/2'] }, srcLabels: { 'http://a/2': '车机' } });
  const p = uiStationProjection(cfg, SA);
  assert.strictEqual(p.name, '台A'); // 台级字段取解析台当前生效名（真实应用中 stations 已过 applyCfg）
  assert.strictEqual(p.category, '新闻'); assert.strictEqual(p.hidden, false);
  assert.strictEqual(p.maps.names['http://a/1'], '新名');
  assert.strictEqual(p.maps.tag['http://a/1'], '台A');
  assert.deepStrictEqual(snap(p.maps.srcs['http://a/1']), ['http://app/1']);
  assert.deepStrictEqual(snap(p.maps.srcManualOrder['http://a/1']), ['http://a/2']);
  assert.deepStrictEqual(snap(p.maps.srcDisabled['http://a/1']), ['http://a/2']); // 有效键值形态被 normCfg 保留并纳入投影
  assert.strictEqual(p.maps.srcLabels['http://a/2'], '车机');
  assert.deepStrictEqual(snap(p.urls), ['http://a/1', 'http://a/2']); // 原始 u 快照
});
ok('uiSrcProjection：srcsKey/srcs/manual/disabled/labels 全纳入；uiCatProjection 含原名/自建/隐藏/movesTo', () => {
  const cfg = App.normCfg({ v: 2, srcs: { 'http://a/2': ['http://app/1'] }, srcManualOrder: { 'http://a/1': ['http://a/2', 'http://a/1'] }, srcDisabled: { 'http://a/1': ['http://a/2'] }, srcLabels: { 'http://a/1': '车机' } });
  const p = uiSrcProjection(cfg, SA);
  assert.strictEqual(p.srcsKey, 'http://a/2');
  assert.deepStrictEqual(snap(p.srcs), ['http://app/1']);
  assert.deepStrictEqual(snap(p.manual), ['http://a/2', 'http://a/1']);
  assert.deepStrictEqual(snap(p.disabled), ['http://a/2']);
  assert.deepStrictEqual(snap(p.labels), { 'http://a/1': '车机' });
  const cfg2 = App.normCfg({ v: 2, cats: ['甲'], renames: { '旧': '甲' }, hideC: { '甲': 1 }, moves: { 'http://a/1': '甲' } });
  const pc = uiCatProjection(cfg2, { orig: '甲', name: '甲' });
  assert.strictEqual(pc.custom, true); assert.strictEqual(pc.hidden, true);
  assert.deepStrictEqual(snap(pc.movesTo), ['http://a/1']);
  assert.strictEqual(pc.from, '旧'); // 「甲」本身是 renames 值（旧→甲）——投影如实捕获改名来源
  const pc2 = uiCatProjection(cfg2, { orig: '旧', name: '甲' }); // 原名「旧」→ 现名「甲」
  assert.strictEqual(pc2.from, '旧');
  const pc3 = uiCatProjection(App.normCfg({ v: 2, cats: ['乙'] }), { orig: '乙', name: '乙' });
  assert.strictEqual(pc3.from, null); // 无改名映射 → from 为 null
});
ok('uiSameProj：任一同对象字段变化 → 投影不等（M02 检测面）', () => {
  const cfg = App.normCfg(null);
  const p0 = uiSrcProjection(cfg, SA);
  const cfg2 = App.normCfg({ v: 2, srcDisabled: { 'http://a/1': ['http://a/2'] } });
  assert.strictEqual(uiSameProj(uiSrcProjection(cfg2, SA), p0), false);
  assert.strictEqual(uiSameProj(uiSrcProjection(cfg, SA), p0), true);
});

(async () => { // 等齐全部异步用例再汇总（okA 已在调用时启动，引擎 save/depart 走微任务）
  await Promise.all(pending);
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
