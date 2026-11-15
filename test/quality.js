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
const boot = () => new Promise(async (resolve, reject) => {
  const srv = spawn(process.execPath, [path.join(UP, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore' });
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
