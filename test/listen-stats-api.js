// 本地收听统计 /api/listenstats 端到端（L2，AIbot review#39 第 4 条：从 listen-stats.js 拆出——纯状态机部分
// 留原文件进 unit profile，真服务部分在此进 api profile）。覆盖：GET 全量 / GET ?rev= 条件获取（同 rev
// notModified、rev 推进回全量）/ POST {baseRev,ops} 增量合并 / op.id 幂等（重放不双计）/ 双标签并发（两 POST
// 同 baseRev 不同增量最终都在）/ 405/403/409（schema 含坏日期键，409 响应带机器可读 code）/ replace 覆盖导入
// （v3 备份 sidecar）/ 损坏文件重启恢复。
// 隔离：makeRoot 建独立应用根 + boot({root})——data/listen-stats.json 写盘全在根内（宿主零接触，无需备份还原）；
// 损坏恢复用例杀服后 boot({root}) 同根重启（写坏文件 → 重启 → 按空库恢复）。
const assert = require('assert'), fs = require('fs'), path = require('path');
const { boot, makeRoot, addCleanup } = require('./harness/api-client');
const { lsDayKey, LSCAPS } = require(path.join(__dirname, '..', 'listen-stats.js'));

const base = Date.UTC(2026, 10, 14, 12, 0, 0); // 与 listen-stats.js 状态机用例同一锚点（小段复制：拆层两文件各自自持）
const DAY = lsDayKey(base);
const op = (id, ms, extra = {}) => Object.assign({ id, day: DAY, u0: 'https://main.example/live', cat: '华语音乐', ms, sess: 0 }, extra);

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });

(async () => {
  const ROOTX = makeRoot(); // 手动建根：损坏恢复用例需要「杀服 → 改盘 → 同根重启」，根须测试自管
  addCleanup(() => { try { fs.rmSync(ROOTX, { recursive: true, force: true }); } catch (_) {} });
  const LSF = () => path.join(ROOTX, 'data', 'listen-stats.json');
  let srv = null;
  try {
    srv = await boot({ root: ROOTX });
    const req = srv.req;

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
    await ok('GET ?rev= 条件获取：同 rev → notModified（不传 days）、rev 推进 → 全量', async () => {
      const rev0 = JSON.parse((await req('GET', '/api/listenstats')).body).rev;
      const nm = JSON.parse((await req('GET', '/api/listenstats?rev=' + rev0)).body);
      assert.strictEqual(nm.rev, rev0); assert.strictEqual(nm.notModified, true);
      assert.ok(!nm.days, '命中当前版本不重复传输全量');
      const pr = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' },
        JSON.stringify({ baseRev: rev0, ops: [op('rv1', 5000)] }));
      const rev1 = JSON.parse(pr.body).rev;
      const full = JSON.parse((await req('GET', '/api/listenstats?rev=' + rev0)).body);
      assert.ok(!full.notModified && full.days, 'rev 变化返回全量 days');
      assert.strictEqual(full.rev, rev1);
      const nm2 = JSON.parse((await req('GET', '/api/listenstats?rev=' + rev1)).body);
      assert.strictEqual(nm2.notModified, true, '追平新 rev 再命中');
    });
    await ok('schema 违规 → 409 + code:schema / 超单批 → 409 + code:batch-limit（机器可读分类，AIbot 复核 P1）', async () => {
      for (const bad of [
        { baseRev: 0, ops: [{ id: 'x1', day: '2026-02-31', u0: 'https://a/live', ms: 1 }] },   // 02-31 历法不存在
        { baseRev: 0, ops: [{ id: 'x2', day: '2026-13-01', u0: 'https://a/live', ms: 1 }] },   // 13 月
        { baseRev: 0, ops: [{ id: 'x3', day: DAY, u0: 'ftp://x', ms: 1 }] },                   // 非 http(s) 台键
        { baseRev: 0, ops: [{ id: 'x4', day: DAY, u0: 'https://a/live', ms: -1 }] },           // 负增量
        { baseRev: 0, ops: [{ day: DAY, ms: 1 }] },                                            // 缺 id
        { baseRev: 0, ops: [] },                                                               // 空批
        { v: 1, days: { [DAY]: { ms: 1, stations: {}, categories: {}, sessions: 1 } } },       // 旧全量快照形态（无 ops）
      ]) {
        const r = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' }, JSON.stringify(bad));
        assert.strictEqual(r.status, 409, JSON.stringify(bad));
        assert.strictEqual(JSON.parse(r.body).code, 'schema', 'schema 来源带 code');
      }
      assert.strictEqual((await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' }, 'not json')).status, 400);
      const many = []; for (let i = 0; i <= LSCAPS.opsMax; i++) many.push(op('sp' + i, 1));
      const r2 = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' },
        JSON.stringify({ baseRev: 0, ops: many }));
      assert.strictEqual(r2.status, 409, '超单批上限 64');
      assert.strictEqual(JSON.parse(r2.body).code, 'batch-limit', '批量超限来源带 code');
    });

    // —— B4 v3 备份 sidecar 覆盖导入：POST {replace:true,days}（lsTrimImport 白名单 + 超限整体拒绝）——
    await ok('replace 覆盖导入：days 全量替换 + rev 推进 + 坏字段静默裁剪（白名单纪律）', async () => {
      const before = JSON.parse((await req('GET', '/api/listenstats')).body);
      const r = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' }, JSON.stringify({ replace: true,
        days: {
          '2026-11-14': { ms: '1800000', sessions: 2.9, stations: { 'ftp://x': 5, 'https://new.example/live': '7000.9' }, categories: { ['长'.repeat(25)]: 1, '华语音乐': 3 } },
          '2026-02-30': { ms: 999 },                                     // 非历法日：丢弃
        } }));
      assert.strictEqual(r.status, 200);
      const g = JSON.parse((await req('GET', '/api/listenstats')).body);
      assert.strictEqual(g.rev, before.rev + 1, 'replace 也走 rev 唯一发号');
      assert.deepStrictEqual(g.days, { '2026-11-14': { ms: 1800000, sessions: 2, stations: { 'https://new.example/live': 7000 }, categories: { '华语音乐': 3 } } });
    });
    await ok('replace 后旧 op 重放不复活旧数据（op 去重日志跨 replace 保留）', async () => {
      const pr = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' },
        JSON.stringify({ baseRev: 0, ops: [op('pre-replace-1', 1000)] }));
      const before = JSON.parse((await req('GET', '/api/listenstats')).body);
      assert.strictEqual((await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' },
        JSON.stringify({ replace: true, days: {} }))).status, 200);   // 清空
      const rp = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' },
        JSON.stringify({ baseRev: 0, ops: [op('pre-replace-1', 1000)] })); // 重放 replace 前已入账的 op
      assert.strictEqual(JSON.parse(rp.body).applied, 0, '去重日志保留：重放 applied=0');
      const g = JSON.parse((await req('GET', '/api/listenstats')).body);
      assert.deepStrictEqual(g.days, {}, 'replace 后旧增量不得复活');
      assert.strictEqual(g.rev, before.rev + 1, '重放 applied=0 不发新号');
    });
    await ok('replace 超限/形态违规 → 409 整体拒绝（>90 日、非对象 days）', async () => {
      const many = {}; for (let i = 0; i < 91; i++) many[lsDayKey(base + i * 86400000)] = { ms: 1, sessions: 1 }; // 历法合法的 91 个连续日
      const r = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' }, JSON.stringify({ replace: true, days: many }));
      assert.strictEqual(r.status, 409, '91 个合法日 > sidecar 保留期 90');
      assert.ok(JSON.parse(r.body).error.includes('不合法或超限'));
      for (const bad of [null, 'x', [1]]) {                              // 非对象 days 一律整体拒绝
        const rb = await req('POST', '/api/listenstats', { 'Content-Type': 'application/json' }, JSON.stringify({ replace: true, days: bad }));
        assert.strictEqual(rb.status, 409, 'days=' + JSON.stringify(bad));
      }
    });

    // 损坏恢复：杀服 → 写坏根内 listen-stats.json → boot({root}) 同根重启——按空库恢复且不碰磁盘外数据
    await srv.close(); srv = null;
    fs.mkdirSync(path.dirname(LSF()), { recursive: true });
    fs.writeFileSync(LSF(), '{broken json');
    srv = await boot({ root: ROOTX });
    await ok('损坏 listen-stats.json → 按空库恢复（rev 归零）', async () => {
      const j = JSON.parse((await srv.req('GET', '/api/listenstats')).body);
      assert.strictEqual(j.v, 1); assert.strictEqual(j.rev, 0); assert.deepStrictEqual(j.days, {});
    });
  } finally {
    if (srv) { try { await srv.close(); } catch (_) {} }
    try { fs.rmSync(ROOTX, { recursive: true, force: true }); } catch (_) {} // SIGINT 兜底外的正常路径清理（幂等）
  }
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('listen-stats-api 测试异常：', e); process.exit(1); });
