// Store 存储收敛层状态机确定性矩阵（docs/testing-strategy-2026-11.md §3 L1 store 行，P0a 批次交付）。
// 黑盒经 vm 沙箱装载 store.js（test/harness/fake-browser），FakeClock 驱动 300ms debounce，
// 可编程 fetch 桩模拟 /api/store GET/POST（含 r.ok 假/网络断失败注入），FakeBC hub 模拟多标签同步互投。
// 与 test/smoke.js 分工：smoke 测服务端 /api/store 侧（白名单/发号/413），本文件只测客户端 Store 模块。
// 覆盖矩阵（13 项全落，编号 = 文件内 [N] 分节）：
//   [1] 白名单快照：snapshot 只收 KEYS 13 键，白名单外/未写入键不入
//   [2] set/remove 立即镜像（不等你 flush）
//   [3] 300ms 合批：连续写单次 POST、tick(299) 不发/tick(1) 发、新 set 重置窗口
//   [4] POST 成功才清 dirty/rev + 广播；失败（r.ok 假/网络断）保 dirty 保镜像
//   [5] 启动先重推 pending 再对账（AIbot P1-2：dirty 跨会话可达，镜像较新不被回滚）
//   [6] 收到他页消息作废 pending（规则②）→ pull 重拉后端
//   [7] flush 读当前内存（规则①）
//   [8] file:// / 后端不可用 / 响应缺 data / bc 创建失败降级
//   [9] beforeunload/visibilitychange flush（规则③，keepalive 透传）
//   [10] 多标签 last-write-wins（后推者胜）+ 同值幂等不重渲（P3-3 面）
//   [11] apply 键级合并：缺键保留绝不 removeItem / 覆盖 / 仅 baselineProg 变化不触发（AIbot P3-3）
//   [12] 服务端 rev 只存不比（客户端不做 rev 仲裁）
//   [13] 首次迁移：后端空 + 本地有镜像 → boot 静默 flush 推上去（老用户无感）
// 未覆盖项与原因：
//   - 真实 fetch keepalive 64KB 规范上限：浏览器网络栈约束，Store 只透传标志位（[9] 断言标志），上限行为不在本层；
//   - 真实 BroadcastChannel 跨进程/跨 origin/异步投递语义：FakeBC 为同 hub 同步互投，只验「收到广播 → pull」状态机；
//   - localStorage QuotaExceeded 配额满降级（set/remove 的 try/catch 吞错）：FakeLS 不抛异常，本层无法复现；
//   - 服务端 /api/store 白名单/发号/413/重启续发号：smoke.js 已覆盖，见文件头分工说明；
//   - Store.rev 不持久化（页面刷新即失）后的对账行为：rev 只存不比（[12]），无仲裁逻辑可测。
// 异步排水坑：flush 内 fetch().then() 链在微任务排空——clock.tick() 同步触发回调后，断言前必须
// setImmediate 兜底排水（drain 两轮），否则 dirty/rev/body 断言读到中间态。
const assert = require('assert');
const { sandbox, loadStore, bcHub, FakeLS } = require('./harness/fake-browser');
const { FakeClock } = require('./harness/fake-clock');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });
const drain = async () => { for (let i = 0; i < 2; i++) await new Promise(r => setImmediate(r)); }; // 微任务排水

// 可编程假后端：GET /api/store → {data, rev}；POST 全量覆盖 + rev 发号；fail*/reject* 注入失败路径
const mkBackend = () => {
  const be = {
    calls: [], rev: 0, data: {},
    failGet: false, rejectGet: false, failPost: false, rejectPost: false,
    posts() { return be.calls.filter(c => c.m === 'POST'); },
    fetch(url, opt) {
      opt = opt || {};
      const m = opt.method || 'GET';
      be.calls.push({ m, url, body: opt.body, keepalive: !!opt.keepalive });
      if (m === 'GET') {
        if (be.rejectGet) return Promise.reject(new Error('网络断（GET 注入）'));
        if (be.failGet) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }); // 缺 data 形态
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: be.data, rev: be.rev }) });
      }
      if (be.rejectPost) return Promise.reject(new Error('网络断（POST 注入）'));
      if (be.failPost) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
      try { be.data = JSON.parse(opt.body).data; } catch (_) {} // 全量覆盖（服务端语义）
      be.rev++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, rev: be.rev }) });
    },
  };
  return be;
};

// 单标签装配：可编程后端 + FakeClock + App.applyServerStore spy；noBoot 时不 init/boot（纯 apply 级用例）
const mkTab = async over => {
  const spy = { n: 0 };
  const be = over.be || mkBackend();
  const clock = over.clock || new FakeClock(0);
  const g = { App: { applyServerStore() { spy.n++; } } };
  if (over.bcBroken) g.BroadcastChannel = function () { throw new Error('BroadcastChannel 不可用'); };
  const sb = sandbox({ clock, fetch: be.fetch, ls: over.ls, lsSeed: over.lsSeed, bcHub: over.hub, location: over.location, globals: g });
  const Store = loadStore(sb);
  if (!over.noBoot) { Store.init(); await Store.boot(); await drain(); }
  return { sb, Store, be, spy, clock };
};
const bodyData = p => JSON.parse(p.body).data;

(async () => {
  console.log('[1] 白名单快照：snapshot() 只收 KEYS 13 键');
  await ok('写入全部 13 键 → 快照键集合恰为 KEYS 且值一致（白名单契约）', async () => {
    const t = await mkTab({});
    assert.strictEqual(t.Store.KEYS.length, 13, 'KEYS 白名单长度必须为 13（契约键数）');
    t.Store.KEYS.forEach((k, i) => t.sb.localStorage.setItem(k, 'v' + i));
    const sn = t.Store.snapshot();
    assert.strictEqual(Object.keys(sn).length, 13, '快照键数应为 13');
    t.Store.KEYS.forEach((k, i) => assert.strictEqual(sn[k], 'v' + i, '快照值应与镜像一致：' + k));
  });
  await ok('白名单外键不入快照（radio.logos/radio.storeDirty/feat.* 等）', async () => {
    const t = await mkTab({});
    ['radio.logos', 'radio.storeDirty', 'feat.uiRefresh', 'radio.customX'].forEach(k => t.sb.localStorage.setItem(k, 'x'));
    assert.strictEqual(Object.keys(t.Store.snapshot()).length, 0, '白名单外键必须全部被排除');
  });
  await ok('未写入键（getItem null）不入；空串值入（排除条件 = v != null，store.js:40）', async () => {
    const t = await mkTab({});
    t.sb.localStorage.setItem('radio.vol', '');
    assert.deepStrictEqual(Object.keys(t.Store.snapshot()), ['radio.vol'], '仅写入过的键入快照（空串也算有值）');
  });

  console.log('[2] set/remove 立即镜像：不等你 flush');
  await ok('set 即写 localStorage 且 get 读到（0ms 内、未 tick/未 flush）', async () => {
    const t = await mkTab({});
    t.Store.set('radio.vol', '66');
    assert.strictEqual(t.sb.localStorage.getItem('radio.vol'), '66', 'set 必须同步写镜像（写放大护栏的前提）');
    assert.strictEqual(t.Store.get('radio.vol'), '66', 'get 读镜像');
  });
  await ok('remove 即删镜像', async () => {
    const t = await mkTab({});
    t.Store.set('radio.view', 'grid');
    t.Store.remove('radio.view');
    assert.strictEqual(t.sb.localStorage.getItem('radio.view'), null, 'remove 必须同步删镜像');
    assert.strictEqual(t.Store.get('radio.view'), null);
  });

  console.log('[3] 300ms 合批：连续写单次 flush，窗口边界与重置');
  await ok('连续两 set → tick(299) 不发 / tick(1) 到点恰 1 次 POST，body 含两键', async () => {
    const t = await mkTab({});
    t.Store.set('radio.vol', '1');
    t.Store.set('radio.theme', 'dark');
    t.clock.tick(299);
    assert.strictEqual(t.be.posts().length, 0, '299ms 不得提前 flush');
    t.clock.tick(1);
    await drain();
    const posts = t.be.posts();
    assert.strictEqual(posts.length, 1, '连续写必须合批为单次 POST（写放大护栏）');
    assert.strictEqual(bodyData(posts[0])['radio.vol'], '1', '合批 body 应含第一键');
    assert.strictEqual(bodyData(posts[0])['radio.theme'], 'dark', '合批 body 应含第二键');
  });
  await ok('新 set 重置窗口：299ms 处再写 → 重新计满 300ms 才发', async () => {
    const t = await mkTab({});
    t.Store.set('radio.vol', '1');
    t.clock.tick(299);
    t.Store.set('radio.view', 'grid'); // 重置窗口（schedule clearTimeout 重排）
    t.clock.tick(299);
    assert.strictEqual(t.be.posts().length, 0, '重置后原窗口到点不得 flush');
    t.clock.tick(1);
    await drain();
    assert.strictEqual(t.be.posts().length, 1, '新窗口 300ms 到点 flush 恰一次');
  });

  console.log('[4] POST 成功才清 dirty/rev；失败保 dirty 保镜像');
  await ok('成功 → dirty 清 + rev 收敛响应值 + 广播 store 恰一次', async () => {
    const t = await mkTab({});
    const probe = new t.sb.BroadcastChannel('probe');
    let bcs = 0; probe.onmessage = () => { bcs++; };
    t.Store.dirty = true;
    assert.strictEqual(t.sb.localStorage.getItem('radio.storeDirty'), '1', 'dirty 是持久化标记 radio.storeDirty');
    t.Store.set('radio.favs', '["n"]');
    const r0 = t.Store.rev;
    await t.Store.flush(); await drain();
    assert.strictEqual(t.sb.localStorage.getItem('radio.storeDirty'), null, '成功后必须清 dirty');
    assert.strictEqual(t.Store.rev, t.be.rev, 'rev 必须收敛为服务端响应值');
    assert.notStrictEqual(t.Store.rev, r0, 'rev 应被响应更新');
    assert.strictEqual(bcs, 1, '成功 flush 必须广播 store 恰一次');
  });
  await ok('r.ok 假（超限被拒等）→ dirty 保 + 镜像保 + rev 不动 + 不广播（AIbot P2-3）', async () => {
    const t = await mkTab({});
    const probe = new t.sb.BroadcastChannel('probe');
    let bcs = 0; probe.onmessage = () => { bcs++; };
    t.Store.set('radio.favs', '["keep"]');
    t.Store.dirty = true;
    const r0 = t.Store.rev;
    t.be.failPost = true;
    await t.Store.flush(); await drain();
    assert.strictEqual(t.sb.localStorage.getItem('radio.storeDirty'), '1', '写失败必须保 dirty');
    assert.strictEqual(t.sb.localStorage.getItem('radio.favs'), '["keep"]', '写失败必须保镜像');
    assert.strictEqual(t.Store.rev, r0, '失败不得更新 rev');
    assert.strictEqual(bcs, 0, '失败不得广播');
  });
  await ok('fetch reject（网络断）→ 同样置 dirty 保镜像', async () => {
    const t = await mkTab({});
    t.Store.set('radio.vol', '7');
    t.Store.dirty = false; // 先清以便观察「失败重新置脏」而非「保持脏」
    t.be.rejectPost = true;
    await t.Store.flush(); await drain();
    assert.strictEqual(t.sb.localStorage.getItem('radio.storeDirty'), '1', '网络异常必须置 dirty');
    assert.strictEqual(t.sb.localStorage.getItem('radio.vol'), '7', '网络异常必须保镜像');
  });

  console.log('[5] 启动先重推 pending 再对账（AIbot P1-2：dirty 跨会话可达，镜像较新不被回滚）');
  await ok('dirty 会话（同 FakeLS 重载模拟旧会话恢复）：boot 走 flush 重推镜像，不 apply 后端 data', async () => {
    const be = mkBackend();
    be.data = { 'radio.favs': '["server"]', 'radio.vol': '1' }; be.rev = 9; // 失败期后端被别的端写过
    const ls = new FakeLS({ 'radio.favs': '["local"]', 'radio.storeDirty': '1' }); // 上一会话 POST 失败遗留
    const t = await mkTab({ be, ls });
    assert.strictEqual(t.Store.mode, 'server', 'boot 应进 server 模式');
    assert.strictEqual(t.be.posts().length, 1, 'dirty 启动必须先重推（flush）');
    assert.strictEqual(t.sb.localStorage.getItem('radio.favs'), '["local"]', '镜像较新：不得被后端 data 回滚（P1-2 核心）');
    assert.strictEqual(t.be.data['radio.favs'], '["local"]', '重推必须把本地镜像写上后端');
    assert.strictEqual(t.sb.localStorage.getItem('radio.storeDirty'), null, '重推成功清 dirty');
    assert.strictEqual(t.spy.n, 0, '重推路径不 apply（后端 data 不进内存，store.js:53）');
    assert.strictEqual(t.Store.rev, 10, 'rev 收敛为 POST 响应值');
  });
  await ok('对照组：无 dirty boot → 后端为准 apply 覆盖本地', async () => {
    const be = mkBackend();
    be.data = { 'radio.favs': '["server-new"]' }; be.rev = 3;
    const t = await mkTab({ be, lsSeed: { 'radio.favs': '["local-old"]' } });
    assert.strictEqual(t.sb.localStorage.getItem('radio.favs'), '["server-new"]', '干净启动后端为准（对账语义）');
    assert.strictEqual(t.spy.n, 1, 'apply 变化应触发 applyServerStore');
  });

  console.log('[6] 收到他页消息作废 pending（规则②）→ pull 重拉后端');
  await ok('本页 pending 被「他页 flush 广播」作废：旧值永不 POST，pull 应用后端、缺键保留本地', async () => {
    const hub = bcHub(), clock = new FakeClock(0), be = mkBackend();
    be.data = { 'radio.vol': '10' }; be.rev = 3;
    const A = await mkTab({ hub, clock, be });
    const B = await mkTab({ hub, clock, be });
    const a0 = A.spy.n;
    A.Store.set('radio.theme', 'dark'); // A 的 pending（尚未推送）
    B.Store.set('radio.vol', '99');
    await B.Store.flush(); await drain(); // B 推送 → 广播 → A pull（先作废 A pending 再 GET）
    assert.strictEqual(be.posts().length, 1, '仅 B 应有一次 POST');
    assert.strictEqual(be.data['radio.theme'], undefined, 'A 的 pending 旧值必须被作废，不得随后到 flush 泄漏上后端');
    assert.strictEqual(A.sb.localStorage.getItem('radio.vol'), '99', 'A pull 后应应用 B 推的后端值');
    assert.strictEqual(A.sb.localStorage.getItem('radio.theme'), 'dark', 'pull 缺键保留本地（theme 不被后端删除）');
    assert.strictEqual(A.spy.n, a0 + 1, 'A 的 pull 应用 vol 变化应恰触发一次 applyServerStore');
    clock.tick(300); await drain();
    assert.strictEqual(be.posts().length, 1, '被作废的 A 定时器到点不得再 POST（store.js:89 clearTimeout）');
  });

  console.log('[7] flush 读当前内存（规则①）：序列化时点在 flush 执行时');
  await ok('pending 期间继续 set → 到点 flush 的 body 是最新内存值', async () => {
    const t = await mkTab({});
    t.Store.set('radio.vol', '1'); // t=0 调度窗口至 300
    t.clock.tick(299);
    t.Store.set('radio.vol', '2'); // 窗口内续写：重置窗口至 599（schedule 每写重排，写永不进旧快照）
    t.clock.tick(300);             // t=599 到点
    await drain();
    assert.strictEqual(t.be.posts().length, 1, '恰一次 flush');
    assert.strictEqual(bodyData(t.be.posts()[0])['radio.vol'], '2', 'flush 必须读执行时内存（规则①），不得用调度时旧值');
  });
  await ok('手动 flush 读当前内存，且消化 pending（之后 tick 无二次 POST）', async () => {
    const t = await mkTab({});
    t.Store.set('radio.theme', 'a');
    t.Store.set('radio.theme', 'b');
    const n0 = t.be.posts().length;
    await t.Store.flush(); await drain();
    assert.strictEqual(bodyData(t.be.posts()[t.be.posts().length - 1])['radio.theme'], 'b', '手动 flush 读当前内存');
    t.clock.tick(300); await drain();
    assert.strictEqual(t.be.posts().length, n0 + 1, 'flush 必须清掉 pending（store.js:78），不得二次 POST');
  });

  console.log('[8] 降级：file:// 短路 / 后端不可用留 local / 响应缺 data / bc 创建失败');
  await ok('file:// → boot 短路零 fetch，flush/pull 短路零 POST，镜像即全部', async () => {
    const t = await mkTab({ location: { protocol: 'file:' } });
    assert.strictEqual(t.Store.mode, 'local', 'file:// 必须留 local 模式（store.js:43）');
    assert.strictEqual(t.be.calls.length, 0, 'file:// boot 不得发任何 fetch');
    t.Store.set('radio.vol', '5');
    await t.Store.flush(); await drain();
    await t.Store.pull(); await drain();
    assert.strictEqual(t.be.calls.length, 0, 'local 模式 flush/pull 一律短路');
    assert.strictEqual(t.sb.localStorage.getItem('radio.vol'), '5', '镜像即全部');
  });
  await ok('http 后端 GET reject → boot 吞错留 local，镜像原样', async () => {
    const be = mkBackend(); be.rejectGet = true;
    const t = await mkTab({ be, lsSeed: { 'radio.favs': '["m"]' } });
    assert.strictEqual(t.Store.mode, 'local', '后端不可用必须降级 local（store.js:55）');
    assert.strictEqual(t.sb.localStorage.getItem('radio.favs'), '["m"]', '降级不丢镜像');
  });
  await ok('GET 响应缺 data（非契约形态）→ 留 local 不 apply', async () => {
    const be = mkBackend(); be.failGet = true; // 响应 {error} 无 data
    const t = await mkTab({ be, lsSeed: { 'radio.favs': '["m"]' } });
    assert.strictEqual(t.Store.mode, 'local', '响应缺 data 不得进 server 模式（store.js:46）');
    assert.strictEqual(t.spy.n, 0, '不得 apply');
  });
  await ok('BroadcastChannel 创建失败 → init 容错 bc=null，flush 照常成功（store.js:25-27）', async () => {
    const t = await mkTab({ bcBroken: true });
    assert.strictEqual(t.Store.bc, null, 'bc 创建失败必须容错为 null');
    t.Store.set('radio.vol', '8');
    await t.Store.flush(); await drain(); // 不抛即通过
    assert.strictEqual(t.be.posts().length, 1, 'bc 缺失不影响推送');
    assert.strictEqual(t.sb.localStorage.getItem('radio.storeDirty'), null, '推送成功清 dirty');
  });
  await ok('pull 的 GET 失败 → 静默吞错本地不动', async () => {
    const be = mkBackend(); be.data = { 'radio.vol': '9' }; be.rev = 1;
    const t = await mkTab({ be });
    be.rejectGet = true;
    await t.Store.pull(); await drain(); // 不抛即通过
    assert.strictEqual(t.sb.localStorage.getItem('radio.vol'), '9', 'pull 失败本地保持原值');
  });

  console.log('[9] beforeunload / visibilitychange flush（规则③）');
  await ok('beforeunload → keepalive POST，300ms 窗口内改动不丢', async () => {
    const t = await mkTab({});
    t.Store.set('radio.vol', '88'); // 未到 300ms
    assert.ok(t.sb._winEv.beforeunload && t.sb._winEv.beforeunload.length, 'init 必须注册 beforeunload 监听');
    t.sb._winEv.beforeunload.forEach(fn => fn());
    await drain();
    const posts = t.be.posts();
    assert.strictEqual(posts.length, 1, 'unload flush 必须发出');
    assert.ok(posts[0].keepalive, 'unload flush 必须 keepalive=true（可穿 unload）');
    assert.strictEqual(bodyData(posts[0])['radio.vol'], '88', '窗口内改动必须进 body（防关页丢写）');
  });
  await ok('visibilitychange：hidden=true flush；hidden=false 不 flush', async () => {
    const t = await mkTab({});
    t.sb.document.hidden = true;
    t.sb.document.dispatch('visibilitychange');
    await drain();
    assert.strictEqual(t.be.posts().length, 1, '切后台必须 flush');
    assert.ok(t.be.posts()[0].keepalive, 'visibility flush 同样 keepalive');
    t.sb.document.hidden = false;
    t.sb.document.dispatch('visibilitychange');
    await drain();
    assert.strictEqual(t.be.posts().length, 1, '前台可见不得 flush');
  });

  console.log('[10] 多标签 last-write-wins + 同值幂等不重渲');
  await ok('两页先后 flush → 后推者胜；未推送改动被回读；先推页经广播 pull 收敛', async () => {
    const hub = bcHub(), clock = new FakeClock(0), be = mkBackend();
    be.data = { 'radio.vol': '5' }; be.rev = 1;
    const A = await mkTab({ hub, clock, be });
    const B = await mkTab({ hub, clock, be });
    const a0 = A.spy.n, b0 = B.spy.n;
    A.Store.set('radio.vol', '10');
    B.Store.set('radio.vol', '20');
    await A.Store.flush(); await drain(); // A 先推 '10' → 广播 → B pull：作废 B pending、回读 '10'
    assert.strictEqual(be.data['radio.vol'], '10', 'A 先推落库');
    assert.strictEqual(B.sb.localStorage.getItem('radio.vol'), '10', 'B 未推送改动被后端为准回读（LWW 退化语义，AIbot P2-1）');
    assert.strictEqual(B.spy.n, b0 + 1, 'B 回读变化触发一次 applyServerStore');
    B.Store.set('radio.vol', '20'); // B 重新落内存后推
    await B.Store.flush(); await drain();
    assert.strictEqual(be.data['radio.vol'], '20', '后推者胜（显式 last-write-wins）');
    assert.strictEqual(A.sb.localStorage.getItem('radio.vol'), '20', '先推页经广播 pull 收敛到后推值');
    assert.strictEqual(A.spy.n, a0 + 1, 'A 恰好一次 applyServerStore');
  });
  await ok('同值幂等：他页广播重拉同值 → apply 返回 changed=false，applyServerStore 不触发', async () => {
    const hub = bcHub(), clock = new FakeClock(0), be = mkBackend();
    be.data = { 'radio.vol': '20' }; be.rev = 1;
    const A = await mkTab({ hub, clock, be });
    const B = await mkTab({ hub, clock, be });
    const b0 = B.spy.n;
    await A.Store.flush(); await drain(); // A 推同值快照 → 广播 → B pull
    assert.strictEqual(be.data['radio.vol'], '20', '后端值不变');
    assert.strictEqual(B.spy.n, b0, '同值 apply 不触发 applyServerStore（防多余重渲，P3-3 面）');
    assert.strictEqual(B.Store.apply({ 'radio.vol': '20' }), false, 'apply 同值必须返回 changed=false（store.js:74）');
  });

  console.log('[11] apply 键级合并：缺键保留 / 覆盖 / 仅 baselineProg 变化不触发（AIbot P3-3）');
  await ok('后端缺键 → 本地保留绝不 removeItem（多浏览器首次迁移窗口保护，store.js:70）', async () => {
    const t = await mkTab({ noBoot: true, lsSeed: { 'radio.favs': '["x"]' } });
    const changed = t.Store.apply({ 'radio.vol': '7' });
    assert.strictEqual(t.sb.localStorage.getItem('radio.favs'), '["x"]', '后端缺键必须保留本地');
    assert.strictEqual(t.sb.localStorage.getItem('radio.vol'), '7', '后端有键必须写入');
    assert.strictEqual(changed, true, '有变化返回 true');
    assert.strictEqual(t.spy.n, 1, 'vol 变化触发一次');
  });
  await ok('后端有键且值不同 → 覆盖；值同键不入 diff（恰触发一次）', async () => {
    const t = await mkTab({ noBoot: true, lsSeed: { 'radio.favs': '["x"]', 'radio.vol': '5' } });
    const changed = t.Store.apply({ 'radio.favs': '["y"]', 'radio.vol': '5' });
    assert.strictEqual(t.sb.localStorage.getItem('radio.favs'), '["y"]', '值不同必须覆盖');
    assert.strictEqual(changed, true, 'favs 变化 → changed');
    assert.strictEqual(t.spy.n, 1, '恰触发一次（值同的 vol 不入 diff）');
  });
  await ok('仅 radio.baselineProg 变化 → 落盘但不触发 applyServerStore（P3-3 防基线期整表重渲）', async () => {
    const t = await mkTab({ noBoot: true, lsSeed: { 'radio.baselineProg': '50' } });
    const changed = t.Store.apply({ 'radio.baselineProg': '80' });
    assert.strictEqual(t.sb.localStorage.getItem('radio.baselineProg'), '80', '进度值必须落盘');
    assert.strictEqual(changed, true, 'changed 为真（有写入）');
    assert.strictEqual(t.spy.n, 0, '仅 baselineProg 变化不得触发内存重载（store.js:73）');
  });
  await ok('混合 diff（baselineProg + 其余键）→ 触发一次', async () => {
    const t = await mkTab({ noBoot: true, lsSeed: { 'radio.baselineProg': '50', 'radio.vol': '1' } });
    t.Store.apply({ 'radio.baselineProg': '90', 'radio.vol': '2' });
    assert.strictEqual(t.spy.n, 1, 'diff 含非 baselineProg 键必须触发一次');
  });
  await ok('白名单外键忽略；null 值键保留本地不删（删除语义靠值表达）', async () => {
    const t = await mkTab({ noBoot: true, lsSeed: { 'radio.vol': '5', 'radio.favs': '["x"]' } });
    const changed = t.Store.apply({ 'radio.logos': 'x', 'radio.favs': null, 'radio.vol': '5' });
    assert.strictEqual(t.sb.localStorage.getItem('radio.favs'), '["x"]', 'null 值 = 后端未见过的键，保留本地（绝不 removeItem）');
    assert.strictEqual(t.sb.localStorage.getItem('radio.logos'), null, '白名单外键不得写入');
    assert.strictEqual(changed, false, '全无变化');
    assert.strictEqual(t.spy.n, 0, '不触发');
  });

  console.log('[12] 服务端 rev 只存不比：客户端不做 rev 仲裁');
  await ok('客户端预置大 rev → flush 照发照收收敛响应值；pull 后 rev 跟随 GET', async () => {
    const be = mkBackend(); be.data = { 'radio.vol': '1' }; be.rev = 2;
    const t = await mkTab({ be });
    assert.strictEqual(t.Store.rev, 2, 'boot 后 rev = 服务端 rev');
    t.Store.rev = 99999; // 人为抬高：若客户端比较 rev 必然拒绝低号响应
    t.Store.set('radio.vol', '77');
    await t.Store.flush(); await drain();
    assert.strictEqual(t.be.posts().length, 1, 'rev 不参与仲裁：照常推送');
    assert.strictEqual(t.Store.rev, 3, 'rev 收敛为响应值（只存不比，store.js:83）');
    assert.strictEqual(t.sb.localStorage.getItem('radio.storeDirty'), null, '照常清 dirty');
    be.rev = 42;
    await t.Store.pull(); await drain();
    assert.strictEqual(t.Store.rev, 42, 'pull 后 rev 跟随 GET 响应（store.js:95）');
  });

  console.log('[13] 首次迁移：后端空 + 本地有镜像 → boot 静默 flush 推上去（老用户无感）');
  await ok('迁移：boot 推快照落库、清 dirty、不触发 applyServerStore', async () => {
    const be = mkBackend(); // data 空 rev 0
    const t = await mkTab({ be, lsSeed: { 'radio.favs': '["a"]', 'radio.vol': '30' } });
    assert.strictEqual(t.Store.mode, 'server', '空库也算 server 模式（后续 flush 生效）');
    assert.strictEqual(t.be.posts().length, 1, '本地有镜像必须静默迁移 flush（store.js:50）');
    assert.strictEqual(be.data['radio.favs'], '["a"]', '镜像键落库');
    assert.strictEqual(be.data['radio.vol'], '30', '镜像键落库');
    assert.strictEqual(t.spy.n, 0, '迁移路径不 apply（不重渲首屏）');
    assert.strictEqual(t.sb.localStorage.getItem('radio.storeDirty'), null, '迁移成功清 dirty');
  });
  await ok('后端空 + 本地空 → 不发迁移 POST，待命 server 模式', async () => {
    const t = await mkTab({});
    assert.strictEqual(t.Store.mode, 'server', '仍进 server 模式');
    assert.strictEqual(t.be.posts().length, 0, '无镜像不得发迁移 POST');
  });

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('store 测试异常：', e); process.exit(1); });
