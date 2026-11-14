// 源生命周期测试（B1，plan-expansion-r4 §5.4）：① srcorder.js 纯函数（Web/Android 双端同语义的单一来源）——
// effective 的 manual 全列/部分列/含未知 URL/空、disabled 命中/不命中/全禁、pick 的 prefer>mem>order[0] 优先级、
// mem 指向禁用源时忽略；② app.js normCfg 三字段清洗——app.js 不可直接 require（尾部 App.boot() 触 DOM），
// 剥离 boot 行后 vm 沙箱装载（定义期无 DOM 访问，normCfg 纯函数可实测）。零依赖离线，npm test 随跑。
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const SrcOrder = require('../srcorder');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); } };

const U = ['http://a/live.m3u8', 'http://b/live.mp3', 'http://c/live.mp3', 'http://d/live.aac'];

console.log('[1] SrcOrder.effective');
ok('无 manual：order = [0..n-1]、dis 空', () => {
  assert.deepStrictEqual(SrcOrder.effective(U, null, null), { order: [0, 1, 2, 3], dis: [] });
  assert.deepStrictEqual(SrcOrder.effective(U, [], []), { order: [0, 1, 2, 3], dis: [] });
});
ok('manual 全列：按 manual 序重排', () => {
  const r = SrcOrder.effective(U, [U[2], U[0], U[3], U[1]], []);
  assert.deepStrictEqual(r.order, [2, 0, 3, 1]); assert.deepStrictEqual(r.dis, []);
});
ok('manual 部分列：列入者在前（manual 序）+ 未列者按 u 原序追加', () => {
  const r = SrcOrder.effective(U, [U[3], U[1]], []);
  assert.deepStrictEqual(r.order, [3, 1, 0, 2]);
});
ok('manual 含未知 URL / 重复条目：忽略去重', () => {
  const r = SrcOrder.effective(U, ['http://ghost/x', U[1], U[1], 'ftp://bad/y'], []);
  assert.deepStrictEqual(r.order, [1, 0, 2, 3]);
});
ok('disabled 命中：从 order 剔除进 dis；不命中/不在 u 的忽略', () => {
  const r = SrcOrder.effective(U, null, [U[0], 'http://ghost/z']);
  assert.deepStrictEqual(r.order, [1, 2, 3]); assert.deepStrictEqual(r.dis, [0]);
});
ok('disabled 与 manual 并存：先按 manual 排、再剔禁用', () => {
  const r = SrcOrder.effective(U, [U[1], U[0]], [U[1]]);
  assert.deepStrictEqual(r.order, [0, 2, 3]); assert.deepStrictEqual(r.dis, [1]);
});
ok('全禁：order 空（pick → -1 = NO_ENABLED_SOURCE）、dis 全量', () => {
  const r = SrcOrder.effective(U, null, U.slice());
  assert.deepStrictEqual(r.order, []); assert.deepStrictEqual(r.dis, [0, 1, 2, 3]);
  assert.strictEqual(SrcOrder.pick(r.order, undefined, undefined), -1);
});
ok('空台/坏输入：不抛、order 空', () => {
  assert.deepStrictEqual(SrcOrder.effective([], null, null), { order: [], dis: [] });
  assert.deepStrictEqual(SrcOrder.effective(undefined, U, U), { order: [], dis: [] });
});

console.log('[2] SrcOrder.pick');
ok('优先级 prefer > mem > order[0]', () => {
  assert.strictEqual(SrcOrder.pick([2, 0, 1], 1, 0), 1);   // prefer 有效压 mem
  assert.strictEqual(SrcOrder.pick([2, 0, 1], undefined, 0), 0); // 无 prefer 用 mem
  assert.strictEqual(SrcOrder.pick([2, 0, 1]), 2);          // 都无 → order[0]
  assert.strictEqual(SrcOrder.pick([2, 0, 1], 9, 9), 2);    // 都不在 order（禁用/越界）→ order[0]
});
ok('mem 指向禁用源（不在 order）→ 忽略顺延 order[0]', () => {
  const { order } = SrcOrder.effective(U, null, [U[0]]); // 源 0 被禁
  assert.deepStrictEqual(order, [1, 2, 3]);
  assert.strictEqual(SrcOrder.pick(order, undefined, 0), 1);
});
ok('prefer 指向禁用源 → 落 mem / order[0]', () => {
  const { order } = SrcOrder.effective(U, null, [U[2]]);
  assert.strictEqual(SrcOrder.pick(order, 2, 3), 3);
  assert.strictEqual(SrcOrder.pick(order, 2, undefined), 0);
});

console.log('[3] app.js normCfg 三字段清洗（vm 沙箱装载，剥尾部 App.boot()）');
const UP = path.join(__dirname, '..');
const { App, sandbox } = (() => {
  const src = fs.readFileSync(path.join(UP, 'app.js'), 'utf8');
  const m = src.match(/\nApp\.boot\(\);\s*$/);
  assert(m, 'app.js 尾部 App.boot() 可剥离（装载法依赖此前提）');
  const sandbox = { console, SrcOrder }; // SrcOrder 注入：srcLife 引用全局 SrcOrder（浏览器由 srcorder.js 经典 script 提供）
  vm.createContext(sandbox);
  vm.runInContext(src.slice(0, m.index) + '\nthis.App = App;', sandbox);
  return { App: sandbox.App, sandbox };
})();
const snap = o => JSON.parse(JSON.stringify(o)); // vm 跨 realm 对象原型不同：经 JSON 快照后再 deepStrictEqual
ok('v1（无 v）迁移为 v2 + 三字段缺省为空对象', () => {
  const c = snap(App.normCfg({ moves: { 'http://a/': '华语音乐' } }));
  assert.strictEqual(c.v, 2);
  assert.deepStrictEqual(c.srcManualOrder, {}); assert.deepStrictEqual(c.srcDisabled, {}); assert.deepStrictEqual(c.srcLabels, {});
  assert.deepStrictEqual(c.moves, { 'http://a/': '华语音乐' });
});
ok('null/坏结构 → 全空配置不抛', () => {
  const c = snap(App.normCfg(null));
  assert.strictEqual(c.v, 2);
  assert.deepStrictEqual(c.srcManualOrder, {}); assert.deepStrictEqual(c.srcDisabled, {}); assert.deepStrictEqual(c.srcLabels, {});
});
ok('srcManualOrder/srcDisabled：键须 URL、值须数组、元素 http(s)、去重、6 条封顶', () => {
  const c = snap(App.normCfg({
    v: 2,
    srcManualOrder: {
      'http://main/live': ['http://x/1.mp3', 'http://x/1.mp3', 'ftp://bad/', 'nope', 'http://main/live',
        'http://x/2.mp3', 'http://x/3.mp3', 'http://x/4.mp3', 'http://x/5.mp3', 'http://x/6.mp3', 'http://x/7.mp3'],
      '非URL键': ['http://y/1.mp3'],
    },
    srcDisabled: { 'http://main/live': 'not-array', 'http://d/live': ['http://dead/1.mp3'] },
  }));
  assert.deepStrictEqual(c.srcManualOrder, {
    'http://main/live': ['http://x/1.mp3', 'http://main/live', 'http://x/2.mp3', 'http://x/3.mp3', 'http://x/4.mp3', 'http://x/5.mp3'], // 去重后 6 条封顶，ftp/裸串过滤
  });
  assert.deepStrictEqual(c.srcDisabled, { 'http://d/live': ['http://dead/1.mp3'] });
});
ok('srcLabels：URL→字符串、空白剔除、非字符串值丢弃', () => {
  const c = snap(App.normCfg({ v: 2, srcLabels: { 'http://x/1.mp3': '车机备用', 'http://x/2.mp3': '  ', 'http://x/3.mp3': 123, 'bad': 'x' } }));
  assert.deepStrictEqual(c.srcLabels, { 'http://x/1.mp3': '车机备用' });
});

console.log('[4] srcLife 键位口径（双端冻结：srcManualOrder/srcDisabled 键 = 身份 URL u[0] 严格命中）');
ok('键挂在追加源 URL 上 → 无视（与 srcs 的任一源命中口径不同）', () => {
  const s = { u: ['http://m/live', 'http://app/x.mp3'] };
  App.cfg = App.normCfg({ v: 2, srcDisabled: { 'http://app/x.mp3': ['http://app/x.mp3'] }, srcManualOrder: { 'http://app/x.mp3': ['http://app/x.mp3', 'http://m/live'] } });
  App.srcLife(s);
  assert.deepStrictEqual(s.dis, []); assert.deepStrictEqual(s.mo, [0, 1]); assert.strictEqual(s.moManual, false);
});
ok('键挂 u[0] → 生效：禁用追加源、人工序重排', () => {
  const s = { u: ['http://m/live', 'http://app/x.mp3'] };
  App.cfg = App.normCfg({ v: 2, srcDisabled: { 'http://m/live': ['http://app/x.mp3'] }, srcManualOrder: { 'http://m/live': ['http://app/x.mp3'] } });
  App.srcLife(s);
  assert.deepStrictEqual(s.dis, [1]); assert.deepStrictEqual(s.mo, [0]); assert.strictEqual(s.moManual, true);
});

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
