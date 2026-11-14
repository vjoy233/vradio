// 本地收听统计测试（B3-B，plan-expansion-r4 §7.2）：① 纯状态机（lsCreate + fake clock + mock save）——
// 播放/暂停/连接中/失败/切源/跨午夜/时钟回拨/90 天裁剪/体积裁剪/重复 flush 幂等/写盘失败不影响（保增量重试）；
// ② 日期键历法校验（AIbot P1-1：坏日期 fixture 双端同一样本——与 Android ListenStatsTest.坏日期键历法校验丢弃
// 逐键等价）；③ 多标签 ops 合并（AIbot P1-3：同 base 两实例各自增量，最终都在——服务端 op.id 幂等合流）；
// ④ /api/listenstats 端点（真服务）——GET 全量 / POST {baseRev,ops} 增量合并 / op.id 幂等（重放不双计）/
// 双标签并发（两 POST 同 baseRev 不同增量最终都在）/ 405/403/409（schema 含坏日期键）/ 损坏文件按空库恢复。
// 用户数据保护（同 quality 口径）：data/listen-stats.json 先备份 .smokebak，跑完还原现场。
const assert = require('assert'), http = require('http'), net = require('net'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const { lsCreate, lsDayKey, lsDayKeyOk, lsMerge, lsTrim, lsOpsToDays, LSCAPS } = require(path.join(__dirname, '..', 'listen-stats.js'));

const UP = path.join(__dirname, '..');
const LSF = path.join(UP, 'data', 'listen-stats.json'), LSFBAK = LSF + '.smokebak';

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });

/* ---------- ① 纯状态机（fake clock） ---------- */
const base = Date.UTC(2026, 10, 14, 12, 0, 0); // 2026-11-14 12:00Z（本地日桶按本地时区，测试只断言相对关系）
const mkClock = () => { let m = 0, w = base; return { mono: () => m, wall: () => w, adv: ms => { m += ms; w += ms; }, back: ms => { m -= ms; w -= ms; } }; };
const st = u0 => ({ u: [u0], c: '华语音乐', n: '测试台' });
const dayOf = ls => ls.view(); // 本页视图 = base + 未确认 ops

assert.strictEqual(lsDayKey(base).length, 10, '日键形态 YYYY-MM-DD');

Promise.resolve().then(async () => {
await ok('播放累计：PLAYING 5s 入账（ms/台/分类/会话数）', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live'), 'https://a/live'); ls.onState('PLAYING');
  c.adv(5000); ls.tick();
  const d = dayOf(ls)[lsDayKey(base)];
  assert.strictEqual(d.ms, 5000); assert.strictEqual(d.sessions, 1);
  assert.strictEqual(d.stations['https://a/live'], 5000); assert.strictEqual(d.categories['华语音乐'], 5000);
});
await ok('暂停不计时：暂停区间不累加，resume 重锚继续累计（§7.2 冻结口径：同台同源 resume 不开新 session）', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING');
  c.adv(5000); ls.onState('PAUSED');           // 离开 PLAYING 结算 5s
  c.adv(60000); ls.onState('PLAYING');         // resume：重锚，60s 暂停不计
  c.adv(10000); ls.tick();
  assert.strictEqual(dayOf(ls)[lsDayKey(base)].ms, 15000);
  assert.strictEqual(dayOf(ls)[lsDayKey(base)].sessions, 1, 'resume 不开新 session');
});
await ok('暂停期周期 tick/flush 不入账（只 PLAYING 结算；Android PAUSED 即关会话同语义）', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING');
  c.adv(5000); ls.onState('PAUSED');
  c.adv(120000); ls.tick();                    // 暂停 2 分钟后的周期 tick（30s flush 同路）
  assert.strictEqual(dayOf(ls)[lsDayKey(base)].ms, 5000, '暂停时长绝不计入');
});
await ok('暂停后换源重连开新 session（resume 资格只对同台同源；暂停/连接期不计时）', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live'), 'https://a/live'); ls.onState('PLAYING');
  c.adv(5000); ls.onState('PAUSED');           // 结算 5s、保留 resume 资格
  c.adv(60000); ls.onState('CONNECTING');      // 暂停中换源重连
  c.adv(2000); ls.tick();                      // 连接期 tick 不入账
  ls.enterPlaying(st('https://a/live'), 'https://a/alt'); ls.onState('PLAYING');   // 新建流到达
  c.adv(5000); ls.tick();
  const d = dayOf(ls)[lsDayKey(base)];
  assert.strictEqual(d.ms, 10000); assert.strictEqual(d.sessions, 2, '新建流到达 PLAYING = 新 session');
});
await ok('连接中/失败不计时：session 关闭后 tick 无增量', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING');
  c.adv(3000); ls.onState('CONNECTING');       // 断流：结算 3s、关 session
  c.adv(20000); ls.tick(); ls.onState('FAILED');
  c.adv(20000); ls.tick();
  assert.strictEqual(dayOf(ls)[lsDayKey(base)].ms, 3000);
});
await ok('切源：旧 session 结束、新源真进 PLAYING 才建新（sessions 按新建流计数，ms 累计同台）', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live'), 'https://a/live'); ls.onState('PLAYING');
  c.adv(10000); ls.onState('CONNECTING');
  c.adv(1000); ls.enterPlaying(st('https://a/live'), 'https://a/alt'); ls.onState('PLAYING');
  c.adv(5000); ls.tick();
  const d = dayOf(ls)[lsDayKey(base)];
  assert.strictEqual(d.ms, 15000); assert.strictEqual(d.sessions, 2);
  assert.strictEqual(d.stations['https://a/live'], 15000);
});
await ok('诊断成功不算收听：不经 enterPlaying 的状态变化零增量', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.onState('CONNECTING'); c.adv(30000); ls.onState('IDLE'); ls.tick();
  assert.deepStrictEqual(dayOf(ls), {}, '无 session 无增量');
});
await ok('跨午夜拆两日：23:59:30 起播 60s → 两日各 30s', () => {
  const dt = new Date(); dt.setHours(23, 59, 30, 0); // 本地时区午夜锚点（日桶按本地自然日）
  const mid = dt.getTime();
  const ls = lsCreate({ clock: { mono: () => 0, wall: () => mid } });
  ls.cur = { u0: 'https://a/live', cat: 'X', src: '', monoAt: 0, wallAt: mid }; // 手工放置会话锚点（add 的入参单测）
  ls.add(ls.cur, 60000, mid + 60000);
  const k0 = lsDayKey(mid), k1 = lsDayKey(mid + 60000);
  assert.notStrictEqual(k0, k1, '测试锚点必须跨本地午夜');
  assert.strictEqual(ls.view()[k0].ms, 30000);
  assert.strictEqual(ls.view()[k1].ms, 30000);
});
await ok('时钟回拨不出负值：单钟回退重锚、再次前进正常入账', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING');
  c.adv(5000); c.back(8000); ls.tick();        // 回拨 8s（超过已播）
  c.adv(4000); ls.tick();
  assert.ok(dayOf(ls)[lsDayKey(base)].ms >= 0 && dayOf(ls)[lsDayKey(base)].ms <= 4000, '不为负');
});
await ok('90 天裁剪 + 体积超限先删最早日（flush 快照口径）', () => {
  const d2 = {};
  for (let i = 0; i < 100; i++) { const dt = new Date(base - (99 - i) * 86400000); d2[lsDayKey(dt.getTime())] = { ms: 1000, stations: {}, categories: {}, sessions: 1 }; }
  const snap = lsTrim({ v: 1, days: d2 });
  assert.strictEqual(Object.keys(snap.days).length, 90);
  assert.ok(snap.days[lsDayKey(base)], '保最新');
  assert.ok(!snap.days[lsDayKey(base - 90 * 86400000)], '最旧被裁');
  const snap2 = lsTrim({ v: 1, days: d2 }, { cap: 1, sizeFn: () => 9999 }); // 体积超限：逐日删最早直至（此处全删）
  assert.ok(Object.keys(snap2.days).length < 90);
});

/* ---------- ② 日期键历法校验（AIbot P1-1；坏日期 fixture 双端同一样本） ---------- */
const BAD_DAYS = ['2026-02-31', '2026-13-01', '2026-00-10', '2026-11-00', '2026-11-1', '2026-02-29', '2026/11/14', '2026-11-14 ', 'not-a-day', ''];
const GOOD_DAYS = ['2026-11-14', '2024-02-29', '2000-02-29', '2100-02-28'];
await ok('日期键历法校验：坏键全拒（02-31/13-01/月日为零/非闰 02-29/形态不符）', () => {
  for (const k of BAD_DAYS) assert.ok(!lsDayKeyOk(k), `应拒绝：${JSON.stringify(k)}`);
  for (const k of GOOD_DAYS) assert.ok(lsDayKeyOk(k), `应放行：${k}`); // 2024/2000 闰、2100 非闰但 02-28 合法
});
await ok('lsMerge 过滤坏日期键：损坏 sidecar 注入的任意 key 不进快照', () => {
  const src = {};
  for (const k of BAD_DAYS) src[k] = { ms: 999, stations: {}, categories: {}, sessions: 9 };
  src['2026-11-14'] = { ms: 100, stations: {}, categories: {}, sessions: 1 };
  const m = lsMerge(src, null);
  assert.deepStrictEqual(Object.keys(m.days), ['2026-11-14'], '坏键全部拦下、好键保留');
});
await ok('lsTrim 清坏键（不占 90 天名额）', () => {
  const days = { '9999-99-99': { ms: 1, stations: {}, categories: {}, sessions: 1 } };
  for (let i = 0; i < 90; i++) { const dt = new Date(base - (89 - i) * 86400000); days[lsDayKey(dt.getTime())] = { ms: 1, stations: {}, categories: {}, sessions: 1 }; }
  const snap = lsTrim({ v: 1, days });
  assert.strictEqual(Object.keys(snap.days).length, 90, '坏键先清，90 个好键全保');
  assert.ok(!snap.days['9999-99-99']);
});
await ok('pull 装载过滤坏键（load 返回脏数据也不污染 base）', async () => {
  const ls = lsCreate({ load: async () => ({ days: { '2026-02-31': { ms: 5, stations: {}, categories: {}, sessions: 1 }, '2026-11-14': { ms: 7, stations: {}, categories: {}, sessions: 1 } }, rev: 3 }) });
  await ls.pull();
  assert.deepStrictEqual(Object.keys(ls.base.days), ['2026-11-14']);
  assert.strictEqual(ls.baseRev, 3);
});

/* ---------- ③ 多标签 ops 合并（AIbot P1-3；真实端到端见下 ④） ---------- */
const mkServer = () => { // 迷你服务端（与服务端 lsCommit 同语义：op.id 去重 + 日桶累加 + rev 发号）
  let rev = 0; const seen = new Set(), days = {};
  return {
    state: () => ({ rev, days: JSON.parse(JSON.stringify(days)) }),
    commit(ops) {
      let applied = 0;
      for (const op of ops) {
        if (seen.has(op.id)) continue;
        seen.add(op.id);
        const d = days[op.day] || (days[op.day] = { ms: 0, stations: {}, categories: {}, sessions: 0 });
        d.ms += op.ms || 0; d.sessions += op.sess || 0;
        if (op.u0 && op.ms) d.stations[op.u0] = (d.stations[op.u0] || 0) + op.ms;
        applied++;
      }
      if (applied) rev++;
      return { ok: true, rev, applied };
    },
  };
};
await ok('双标签同 base 并发：各自增量 flush，最终两条都在（不再快照覆盖丢一页）', async () => {
  const srv = mkServer();
  const mkTab = c => lsCreate({
    clock: c,
    load: async () => { const s = srv.state(); return { days: s.days, rev: s.rev }; },
    save: async (batch, baseRev) => srv.commit(batch),   // 同 baseRev 各自 POST：服务端增量合流
  });
  const A = mkTab(mkClock()), B = mkTab(mkClock());
  A.enabled = B.enabled = true;
  await A.pull(); await B.pull();                        // 同 base（空库 rev=0）
  A.enterPlaying(st('https://a/live')); A.onState('PLAYING'); A.clock.adv(10000); A.tick();
  B.enterPlaying(st('https://b/live')); B.onState('PLAYING'); B.clock.adv(20000); B.tick();
  await A.flush(); await B.flush();                     // 并发窗口：两页都基于 rev=0 的 base 各自 POST
  const fin = srv.state().days[lsDayKey(base)];
  assert.strictEqual(fin.stations['https://a/live'], 10000, 'A 页增量在');
  assert.strictEqual(fin.stations['https://b/live'], 20000, 'B 页增量在（先写者不被覆盖）');
  assert.strictEqual(fin.sessions, 2);
});
await ok('响应丢失重试不双计：同 op.id 重放 applied=0、日桶不变（服务端幂等兜底）', async () => {
  const srv = mkServer();
  const saved = [];
  const c = mkClock();
  const ls = lsCreate({ clock: c, load: async () => ({ days: {}, rev: 0 }), save: async (batch, baseRev) => { saved.push(batch.slice()); return srv.commit(batch); } });
  ls.enabled = true;
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING'); c.adv(10000); ls.tick();
  await ls.flush();
  // 模拟「服务端已入账但响应在网络上丢失」：客户端拿未确认 ops 重放（同 id）
  const replay = saved[0];
  const r = srv.commit(replay);
  assert.strictEqual(r.applied, 0, '同 op.id 去重');
  assert.strictEqual(srv.state().days[lsDayKey(base)].ms, 10000, '不双计');
});
await ok('写失败保 pending 重试：失败后增量不丢、下次 flush 同 id 补投', async () => {
  const c = mkClock(), posted = [];
  let fail = true;
  const ls = lsCreate({ clock: c, save: async (batch) => { if (fail) throw new Error('disk down'); posted.push(batch.slice()); return { ok: true, rev: 1, applied: batch.length }; } });
  ls.enabled = true;
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING'); c.adv(10000);
  await ls.flush();                                     // 失败：pending 保留
  assert.strictEqual(posted.length, 0); assert.strictEqual(ls.pend.length, 2, 'session op + 10s 增量 op 均未确认'); assert.ok(ls.dirty);
  c.adv(5000); ls.tick();
  fail = false;
  await ls.flush();                                     // 重试：同 op.id 补投 + 新增量随行
  assert.ok(posted.flat().some(o => o.ms === 10000), '失败期增量 10s 在');
  assert.strictEqual(ls.view()[lsDayKey(base)].ms, 15000);
  assert.strictEqual(ls.pend.length, 0, '确认后出队');
});
await ok('重复 flush 幂等：成功后 pending 清零、无新增量不再上送', async () => {
  const c = mkClock(), posted = [];
  const ls = lsCreate({ clock: c, save: async (batch) => { posted.push(batch.slice()); return { ok: true, rev: 1, applied: batch.length }; } });
  ls.enabled = true;
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING'); c.adv(10000);
  await ls.flush();
  await ls.flush();                                     // 无新增量：不再 save
  assert.strictEqual(posted.length, 1, '无新增量不再上送');
  assert.deepStrictEqual(posted[0].map(o => [o.ms, o.sess]).sort((a, b) => b[0] - a[0]), [[10000, 0], [0, 1]], '一批 = session op + 10s 增量 op');
  assert.strictEqual(ls.view()[lsDayKey(base)].ms, 10000);
});
await ok('summary：近 N 日合计 + 今日口径', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING');
  c.adv(120000); ls.tick();
  const s = ls.summary(7);
  assert.strictEqual(s.ms, 120000); assert.strictEqual(s.sessions, 1); assert.strictEqual(s.todayMs, 120000);
});

/* ---------- ④ /api/listenstats 端点（真服务端到端） ---------- */
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
let PORT = 0;
const req = (m, p, headers = {}, body = null) => new Promise((resolve, reject) => {
  if (body != null && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(body);
  const r = http.request({ host: '127.0.0.1', port: PORT, method: m, path: p, headers }, res => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  r.on('error', reject); r.end(body);
});
const boot = () => new Promise(async (resolve, reject) => {
  const srv = spawn(process.execPath, [path.join(UP, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { const r = await req('GET', '/'); if (r.status === 200) return resolve(srv); } catch (_) {}
    if (srv.exitCode !== null) return reject(new Error('server 启动即退出'));
  }
  srv.kill(); reject(new Error('server 6s 未就绪'));
});
const DAY = lsDayKey(base);
const op = (id, ms, extra = {}) => Object.assign({ id, day: DAY, u0: 'https://main.example/live', cat: '华语音乐', ms, sess: 0 }, extra);

const hadLS = fs.existsSync(LSF);
if (hadLS) { fs.copyFileSync(LSF, LSFBAK); fs.unlinkSync(LSF); }
let srv = null;
try {
  PORT = await freePort();
  srv = await boot();

  await ok('方法校验：DELETE /api/listenstats → 405', async () =>
    assert.strictEqual((await req('DELETE', '/api/listenstats')).status, 405));
  await ok('跨源拒绝：POST（Origin: evil）→ 403', async () =>
    assert.strictEqual((await req('POST', '/api/listenstats', { Origin: 'http://evil.com' }, '{}')).status, 403));
  await ok('GET 空库 → {v:1, rev:0, days:{}}', async () => {
    const j = JSON.parse((await req('GET', '/api/listenstats')).body);
    assert.strictEqual(j.v, 1); assert.strictEqual(j.rev, 0); assert.deepStrictEqual(j.days, {});
  });
  await ok('POST 单批 ops → rev=1 applied=2，GET 读回日桶', async () => {
    const r = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' },
      JSON.stringify({ baseRev: 0, ops: [op('t1', 1200000, { sess: 1 }), op('t2', 620000)] }));
    const j = JSON.parse(r.body);
    assert.strictEqual(r.status, 200); assert.strictEqual(j.ok, true); assert.strictEqual(j.rev, 1); assert.strictEqual(j.applied, 2);
    const g = JSON.parse((await req('GET', '/api/listenstats')).body);
    assert.strictEqual(g.rev, 1); assert.strictEqual(g.days[DAY].ms, 1820000);
    assert.strictEqual(g.days[DAY].stations['https://main.example/live'], 1820000);
    assert.strictEqual(g.days[DAY].categories['华语音乐'], 1820000);
    assert.strictEqual(g.days[DAY].sessions, 1);
  });
  await ok('op.id 幂等：重放同批 applied=0、日桶不变、rev 不跳', async () => {
    const r = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' },
      JSON.stringify({ baseRev: 1, ops: [op('t1', 1200000, { sess: 1 }), op('t2', 620000)] }));
    const j = JSON.parse(r.body);
    assert.strictEqual(j.applied, 0); assert.strictEqual(j.rev, 1);
    const g = JSON.parse((await req('GET', '/api/listenstats')).body);
    assert.strictEqual(g.days[DAY].ms, 1820000); assert.strictEqual(g.rev, 1);
  });
  await ok('双标签并发：两页同 baseRev 各自 POST 不同增量，最终两条都在', async () => {
    const rA = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' },
      JSON.stringify({ baseRev: 1, ops: [op('wA1', 10000)] }));
    const rB = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' },
      JSON.stringify({ baseRev: 1, ops: [op('wB1', 20000, { u0: 'https://b/live', cat: '欧美音乐' })] })); // B 页仍基于 rev=1 的 base
    assert.strictEqual(JSON.parse(rA.body).applied, 1);
    assert.strictEqual(JSON.parse(rB.body).applied, 1);   // 增量合流：不因 baseRev 落后拒批
    const g = JSON.parse((await req('GET', '/api/listenstats')).body);
    assert.strictEqual(g.days[DAY].ms, 1820000 + 30000);
    assert.strictEqual(g.days[DAY].stations['https://main.example/live'], 1820000 + 10000, 'A 页在');
    assert.strictEqual(g.days[DAY].stations['https://b/live'], 20000, 'B 页在（后写者不覆盖先写者）');
  });
  await ok('schema 违规 → 409（坏日键含历法无效/坏 URL/负值/裸 JSON/旧快照形态）', async () => {
    for (const bad of [
      { baseRev: 0, ops: [{ id: 'x1', day: '2026-02-31', u0: 'https://a/live', ms: 1 }] },   // 02-31 历法不存在
      { baseRev: 0, ops: [{ id: 'x2', day: '2026-13-01', u0: 'https://a/live', ms: 1 }] },   // 13 月
      { baseRev: 0, ops: [{ id: 'x3', day: DAY, u0: 'ftp://x', ms: 1 }] },                   // 非 http(s) 台键
      { baseRev: 0, ops: [{ id: 'x4', day: DAY, u0: 'https://a/live', ms: -1 }] },           // 负增量
      { baseRev: 0, ops: [{ day: DAY, ms: 1 }] },                                            // 缺 id
      { baseRev: 0, ops: [] },                                                               // 空批
      { v: 1, days: { [DAY]: { ms: 1, stations: {}, categories: {}, sessions: 1 } } },       // 旧全量快照形态（无 ops）
    ]) assert.strictEqual((await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' }, JSON.stringify(bad))).status, 409);
    assert.strictEqual((await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' }, 'not json')).status, 400);
    const many = []; for (let i = 0; i <= LSCAPS.opsMax; i++) many.push(op('sp' + i, 1));
    assert.strictEqual((await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' },
      JSON.stringify({ baseRev: 0, ops: many }))).status, 409, '超单批上限 64');
  });

  // 损坏恢复：写坏 listen-stats.json 后重启服务——按空库恢复且不碰磁盘外数据
  srv.kill(); srv = null;
  fs.mkdirSync(path.dirname(LSF), { recursive: true });
  fs.writeFileSync(LSF, '{broken json');
  PORT = await freePort();
  srv = await boot();
  await ok('损坏 listen-stats.json → 按空库恢复（rev 归零）', async () => {
    const j = JSON.parse((await req('GET', '/api/listenstats')).body);
    assert.strictEqual(j.v, 1); assert.strictEqual(j.rev, 0); assert.deepStrictEqual(j.days, {});
  });
} finally {
  if (srv) srv.kill();
  try { fs.unlinkSync(LSF); fs.unlinkSync(LSF + '.tmp'); } catch (_) {}
  if (hadLS) { try { fs.copyFileSync(LSFBAK, LSF); fs.unlinkSync(LSFBAK); } catch (_) {} }
}
console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
}).catch(e => { console.error('listen-stats 测试异常：', e); process.exit(1); });
