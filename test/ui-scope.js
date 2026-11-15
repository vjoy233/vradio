// UI 单一筛选状态测试（ui-redesign P1 §3.2/§6.2/§6.3 + §9.1 F01–F06）：app.js 顶层筛选纯函数
// uiStationShown/uiProjectStations/uiChooseResume 经 vm 沙箱直测（剥尾部 boot 块，同 test/source-lifecycle.js 法）；
// App 侧 setScope/setCategory/searchEverywhere/locatePlaying/buildCats/catCounts/baselineList 用替换 render +
// 最小 document/Player 桩实测状态迁移（scope 内存态语义：切范围重置 cat、组合筛选、搜全部保词、手动隐藏永不
// 豁免、dead 正在播例外、基线全库口径不被 scope 截断）。零依赖离线，npm test 随跑。
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); } };

const UP = path.join(__dirname, '..');
const { sandbox } = (() => {
  const src = fs.readFileSync(path.join(UP, 'app.js'), 'utf8');
  const m = src.match(/\nApp\.boot\(\);\s*$/) || src.match(/\nif \(typeof document !== 'undefined'\) App\.boot\(\);[\s\S]*$/);
  assert(m, 'app.js 尾部 boot 块可剥离（装载法依赖此前提）');
  const sandbox = { console, clearTimeout, setTimeout, CSS: { escape: s => '"' + String(s).replace(/"/g, '\\"') + '"' } }; // 定时器/CSS.escape 桩（swapRender/locatePlaying 用）；Player/Store 等方法级测试按需再补
  vm.createContext(sandbox);
  vm.runInContext(src.slice(0, m.index) +
    '\nthis.App = App; this.uiStationShown = uiStationShown; this.uiProjectStations = uiProjectStations; this.uiChooseResume = uiChooseResume; this.keyOf = keyOf;', sandbox);
  return { sandbox };
})();

// —— 方法级测试的最小桩：$ = document.getElementById（按 id 缓存同一实例，断言可读 innerHTML/value）——
const els = {};
const mkEl = () => ({ classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, innerHTML: '', contains: () => false,
  querySelector: () => null, querySelectorAll: () => [], scrollLeft: 0, clientWidth: 0, scrollWidth: 0, value: '' });
sandbox.document = { activeElement: null, getElementById: id => els[id] || (els[id] = mkEl()) };
sandbox.Player = { station: null, connecting: null };
const App = sandbox.App, keyOf = sandbox.keyOf, uiStationShown = sandbox.uiStationShown,
  uiProjectStations = sandbox.uiProjectStations, uiChooseResume = sandbox.uiChooseResume;
const el = id => sandbox.document.getElementById(id);
App.render = () => {}; // 方法级测试外科替换渲染（swapRender 真身走 classList/timeout 桩，无害）
// vm 跨 realm 数组原型不同（deepStrictEqual 会因原型失配误报）：投影结果先展开成本地数组再断言
const names = r => [...r].map(s => s.n);

const mkOpt = over => Object.assign({ // uiProjectStations/uiStationShown 的全量依赖注入（与 App.visible 适配同形）
  stations: [], scope: 'all', category: '全部', keyword: '', recents: [], resolveRecent: () => null,
  favoriteKeys: new Set(), hiddenCategories: {}, showDead: false, all: false, key: keyOf,
  playingKey: null, connectingKey: null,
}, over);

console.log('[F01] 多词 AND：词可分别命中台名/分类，dCat 不参与');
const stF01 = [
  { c: '新闻', n: '北京新闻广播', u: ['http://a/1'] },
  { c: '音乐', n: '北京音乐台', u: ['http://a/2'] },
  { c: '新闻', n: '上海新闻台', u: ['http://a/3'] },
  { c: '交通', n: '北京交通广播', u: ['http://a/4'], dCat: '文教' }, // dCat 留底 ≠ 现分类
];
ok('「北京 新闻」一词命中台名一词命中分类（AND 全中才留）', () => {
  assert.deepStrictEqual(names(uiProjectStations(mkOpt({ stations: stF01, keyword: '北京 新闻' }))), ['北京新闻广播']); // 北京音乐台缺「新闻」词、上海新闻台缺「北京」词
});
ok('「交通 北京」分别命中分类与台名', () => {
  assert.deepStrictEqual(names(uiProjectStations(mkOpt({ stations: stF01, keyword: '交通 北京' }))), ['北京交通广播']);
});
ok('dCat 留底不参与搜索（旧快照分类不给结果加权）', () => {
  assert.deepStrictEqual(names(uiProjectStations(mkOpt({ stations: stF01, keyword: '文教' }))), []);
});
ok('大小写不敏感；单词直配台名/分类均可', () => {
  const b = [{ c: '欧美音乐', n: 'BBC Radio', u: ['http://a/9'] }];
  assert.strictEqual(uiProjectStations(mkOpt({ stations: b, keyword: 'bbc' })).length, 1);
  assert.strictEqual(uiProjectStations(mkOpt({ stations: b, keyword: 'BBC RADIO' })).length, 1);
  assert.strictEqual(uiProjectStations(mkOpt({ stations: b, keyword: 'bbc news' })).length, 0); // AND：news 未命中
  assert.strictEqual(uiProjectStations(mkOpt({ stations: b, keyword: '欧美' })).length, 1);     // 分类词单独可搜
});
ok('uiStationShown：手动隐藏永不豁免（all/playingKey 双豁免都不越手动线）', () => {
  const s = { c: '新闻', n: '藏台', u: ['http://a/0'], hidden: true };
  const opt = mkOpt({ stations: [s], all: true, playingKey: keyOf(s), connectingKey: keyOf(s) });
  assert.strictEqual(uiStationShown(s, opt), false);
  assert.deepStrictEqual([...uiProjectStations(opt)], []);
});

console.log('[F02] 收藏+分类+搜索组合，再搜全部（保词、解除 scope/category）');
const stF02 = [
  { c: '新闻', n: '北京新闻台', u: ['http://b/1'] },
  { c: '新闻', n: '上海新闻台', u: ['http://b/2'] },
  { c: '音乐', n: '北京音乐台', u: ['http://b/3'] },
];
const favsF02 = new Set(['新闻|北京新闻台', '音乐|北京音乐台']);
ok('favorites+分类+关键词三重组合投影', () => {
  const r = uiProjectStations(mkOpt({ stations: stF02, scope: 'favorites', category: '新闻', keyword: '北京', favoriteKeys: favsF02 }));
  assert.deepStrictEqual(names(r), ['北京新闻台']); // 音乐台被分类剔、上海新闻台被收藏剔
});
ok('搜全部（scope=all+cat=全部）：关键词保留', () => {
  const r = uiProjectStations(mkOpt({ stations: stF02, scope: 'all', category: '全部', keyword: '北京', favoriteKeys: favsF02 }));
  assert.deepStrictEqual(names(r), ['北京新闻台', '北京音乐台']);
});
ok('App.searchEverywhere：解除 scope/category、keyword 与 #q.value 保留', () => {
  App.state.scope = 'favorites'; App.state.cat = '新闻'; App.state.keyword = '北京'; App.rowIdx = 3;
  el('q').value = '北京';
  App.searchEverywhere();
  assert.strictEqual(App.state.scope, 'all');
  assert.strictEqual(App.state.cat, '全部');
  assert.strictEqual(App.state.keyword, '北京');
  assert.strictEqual(el('q').value, '北京');
  assert.strictEqual(App.rowIdx, 0);
});
ok('App.setCategory：只改 cat，scope/keyword 不动', () => {
  App.state.scope = 'favorites'; App.state.keyword = '北京';
  App.setCategory('音乐');
  assert.strictEqual(App.state.cat, '音乐');
  assert.strictEqual(App.state.scope, 'favorites');
  assert.strictEqual(App.state.keyword, '北京');
});

console.log('[F03] 最近 20 条：失配过滤、URL 回绑、keyOf 去重、队序不按库序');
const libF03 = [
  { c: '音乐', n: '台A', u: ['http://c/a'] },
  { c: '音乐', n: '台B', u: ['http://c/b1', 'http://c/b2'] }, // 曾名「台B旧名」，按 URL 快照回绑
  { c: '音乐', n: '台C', u: ['http://c/c'] },
];
const resolveF03 = r => libF03.find(s => keyOf(s) === r.k) || libF03.find(s => s.u.some(u => (r.u || []).includes(u))) || null;
ok('失配丢弃 + URL 回绑 + 去重 + 队序=recents 序（不按库序）', () => {
  const recents = [ // 库序 A,B,C；recents 故意让台C在前
    { k: '音乐|台Ghost', u: [] },              // 键/URL 双失配 → 丢
    { k: '音乐|台C', u: [] },                  // → 台C
    { k: '音乐|台B', u: [] },                  // → 台B（键命中，第一次出现）
    { k: '音乐|台B旧名', u: ['http://c/b2'] }, // 键失配 → URL 回绑也命中台B → keyOf 去重跳过
  ];
  const r = uiProjectStations(mkOpt({ stations: libF03, scope: 'recent', recents, resolveRecent: resolveF03 }));
  assert.deepStrictEqual(names(r), ['台C', '台B']); // 无台A（不在 recents）；台B 只出现一次；顺序随 recents 不随库序
});
ok('上限 20：slice(0,20) 生效（超编条目不投影）', () => {
  const recents = [];
  for (let i = 0; i < 22; i++) recents.push({ k: '音乐|台A', u: [] }); // 22 条同台 → 投影内去重后 1 条
  assert.strictEqual(uiProjectStations(mkOpt({ stations: libF03, scope: 'recent', recents, resolveRecent: resolveF03 })).length, 1);
  const many = [];
  for (let i = 0; i < 25; i++) many.push({ k: '音乐|台' + i, u: [] }); // 25 条独立键均失配 → 全丢
  assert.deepStrictEqual([...uiProjectStations(mkOpt({ stations: libF03, scope: 'recent', recents: many, resolveRecent: resolveF03 }))], []);
});
ok('F03 收藏 scope 的 favorites 过滤照常（范围互不冒充）', () => {
  const r = uiProjectStations(mkOpt({ stations: libF03, scope: 'favorites', favoriteKeys: new Set(['音乐|台C']) }));
  assert.deepStrictEqual(names(r), ['台C']);
});

console.log('[F04] 手动隐藏台/分类：visible(true) 仍隐藏');
ok('隐藏台 + 隐藏分类：all=true 也不出现', () => {
  const st = [{ c: '新闻', n: '可见台', u: ['http://d/1'] }, { c: '新闻', n: '被藏台', u: ['http://d/2'], hidden: true }, { c: '体育', n: '藏分类台', u: ['http://d/3'] }];
  const r = uiProjectStations(mkOpt({ stations: st, all: true, hiddenCategories: { '体育': 1 } }));
  assert.deepStrictEqual(names(r), ['可见台']);
});
ok('F04 正在播的隐藏台不豁免（手动是明确意图，§6.2 口径）', () => {
  const s = { c: '新闻', n: '被藏的正在播台', u: ['http://d/9'], hidden: true };
  const r = uiProjectStations(mkOpt({ stations: [s], all: true, playingKey: keyOf(s), connectingKey: keyOf(s) }));
  assert.deepStrictEqual([...r], []);
});
ok('F04 对照：未隐藏的正在播死台可见（同一注入只差 hidden）', () => {
  const s = { c: '新闻', n: '死台正在播', u: ['http://d/8'], health: 'dead' };
  assert.deepStrictEqual(names(uiProjectStations(mkOpt({ stations: [s], playingKey: keyOf(s) }))), ['死台正在播']);
});

console.log('[F05] 自动 dead：正在播/连接中例外；all 仅绕自动 dead');
const stF05 = [
  { c: '新闻', n: '死台A', u: ['http://e/1'], health: 'dead' },
  { c: '新闻', n: '死台B正在播', u: ['http://e/2'], health: 'dead' },
  { c: '新闻', n: '死台C连接中', u: ['http://e/3'], health: 'dead' },
];
ok('默认（showDead=false, all=false）：只剩正在播/连接中', () => {
  const r = uiProjectStations(mkOpt({ stations: stF05, playingKey: keyOf(stF05[1]), connectingKey: keyOf(stF05[2]) }));
  assert.deepStrictEqual(names(r), ['死台B正在播', '死台C连接中']);
});
ok('all=true 绕自动 dead（空态判断「只是被死台隐藏」），但手动隐藏仍不出现', () => {
  const st = [...stF05, { c: '新闻', n: '藏台', u: ['http://e/4'], hidden: true }];
  assert.deepStrictEqual(names(uiProjectStations(mkOpt({ stations: st, all: true }))), ['死台A', '死台B正在播', '死台C连接中']);
});
ok('showDead=true（✗ 无效源开关开）：死台照常显示', () => {
  assert.strictEqual(uiProjectStations(mkOpt({ stations: stF05, showDead: true })).length, 3);
});
ok('手动隐藏 + dead + 正在播叠加：手动优先，任何豁免不越线', () => {
  const s = { c: '新闻', n: '叠加', u: ['http://e/5'], health: 'dead', hidden: true };
  assert.deepStrictEqual([...uiProjectStations(mkOpt({ stations: [s], all: true, showDead: true, playingKey: keyOf(s), connectingKey: keyOf(s) }))], []);
});
ok('健康台正常通过（health 非 dead 不受开关影响）', () => {
  assert.deepStrictEqual(names(uiProjectStations(mkOpt({ stations: [{ c: '新闻', n: '活台', u: ['http://e/6'], health: 'ok' }] }))), ['活台']);
});

console.log('[F06] 切 scope 重置 cat / 分类失效回退 / locatePlaying 语义');
ok('setScope 非法值忽略（旧哨兵 ★收藏 也进不来，状态不被污染）', () => {
  App.state.scope = 'all';
  App.setScope('bogus'); App.setScope(undefined); App.setScope('★收藏'); App.setScope('最近');
  assert.strictEqual(App.state.scope, 'all');
});
ok('setScope("favorites")：cat 重置全部、rowIdx 归零（keyword 不动）', () => {
  App.state.cat = '新闻'; App.rowIdx = 5; App.state.keyword = '北京';
  App.setScope('favorites');
  assert.strictEqual(App.state.scope, 'favorites');
  assert.strictEqual(App.state.cat, '全部');
  assert.strictEqual(App.rowIdx, 0);
  assert.strictEqual(App.state.keyword, '北京');
});
ok('buildCats：分类失效回退「全部」，scope 独立有效不误回 all', () => {
  App.cfg = App.normCfg(null);
  App.state.stations = [{ c: '新闻', n: '台1', u: ['http://f/1'] }];
  App.favs = []; App.recents = [];
  App.state.scope = 'favorites'; App.state.cat = '已消失分类'; App.state.showDead = false;
  App.buildCats();
  assert.strictEqual(App.state.cat, '全部');       // 真实分类失效才回退
  assert.strictEqual(App.state.scope, 'favorites'); // scope 不被牵连
});
ok('buildCats：chip 高亮 = 范围 chip（scope）与分类 chip（cat）各自独立、可同时亮', () => {
  App.state.scope = 'favorites'; App.state.cat = '新闻'; // 组合筛选：收藏 + 分类
  App.buildCats();
  assert.ok(els.cats.innerHTML.includes('class="chip on" data-c="★收藏"'), '收藏范围 chip 高亮');
  assert.ok(els.cats.innerHTML.includes('class="chip on" data-c="新闻"'), '分类 chip 高亮');
  assert.ok(!els.cats.innerHTML.includes('class="chip on" data-c="全部"'), '全部 chip 不亮');
  assert.ok(els.cats.innerHTML.includes('data-c="最近"')); // 三范围入口仍在（紧凑布局保留）
});
ok('§3.2 计数口径：范围计数=全库口径（不含 keyword/category）；分类计数按 scope 不套当前 cat/keyword', () => {
  App.cfg = App.normCfg(null);
  App.state.stations = [
    { c: '新闻', n: '台1', u: ['http://f/1'] },
    { c: '新闻', n: '台2', u: ['http://f/2'] },
    { c: '音乐', n: '台3', u: ['http://f/3'] },
  ];
  App.favs = [{ k: '新闻|台1', u: [] }, { k: '音乐|台3', u: [] }];
  App.recents = [{ k: '音乐|台3', n: '台3', u: [] }];
  App.state.scope = 'favorites'; App.state.cat = '新闻'; App.state.keyword = '台1'; App.state.showDead = false;
  const cc = App.catCounts();
  assert.strictEqual(cc.all, 3);  // 范围计数：不因 keyword=台1 缩成 1
  assert.strictEqual(cc.favN, 2);
  assert.strictEqual(cc.recN, 1);
  assert.strictEqual(cc.m.get('新闻'), 1); // 分类计数按 scope=favorites：不套 cat=新闻（否则音乐为 0）
  assert.strictEqual(cc.m.get('音乐'), 1); // 也不套 keyword=台1（否则音乐为 0）
  App.state.scope = 'all';
  const m3 = App.catCounts();
  assert.strictEqual(m3.m.get('新闻'), 2); // scope=all 时分类计数恢复全量
  assert.strictEqual(m3.m.get('音乐'), 1);
});
ok('F06 locatePlaying：筛选下不可见 → 清 scope/cat/keyword/#q.value', () => {
  App.cfg = App.normCfg(null);
  App.state.stations = [{ c: '新闻', n: '台1', u: ['http://f/1'] }, { c: '新闻', n: '藏台', u: ['http://f/2'], hidden: true }];
  App.favs = []; App.recents = [];
  App.state.scope = 'favorites'; App.state.cat = '全部'; App.state.keyword = '不匹配的词';
  el('q').value = '不匹配的词';
  sandbox.Player.station = App.state.stations[0]; sandbox.Player.connecting = null;
  App.locatePlaying(); // 收藏范围 + 关键词下不可见 → 全部重置
  assert.strictEqual(App.state.scope, 'all');
  assert.strictEqual(App.state.cat, '全部');
  assert.strictEqual(App.state.keyword, '');
  assert.strictEqual(el('q').value, '');
});
ok('F06 locatePlaying：手动隐藏台重置后仍不露行（静默不跳，不抛）', () => {
  sandbox.Player.station = App.state.stations[1];
  App.locatePlaying(); // visible 仍不含隐藏台 → querySelector null → 静默返回
});
ok('F06 locatePlaying：可见台不动任何筛选', () => {
  App.favs = [{ k: '新闻|台1', u: ['http://f/1'] }];
  App.state.scope = 'favorites'; App.state.cat = '全部'; App.state.keyword = '';
  sandbox.Player.station = App.state.stations[0];
  App.locatePlaying();
  assert.strictEqual(App.state.scope, 'favorites');
  assert.strictEqual(App.state.keyword, '');
});
ok('基线全库口径：baselineList 不被 scope/category/keyword 截断（§6.7「搜索不能截断全库基线」）', () => {
  App.cfg = App.normCfg(null);
  App.state.stations = [
    { c: '新闻', n: '台1', u: ['http://f/1'], dCat: '新闻' },
    { c: '欧美音乐', n: 'EU 台', u: ['http://f/9'], dCat: '欧美音乐' }, // 同步期已实测，基线排除
  ];
  App.favs = []; App.recents = [];
  App.state.scope = 'favorites'; App.state.cat = '新闻'; App.state.keyword = '台1'; App.state.showDead = false;
  assert.deepStrictEqual([...App.baselineList()].map(s => s.n), ['台1']); // 全库（除欧美两分类）口径：scope/cat/keyword 不截断
});

console.log('[续听] uiChooseResume 三级候选与 eligible 过滤（§6.3，本批立函数 P2 接 UI）');
ok('current 合格 → origin=current', () => {
  const cur = { c: '新闻', n: '当前台', u: ['http://g/1'] };
  const r = uiChooseResume({ current: cur, resolveCurrent: x => x, recents: [], starters: [], eligible: s => !s.hidden });
  assert.strictEqual(r.origin, 'current');
  assert.strictEqual(r.station.n, '当前台');
});
ok('current 解析失配（resolveCurrent → null）→ 落最近第一条合格', () => {
  const recent = { c: '新闻', n: '最近台', u: ['http://g/2'] };
  const r = uiChooseResume({ current: { k: '幽灵' }, resolveCurrent: () => null, recents: [{}],
    resolveRecent: () => recent, starters: [], eligible: () => true });
  assert.strictEqual(r.origin, 'recent');
  assert.strictEqual(r.station.n, '最近台');
});
ok('current 不合格（eligible=false，如手动隐藏）→ 不复活，落最近', () => {
  const cur = { c: '新闻', n: '被藏的当前台', u: ['http://g/3'], hidden: true };
  const recent = { c: '音乐', n: '最近台', u: ['http://g/4'] };
  const r = uiChooseResume({ current: cur, resolveCurrent: x => x, recents: [{}],
    resolveRecent: () => recent, starters: [], eligible: s => !s.hidden });
  assert.strictEqual(r.origin, 'recent');
});
ok('最近全不合格 → starter；recents 失配条目跳过', () => {
  const starter = { c: '常听', n: '精选台', u: ['http://g/5'] };
  const r = uiChooseResume({ current: null, recents: [{ k: '幽灵1' }, { k: '幽灵2' }],
    resolveRecent: () => null, starters: [starter], eligible: () => true });
  assert.strictEqual(r.origin, 'starter');
  assert.strictEqual(r.station.n, '精选台');
});
ok('三级全不合格 → null（显示「暂无可收听电台」的依据）', () => {
  assert.strictEqual(uiChooseResume({ current: null, recents: [], starters: [{}], eligible: () => false }), null);
});
ok('候选顺序：current → recent → starter 严格逐级（高级合格不探低级）', () => {
  const calls = [];
  const cur = { c: '新闻', n: '当前台', u: ['http://g/6'] };
  const r = uiChooseResume({ current: cur, resolveCurrent: x => { calls.push('cur'); return x; },
    recents: [{}], resolveRecent: () => { calls.push('recent'); return { c: '音乐', n: '最近台', u: [] }; },
    starters: [{ c: '常听', n: '精选台', u: [] }], eligible: () => true });
  assert.strictEqual(r.origin, 'current');
  assert.deepStrictEqual(calls, ['cur']); // recent/starters 未被探测
});

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
