// android-fixture 定时器回收确定性测试（review#40 P2）：/slow.mp3 延迟 starter 在 1.5s 窗口内客户端断连，
// 旧版照常建 interval + 10 分钟 TTL 且 close 监听永不触发 → interval 泄漏（复现实证：断连 2s 后仍剩
// 1 个活动 interval）。三场景断言注册表计数归零：①正常 keep-open 断连 ②延迟期间断连 ③close 时仍有
// 挂起延迟响应（close 后越过原起跑点不复活）。Node 14 兼容零依赖，离线秒级；run.js 全量自动发现。
const assert = require('assert'), http = require('http');
const fx = require('./harness/android-fixture');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 拉起一个请求并返回（连接建立即 resolve；error 全部吞掉——客户端主动断连在服务端视角就是连接关闭）
function req(port, path) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path }, res => { res.resume(); resolve(res); });
    r.on('error', () => {});
    setTimeout(() => reject(new Error('fixture 连接超时')), 5000);
    // 连接失败时 get 回调不触发，靠上面的超时 reject
  });
}

(async () => {
  console.log('[1] android-fixture 定时器回收（liveTimers 注册表）');
  const f = await fx.start();
  try {
    await ok('0 前置：fixture 刚起，无在飞定时器', async () => {
      assert.strictEqual(fx.pendingTimers(), 0);
    });
    await ok('① 正常 keep-open（direct.mp3）断连后 interval/TTL 归零', async () => {
      const res = await req(f.port, '/direct.mp3');
      await sleep(300);
      assert.ok(fx.pendingTimers() >= 1, '前置：keep-open 应有在飞 interval/TTL');
      res.destroy(); // 客户端主动断连
      await sleep(600); // close 事件到达 + rm 清理
      assert.strictEqual(fx.pendingTimers(), 0, '断连后应归零');
    });
    await ok('② 慢流延迟期间断连：starter 起跑点后不建 interval（旧版泄漏 1 个）', async () => {
      const r = await req(f.port, '/slow.mp3');
      r.destroy(); // 1.5s 延迟窗口内立即断连
      await sleep(2200); // 越过 starter 起跑点（1.5s）+ 余量
      assert.strictEqual(fx.pendingTimers(), 0, '断连 2s 后注册表应为空（旧版此处剩 1 个活动 interval）');
    });
    await ok('③ close 时仍有挂起延迟响应：close 立即清零且越过起跑点不复活', async () => {
      const r = await req(f.port, '/slow.mp3');
      await sleep(300); // starter 已挂表、延迟未到
      assert.ok(fx.pendingTimers() >= 1, '前置：挂起延迟 starter 应在表');
      r.destroy();
      await f.close(); // 统一回收（untrackTimers 先于断连）
      assert.strictEqual(fx.pendingTimers(), 0, 'close 后挂起延迟 starter 应立即清零');
      await sleep(1500); // 越过原起跑点：不复活
      assert.strictEqual(fx.pendingTimers(), 0, 'close 后越过起跑点仍归零');
    });
  } catch (e) {
    fail++; console.error('  ✗ 环境失败：', String(e && e.message || e).split('\n')[0]);
  }
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
})();
