// boot({root}) 生命周期契约（review#39-r2 P3-④，harness/api-client.js 的行为面）：真服务 + 独立根两轮 boot 的
// 数据连续性与临时根清理——
//   [1] boot({root})（测试自管根，ownsRoot=false）：写 /api/store → close（进程退出）后根仍完整
//       （根目录在、store.json 原样）——「操纵资产 → 同根重启」矩阵的前提；
//   [2] 同根重启 boot({root})：读回同一 rev/数据且续发号不重置（storeRead 懒装载跨进程连续，rev 服务端唯一发号）；
//   [3] isolated boot（自有根）：写盘落自有根（顺带钉死 review#39-r2 ③ 的隔离默认化——boot() 无 opts 不再落宿主根）
//       → close = 杀服 → 等退出 → rmRoot，根目录最终不存在。
//   删除失败可见性由 rmRoot 的 console.error 承担（记录不吞，根残留即本用例变红可见）；删除失败注入跨平台
//   不稳定（Windows 只读属性不拦目录删除），不在此模拟——本文件钉成功路径的「根已删」。
// /api/store 是最小写盘面（只写根内 data/store.json，零外网、零注入缝），生命周期断言用 HTTP + 文件双视角。
const assert = require('assert'), fs = require('fs'), path = require('path');
const { boot, makeRoot, addCleanup, ROOT } = require('./harness/api-client');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });
const postStore = (s, data) => s.req('POST', '/api/store', { 'Content-Type': 'application/json' }, JSON.stringify({ data }));

(async () => {
  const R = makeRoot(); // 测试自管根：boot({root}) 复用，close 不删——SIGINT 兜底 + finally 兜删
  addCleanup(() => { try { fs.rmSync(R, { recursive: true, force: true }); } catch (_) {} });
  const storeFile = () => path.join(R, 'data', 'store.json');
  let s = null, s2 = null;
  try {
    console.log('[1] boot({root})：进程退出后临时根仍完整 + 同根重启读回同一 rev/数据');
    s = await boot({ root: R });
    let rev1 = null;
    await ok('首 boot 写入 → rev=1 且 store.json 落在根内', async () => {
      const r = await postStore(s, { 'radio.favs': JSON.stringify(['https://a.example/live']) });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(JSON.parse(r.body).rev, 1);
      rev1 = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
      assert.strictEqual(rev1.rev, 1);
      assert.deepStrictEqual(rev1.data, { 'radio.favs': '["https://a.example/live"]' });
    });
    await s.close(); s = null;
    await ok('close（进程退出）后临时根仍完整：根目录在、store.json 原样', () => {
      assert.ok(fs.existsSync(R), 'boot({root}) 的 close 不删测试自管根');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(storeFile(), 'utf8')), rev1);
    });
    s = await boot({ root: R });
    await ok('同根重启读回同一 rev/数据，续发号不重置（跨进程连续）', async () => {
      const j = JSON.parse((await s.req('GET', '/api/store')).body);
      assert.strictEqual(j.rev, rev1.rev);
      assert.deepStrictEqual(j.data, rev1.data);
      const w = await postStore(s, { 'radio.favs': '[]' });
      assert.strictEqual(JSON.parse(w.body).rev, rev1.rev + 1, '重启后从盘上 rev 续发，不从 1 重发');
    });
    await s.close(); s = null;

    console.log('[2] isolated boot：close = 杀服 → 等退出 → 删自有根');
    s2 = await boot(); // 无 opts：默认 isolated（review#39-r2 ③ 隔离默认化——本用例同时钉死 boot() 不再落宿主根）
    const root2 = s2.root;
    await ok('isolated 写盘落在自有根内（非宿主仓库根）', async () => {
      assert.notStrictEqual(root2, ROOT, '无 opts boot 的根不得是宿主仓库根');
      const r = await postStore(s2, { 'radio.vol': '30' });
      assert.strictEqual(r.status, 200);
      assert.ok(fs.existsSync(path.join(root2, 'data', 'store.json')), '自有根内已写');
    });
    await s2.close(); s2 = null;
    await ok('close 后临时根最终删除（rmRoot 失败会留根 + console.error，本用例变红可见）',
      () => assert.strictEqual(fs.existsSync(root2), false));
  } finally {
    if (s) { try { await s.close(); } catch (_) {} }
    if (s2) { try { await s2.close(); } catch (_) {} }
    try { fs.rmSync(R, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('boot-lifecycle 测试异常：', e); process.exit(1); });
