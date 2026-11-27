// 发现页纯派生测试（B3-C，plan-expansion-r4 §7.3）：buildDiscovery 是纯函数（数据全注入、Node 直跑即证明
// 不产生网络请求）。覆盖：originMask 精选命中、无质量数据不进质量分组（unknown 计数）、稳定直连判定
// （good 且 directCount>0）、最近新增（firstSeenAt 排序/无 meta 为空）、最近恢复（只认转移记录）、有曲讯
// （metadata==icy）、未听过（键/URL 双口径）、手动隐藏彻底过滤、dead 默认过滤（正在播例外）、每组 20 上限、
// 排序稳定（时间降序 + identityUrl 字典序）、同一台跨组不重复。
const assert = require('assert'), path = require('path');
const { buildDiscovery } = require(path.join(__dirname, '..', 'app.js'));

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); } };

const row = (i, extra = {}) => Object.assign({
  k: '华语音乐|台' + i, n: '台' + i, c: '华语音乐', u0: 'https://s' + i + '/live', u: ['https://s' + i + '/live'],
  hidden: false, dead: false, om: 0,
}, extra);
const qa = (extra = {}) => Object.assign({ identityUrl: '', sourceCount: 1, directCount: 1, okCount: 10, failCount: 0,
  lastOkAt: 0, lastFailAt: 0, lastPlaybackAt: 0, lastObservedAt: 0, avgLatencyMs: 100, disconnects: 0,
  metadata: 'icy', stability: 'unknown' }, extra);
const run = (rows, opt = {}) => buildDiscovery(Object.assign({
  rows, quality: (u0) => opt.q && opt.q[u0] || null, meta: opt.meta || null,
  recents: opt.recents || [], revives: opt.revives || new Map(),
  playingKey: opt.playingKey || '', connectingKey: opt.connectingKey || '',
}, opt.input || {}));
const names = g => g.map(r => r.n);

ok('originMask 精选：om 位命中 → starter 组（不按 u[0] 字面比对 STARTER）', () => {
  const d = run([row(1, { om: 1 }), row(2, { om: 0 })]);
  assert.deepStrictEqual(names(d.groups.starter), ['台1']);
});
ok('无质量数据：不进稳定直连（unknown 计数供 UI 提示，绝不误判 poor）', () => {
  const d = run([row(1)]);
  assert.deepStrictEqual(d.groups.stable, []);
  assert.strictEqual(d.unknown, 1);
});
ok('稳定直连：stability=good 且 directCount>0 才入；good 但全 hls 源/非 good 不入', () => {
  const d = run([row(1), row(2), row(3)], { q: {
    'https://s1/live': qa({ stability: 'good', directCount: 1 }),
    'https://s2/live': qa({ stability: 'good', directCount: 0 }),
    'https://s3/live': qa({ stability: 'poor', directCount: 1 }),
  } });
  assert.deepStrictEqual(names(d.groups.stable), ['台1']);
});
ok('最近新增：按 firstSeenAt 降序；无 meta 该组为空', () => {
  const d = run([row(1), row(2)], { meta: { stations: { 'https://s2/live': { firstSeenAt: 200 }, 'https://s1/live': { firstSeenAt: 100 } } } });
  assert.deepStrictEqual(names(d.groups.fresh), ['台2', '台1']);
  const d2 = run([row(1)]);
  assert.deepStrictEqual(d2.groups.fresh, []);
});
ok('最近新增：radio-meta 真实形态（firstSeenAt 挂 source 上）取最早源', () => {
  const d = run([row(1), row(2)], { meta: { stations: {
    'https://s1/live': { name: '台1', category: 'X', sources: [{ url: 'https://s1/live', firstSeenAt: 300 }] },
    'https://s2/live': { name: '台2', category: 'X', sources: [{ url: 'https://s2/live', firstSeenAt: 900 }, { url: 'https://s2/alt', firstSeenAt: 100 }] },
  } } });
  assert.deepStrictEqual(names(d.groups.fresh), ['台1', '台2']); // 台2 取最早源 100 < 台1 300
});
ok('最近恢复：只认 revives 转移记录（无记录不猜测）', () => {
  const d = run([row(1), row(2)], { revives: new Map([['https://s1/live', 123]]) });
  assert.deepStrictEqual(names(d.groups.revived), ['台1']);
});
ok('有曲讯：metadata==icy 才入（none/mixed 不入）', () => {
  const d = run([row(1), row(2), row(3)], { q: {
    'https://s1/live': qa({ metadata: 'icy' }), 'https://s2/live': qa({ metadata: 'none' }), 'https://s3/live': qa({ metadata: 'mixed' }),
  } });
  assert.deepStrictEqual(names(d.groups.icy), ['台1']);
});
ok('未听过：不在 radio.recents（键或任一源 URL 命中即算听过）', () => {
  const d = run([row(1), row(2), row(3, { u: ['https://s3/live', 'https://rec/x'] })],
    { recents: [{ k: '华语音乐|台1', u: ['https://s1/live'] }, { k: '别的|gone', u: ['https://rec/x'] }] });
  assert.deepStrictEqual(names(d.groups.unheard), ['台2']);
});
ok('手动隐藏：彻底过滤（含精选位，无正在播例外）', () => {
  const d = run([row(1, { om: 1, hidden: true })], { playingKey: '华语音乐|台1' });
  assert.deepStrictEqual(d.groups.starter, []);
  assert.strictEqual(d.unknown, 0);
});
ok('dead 默认过滤；正在播/连接中例外（口径沿用 visible）', () => {
  const d0 = run([row(1, { dead: true })], { q: { 'https://s1/live': qa({ stability: 'good' }) } });
  assert.deepStrictEqual(d0.groups.stable, []);
  const d1 = run([row(1, { dead: true })], { playingKey: '华语音乐|台1', q: { 'https://s1/live': qa({ stability: 'good' }) } });
  assert.deepStrictEqual(names(d1.groups.stable), ['台1']);
  const d2 = run([row(1, { dead: true })], { connectingKey: '华语音乐|台1' });
  assert.deepStrictEqual(names(d2.groups.unheard), ['台1']);
});
ok('排序：lastObservedAt 降序、平局 identityUrl 字典序（fresh 用 firstSeenAt）', () => {
  const q = { 'https://s1/live': qa({ lastObservedAt: 300 }), 'https://s2/live': qa({ lastObservedAt: 500 }), 'https://s3/live': qa({ lastObservedAt: 300 }) };
  const d = run([row(1), row(2), row(3)], { q });
  assert.deepStrictEqual(names(d.groups.unheard), ['台2', '台1', '台3']); // 300 平局按 u0 字典序 s1 < s3
});
ok('每组 20 上限（候选多时截断，组内不重复）', () => {
  const rows = [];
  for (let i = 1; i <= 25; i++) rows.push(row(i, { om: 1 }));
  const d = run(rows);
  assert.strictEqual(d.groups.starter.length, 20);
  assert.strictEqual(new Set(names(d.groups.starter)).size, 20);
});
ok('同一台可跨组：精选 + 未听过 + 稳定直连同时命中', () => {
  const d = run([row(1, { om: 1 })], { q: { 'https://s1/live': qa({ stability: 'good', directCount: 1, metadata: 'icy' }) } });
  assert.deepStrictEqual(names(d.groups.starter), ['台1']);
  assert.deepStrictEqual(names(d.groups.stable), ['台1']);
  assert.deepStrictEqual(names(d.groups.icy), ['台1']);
  assert.deepStrictEqual(names(d.groups.unheard), ['台1']);
});
ok('纯函数：Node 直跑无 DOM/网络依赖（不产生网络请求）', () => {
  const d = run([row(1)]); // 在无 fetch/document 的 Node 侧同步完成即证明本地派生
  assert.ok(d && d.groups);
});

ok('验证仅接受关联源的近期同步事实，排除过期、未来和未知证明', () => {
  const now = 40 * 86400000, mk = (url, t, verification = 'sync') => ({url, lastVerifiedAt:t, verification});
  const rows = [row(1), row(2), row(3), row(4), row(5)];
  const meta = {stations:{}};
  rows.forEach((r, i) => { meta.stations[r.u0] = {sources:[mk(r.u0, [now-1, now-30*86400000, now+1, now-2, now-3][i], i === 3 ? 'unknown' : 'sync')]}; });
  meta.stations[rows[4].u0].sources[0].url = 'https://unrelated';
  assert.deepStrictEqual(names(run(rows, {meta, input:{now}}).groups.recentlyVerified), ['台1']);
});
ok('质量关注仅取可信差异样本，来源混合且不推断分类', () => {
  const { qExplain } = require('../quality-store');
  const now = 10000, rows = [row(1, { origins:['personal','adjusted'] }), row(2)];
  const meta = {stations:{'https://s1/live':{sources:[{url:'https://s1/live',upstream:'gao'}]}}};
  const d = run(rows, {meta, q:{'https://s1/live':qa({okCount:2,failCount:1,lastObservedAt:9000,stability:'fair'})}, input:{now,explain:qExplain}});
  assert.deepStrictEqual(names(d.groups.needsAttention), ['台1']);
  assert.deepStrictEqual(d.groups.needsAttention[0].origins, ['adjusted','gao','personal']);
  assert.strictEqual(d.groups.unheard.find(x => x.n === '台2').explain.level, 'unknown');
});
ok('跨端共享 fixture：全部分组及排序、可见性和 URL 回绑', () => {
  const f = require('../contracts/fixtures/discovery.json');
  const rows = f.stations.map(s => ({ k:'X|'+s.name, n:s.name, c:'X', u0:s.id, u:[s.id], om:s.starter, hidden:s.hidden, dead:s.dead }));
  const q = {}, stations = {}, revives = new Map();
  f.stations.forEach(s => {
    if (s.quality) q[s.id] = s.quality;
    stations[s.id] = {firstSeenAt:s.firstSeenAt, sources:[{url:s.id, verification:'sync', lastVerifiedAt:s.verifiedAt}]};
    if (s.recoveredAt) revives.set(s.id, s.recoveredAt);
  });
  const d = buildDiscovery({rows, quality:u => q[u] || null, meta:{stations}, revives,
    recents:[{u:f.recentUrls}], playingKey:'X|'+f.playing, connectingKey:'X|'+f.connecting, now:f.now,
    explain:q => ({level:q && q.stability || 'unknown', action:q && q.stability === 'fair' ? 'retest' : 'none'})});
  for (const key of Object.keys(f.expected)) assert.deepStrictEqual(names(d.groups[key]), f.expected[key], key);
});
console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
