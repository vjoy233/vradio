// 本地收听统计测试（B3-B，plan-expansion-r4 §7.2）：① 纯状态机（lsCreate + fake clock + mock save）——
// 播放/暂停/连接中/失败/切源/跨午夜/时钟回拨/90 天裁剪/体积裁剪/重复 flush 幂等/写盘失败不影响（保增量重试）；
// ② /api/listenstats 端点（真服务）——GET 全量/POST 快照覆盖/405/403/400/损坏文件按空库恢复。
// 用户数据保护（同 quality 口径）：data/listen-stats.json 先备份 .smokebak，跑完还原现场。
const assert = require('assert'), http = require('http'), net = require('net'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const { lsCreate, lsDayKey, lsMerge, lsTrim } = require(path.join(__dirname, '..', 'listen-stats.js'));

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
const dayOf = ls => ls.delta.days;

assert.strictEqual(lsDayKey(base).length, 10, '日键形态 YYYY-MM-DD');

Promise.resolve().then(async () => {
await ok('播放累计：PLAYING 5s 入账（ms/台/分类/会话数）', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live'), 'https://a/live');
  c.adv(5000); ls.tick();
  const d = dayOf(ls)[lsDayKey(base)];
  assert.strictEqual(d.ms, 5000); assert.strictEqual(d.sessions, 1);
  assert.strictEqual(d.stations['https://a/live'], 5000); assert.strictEqual(d.categories['华语音乐'], 5000);
});
await ok('暂停不计时：暂停区间不累加，resume 重锚继续累计', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING');
  c.adv(5000); ls.onState('PAUSED');           // 离开 PLAYING 结算 5s
  c.adv(60000); ls.onState('PLAYING');         // resume：重锚，60s 暂停不计
  c.adv(10000); ls.tick();
  assert.strictEqual(dayOf(ls)[lsDayKey(base)].ms, 15000);
  assert.strictEqual(dayOf(ls)[lsDayKey(base)].sessions, 1, 'resume 不开新 session');
});
await ok('连接中/失败不计时：session 关闭后 tick 无增量', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING');
  c.adv(3000); ls.onState('CONNECTING');       // 断流：结算 3s、关 session
  c.adv(20000); ls.tick(); ls.onState('FAILED');
  c.adv(20000); ls.tick();
  assert.strictEqual(dayOf(ls)[lsDayKey(base)].ms, 3000);
});
await ok('切源：旧 session 结束、新源真进 PLAYING 才建新（sessions 按进入次数，ms 累计同台）', () => {
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
  assert.strictEqual(ls.delta.days[k0].ms, 30000);
  assert.strictEqual(ls.delta.days[k1].ms, 30000);
});
await ok('时钟回拨不出负值：单钟回退重锚、再次前进正常入账', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING');
  c.adv(5000); c.back(8000); ls.tick();        // 回拨 8s（超过已播）
  c.adv(4000); ls.tick();
  assert.ok(dayOf(ls)[lsDayKey(base)].ms >= 0 && dayOf(ls)[lsDayKey(base)].ms <= 4000, '不为负');
});
await ok('90 天裁剪 + 体积超限先删最早日（flush 快照口径）', () => {
  const days = {};
  for (let i = 0; i < 100; i++) days['2026-0' + ((i % 9) + 1) + '-01'] = { ms: 1000, stations: {}, categories: {}, sessions: 1 };
  // 用真实递增日期构造（上面的键有重复，改用真序列）
  const d2 = {};
  for (let i = 0; i < 100; i++) { const dt = new Date(base - (99 - i) * 86400000); d2[lsDayKey(dt.getTime())] = { ms: 1000, stations: {}, categories: {}, sessions: 1 }; }
  const snap = lsTrim({ v: 1, days: d2 });
  assert.strictEqual(Object.keys(snap.days).length, 90);
  assert.ok(snap.days[lsDayKey(base)], '保最新');
  assert.ok(!snap.days[lsDayKey(base - 90 * 86400000)], '最旧被裁');
  const snap2 = lsTrim({ v: 1, days: d2 }, { cap: 1, sizeFn: () => 9999 }); // 体积超限：逐日删最早直至（此处全删）
  assert.ok(Object.keys(snap2.days).length < 90);
});
await ok('重复 flush 幂等：成功后 delta 清零、无新增量不再落盘；重试重放同一快照不双计', async () => {
  const c = mkClock(), saved = [];
  const ls = lsCreate({ clock: c, save: async s => { saved.push(JSON.parse(JSON.stringify(s))); } });
  ls.enabled = true;
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING');
  c.adv(10000);
  await ls.flush();
  await ls.flush(); // 无新增量：不再 save
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].days[lsDayKey(base)].ms, 10000);
  c.adv(5000);
  await ls.flush();
  assert.strictEqual(saved.length, 2);
  assert.strictEqual(saved[1].days[lsDayKey(base)].ms, 15000, '增量叠 base，不双计');
});
await ok('写盘失败不影响：保内存增量、下次 flush 重试成功（不阻播）', async () => {
  const c = mkClock(), saved = [];
  let fail = true;
  const ls = lsCreate({ clock: c, save: async s => { if (fail) throw new Error('disk full'); saved.push(s); } });
  ls.enabled = true;
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING');
  c.adv(10000);
  await ls.flush(); // 失败：delta 保留
  assert.strictEqual(saved.length, 0); assert.ok(ls.dirty);
  c.adv(5000);
  fail = false;
  await ls.flush(); // 重试：一次入账 15s
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].days[lsDayKey(base)].ms, 15000);
});
await ok('lsMerge：base+delta 深合并、不改入参、多标签语义（他页增量已在 base）', () => {
  const b = { '2026-11-14': { ms: 100, stations: { 'https://a/live': 100 }, categories: {}, sessions: 1 } };
  const d = { '2026-11-14': { ms: 50, stations: { 'https://a/live': 50 }, categories: {}, sessions: 1 } };
  const m = lsMerge(b, d);
  assert.strictEqual(m.days['2026-11-14'].ms, 150);
  assert.strictEqual(m.days['2026-11-14'].stations['https://a/live'], 150);
  assert.strictEqual(m.days['2026-11-14'].sessions, 2);
  assert.strictEqual(b['2026-11-14'].ms, 100, '入参不被改写');
});
await ok('summary：近 N 日合计 + 今日口径', () => {
  const c = mkClock(), ls = lsCreate({ clock: c });
  ls.enterPlaying(st('https://a/live')); ls.onState('PLAYING');
  c.adv(120000); ls.tick();
  const s = ls.summary(7);
  assert.strictEqual(s.ms, 120000); assert.strictEqual(s.sessions, 1); assert.strictEqual(s.todayMs, 120000);
});

/* ---------- ② /api/listenstats 端点（真服务端到端） ---------- */
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

const hadLS = fs.existsSync(LSF);
if (hadLS) { fs.copyFileSync(LSF, LSFBAK); fs.unlinkSync(LSF); }
let srv = null;
try {
  PORT = await freePort();
  srv = await boot();
  const DAY1 = { ms: 1820000, stations: { 'https://main.example/live': 1200000 }, categories: { '华语音乐': 1200000 }, sessions: 3 };

  await ok('方法校验：DELETE /api/listenstats → 405', async () =>
    assert.strictEqual((await req('DELETE', '/api/listenstats')).status, 405));
  await ok('跨源拒绝：POST（Origin: evil）→ 403', async () =>
    assert.strictEqual((await req('POST', '/api/listenstats', { Origin: 'http://evil.com' }, '{}')).status, 403));
  await ok('GET 空库 → {v:1, days:{}}', async () => {
    const j = JSON.parse((await req('GET', '/api/listenstats')).body);
    assert.strictEqual(j.v, 1); assert.deepStrictEqual(j.days, {});
  });
  await ok('POST 合法快照 → ok，GET 读回同构', async () => {
    const r = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' }, JSON.stringify({ v: 1, days: { '2026-11-14': DAY1 } }));
    assert.strictEqual(JSON.parse(r.body).ok, true);
    const j = JSON.parse((await req('GET', '/api/listenstats')).body);
    assert.deepStrictEqual(j.days['2026-11-14'], DAY1);
  });
  await ok('POST 快照覆盖语义：重放同一快照结果一致（幂等）', async () => {
    await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' }, JSON.stringify({ v: 1, days: { '2026-11-14': DAY1 } }));
    const j = JSON.parse((await req('GET', '/api/listenstats')).body);
    assert.deepStrictEqual(j.days['2026-11-14'], DAY1);
  });
  await ok('schema 违规 → 400（坏日键/坏 URL/负值/裸 JSON）', async () => {
    for (const bad of [
      { v: 1, days: { '2026/11/14': DAY1 } },
      { v: 1, days: { '2026-11-14': { ms: -1, stations: {}, categories: {}, sessions: 1 } } },
      { v: 1, days: { '2026-11-14': { ms: 1, stations: { 'ftp://x': 1 }, categories: {}, sessions: 1 } } },
      { v: 2, days: {} },
    ]) assert.strictEqual((await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' }, JSON.stringify(bad))).status, 400);
    assert.strictEqual((await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' }, 'not json')).status, 400);
  });

  // 损坏恢复：写坏 listen-stats.json 后重启服务——按空库恢复且不碰磁盘外数据
  srv.kill(); srv = null;
  fs.mkdirSync(path.dirname(LSF), { recursive: true });
  fs.writeFileSync(LSF, '{broken json');
  PORT = await freePort();
  srv = await boot();
  await ok('损坏 listen-stats.json → 按空库恢复', async () => {
    const j = JSON.parse((await req('GET', '/api/listenstats')).body);
    assert.strictEqual(j.v, 1); assert.deepStrictEqual(j.days, {});
  });
} finally {
  if (srv) srv.kill();
  try { fs.unlinkSync(LSF); fs.unlinkSync(LSF + '.tmp'); } catch (_) {}
  if (hadLS) { try { fs.copyFileSync(LSFBAK, LSF); fs.unlinkSync(LSFBAK); } catch (_) {} }
}
console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
}).catch(e => { console.error('listen-stats 测试异常：', e); process.exit(1); });
