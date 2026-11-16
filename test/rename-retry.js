// server.js renameRetry/atomicWrite 确定性分支测试（review#40 / #37 review P2-2 转交，P3）。
// 覆盖（全走真实 HTTP + 隔离临时应用根，宿主 data/、my-radio.txt 零接触——api-client isolated 口径）：
// ① 第一次 rename EPERM、重试后成功 → 落盘成功、响应恰一次 ok:true（fs 注入：test/harness/fs-inject.js
//    preload，-r 挂载；日志两行 = 第一次注入失败 + 第二次真实成功——重试分支确定性走过，不靠计时器猜）；
// ② 连续失败（真 fs 注入连续 ENOSPC = 不可重试码）→ 响应 ok:false 恰一次、旧文件字节不变、rev 不推进、
//    tmp 孤儿被清理（data/ 无 *.tmp 残留）；
// ③ 不可重试错误立即失败不重试（同一注入的日志恰 1 行 = renameRetry 对 ENOSPC 直通）；
// ④ 队列继续前进（失败后下一请求正常处理——store 串行队列不被毒死）；
// ⑤ 目录替身触发真 fs 失败（rename 文件→目录，Windows EPERM/Linux EISDIR 双平台必败，该路径已证明稳定
//    复现）+ tmp 回收；「第一次失败重试成功」用 fs 注入覆盖（真 fs 难以跨平台确定性复现瞬时 EPERM，
//    任务书允许的静态检查已并入 ⑥：atomicWrite 内含 renameRetry/unlink、七条写路径全走 helper、
//    tmpOf 不再被裸调用）。
// 注意 server.js 单文件经典 script 不可 require——统一子进程起真服打真端口；离线秒级。
const assert = require('assert'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const { boot, freePort, reqFn, makeRoot } = require('./harness/api-client');
// api-client 的 rmRoot 未导出（该文件禁止改动）——本地同款实现：删自有临时根，失败记录不吞
const rmRoot = dir => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error('临时根清理失败（记录不吞）:', dir, (e && e.code) || e); } };

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const UP = path.join(__dirname, '..');
const POST_HDR = { 'Content-Type': 'application/json' };
const OLD = JSON.stringify({ rev: 7, data: { 'radio.vol': '0.4' } }); // 预置旧盘：rev 7
const OLD_BYTES = Buffer.from(OLD);
const tmpOrphans = root => { // data/ 下 *.tmp 残留（atomicWrite 失败回收的验收面）
  const d = path.join(root, 'data');
  try { return fs.readdirSync(d).filter(n => /\.tmp$/.test(n)); } catch (_) { return []; }
};
const readLog = log => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

// 带注入的子进程起服（api-client 无 -r 参数注入口且禁止改动——本地复刻 boot 的隔离根 + 就绪轮询口径）
async function bootInject(inject) {
  const root = makeRoot();
  const port = await freePort();
  const log = path.join(root, 'rename-log.jsonl');
  const srv = spawn(process.execPath, ['-r', path.join(__dirname, 'harness', 'fs-inject.js'), path.join(root, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1',
      VR_TEST_RENAME_INJECT: JSON.stringify(inject), VR_TEST_RENAME_LOG: log }),
    cwd: root, stdio: 'ignore' });
  const req = reqFn(port);
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try { if ((await req('GET', '/')).status === 200) break; } catch (_) {}
    if (srv.exitCode !== null) throw new Error('server 启动即退出');
  }
  return { srv, root, log, req, close: async () => { try { srv.kill(); } catch (_) {} await sleep(200); rmRoot(root); } };
}

(async () => {
  console.log('[1] 注入：第一次 EPERM → 重试成功（①④）');
  await ok('第一次 rename EPERM 失败、重试后成功：ok:true 恰一次 + 旧 rev 7 推进到 8 + 日志两行（重试分支确定性走过）', async () => {
    const h = await bootInject({ failFirst: 1, code: 'EPERM', pathIncludes: 'store.json' });
    try {
      fs.mkdirSync(path.join(h.root, 'data'));
      fs.writeFileSync(path.join(h.root, 'data', 'store.json'), OLD_BYTES);
      const w = JSON.parse((await h.req('POST', '/api/store', POST_HDR, JSON.stringify({ data: { 'radio.vol': '0.5' } }))).body);
      assert.strictEqual(w.ok, true);
      const g = JSON.parse((await h.req('GET', '/api/store')).body);
      assert.strictEqual(g.rev, 8); // 旧盘 rev 7 + 1：成功才推进
      assert.strictEqual(fs.readFileSync(path.join(h.root, 'data', 'store.json'), 'utf8'), JSON.stringify({ rev: 8, data: { 'radio.vol': '0.5' } }));
      assert.deepStrictEqual(tmpOrphans(h.root), []); // rename 成功 tmp 已不存在
      const log = readLog(h.log);
      assert.strictEqual(log.length, 2, '恰两次 rename 调用（注入 1 次 + 真实 1 次）');
      assert.strictEqual(log[0].injected, 'EPERM');
      assert.strictEqual(log[1].injected, null, '第二次调用已透传真实 rename');
    } finally { await h.close(); }
  });

  console.log('[2] 注入：连续 ENOSPC 不可重试（②③）');
  await ok('连续 ENOSPC：ok:false 恰一次 + 旧文件字节不变 + rev 不推进 + tmp 孤儿被清理', async () => {
    const h = await bootInject({ failFirst: 99, code: 'ENOSPC', pathIncludes: 'store.json' });
    try {
      fs.mkdirSync(path.join(h.root, 'data'));
      fs.writeFileSync(path.join(h.root, 'data', 'store.json'), OLD_BYTES);
      const before = Buffer.from(fs.readFileSync(path.join(h.root, 'data', 'store.json')));
      const w = JSON.parse((await h.req('POST', '/api/store', POST_HDR, JSON.stringify({ data: { 'radio.vol': '0.5' } }))).body);
      assert.strictEqual(w.ok, false);
      const g = JSON.parse((await h.req('GET', '/api/store')).body);
      assert.strictEqual(g.rev, 7); // 失败不推进（内存 rev 与旧盘一致）
      assert.ok(Buffer.from(fs.readFileSync(path.join(h.root, 'data', 'store.json'))).equals(before), '旧文件字节不变');
      assert.deepStrictEqual(tmpOrphans(h.root), [], '失败后本次 tmp 已 unlink（无 *.tmp 残留）');
      assert.deepStrictEqual(readLog(h.log), [{ path: path.join(h.root, 'data', 'store.json'), injected: 'ENOSPC' }],
        '不可重试码直通：恰 1 次 rename 调用（③ 立即失败不重试）');
    } finally { await h.close(); }
  });

  console.log('[3] 目录替身真 fs 失败 + 队列前进（②④真盘面）');
  await ok('目录替身：rename 必败 → ok:false + 无 tmp 残留 + rev 不推进', async () => {
    const h = await boot({ isolated: true }); // api-client isolated：临时应用根，宿主零接触
    try {
      fs.mkdirSync(path.join(h.root, 'data'));
      fs.mkdirSync(path.join(h.root, 'data', 'store.json')); // 目标换目录 → rename 文件→目录必败（Win EPERM/Linux EISDIR）
      const w = JSON.parse((await h.req('POST', '/api/store', POST_HDR, JSON.stringify({ data: { 'radio.vol': '0.5' } }))).body);
      assert.strictEqual(w.ok, false);
      assert.deepStrictEqual(tmpOrphans(h.root), [], '真 fs 失败路径同样回收 tmp');
      const g = JSON.parse((await h.req('GET', '/api/store')).body);
      assert.strictEqual(g.rev, 0); // 目录读不出旧盘 = 空库，失败不推进
      // ④ 队列继续前进：撤目录写真文件，下一请求正常处理
      fs.rmdirSync(path.join(h.root, 'data', 'store.json'));
      fs.writeFileSync(path.join(h.root, 'data', 'store.json'), OLD_BYTES);
      const w2 = JSON.parse((await h.req('POST', '/api/store', POST_HDR, JSON.stringify({ data: { 'radio.vol': '0.5' } }))).body);
      assert.strictEqual(w2.ok, true);
      const g2 = JSON.parse((await h.req('GET', '/api/store')).body);
      assert.strictEqual(g2.rev, 1); // 内存 rev 0 + 1（服务端内存态权威；断言点 = 队列没被失败毒死）
      assert.strictEqual(g2.data['radio.vol'], '0.5');
    } finally { await h.close(); }
  });

  console.log('[4] 静态检查（任务书允许的兜底：helper 化 + 全路径接线）');
  await ok('atomicWrite 内含 renameRetry 短重试 + 失败 unlink；七条写路径全走 helper；tmpOf 不再被裸调用', () => {
    const src = fs.readFileSync(path.join(UP, 'server.js'), 'utf8');
    assert.strictEqual((src.match(/atomicWrite\(/g) || []).length, 8, '1 处定义 + 7 处调用（my-radio×2/store/quality×2/listen-stats×2）');
    assert.strictEqual((src.match(/tmpOf\(/g) || []).length, 1, 'tmpOf 只在 atomicWrite 内调用（写路径不再自造 tmp）');
    const helper = src.slice(src.indexOf('function atomicWrite'), src.indexOf('function atomicWrite') + 900);
    assert.ok(/renameRetry\(tmp, target/.test(helper), '短重试语义保留在 helper 内');
    assert.ok(/fs\.unlink\(tmp/.test(helper), '失败回收 unlink 本次拥有的 tmp');
    assert.ok(/EPERM' \|\| e\.code === 'EACCES'/.test(src), 'renameRetry 仅 EPERM/EACCES 重试（语义不变）');
  });

  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
})();
