// 质量 sidecar API 测试（B0 骨架 + B2 聚合形态，契约 contracts/quality-summary.json）：真服务端到端——
// 方法校验、跨源拒绝、rev 发号/条件获取（notModified）、op.id 幂等（重试不重复计数）、
// 多标签同 baseRev 并发合流、keep 保护集附带（B2 trim 落地）、schema/批量/字节上限 409 均带机器可读
// code=schema|batch-limit|too-large（AIbot PR#26 复核 P2，客户端 flush 分类处置的契约面）、损坏文件按空库恢复；
// 耗尽/断流路径空 mode 事件经客户端入口归一后不再 409（AIbot P1-1）、服务端枚举保持严格。
// /api/myradio 行清洗与封顶。B2 起服务端聚合走 quality-store.js 纯函数（每台 {cf, sources:{源URL:{…}}}
// 内层形态与 Android 一致；包装层 {v,rev,ops,data} vs {v,stations} 见契约 files 节）；纯函数单测见 test/quality-store.js。
// 用户数据保护（同 smoke 口径）：my-radio.txt 与 data/quality.json 先备份 .smokebak，跑完还原现场。
const assert = require('assert'), http = require('http'), net = require('net'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const UP = path.join(__dirname, '..');
const MY = path.join(UP, 'my-radio.txt'), MYBAK = MY + '.smokebak';
const QF = path.join(UP, 'data', 'quality.json'), QFBAK = QF + '.smokebak';

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
const boot = (extraEnv = {}) => new Promise(async (resolve, reject) => {
  const srv = spawn(process.execPath, [path.join(UP, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ...extraEnv }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { const r = await req('GET', '/'); if (r.status === 200) return resolve(srv); } catch (_) {}
    if (srv.exitCode !== null) return reject(new Error('server 启动即退出'));
  }
  srv.kill(); reject(new Error('server 6s 未就绪'));
});

const op = (id, ok, at, extra = {}) => Object.assign({
  id, identityUrl: 'https://main.example/live', sourceUrl: 'https://main.example/live',
  kind: 'diagnostic', trigger: 'manual', ok, latencyMs: ok ? 320 : 0, bytes: ok ? 12000 : 0, mode: 'direct', at
}, extra);

(async () => {
  const hadMy = fs.existsSync(MY), hadQ = fs.existsSync(QF);
  if (hadMy) { fs.copyFileSync(MY, MYBAK); fs.unlinkSync(MY); }
  if (hadQ) { fs.copyFileSync(QF, QFBAK); fs.unlinkSync(QF); }
  process.on('SIGINT', () => {
    try {
      if (fs.existsSync(MYBAK)) { fs.copyFileSync(MYBAK, MY); fs.unlinkSync(MYBAK); }
      if (fs.existsSync(QFBAK)) { fs.copyFileSync(QFBAK, QF); fs.unlinkSync(QFBAK); }
    } catch (_) {}
    process.exit(130);
  });
  let srv = null, pass = 0, fail = 0;
  const ok = (name, fn) => Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ✓', name); },
    e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });
  try {
    PORT = await freePort();
    srv = await boot();

    await ok('方法校验：DELETE /api/quality → 405', async () =>
      assert.strictEqual((await req('DELETE', '/api/quality')).status, 405));
    await ok('跨源拒绝：GET /api/quality（Origin: evil）→ 403', async () =>
      assert.strictEqual((await req('GET', '/api/quality', { Origin: 'http://evil.com' })).status, 403));
    await ok('GET /api/myradio → 405（只收 POST）', async () =>
      assert.strictEqual((await req('GET', '/api/myradio')).status, 405));

    await ok('POST 单条 op → rev=1 applied=1', async () => {
      const r = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops: [op('t1', true, 1000)] }));
      const j = JSON.parse(r.body);
      assert.strictEqual(r.status, 200); assert.strictEqual(j.rev, 1); assert.strictEqual(j.applied, 1);
    });
    await ok('GET 条件获取：rev 命中只回 notModified 不传 data', async () => {
      const j = JSON.parse((await req('GET', '/api/quality?rev=1')).body);
      assert.strictEqual(j.rev, 1); assert.strictEqual(j.notModified, true); assert.ok(!('data' in j));
    });
    await ok('GET 全量含聚合条目（B2 每台/每源结构：{cf, sources:{源URL:{…}}}）', async () => {
      const j = JSON.parse((await req('GET', '/api/quality')).body);
      assert.strictEqual(j.rev, 1); assert.ok(j.data['https://main.example/live']);
      assert.strictEqual(j.data['https://main.example/live'].sources['https://main.example/live'].okCount, 1);
    });
    await ok('同一 op.id 重试不重复计数（applied=0、rev 不动）', async () => {
      const r = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 1, ops: [op('t1', true, 1000)] }));
      const j = JSON.parse(r.body);
      assert.strictEqual(j.applied, 0); assert.strictEqual(j.rev, 1);
      const g = JSON.parse((await req('GET', '/api/quality')).body);
      assert.strictEqual(g.data['https://main.example/live'].sources['https://main.example/live'].okCount, 1);
    });
    await ok('多标签同 baseRev 各提不同 op → 两条样本都在（版本落后不拒合并）', async () => {
      const p1 = req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 1, ops: [op('t2', false, 2000, { kind: 'playback', trigger: 'play' })] }));
      const p2 = req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 1, ops: [op('t3', true, 3000, { identityUrl: 'https://other.example/live', sourceUrl: 'https://other.example/live' })] }));
      const [a, b] = await Promise.all([p1, p2]);
      assert.strictEqual(JSON.parse(a.body).ok, true); assert.strictEqual(JSON.parse(b.body).ok, true);
      const g = JSON.parse((await req('GET', '/api/quality')).body);
      const main = g.data['https://main.example/live'].sources['https://main.example/live'];
      assert.strictEqual(main.failCount, 1); assert.strictEqual(main.lastPlaybackAt, 2000); // playback 事件落 lastPlaybackAt
      assert.strictEqual(g.data['https://main.example/live'].sources['https://main.example/live'].lastPlayFail.t, 'play'); // 播放失败留最近一条
      assert.ok(g.data['https://other.example/live']); // 第二台也合流成功
    });
    await ok('keep 保护集随批附带（B2）：非法条目清洗、不影响合并', async () => {
      const r = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 2, ops: [op('tk', true, 4500)], keep: ['https://main.example/live', 'not-a-url', 42] }));
      const j = JSON.parse(r.body);
      assert.strictEqual(j.ok, true); assert.ok(j.rev >= 2);
    });
    await ok('schema 违规 op → 409 code=schema（kind 不合法；AIbot PR#26 复核 P2 机器可读错误码）', async () => {
      const r = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops: [op('t9', true, 1, { kind: 'vacuum' })] }));
      assert.strictEqual(r.status, 409);
      assert.strictEqual(JSON.parse(r.body).code, 'schema');
    });
    await ok('ops 非数组/空数组 → 409 code=schema（列表形态不合法）', async () => {
      const r1 = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops: 'nope' }));
      assert.strictEqual(r1.status, 409); assert.strictEqual(JSON.parse(r1.body).code, 'schema');
      const r2 = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops: [] }));
      assert.strictEqual(r2.status, 409); assert.strictEqual(JSON.parse(r2.body).code, 'schema');
    });
    await ok('耗尽/断流路径空 mode 事件经客户端入口归一后不再 409（AIbot P1-1；服务端枚举保持严格）', async () => {
      const { QualityStore } = require('../quality-store');
      const Q = Object.create(QualityStore); Q.mode = 'local'; Q.stations = {}; Q.pend = []; Q.keepHint = []; Q.seq = 0; Q.sid = 'tq';
      // 真实播放失败路径形态（app.js qosMap exhaust/disconnect 分支）：引擎 mode 拿不到 → 空
      Q.recordPlayback('https://ex.example/live', { sourceUrl: 'https://ex.example/live/64.mp3', ok: false, latencyMs: 0, mode: '', trigger: 'error' });
      Q.recordPlayback('https://ex.example/live', { sourceUrl: 'https://ex.example/live/index.m3u8', ok: false, latencyMs: 0, mode: '', trigger: 'watchdog' });
      assert.strictEqual(Q.pend.length, 2);
      assert.deepStrictEqual(Q.pend.map(o => o.mode), ['direct', 'hls']);   // 按实际尝试的 variant 形态兜底
      const r = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops: Q.pend }));
      assert.strictEqual(r.status, 200);                                    // 归一后整批合入（旧版此处 409 丢样本）
      assert.strictEqual(JSON.parse(r.body).applied, 2);
      const r2 = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops: [op('tbad', true, 1, { mode: '' })] }));
      assert.strictEqual(r2.status, 409, '裸空 mode op 仍被服务端拒（契约枚举不动，无 unknown）');
      assert.strictEqual(JSON.parse(r2.body).code, 'schema');
    });
    await ok('单批 33 条 → 409 code=batch-limit（批量上限与 schema 拆分报码）', async () => {
      const ops = Array.from({ length: 33 }, (_, i) => op(`bx${i}`, true, 4000 + i));
      const r = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops }));
      assert.strictEqual(r.status, 409);
      assert.strictEqual(JSON.parse(r.body).code, 'batch-limit');
    });
    await ok('请求体超 256KB → 409 code=too-large（字节超限与批量/schema 分开报码）', async () => {
      const big = 'x'.repeat(300 * 1024); // 未到 JSON 解析即拒：纯字节维度（合法 ops≤32 恒到不了，防御性护栏）
      // Connection:close = 独占短连：服务端超限先答 409 再断连（与 store 同口径），RST 只落在本请求 socket，
      // 不污染全局 agent 的 keep-alive 连接池（Node 19+ 默认 keepAlive，复用半死 socket 会误伤下一用例）
      const r = await req('POST', '/api/quality', { 'Content-Type': 'application/json', Connection: 'close' }, big);
      assert.strictEqual(r.status, 409);
      let code = ''; try { code = JSON.parse(r.body).code; } catch (_) {} // 断连后响应体尽力读（读不到不误判）
      assert.strictEqual(code, 'too-large');
    });
    await ok('裸 JSON 解析失败 → 400', async () => {
      assert.strictEqual((await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, 'not json')).status, 400);
    });

    // FIFO 淘汰幂等边界（AIbot P1）：>512 条后，被淘汰旧 op 的重试必须显式拒绝（rejected 计数）而非静默重算。
    // at 用真实单调时间戳（生产口径：客户端恒 Date.now()；前序归一测试的 at≈now 在日志更早期，e* 须晚于它们）
    await ok('超过 512 条后：淘汰旧 op 重试被显式拒绝、不重复计数', async () => {
      const T0 = Date.now();
      let applied = 0;
      for (let i = 0; i < 17; i++) { // 520 条分 17 批（单批 ≤32），at 单调递增
        const ops = Array.from({ length: Math.min(32, 520 - i * 32) }, (_, j) => op(`e${i * 32 + j + 1}`, true, T0 + i * 32 + j));
        const r = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops }));
        applied += JSON.parse(r.body).applied;
      }
      assert.strictEqual(applied, 520); // 520 条全量落账（窗口 512 → t1/t2/t3/归一 2 条与最早 e* 被淘汰，floorAt 推进）
      const before = JSON.parse((await req('GET', '/api/quality')).body).data['https://main.example/live'].sources['https://main.example/live'].okCount;
      const r1 = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops: [op('t1', true, 1000)] }));
      const j1 = JSON.parse(r1.body);
      assert.strictEqual(j1.applied, 0); assert.ok(j1.rejected >= 1); // 淘汰后重试：显式拒绝，不是静默重算
      const r2 = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops: [op('e520', true, T0 + 519)] }));
      const j2 = JSON.parse(r2.body);
      assert.strictEqual(j2.applied, 0); assert.strictEqual(j2.rejected || 0, 0); // 窗口内重试：幂等跳过（非拒绝）
      const after = JSON.parse((await req('GET', '/api/quality')).body).data['https://main.example/live'].sources['https://main.example/live'].okCount;
      assert.strictEqual(after, before); // 两次重试均未重复计数
    });

    await ok('/api/myradio 行清洗：非法行丢弃、合法行落盘、GET 校验', async () => {
      const r = await req('POST', '/api/myradio', { 'Content-Type': 'application/json' }, JSON.stringify({
        lines: ['自建,#genre#', '我的电台,https://example.test/live', '坏行没有逗号', '另台,https://other.test/x', '', '名,ftp://bad/协议']
      }));
      assert.strictEqual(JSON.parse(r.body).ok, true);
      const txt = fs.readFileSync(MY, 'utf8');
      assert.ok(txt.includes('自建,#genre#') && txt.includes('我的电台,https://example.test/live') && txt.includes('另台,https://other.test/x'));
      assert.ok(!txt.includes('坏行') && !txt.includes('ftp://'));
    });

    // —— v3 备份 sidecar 覆盖导入（B4，POST /api/quality {replace:true,data}）——
    await ok('sidecar 覆盖导入：replace=true 全量覆盖、rev 递增、未知字段剔除', async () => {
      const data = { // B2 嵌套形态（每台 {cf, sources:{源URL:{…}}}）：计数精确覆盖（非合并累加——与 ops 通道语义差异）
        'https://main.example/live': { cf: 2, sources: { 'https://main.example/live': { okCount: 37, failCount: 2, lastOkAt: 9000, modes: ['direct'], rawResponse: 'SECRET' } } },
        'https://other.example/live': { cf: 0, sources: { 'https://other.example/live': { lastPlaybackAt: 8000 } } },
        'ftp://bad.example/x': { cf: 0, sources: {} }, // 非 http(s) 键清洗丢弃
      };
      const r = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ replace: true, data }));
      const j = JSON.parse(r.body);
      assert.strictEqual(r.status, 200); assert.strictEqual(j.ok, true); assert.ok(j.rev > 1);
      const g = JSON.parse((await req('GET', '/api/quality')).body);
      const m = g.data['https://main.example/live'].sources['https://main.example/live'];
      assert.strictEqual(m.okCount, 37);
      assert.deepStrictEqual(m.modes, ['direct']);
      assert.ok(!('rawResponse' in m)); // 白名单外字段剔除
      assert.ok(!('ftp://bad.example/x' in g.data));
    });
    await ok('覆盖导入后旧 op 重放不复活旧数据（去重日志保留）', async () => {
      const r = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops: [op('t2', false, 2000, { kind: 'playback', trigger: 'play' })] }));
      const g = JSON.parse((await req('GET', '/api/quality')).body);
      assert.strictEqual(g.data['https://main.example/live'].sources['https://main.example/live'].failCount, 2); // t2 在去重日志里被跳过，覆盖态不被旧事件翻改
    });
    await ok('replace 坏形状 → 409（data 非对象 / 条目超 2000）', async () => {
      assert.strictEqual((await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ replace: true, data: 'nope' }))).status, 409);
      const big = {}; for (let i = 0; i < 2100; i++) big['https://a.example/' + i] = { cf: 1, sources: {} };
      assert.strictEqual((await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ replace: true, data: big }))).status, 409);
    });
    await ok('sidecar 回滚通道（AIbot P1-2 端到端）：旧快照再 replace 无损回写', async () => {
      const before = JSON.parse((await req('GET', '/api/quality')).body).data; // 当前服务端存储态（= GET 面快照来源）
      assert.ok(before['https://main.example/live']);                        // 前置：非空
      const imp = { 'https://fresh.example/live': { cf: 1, sources: { 'https://fresh.example/live': { okCount: 50, modes: ['hls'] } } } };
      const r1 = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ replace: true, data: imp }));
      assert.strictEqual(JSON.parse(r1.body).ok, true);
      const mid = JSON.parse((await req('GET', '/api/quality')).body).data;
      assert.deepStrictEqual(mid, imp);                                       // 覆盖后 = 导入数据（存储形态 = 白名单内无损）
      const r2 = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ replace: true, data: before }));
      assert.strictEqual(JSON.parse(r2.body).ok, true);
      const after = JSON.parse((await req('GET', '/api/quality')).body).data;
      assert.deepStrictEqual(after, before);                                  // 旧快照经同一 replace 通道回写 = 无损（Web 回滚路径的服务端保证）
    });

    // 损坏恢复：写坏 quality.json 后重启服务——按空库恢复且不碰磁盘外数据
    srv.kill(); srv = null;
    fs.mkdirSync(path.dirname(QF), { recursive: true });
    fs.writeFileSync(QF, '{broken json');
    PORT = await freePort();
    srv = await boot();
    await ok('损坏 quality.json → 按空库恢复（rev=0 可重新发号）', async () => {
      const j = JSON.parse((await req('GET', '/api/quality')).body);
      assert.strictEqual(j.rev, 0); assert.deepStrictEqual(j.data, {});
      const r = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops: [op('fresh1', true, 5000)] }));
      assert.strictEqual(JSON.parse(r.body).rev, 1);
    });

    // 2MB 硬上限拒绝路径（AIbot 三轮 P1 实证）：VR_TEST_Q_MAX 注入缝压小上限——不可裁的 ops 日志顶满后
    // 真实 HTTP 链必须回 409 + 机器可读 code:'too-large'（客户端据此与临时写失败区分、保留 pend 重试）
    srv.kill(); srv = null;
    try { fs.unlinkSync(QF); } catch (_) {}
    PORT = await freePort();
    srv = await boot({ VR_TEST_Q_MAX: '1024' });
    await ok('qCommit 2MB 超限 → HTTP 409 + code:too-large（真 HTTP 链）', async () => {
      // AIbot PR#34 P2 排查结论（非本 PR 回归——diff 不含 quality 三件套，双 worktree 23/23 绿）：本用例是
      // 全文件唯一高频写盘点（空态起步 ~70 次连续 writeFile+rename 同一 tmp 路径），共享 data 目录的并发
      // 写者（遗留 dev 服务页面 flush/并行实例）或杀毒扫描瞬时锁 rename 会令服务端回 200 ok:false
      // 「写入失败」——临时错误通道、非协议拒（内存态不推进）。旧循环把任何 !ok 记为容量拒绝，撞上一
      // 次写失败断言 409 即炸（故障注入实锤：外部持锁 quality.json 即复现）。加固：只认协议级拒绝
      // （409/带 code）作 hit，写失败计数旁路继续——每条成功提交才推进不可裁 ops 日志，容量拒绝必然
      // 到达；上限 80→200 给瞬时失败留余量。
      let hit = null, wfail = 0;
      for (let i = 1; i <= 200 && !hit; i++) {
        const r = await req('POST', '/api/quality', { 'Content-Type': 'application/json' }, JSON.stringify({ baseRev: 0, ops: [op('cap' + i, true, 20000 + i)] }));
        const j = JSON.parse(r.body);
        if (!j.ok && (r.status === 409 || j.code)) hit = { status: r.status, j }; // 首次协议级拒绝（容量被顶满）
        else if (!j.ok) wfail++; // 200 ok:false 写入失败：不阻断，继续灌 op 直至容量拒绝
      }
      assert.ok(hit, `200 条内应触发容量拒绝（oplog 不可裁部分 > 1024B；写入失败旁路 ${wfail} 次）`);
      assert.strictEqual(hit.status, 409); // 路由按 code 映射 409（AIbot 三轮所指 200 缺口已被 23e1df6 修复，此处实证钉死）
      assert.strictEqual(hit.j.code, 'too-large');
    });
  } finally {
    if (srv) srv.kill();
    try { fs.unlinkSync(QF); fs.unlinkSync(QF + '.tmp'); } catch (_) {}
    try { fs.unlinkSync(MY); fs.unlinkSync(MY + '.tmp'); } catch (_) {}
    if (hadQ) { try { fs.copyFileSync(QFBAK, QF); fs.unlinkSync(QFBAK); } catch (_) {} }
    if (hadMy) { try { fs.copyFileSync(MYBAK, MY); fs.unlinkSync(MYBAK); } catch (_) {} }
  }
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('quality 测试异常：', e); process.exit(1); });
