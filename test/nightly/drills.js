// test/nightly/drills.js —— 夜间故障演练层（P3，docs/testing-strategy-2026-11.md §3 L5 + §7 P3；全离线约 1-2 分钟）。
// 退出码语义（方案 §5 失败分类）：代码回归（确定性断言破）= 非零退出；环境失败（端口/权限）= 报告标「环境未执行」非零退出。
// 报告：docs/test-reports/nightly/<run-id>/drills.json（每轮独立目录，逐断言入列 + 分类，review#41 任务 2/6）。
// 跑法：node test/nightly/drills.js（编排见 run.js）。
// 覆盖矩阵：
//   [1] /proxy 上游故障注入（VR_TEST_GUARD=1 + 回环 fixture）：上游 404 状态保留、非媒体类型隔离 /
//       HTML 内容保留但禁主动解释 / 假流媒体类型保留 / 畸形 Location 403——服务不崩、语义正确
//   [2] /api/check?detail=1 结构化 code（对照 contracts/source-diagnostic.json 枚举）：真流 OK / 假流 SHORT_BODY /
//       HTML 大页 HTML / CT 撒谎仍 HTML（内容嗅探）/ 断流 NETWORK / HLS 清单 404 HTTP；
//       契约字段齐全 + 响应不含上游响应体 + code ⊆ 契约枚举
//   [3] 写盘故障注入（quality+store 双通道，任务稿明示三选二）：data/*.json 换同名目录（Windows 无强制锁，
//       openSync r+ 锁不住——rename 目标是目录必 EPERM/EISDIR 稳定复现，本机实测 EPERM）→ POST 200 {ok:false,
//       error:'写入失败'} 不崩（临时错误通道非 5xx）+ 内存态不推进（rev/数据不回退不脏写）→ 恢复后服务可写且 rev 连续
//   [4] kill 中断强制发布 + 重启恢复：VR_TEST_SYNC_STASH + STALL=3000，POST /api/sync 进行中 SIGKILL ×2
//       （STALL 窗内 800ms = 确定性零写盘 / 窗后 3400ms = 算力段可能落 publishSync 中途）→ 重启 /api/boot
//       断言不变量：ok:true + 四资产完整 + manifest 可校验 + 版本 ∈ {基线批, sync-*}（与 test/station-api.js
//       [B] 区 boot 矩阵语义对齐；恢复路径本体由其确定性覆盖，此处验真实 kill 落点的状态一致性）
//   [5] 资产同步演练：CLI 级直接 require update-sources.publishSync 三连发造两代 arts → root/prev/prev-old
//       代际轮换 + readManifestOf/manifestCheckDir 对两代分别可校验（任何时刻至少一代完整上一批）
//   [6] 并发压力：8 路并发 POST /api/quality（各 16 ops）+ 4 路并发 /api/store 全量写 + detail 探活 8 源 ×3 轮
//       同炮齐鸣 → rev 互不重号、终态聚合一致（写失败 200 ok:false 允许出现但全量重放幂等收敛——renameRetry
//       后应极少）/ 无 5xx / 服务存活
// 未覆盖项：
//   - kill 精确落在「rename 后 manifest 前」不可注入（publishSync 是毫秒级同步段、无暂停缝）——以重启不变量替代，
//     半批状态的恢复矩阵由 test/station-api.js [B] 区确定性覆盖
//   - /api/listenstats 写盘故障（三通道取 quality+store 两个）；INVALID_URL 经 API 不可达（safeTarget 前置过滤
//     → 400，checkDetail 直调路径由 test/diagnostic.js 覆盖）
//   - 上游 DNS 变更注入、/proxy 重定向环深度上限（diagnostic.js 已覆盖同型护栏）；np-proxy 已覆盖的 302 跟跳/
//     Content-Range/中途断流/客户端回收不重复
const assert = require('assert'), fs = require('fs'), path = require('path');
const { boot, freePort, snapshotAssets, restoreAssets, addCleanup, ROOT } = require('../harness/api-client');
const { fixture } = require('../harness/http-fixture');
const { publishSync, readManifestOf, manifestCheckDir, assetsComplete } = require('../../update-sources');
const { openRun } = require('./report-dir');

let pass = 0, fail = 0;
const ctx = openRun(); // 每轮独立报告目录（env NIGHTLY_RUN_ID = 编排方已建目录；本地自算先清）
const asserts = [];
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); asserts.push({ name, pass: true, category: 'code-regression' }); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); asserts.push({ name, pass: false, category: 'code-regression', error: String(e && e.message || e).slice(0, 300) }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const postJson = (req, p, body) => req('POST', p, { 'Content-Type': 'application/json' }, JSON.stringify(body))
  .then(r => ({ status: r.status, j: (() => { try { return JSON.parse(r.body); } catch (_) { return null; } })() }));
const getJson = (req, p) => req('GET', p).then(r => ({ status: r.status, j: (() => { try { return JSON.parse(r.body); } catch (_) { return null; } })() }));
// 注入目录的通道用完必须还原成非目录（否则 api-client 快照还原 writeFileSync 打目录会炸清理链）
const ensureNotDir = fp => { try { if (fs.statSync(fp).isDirectory()) fs.rmdirSync(fp); } catch (_) {} };
// 质量侧车合法 op（契约 opEvent 形态；qValidOp 全字段命中）
const opOf = (id, u) => ({ id, identityUrl: u, sourceUrl: u, kind: 'playback', trigger: 'play', ok: true, latencyMs: 12, bytes: 1000, at: Date.now(), mode: 'direct' });
// 演练批四资产（assetsComplete 可解析形态，学 test/station-api.js makeArts）
const makeArts = tag => {
  const txt = '音乐,#genre#\r\n演练台-' + tag + ',http://192.0.2.10/a.mp3\r\n演练备-' + tag + ',http://192.0.2.11/a2.mp3\r\n新闻,#genre#\r\n演练乙-' + tag + ',http://192.0.2.12/b.m3u8\r\n';
  const meta = { v: 1, generatedAt: 0, stations: {} };
  meta.stations['http://192.0.2.10/a.mp3'] = { name: '演练台-' + tag, category: '音乐',
    sources: [{ url: 'http://192.0.2.10/a.mp3', upstream: 'gao', upstreamId: '', kind: 'main', firstSeenAt: 0 }] };
  return { 'radio.txt': txt, 'radio-data.js': 'window.RADIO_DATA=' + JSON.stringify(txt) + ';\r\n', 'logos.txt': '# 演练占位台标表\r\n', 'radio-meta.json': JSON.stringify(meta) };
};
const hardKill = srv => new Promise(done => { // SIGKILL：Windows = TerminateProcess（无清理硬杀，kill -9 同语义）
  try { srv.kill('SIGKILL'); } catch (_) {}
  const t0 = Date.now(); (function poll() { if (srv.exitCode !== null || Date.now() - t0 > 3000) return done(); setTimeout(poll, 50); })();
});
const enumCodes = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'source-diagnostic.json'), 'utf8')).codes;

(async () => {
  const t0 = Date.now();
  // 外层快照：[4]/[5] 直接操纵仓库根生成资产 + data/last-sync-report.json；SIGINT 兜底 + finally 双保险
  const pristine = snapshotAssets();
  addCleanup(() => restoreAssets(pristine));
  const REPORT_FILE = path.join(ROOT, 'data', 'last-sync-report.json');
  const reportRaw = fs.existsSync(REPORT_FILE) ? fs.readFileSync(REPORT_FILE) : null;
  // stash 原料先取真实全库（任何 publishSync 之前）——强制发布复用原料不重拉上游，min-total 硬门槛靠全库规模过
  const REAL_TXT = fs.readFileSync(path.join(ROOT, 'radio.txt'), 'utf8');
  const stashF = path.join(ROOT, 'data', '.test-stash.json');

  // 回环 fixture（[1][2][6] 共用）：探活真流分块吐 12288B（≥8000B 阈值），假流 336B，HTML 大页 9000B+
  const CHUNK = Buffer.alloc(4096, 7);
  const stream = res => { let n = 0; const w = () => { if (res.writableEnded || res.destroyed) return; res.write(CHUNK); n += CHUNK.length; if (n >= 12288) res.end(); else setTimeout(w, 10); }; w(); };
  const HTML_BIG = Buffer.from('<html>' + 'x'.repeat(9000) + '</html>');
  const fx = fixture({
    '/up404.mp3': { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'not found' },      // [1] 上游 404
    '/uphtml.html': { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: HTML_BIG },      // [1] 上游 HTML 页
    '/upstub.mp3': { headers: { 'Content-Type': 'audio/mpeg' }, body: Buffer.alloc(336, 3) },         // [1] 假流 336B
    '/upbad302.mp3': { status: 302, headers: { Location: 'http://[' }, body: '' },                    // [1] 畸形 Location
    '/ok.mp3': { headers: { 'Content-Type': 'audio/mpeg' }, stream },                                 // [2][6] 真流
    '/stub.mp3': { headers: { 'Content-Type': 'audio/mpeg' }, body: Buffer.alloc(336, 3) },           // [2][6] 假流
    '/page.html': { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: HTML_BIG },        // [2][6] HTML 错误页
    '/fakebin.mp3': { headers: { 'Content-Type': 'application/octet-stream' }, body: HTML_BIG },      // [2] CT 撒谎
    '/bad.m3u8': { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'no' },              // [2][6] HLS 清单 404
    '/stress.mp3': { headers: { 'Content-Type': 'audio/mpeg' }, stream },                             // [6] 压力聚合目标
  });
  const FPORT = await fx.listen();
  const FIX = 'http://127.0.0.1:' + FPORT;
  const deadPort = await freePort(); // 建服后即关：建连必拒（NETWORK 确定性路径）
  let s = null; // 当前演练服务句柄——finally 兜底关闭必须可见（异常时 try 内的 close 可能被跳过）

  try {
    console.log('[1] /proxy 上游故障注入（VR_TEST_GUARD=1 + 回环 fixture）');
    s = await boot({ isolated: true, env: { VR_TEST_GUARD: '1' } });
    await ok('上游 404 → 状态码保留、非媒体类型隔离', async () => {
      const r = await s.req('GET', '/proxy?url=' + encodeURIComponent(FIX + '/up404.mp3'));
      assert.strictEqual(r.status, 404); assert.strictEqual(r.headers['content-type'], 'application/octet-stream');
      assert.strictEqual(r.body, 'not found'); assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    });
    await ok('上游 HTML → 二进制隔离、载荷保留并禁止主动文档', async () => {
      const r = await s.req('GET', '/proxy?url=' + encodeURIComponent(FIX + '/uphtml.html'));
      assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['content-type'], 'application/octet-stream');
      assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(r.headers['content-security-policy'], "sandbox; default-src 'none'");
      assert.ok(r.body.startsWith('<html>') && r.body.length >= 9000, '载荷字节保持');
    });
    await ok('上游假流 336B → 200 audio/mpeg 336B（代理不验字节——验收在探活层）', async () => {
      const r = await s.req('GET', '/proxy?url=' + encodeURIComponent(FIX + '/upstub.mp3'));
      assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['content-type'], 'audio/mpeg');
      assert.strictEqual(Buffer.byteLength(r.body), 336);
    });
    await ok('畸形 Location（http://[）→ 403（tryUrl 归 null 按拒绝处理，audit-r2 P2-1 回归）', async () => {
      const r = await s.req('GET', '/proxy?url=' + encodeURIComponent(FIX + '/upbad302.mp3'));
      assert.strictEqual(r.status, 403);
    });
    await ok('故障面打完服务仍存活：GET / → 200（无未捕获异常崩溃）', async () =>
      assert.strictEqual((await s.req('GET', '/')).status, 200));

    console.log('[2] /api/check?detail=1 结构化 code（对照 contracts/source-diagnostic.json 枚举）');
    const detail = async urls => {
      const r = await s.req('GET', '/api/check?detail=1&' + urls.map(u => 'url=' + encodeURIComponent(u)).join('&'));
      assert.strictEqual(r.status, 200, 'detail HTTP ' + r.status);
      return JSON.parse(r.body);
    };
    await ok('真流 fixture → code=OK（ok:true、mode direct、bytes≥8000）', async () => {
      const j = await detail([FIX + '/ok.mp3']);
      const d = j.results[0];
      assert.strictEqual(d.code, 'OK'); assert.strictEqual(d.ok, true); assert.strictEqual(d.mode, 'direct');
      assert.ok(d.bytes >= 8000, '字节阈值验收实得 ' + d.bytes);
    });
    await ok('假流 336B → SHORT_BODY；HTML 大页 → HTML；CT 撒谎 octet-stream 仍 HTML（内容嗅探）', async () => {
      const j = await detail([FIX + '/stub.mp3', FIX + '/page.html', FIX + '/fakebin.mp3']);
      assert.deepStrictEqual(j.results.map(x => x.code), ['SHORT_BODY', 'HTML', 'HTML']);
      assert.ok(j.results.every(x => x.ok === false));
    });
    await ok('断流源（死端口）→ NETWORK 且 httpStatus=0（未建连）', async () => {
      const j = await detail(['http://127.0.0.1:' + deadPort + '/x.mp3']);
      assert.strictEqual(j.results[0].code, 'NETWORK'); assert.strictEqual(j.results[0].httpStatus, 0);
    });
    await ok('HLS 清单 404 → code=HTTP（mode=hls，直流不看状态码而 HLS 清单看——双口径）', async () => {
      const j = await detail([FIX + '/bad.m3u8']);
      assert.strictEqual(j.results[0].code, 'HTTP'); assert.strictEqual(j.results[0].mode, 'hls');
      assert.strictEqual(j.results[0].httpStatus, 404);
    });
    await ok('契约形态：逐结果字段齐全、code ⊆ 枚举、响应不含上游响应体（顶层 ok = 任一源活）', async () => {
      const j = await detail([FIX + '/ok.mp3', FIX + '/stub.mp3']);
      for (const d of j.results) {
        for (const k of ['url', 'ok', 'code', 'hls', 'mode', 'httpStatus', 'contentType', 'bytes', 'latencyMs', 'why', 'checkedAt'])
          assert.ok(k in d, '缺字段 ' + k);
        assert.ok(enumCodes.includes(d.code), '枚举外 code ' + d.code);
        assert.ok(!('body' in d), '契约：不返回响应体');
      }
      assert.strictEqual(j.ok, true, '顶层 ok = 任一源 ok');
    });
    await s.close(); s = null;

    console.log('[3] 写盘故障注入（quality+store 双通道：data/*.json 换同名目录）');
    s = await boot({ isolated: true }); // 无缝 boot：写盘面不涉网络护栏
    // isolated 语义（review#41 复核补修）：server.js ROOT=__dirname——写盘落在 boot 临时应用根，注入必须瞄准 s.root，
    // 打仓库根 data/ 既打不到服务（服务读不到）又在无 data/ 的 checkout 上 ENOENT 崩套件
    const QF = path.join(s.root, 'data', 'quality.json'), SF = path.join(s.root, 'data', 'store.json');
    const U1 = FIX + '/wf1.mp3', U2 = FIX + '/wf2.mp3', U3 = FIX + '/wf3.mp3';
    await ok('quality 基线：合法 op → 200 {ok:true, rev:1}', async () => {
      const r = await postJson(s.req, '/api/quality', { ops: [opOf('wf-1', U1)] });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.j.ok, true); assert.strictEqual(r.j.rev, 1);
    });
    await ok('store 基线：全量写 → 200 {ok:true, rev:1}', async () => {
      const r = await postJson(s.req, '/api/store', { data: { 'radio.favs': '["' + U1 + '"]', 'radio.vol': '0.8' } });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.j.ok, true); assert.strictEqual(r.j.rev, 1);
    });
    fs.unlinkSync(QF); fs.mkdirSync(QF); // 注入：目标变目录 → rename 必 EPERM（Win 实测）/EISDIR（POSIX）
    await ok('quality 写盘故障：POST 新批 → 200 {ok:false, error:「写入失败」}（临时错误通道非 5xx、不崩）', async () => {
      const r = await postJson(s.req, '/api/quality', { ops: [opOf('wf-2', U2)] });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.j.ok, false); assert.strictEqual(r.j.error, '写入失败');
    });
    await ok('quality 内存态不推进：GET → rev 仍 1、故障批台目未入 data（写失败不留半应用状态）', async () => {
      const r = await getJson(s.req, '/api/quality');
      assert.strictEqual(r.j.rev, 1); assert.ok(!r.j.data[U2], '故障批不得入内存'); assert.ok(r.j.data[U1], '基线批保持');
    });
    fs.rmdirSync(QF); // 恢复：目录移除后由服务重写
    await ok('quality 恢复后可写：POST → {ok:true, rev:2}（失败不发号不跳号，rev 连续）', async () => {
      const r = await postJson(s.req, '/api/quality', { ops: [opOf('wf-3', U3)] });
      assert.strictEqual(r.j.ok, true); assert.strictEqual(r.j.rev, 2);
      const g = await getJson(s.req, '/api/quality');
      assert.strictEqual(g.j.rev, 2); assert.ok(g.j.data[U3] && g.j.data[U1] && !g.j.data[U2]);
    });
    fs.unlinkSync(SF); fs.mkdirSync(SF);
    await ok('store 写盘故障：POST 全量 → 200 {ok:false,「写入失败」}（storeQ 串行队列不被毒化）', async () => {
      const r = await postJson(s.req, '/api/store', { data: { 'radio.favs': '["' + U2 + '"]', 'radio.vol': '0.9' } });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.j.ok, false); assert.strictEqual(r.j.error, '写入失败');
    });
    await ok('store 内存态不推进：GET → rev 仍 1、数据仍是基线批', async () => {
      const r = await getJson(s.req, '/api/store');
      assert.strictEqual(r.j.rev, 1); assert.strictEqual(r.j.data['radio.favs'], '["' + U1 + '"]');
    });
    fs.rmdirSync(SF);
    await ok('store 恢复后可写：POST → {ok:true, rev:2}', async () => {
      const r = await postJson(s.req, '/api/store', { data: { 'radio.favs': '["' + U3 + '"]', 'radio.vol': '0.9' } });
      assert.strictEqual(r.j.ok, true); assert.strictEqual(r.j.rev, 2);
    });
    ensureNotDir(QF); ensureNotDir(SF); // 双保险：绝不让目录形态漏进快照还原链
    await s.close(); s = null;

    console.log('[5] 资产同步演练（CLI 级 publishSync 三连发 → 两代 prev 轮换）');
    publishSync(ROOT, makeArts('a2'), { version: 'A2', ts: 1000000 });
    publishSync(ROOT, makeArts('b2'), { version: 'B2', ts: 2000000 });
    publishSync(ROOT, makeArts('c2'), { version: 'C2', ts: 3000000 });
    await ok('三连发后 root manifest = C2 且四资产逐文件可校验', () => {
      const m = readManifestOf(ROOT);
      assert.ok(m && m.version === 'C2', 'root manifest 实得 ' + (m && m.version));
      assert.ok(manifestCheckDir(ROOT, m)); assert.ok(assetsComplete(ROOT));
    });
    await ok('两代回滚副本逐代可校验：sync-prev = B2、sync-prev-old = A2（代际轮换：任何时刻至少一代完整上一批）', () => {
      const mp = readManifestOf(path.join(ROOT, '.tmp', 'sync-prev'));
      const mo = readManifestOf(path.join(ROOT, '.tmp', 'sync-prev-old'));
      assert.ok(mp && mp.version === 'B2' && manifestCheckDir(path.join(ROOT, '.tmp', 'sync-prev'), mp), 'prev 实得 ' + (mp && mp.version));
      assert.ok(mo && mo.version === 'A2' && manifestCheckDir(path.join(ROOT, '.tmp', 'sync-prev-old'), mo), 'prev-old 实得 ' + (mo && mo.version));
    });

    console.log('[4] kill 中断强制发布 + 重启恢复（STALL=3000，SIGKILL ×2）');
    // stash 原料 = 开场快照的全库文本（server 启动时读文件；publishSync 改掉的 radio.txt 不影响注入原料）
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true }); // [3] 的隔离还原可能已删空 data/ 目录
    fs.writeFileSync(stashF, JSON.stringify({ report: { reasons: [{ key: 'count-drop', msg: '测试门槛', bypassable: true }] },
      reportHash: 'a'.repeat(64), inputs: { cn: REAL_TXT + '华语音乐,#genre#\r\n注入测试台,http://s.example/inject.mp3\r\n注入测试台二,http://s.example/inject2.m3u8\r\n', eu: null }, tokens: {} }));
    const restartAssert = async (tag, killAt) => {
      const srv = await boot({ isolated: true, env: { VR_TEST_SYNC_STASH: stashF, VR_TEST_SYNC_STALL: '3000' } });
      try {
        const t = await postJson(srv.req, '/api/sync/force-token', { reportHash: 'a'.repeat(64) });
        assert.strictEqual(t.status, 200, 'force-token ' + t.status);
        srv.req('POST', '/api/sync', { 'Content-Type': 'application/json' }, JSON.stringify({ forceToken: t.j.token })).catch(() => {}); // 进行中，不等响应
        await sleep(killAt);
      } finally { await hardKill(srv.srv); await srv.close(); } // 杀服 + 还原 data 快照（生成资产不动，留给重启校验）；断言破也不泄漏演练服务
      const b = await boot({ isolated: true });
      try {
        const j = (await getJson(b.req, '/api/boot')).j;
        assert.strictEqual(j.ok, true, tag + ' /api/boot ok（实得 ' + JSON.stringify(j) + '）');
        assert.ok(j.version === 'C2' || /^sync-/.test(j.version), tag + ' 版本 ∈ {C2, sync-*}（实得 ' + j.version + '：旧批完整或新批完整，绝不混态）');
        assert.ok(assetsComplete(ROOT), tag + ' 四资产完整可解析');
        const m = readManifestOf(ROOT);
        assert.ok(m && manifestCheckDir(ROOT, m), tag + ' manifest 可校验（哈希逐文件全对）');
        const mp = readManifestOf(path.join(ROOT, '.tmp', 'sync-prev')) || readManifestOf(path.join(ROOT, '.tmp', 'sync-prev-old'));
        assert.ok(mp && (manifestCheckDir(path.join(ROOT, '.tmp', 'sync-prev'), mp) || manifestCheckDir(path.join(ROOT, '.tmp', 'sync-prev-old'), mp)),
          tag + ' 至少一代完整回滚副本仍在（重启恢复能力未损）');
      } finally { await b.close(); }
    };
    await ok('kill#1（STALL 窗内 800ms，确定性零写盘）→ 重启 /api/boot：ok:true + 四资产完整 + manifest 可校验', () => restartAssert('kill#1', 800));
    await ok('kill#2（STALL 窗后 3400ms，算力/发布段随机落点）→ 重启同款不变量（旧批完整或新批完整，绝不混态）', () => restartAssert('kill#2', 3400));

    console.log('[6] 并发压力（8 路 quality ×16ops + 4 路 store 全量 + detail 8 源 ×3 轮同炮齐鸣）');
    s = await boot({ isolated: true, env: { VR_TEST_GUARD: '1' } });
    const statuses = []; // 全程状态码记账（0 = 连接级失败）
    const call = (m, p, body) => s.req(m, p, body ? { 'Content-Type': 'application/json' } : null, body ? JSON.stringify(body) : null)
      .then(r => { statuses.push(r.status); return r; }, e => { statuses.push(0); throw e; });
    const U0 = FIX + '/stress.mp3';
    const qWorker = w => call('POST', '/api/quality', { ops: Array.from({ length: 16 }, (_, i) => opOf('w' + w + '-o' + i, U0)) });
    const sWorker = w => call('POST', '/api/store', { data: { 'radio.favs': '["' + U0 + '"]', 'radio.vol': String(0.4 + w / 10), 'radio.view': w % 2 ? 'list' : 'grid' } });
    const checkCall = urls => call('GET', '/api/check?detail=1&' + urls.map(u => 'url=' + encodeURIComponent(u)).join('&'));
    const cDead = 'http://127.0.0.1:' + deadPort + '/x.mp3';
    const checks = [];
    for (let r = 0; r < 3; r++) {
      checks.push([1, 2, 3, 4].map(i => FIX + '/ok.mp3?i=' + i));
      checks.push([FIX + '/stub.mp3', FIX + '/page.html', FIX + '/bad.m3u8', cDead]);
    }
    const results = await Promise.all([
      ...Array.from({ length: 8 }, (_, w) => qWorker(w)),
      ...Array.from({ length: 4 }, (_, w) => sWorker(w)),
      ...checks.map(urls => checkCall(urls)),
    ]);
    const qRevs = results.slice(0, 8).map(r => JSON.parse(r.body)).map(j => j.rev);
    const qBad = results.slice(0, 8).filter(r => !JSON.parse(r.body).ok).length;
    await ok('quality rev 互不重号（串行队列唯一发号；成功批 ' + (8 - qBad) + ' 个，写失败 ' + qBad + ' 批不发号不计入）', () => {
      const fin = qRevs.filter(Number.isFinite);
      assert.strictEqual(new Set(fin).size, fin.length, '互不重号：' + qRevs.join(','));
      assert.strictEqual(fin.length + qBad, 8, '每批要么发号要么显式 ok:false（不允许中间态）');
    });
    for (let round = 0; round < 3; round++) { // 写失败重放收敛（幂等去重保证重放安全；renameRetry 后应极少触发）
      const g = (await getJson(s.req, '/api/quality')).j;
      const okCount = (g.data[U0] && g.data[U0].sources[U0] && g.data[U0].sources[U0].okCount) || 0;
      if (okCount >= 128) break;
      await Promise.all(Array.from({ length: 8 }, (_, w) => call('POST', '/api/quality', { ops: Array.from({ length: 16 }, (_, i) => opOf('w' + w + '-o' + i, U0)) })));
    }
    await ok('quality 终态聚合一致：128 ops 全部入账（写失败批重放收敛，实得 okCount 见报告）+ latN=128 + modes 含 direct', async () => {
      const g = (await getJson(s.req, '/api/quality')).j;
      const src = g.data[U0] && g.data[U0].sources[U0];
      assert.ok(src && src.okCount === 128, 'okCount 实得 ' + (src && src.okCount) + '（写失败批 ' + qBad + ' 个）');
      assert.strictEqual(src.latN, 128); assert.ok(src.modes.includes('direct'));
    });
    await ok('quality 幂等回放：16 个已见 id 再 POST → {ok:true, applied:0} 且 rev 不动（回放前当前号）', async () => {
      const before = (await getJson(s.req, '/api/quality')).j.rev;
      const r = await postJson(s.req, '/api/quality', { ops: Array.from({ length: 16 }, (_, i) => opOf('w0-o' + i, U0)) });
      assert.strictEqual(r.j.ok, true); assert.strictEqual(r.j.applied, 0); assert.strictEqual(r.j.rev, before);
    });
    await ok('store LWW rev 单调：成功批 rev 互不重号，GET rev = max，data 与 max-rev 批载荷一致（显式 last-write-wins）', async () => {
      const sRes = results.slice(8, 12).map(r => JSON.parse(r.body));
      const revs = sRes.map(j => j.rev).filter(Number.isFinite);
      assert.strictEqual(new Set(revs).size, revs.length, '互不重号：' + sRes.map(j => j.rev).join(','));
      const g = (await getJson(s.req, '/api/store')).j;
      assert.strictEqual(g.rev, Math.max(...revs), '终态 rev = 最大发号');
      const wMax = sRes.map(j => j.rev).indexOf(Math.max(...revs));
      assert.deepStrictEqual(g.data, { 'radio.favs': '["' + U0 + '"]', 'radio.vol': String(0.4 + wMax / 10), 'radio.view': wMax % 2 ? 'list' : 'grid' });
    });
    await ok('detail 探活 3 轮 × 8 源：code 全部命中预期（4×OK + SHORT_BODY/HTML/HTTP/NETWORK）且 code ⇔ ok 一致', async () => {
      for (let r = 0; r < 3; r++) {
        const j1 = JSON.parse(results[12 + r * 2].body), j2 = JSON.parse(results[13 + r * 2].body);
        assert.deepStrictEqual(j1.results.map(x => x.code), ['OK', 'OK', 'OK', 'OK']);
        assert.deepStrictEqual(j2.results.map(x => x.code), ['SHORT_BODY', 'HTML', 'HTTP', 'NETWORK']);
        assert.ok([...j1.results, ...j2.results].every(x => x.ok === (x.code === 'OK')), 'code ⇔ ok 一致');
      }
    });
    await ok('压力段全程无 5xx、无连接级失败（' + statuses.length + ' 个响应，含收敛重放；写失败走 200 ok:false 临时通道）', () => {
      assert.ok(statuses.length >= 8 + 4 + checks.length, '响应计数齐（实得 ' + statuses.length + '）');
      assert.ok(statuses.every(c => c > 0 && c < 500), '状态码实得 ' + statuses.join(','));
    });
    await ok('压力后服务存活：GET / → 200', async () => assert.strictEqual((await s.req('GET', '/')).status, 200));
    await s.close(); s = null;
  } finally {
    if (s) { try { await s.close(); } catch (_) {} s = null; } // 异常路径兜底：异常时 try 内的 close 可能被跳过，孤儿服务会把演练态写穿快照链
    if (reportRaw) fs.writeFileSync(REPORT_FILE, reportRaw); else for (let i = 0; i < 3; i++) { // Windows 索引器/杀毒瞬时锁实测会打在新鲜文件上（server.js renameRetry 同源问题）——短重试再放弃
      try { fs.unlinkSync(REPORT_FILE); break; } catch (e) { if (e.code === 'ENOENT') break; if (i === 2) console.error('[drills] 提示：', REPORT_FILE, '清理未成（' + e.code + '），请手删'); else await sleep(100); }
    }
    try { fs.unlinkSync(stashF); } catch (_) {}
    ensureNotDir(path.join(ROOT, 'data', 'quality.json')); ensureNotDir(path.join(ROOT, 'data', 'store.json'));
    try { restoreAssets(pristine); } catch (_) {} // 外层快照兜底还原（幂等）
    try { await fx.close(); } catch (_) {}
  }

  // 报告落盘（每轮独立目录已建；exit 语义：代码回归 = 非零）
  const report = { script: 'drills', runId: ctx.runId, headSha: ctx.headSha, startedAt: ctx.startedAt,
    generatedAt: new Date().toISOString(), durationMs: Date.now() - t0,
    executed: true, category: fail ? 'code-regression' : 'pass', pass, fail, assertions: asserts };
  fs.writeFileSync(ctx.file('drills'), JSON.stringify(report, null, 2));
  console.log(`\n${pass} 通过，${fail} 失败（报告 docs/test-reports/nightly/${ctx.runId}/drills.json）`);
  process.exit(fail ? 1 : 0);
})().catch(e => { // 套件级异常 = 未执行：环境类（端口/权限/起服失败）标「环境未执行」，其余按代码回归处置
  const env = /EADDRINUSE|EACCES|EPERM|未就绪|启动即退出|listen /.test(String(e && e.message || e));
  console.error('drills 未执行（' + (env ? '环境失败' : '套件异常') + '）：', e && e.message || e);
  try {
    fs.writeFileSync(ctx.file('drills'), JSON.stringify({ script: 'drills', runId: ctx.runId, headSha: ctx.headSha, startedAt: ctx.startedAt,
      generatedAt: new Date().toISOString(), executed: false, category: env ? 'environment' : 'code-regression',
      reason: String(e && e.message || e).slice(0, 300), pass, fail, assertions: asserts }, null, 2));
  } catch (_) {}
  process.exit(1);
});
