// UI 续听卡（hero）回归测试（ui-redesign P2 §3.3/§6.3，采纳 AIbot review PR#30 两条 P1）：
// app.js 剥尾部 boot 块经 vm 沙箱装载后对 App.renderHero 做方法级实测（同 test/ui-scope.js 法）——
// ①自动 dead 台正在播/连接时是 hero 当前候选不降级（eligible 的 playingKey/connectingKey 与主列表
// visible 同口径传入，手动隐藏台仍在播也不豁免）；②hero 因范围/分类/搜索隐藏时清 dataset.sig，
// 回到同候选同状态时签名早退不得抢在 hidden=false 复位前（否则 hero 保持隐藏）。零依赖离线随 npm test。
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); } };

const UP = path.join(__dirname, '..');
const { sandbox } = (() => {
  const src = fs.readFileSync(path.join(UP, 'app.js'), 'utf8');
  const m = src.match(/\nApp\.boot\(\);\s*$/) || src.match(/\nif \(typeof document !== 'undefined'\) App\.boot\(\);[\s\S]*$/);
  assert(m, 'app.js 尾部 boot 块可剥离（装载法依赖此前提）');
  const sandbox = { console, clearTimeout, setTimeout, CSS: { escape: s => '"' + String(s).replace(/"/g, '\\"') + '"' } };
  vm.createContext(sandbox);
  vm.runInContext(src.slice(0, m.index) + '\nthis.App = App; this.keyOf = keyOf;', sandbox);
  return { sandbox };
})();

// —— renderHero 的最小桩：hero 节点要 dataset/hidden；documentElement.classList 驱动 ui-refresh 开关 ——
const els = {};
const mkEl = () => ({ classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, removeAttribute() {},
  innerHTML: '', hidden: false, dataset: {}, contains: () => false, querySelector: () => null, querySelectorAll: () => [] });
sandbox.document = { activeElement: null, documentElement: { classList: { contains: () => true } },
  getElementById: id => els[id] || (els[id] = mkEl()) };
sandbox.Player = { station: null, connecting: null, isPaused: () => false };
sandbox.Logos = { visual: () => '<i class="stub-logo"></i>' };
const App = sandbox.App;
App.render = () => {};
App.cfg = { hideC: {} };                       // renderHero 读 cfg.hideC（隐藏分类）
App.recents = [];                              // 最近层置空：候选只走 current → starter 两级
const hero = () => sandbox.document.getElementById('resumeHero');

const deadA = { c: '新闻', n: '死台A', u: ['http://h/1'], health: 'dead' };   // 自动 dead（非手动隐藏）
const starterB = { c: '音乐', n: '精选B', u: ['http://h/2'], om: 1 };         // STARTER 精选兜底
const reset = () => {
  App.state.stations = [deadA, starterB]; App.state.scope = 'all'; App.state.cat = '全部';
  App.state.keyword = ''; App.state.showDead = false;
  sandbox.Player.station = null; sandbox.Player.connecting = null;
};

console.log('[H1] AIbot P1-①：自动 dead 台正在播 → hero 仍是该台（不降级到最近/精选）');
reset();
ok('在播死台成为 hero 当前候选（heroK 锚定该台、按钮=暂停、不显示精选兜底）', () => {
  sandbox.Player.station = deadA;
  App.renderHero();
  assert.strictEqual(hero().hidden, false);
  assert.strictEqual(App.heroK, deadA.u[0]);
  assert.ok(hero().innerHTML.includes('当前电台'));
  assert.ok(hero().innerHTML.includes('暂停'));
  assert.ok(!hero().innerHTML.includes(starterB.n));
});
ok('连接中的死台同样例外保留（connectingKey 口径，按钮=正在连接禁用态）', () => {
  reset();
  sandbox.Player.connecting = deadA;
  App.renderHero();
  assert.strictEqual(App.heroK, deadA.u[0]);
  assert.ok(hero().innerHTML.includes('正在连接'));
});
ok('死台未在播仍被过滤（showDead=false 时 eligible 不豁免非当前死台，精选兜底接位）', () => {
  reset();
  App.renderHero();
  assert.strictEqual(App.heroK, starterB.u[0]);
  assert.ok(hero().innerHTML.includes(starterB.n));
});
ok('手动隐藏台（s.hidden）正在播也不豁免——首页改用下一候选（§3.3 手动线）', () => {
  reset();
  const hid = { c: '新闻', n: '手藏C', u: ['http://h/3'], hidden: true };
  App.state.stations = [hid, starterB];
  sandbox.Player.station = hid;
  App.renderHero();
  assert.strictEqual(App.heroK, starterB.u[0]);
  assert.ok(!hero().innerHTML.includes(hid.n));
});

console.log('[H2] AIbot P1-②：hero 隐藏后回到同候选同状态必须复显（隐藏时清 dataset.sig）');
ok('范围切走隐藏 → 切回 all：同候选同状态，hero.hidden 复位 false 且内容重建', () => {
  reset();
  sandbox.Player.station = starterB;
  App.renderHero();
  assert.strictEqual(hero().hidden, false);
  const sigOnce = hero().dataset.sig;
  assert.ok(sigOnce, '首次渲染落签名');
  App.state.scope = 'favorites';
  App.renderHero();
  assert.strictEqual(hero().hidden, true);
  assert.ok(!('sig' in hero().dataset), '隐藏即清签名（否则同签名早退卡死隐藏态）');
  App.state.scope = 'all';
  App.renderHero();
  assert.strictEqual(hero().hidden, false, '同候选回显不因签名早退保持隐藏');
  assert.strictEqual(App.heroK, starterB.u[0]);
  assert.ok(hero().innerHTML.includes(starterB.n));
});
ok('分类/搜索隐藏同样走清签名路径（on 条件三支任一恢复都复显）', () => {
  reset();
  App.renderHero();
  App.state.cat = '新闻';
  App.renderHero();
  assert.strictEqual(hero().hidden, true);
  App.state.cat = '全部'; App.state.keyword = '广播';
  App.renderHero();
  assert.strictEqual(hero().hidden, true);
  App.state.keyword = '';
  App.renderHero();
  assert.strictEqual(hero().hidden, false);
});

console.log(`ui-hero: ${pass} 通过, ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
