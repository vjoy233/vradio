// /api/sync 两步强制协议真服务矩阵（P1，docs/testing-strategy-2026-11.md §3 L2 覆盖总表 sync 行）：
// gated→token→forced 全链离线实测——VR_TEST_SYNC_STASH 预置 stash（token 换发/指纹绑定/单次消费）+
// 强制发布复用原料不重拉上游（publishResult 走真发布链：四资产+manifest+prev 代际轮换+运行时报告）+
// VR_TEST_SYNC_STALL 撑开 busy 409 竞态窗。普通（非强制）/api/sync 依赖上游网络行为（有网机器 ghFile
// 真拉、离线机器保留本地），离线不可确定——不覆盖，属夜间层（§3 L5 真实来源抽样）。
// 隔离（AIbot review#39 第 2 条根治说明）：#37 修订版 api-client 的 isolated = 复制仓库骨架到独立临时应用根
// 再起服——data/ 整目录（含 last-sync-report.json 与 stash 注入文件）与生成资产全在临时根内，宿主零接触。
// 旧方案「snapshotAssets/restoreAssets 外层快照 + finally 还原 + 报告手补还原」整体删除：临时根随 close 删除，
// 不存在覆写宿主运行时报告的通道；本文件另留只读对照断言钉死「宿主 last-sync-report.json 字节零变动」。
const assert = require('assert'), fs = require('fs'), path = require('path');
const { boot, makeRoot, addCleanup } = require('./harness/api-client');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });
const UP = path.join(__dirname, '..');
const HOST_REPORT = path.join(UP, 'data', 'last-sync-report.json'); // 仅只读对照（隔离根治的证据面），从不写
const hostReportSnap = () => { try { return fs.readFileSync(HOST_REPORT); } catch (_) { return null; } };
const HASH = 'a'.repeat(64); // stash.reportHash 任意指纹即可（发号只与 stash 内值比对，消费复查同值）
// stash 落在临时应用根 data/ 内（VR_TEST_SYNC_STASH 收绝对路径；骨架复制排除 data/，先建目录再写）；
// 值为字符串时原样写入（坏 JSON 用例），否则 JSON 序列化
const stashFile = (root, v) => {
  const f = path.join(root, 'data', '.test-stash.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
  return f;
};
// cn 注入 = 当前库全文 + 追加台：强制复跑仍拦「min-total」硬门槛（安全护栏 force 不绕——合并 <800 台即
// hardAbort 保旧库），小 fixture 注入结构性过不去；全量库输入与真实同步同形态（新上游 ≈ 旧库规模）
const stashOk = () => ({ report: { reasons: [{ key: 'count-drop', msg: '测试门槛', bypassable: true }] }, reportHash: HASH,
  inputs: { cn: fs.readFileSync(path.join(UP, 'radio.txt'), 'utf8') + '华语音乐,#genre#\r\n注入测试台,http://s.example/inject.mp3\r\n注入测试台二,http://s.example/inject2.m3u8\r\n', eu: null }, tokens: {} });
// 独立根起服（boot({root}) 不重新复制骨架、close 不删非自有根——根由测试自管：SIGINT 兜底 + finally 兜删）
const rmRoot = root => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} };

(async () => {
  const rp = (req, m, p, body) => req(m, p, { 'Content-Type': 'application/json' }, body ? JSON.stringify(body) : null)
    .then(r => ({ status: r.status, j: (() => { try { return JSON.parse(r.body); } catch (_) { return null; } })() }));

  await ok('无 stash：force-token → 404 无可强制的同步报告', async () => {
    const root = makeRoot();
    addCleanup(rmRoot.bind(null, root));
    const srv = await boot({ root });
    try {
      const r = await rp(srv.req, 'POST', '/api/sync/force-token', { reportHash: HASH });
      assert.strictEqual(r.status, 404); assert.ok(r.j.error.includes('无可强制'));
    } finally { await srv.close(); rmRoot(root); }
  });

  await ok('stash 坏 JSON：视为无 stash → 404', async () => {
    const root = makeRoot();
    addCleanup(rmRoot.bind(null, root));
    const f = stashFile(root, 'not json');
    const srv = await boot({ root, env: { VR_TEST_SYNC_STASH: f } });
    try {
      const r = await rp(srv.req, 'POST', '/api/sync/force-token', { reportHash: HASH });
      assert.strictEqual(r.status, 404);
    } finally { await srv.close(); rmRoot(root); }
  });

  await ok('无 bypassable 门槛 → 400 无决策门可绕过；指纹不匹配 → 400 报告指纹不匹配', async () => {
    const before = hostReportSnap();
    const root = makeRoot();
    addCleanup(rmRoot.bind(null, root));
    const f = stashFile(root, { report: { reasons: [{ key: 'k', msg: '不可绕', bypassable: false }] }, reportHash: HASH, inputs: { cn: null, eu: null }, tokens: {} });
    let srv = await boot({ root, env: { VR_TEST_SYNC_STASH: f } });
    try {
      const r1 = await rp(srv.req, 'POST', '/api/sync/force-token', { reportHash: HASH });
      assert.strictEqual(r1.status, 400); assert.ok(r1.j.error.includes('无决策门'));
    } finally { await srv.close(); }
    // 换可绕 stash 文件重启服务验证指纹分支（boot({root}) 复用同一根，stash 覆写即可）
    const f2 = stashFile(root, stashOk());
    srv = await boot({ root, env: { VR_TEST_SYNC_STASH: f2 } });
    try {
      const r2 = await rp(srv.req, 'POST', '/api/sync/force-token', { reportHash: 'b'.repeat(64) });
      assert.strictEqual(r2.status, 400); assert.ok(r2.j.error.includes('指纹不匹配'));
    } finally { await srv.close(); rmRoot(root); }
    assert.deepStrictEqual(hostReportSnap(), before, '宿主 last-sync-report.json 零接触');
  });

  await ok('正常发号：200 {ok,token,expiresAt,reportHash}；错 token 强制 → 403 强制令牌无效', async () => {
    const root = makeRoot();
    addCleanup(rmRoot.bind(null, root));
    const f = stashFile(root, stashOk());
    const srv = await boot({ root, env: { VR_TEST_SYNC_STASH: f } });
    try {
      const r = await rp(srv.req, 'POST', '/api/sync/force-token', { reportHash: HASH });
      assert.strictEqual(r.status, 200); assert.ok(r.j.ok && r.j.token && r.j.token.length === 64);
      assert.strictEqual(r.j.reportHash, HASH); assert.ok(r.j.expiresAt > Date.now());
      const bad = await rp(srv.req, 'POST', '/api/sync', { forceToken: 'f'.repeat(64) });
      assert.strictEqual(bad.status, 403); assert.ok(bad.j.error.includes('令牌无效'));
    } finally { await srv.close(); rmRoot(root); }
  });

  await ok('强制发布全链（离线真发布链）：forced 摘要 + 四资产/manifest/运行时报告落盘（均在临时根）+ token 单次消费', async () => {
    const before = hostReportSnap();
    const root = makeRoot();
    addCleanup(rmRoot.bind(null, root));
    const f = stashFile(root, stashOk());
    const srv = await boot({ root, env: { VR_TEST_SYNC_STASH: f } });
    try {
      const t = await rp(srv.req, 'POST', '/api/sync/force-token', { reportHash: HASH });
      assert.strictEqual(t.status, 200);
      const r = await rp(srv.req, 'POST', '/api/sync', { forceToken: t.j.token });
      assert.strictEqual(r.status, 200, '强制发布响应 ' + JSON.stringify(r.j));
      assert.strictEqual(r.j.ok, true); assert.strictEqual(r.j.replacement, 'forced');
      assert.ok(r.j.total >= 800 && r.j.total < 3000, '全量库规模发布计数（实得 ' + r.j.total + '）');
      assert.ok(r.j.delta > -100, '去重后 delta 哨兵（再分类会吃上游遗留重复台，实得 ' + r.j.delta + '）');
      assert.ok(String(r.j.manifestVersion).startsWith('sync-')); assert.ok(r.j.reportHash);
      assert.ok(Array.isArray(r.j.forcedReasons), '复跑报告自身 reasons 的 key 列表（全量库干净输入可为空数组，非 stash 报告）');
      const txt = fs.readFileSync(path.join(root, 'radio.txt'), 'utf8');
      assert.ok(txt.includes('注入测试台,http://s.example/inject.mp3'), '注入原料进发布产物');
      assert.ok(txt.includes('综合·其他,#genre#') || txt.includes('华语音乐,#genre#'), 'classifyCn 装配');
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'sync-manifest.json'), 'utf8'));
      assert.strictEqual(manifest.version, r.j.manifestVersion);
      assert.ok(fs.existsSync(path.join(root, 'data', 'last-sync-report.json')), '运行时报告落盘（临时根内）');
      const rep = JSON.parse(fs.readFileSync(path.join(root, 'data', 'last-sync-report.json'), 'utf8'));
      assert.strictEqual(rep.replacement, 'forced');
      // token 单次消费：同 token 重放 → 403
      const r2 = await rp(srv.req, 'POST', '/api/sync', { forceToken: t.j.token });
      assert.strictEqual(r2.status, 403); assert.ok(r2.j.error.includes('令牌无效'));
      assert.deepStrictEqual(hostReportSnap(), before, '宿主 last-sync-report.json 零接触（隔离根治实证）');
    } finally { await srv.close(); rmRoot(root); }
  });

  await ok('busy 409：STALL 撑开窗口，第二 POST → 409 同步已在进行中；首个正常完成', async () => {
    const before = hostReportSnap();
    const root = makeRoot();
    addCleanup(rmRoot.bind(null, root));
    const f = stashFile(root, stashOk());
    const srv = await boot({ root, env: { VR_TEST_SYNC_STASH: f, VR_TEST_SYNC_STALL: '1500' } });
    try {
      const t = await rp(srv.req, 'POST', '/api/sync/force-token', { reportHash: HASH });
      assert.strictEqual(t.status, 200);
      const p1 = rp(srv.req, 'POST', '/api/sync', { forceToken: t.j.token });
      await new Promise(r => setTimeout(r, 400)); // 让 p1 先占住 syncInFlight
      const p2 = await rp(srv.req, 'POST', '/api/sync', { forceToken: 'z'.repeat(64) });
      assert.strictEqual(p2.status, 409); assert.ok(p2.j.error.includes('同步已在进行中'));
      const r1 = await p1; assert.strictEqual(r1.status, 200); assert.strictEqual(r1.j.replacement, 'forced');
      assert.deepStrictEqual(hostReportSnap(), before, '宿主 last-sync-report.json 零接触');
    } finally { await srv.close(); rmRoot(root); }
  });
})().then(() => { console.log(`\n${pass} 通过，${fail} 失败`); process.exit(fail ? 1 : 0); })
  .catch(e => { console.error(e); process.exit(1); });
