// Store 存储收敛层状态机确定性矩阵（docs/testing-strategy-2026-11.md §3 L1 store 行，P0a 批次交付）。
// 黑盒经 vm 沙箱装载 store.js（test/harness/fake-browser），FakeClock 驱动 300ms debounce，
// 可编程 fetch 桩模拟 /api/store GET/POST（含 r.ok 假/网络断失败注入），FakeBC hub 模拟多标签同步互投。
// 与 test/smoke.js 分工：smoke 测服务端 /api/store 侧（白名单/发号/413），本文件只测客户端 Store 模块。
// 覆盖矩阵（编号 = 文件内 [N] 分节）：
//   [0] FakeBC 装置契约：同名互投/异名隔离/不回发自身/close 语义/逐接收方深拷贝（review#37 P2-1）
//   [1] 白名单快照：snapshot 只收 KEYS（与 contracts/radio-keys.json 逐键比对，不双硬编码键数）
//   [2] set/remove 立即镜像（不等你 flush）
//   [3] 300ms 合批：连续写单次 POST、tick(299) 不发/tick(1) 发、新 set 重置窗口
//   [4] POST 成功才清 dirty/rev + 广播；失败（r.ok 假/网络断）保 dirty 保镜像
//   [5] 启动先重推 pending 再对账（AIbot P1-2：dirty 跨会话可达，镜像较新不被回滚）
//   [6] 收到他页消息作废 pending（规则②）→ pull 重拉后端
//   [7] flush 读当前内存（规则①）
//   [8] file:// / 后端不可用 / 响应缺 data / bc 创建失败降级
//   [9] beforeunload/visibilitychange flush（规则③，keepalive 透传）
//   [10] 跨页 last-write-wins（后推者胜）+ 同值幂等不重渲（P3-3 面）
//   [10b] 同浏览器双标签共享 FakeLS：他页直写共享镜像后本页内存基线重载（review#37 P1-2 生产修复面）
//   [10c] 跨浏览器（独立 LS/无 BC）：显式 pull 对账收敛 LWW
//   [11] apply 键级合并：缺键保留绝不 removeItem / 覆盖 / 仅 baselineProg 变化不触发（AIbot P3-3）
//   [12] 服务端 rev 只存不比（客户端不做 rev 仲裁）
//   [13] 首次迁移：后端空 + 本地有镜像 → boot 静默 flush 推上去（老用户无感）
//   [14] 空覆盖门（issue #42）：空库开局页 unload 不以全空快照清库（拦下发 pull 对账）；三个放行面
//        （本页有写/sawData 见过非空/合法删除空值表达）+ 门后自愈
//   [15] flush 单飞串行 + 尾随重推：在飞不并发/补发读最新内存/旧快照终态不清新 dirty/keepalive 旁路
//        （review#37 P1-4 生产修复面；defer 后端手动 release 模拟乱序）
// 未覆盖项与原因：
//   - 真实 fetch keepalive 64KB 规范上限：浏览器网络栈约束，Store 只透传标志位（[9] 断言标志），上限行为不在本层；
//   - 真实 BroadcastChannel 跨进程/跨 origin/异步投递语义：FakeBC 为同 hub 同步互投（装置边界——异步投递/
//     跨进程时序不属本层，[0] 只冻结同名/异名/不回发/close/克隆五项桩契约）；
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

// 可编程假后端：GET /api/store → {data, rev}；POST 全量覆盖 + rev 发号；fail*/reject* 注入失败路径。
// defer=true 时 POST 响应挂起不落定，由 release(i, resp) 手动放行（乱序响应矩阵——review#37 P1-4：
// 真实 flush 可被 debounce/unload/手动重叠触发，完成顺序不受调用顺序约束）
const mkBackend = () => {
  const be = {
    calls: [], rev: 0, data: {},
    failGet: false, rejectGet: false, failPost: false, rejectPost: false, defer: false,
    posts() { return be.calls.filter(c => c.m === 'POST'); },
    _waiters: [],
    release(i, resp) { // resp: 'ok' | 'fail' | 'reject'——放行第 i 个挂起的 POST（按调用序）
      const w = be._waiters[i];
      if (!w) throw new Error('无挂起 POST #' + i);
      be._waiters[i] = null;
      if (resp === 'reject') return w.res(Promise.reject(new Error('网络断（release 注入）')));
      if (resp === 'fail') return w.res({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
      try { be.data = JSON.parse(w.body).data; } catch (_) {} // 全量覆盖（服务端语义）
      be.rev++;
      w.res({ ok: true, json: () => Promise.resolve({ ok: true, rev: be.rev }) });
    },
    fetch(url, opt) {
      opt = opt || {};
      const m = opt.method || 'GET';
      be.calls.push({ m, url, body: opt.body, keepalive: !!opt.keepalive });
      if (m === 'GET') {
        if (be.rejectGet) return Promise.reject(new Error('网络断（GET 注入）'));
        if (be.failGet) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }); // 缺 data 形态
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: be.data, rev: be.rev }) });
      }
      if (be.defer) return new Promise(res => be._waiters.push({ body: opt.body, res })); // 挂起待 release
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
  console.log('[0] FakeBC 装置契约：同名互投/异名隔离/不回发自身/关闭语义/消息克隆（review#37 P2-1）');
  await ok('同名互投、异名隔离：store 广播只达同名通道，异名通道零触达', async () => {
    const hub = bcHub();
    const a = new hub.FakeBC('vradio'), b = new hub.FakeBC('vradio'), other = new hub.FakeBC('unrelated');
    let got = 0, noise = 0;
    b.onmessage = () => { got++; };
    other.onmessage = () => { noise++; };
    a.postMessage('store');
    assert.strictEqual(got, 1, '同名通道必须收到');
    assert.strictEqual(noise, 0, '异名通道绝不能收到（旧桩全 hub 互投是装置缺陷）');
  });
  await ok('不回发自身；close 后 postMessage 抛错且不再接收', async () => {
    const hub = bcHub();
    const a = new hub.FakeBC('vradio'), b = new hub.FakeBC('vradio');
    let self = 0, bGot = 0;
    a.onmessage = () => { self++; };
    b.onmessage = () => { bGot++; };
    a.postMessage('store');
    assert.strictEqual(self, 0, '不得回发自身');
    assert.strictEqual(bGot, 1);
    a.close();
    assert.throws(() => a.postMessage('store'), /close/, 'close 后发送必须抛错（spec 口径）');
    b.postMessage('store');
    assert.strictEqual(bGot, 1, 'close 后不再接收');
  });
  await ok('消息对象深拷贝投递：接收方改写不影响他方（结构化克隆近似）', async () => {
    const hub = bcHub();
    const a = new hub.FakeBC('vradio'), b1 = new hub.FakeBC('vradio'), b2 = new hub.FakeBC('vradio');
    let d1 = null, d2 = null;
    b1.onmessage = e => { d1 = e.data; d1.x = 1; };
    b2.onmessage = e => { d2 = e.data; };
    a.postMessage({ k: 'v' });
    assert.deepStrictEqual(d2, { k: 'v' }, '他页改写不得串扰（深拷贝语义）');
  });

  console.log('[1] 白名单快照：snapshot() 只收 KEYS 契约键');
  const CONTRACT_KEYS = Object.keys(JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'contracts', 'radio-keys.json'), 'utf8')).keys);
  const arr = r => [].slice.call(r); // vm 跨 realm 数组原型失配：deepStrictEqual 前先展开（同 test/player.js 法）
  await ok('KEYS 与 contracts/radio-keys.json 逐键一致（契约单一来源，review#37 P3——不双硬编码键数）', async () => {
    const t = await mkTab({});
    assert.deepStrictEqual(arr(t.Store.KEYS), CONTRACT_KEYS, 'KEYS 必须与契约文件同序同集合');
    t.Store.KEYS.forEach((k, i) => t.sb.localStorage.setItem(k, 'v' + i));
    const sn = t.Store.snapshot();
    assert.strictEqual(Object.keys(sn).length, CONTRACT_KEYS.length, '快照键数应为契约键数');
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
    const probe = new t.sb.BroadcastChannel('vradio'); // 同名观察通道（FakeBC 现按 name 过滤，异名收不到——review#37 P2-1）
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
    const probe = new t.sb.BroadcastChannel('vradio'); // 同名观察通道（FakeBC 现按 name 过滤，异名收不到——review#37 P2-1）
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
  await ok('visibilitychange：hidden=true flush（有写面）；hidden=false 不 flush', async () => {
    const t = await mkTab({});
    t.Store.set('radio.vol', '9'); // 有写面：快照非空，断言 flush 机制本身（空快照面归 [14] 门管）
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

  console.log('[10b] 同浏览器多标签（共享 FakeLS + 共享 hub）：他页写共享镜像后本页内存基线仍须重载（review#37 P1-2）');
  await ok('A 写+flush → B 镜像早已同步（A 直写共享 LS），B pull 后 App 内存必须重载', async () => {
    const hub = bcHub(), clock = new FakeClock(0), be = mkBackend();
    be.data = { 'radio.vol': '5' }; be.rev = 1;
    const shared = new FakeLS();
    const A = await mkTab({ hub, clock, be, ls: shared });
    const B = await mkTab({ hub, clock, be, ls: shared }); // 同浏览器第二标签：同一 localStorage 实例（真实同源标签页形态）
    const b0 = B.spy.n, a0 = A.spy.n;
    assert.strictEqual(B.sb.localStorage.getItem('radio.vol'), '5', '装置前提：两页共享同一镜像');
    A.Store.set('radio.vol', '99'); // A 写共享镜像 + A 内存基线
    await A.Store.flush(); await drain(); // 落库 + 广播 → B pull
    assert.strictEqual(B.sb.localStorage.getItem('radio.vol'), '99', '镜像侧早已同步（这正是旧判定漏掉内存重载的原因）');
    assert.strictEqual(B.Store.mem['radio.vol'], '99', 'B 内存基线必须更新');
    assert.strictEqual(B.spy.n, b0 + 1, '镜像相同但内存旧 → 必须重载 App（P1-2 修复面：只看镜像会跳过）');
    assert.strictEqual(A.spy.n, a0, 'A 自身不受广播影响（postMessage 不回发自身）');
  });
  await ok('同浏览器下仅 baselineProg 变化：镜像已同步（无 LS 写入）仍抑制重载（防基线期整表重渲不回退）', async () => {
    const hub = bcHub(), clock = new FakeClock(0), be = mkBackend();
    const shared = new FakeLS();
    const A = await mkTab({ hub, clock, be, ls: shared });
    const B = await mkTab({ hub, clock, be, ls: shared });
    const b0 = B.spy.n;
    A.Store.set('radio.baselineProg', '25');
    await A.Store.flush(); await drain();
    assert.strictEqual(B.sb.localStorage.getItem('radio.baselineProg'), '25', '进度值进共享镜像');
    assert.strictEqual(B.Store.mem['radio.baselineProg'], '25', '内存基线更新（进度本身入基线）');
    assert.strictEqual(B.spy.n, b0, '仅 baselineProg 的内存差异不得触发重载（P3-3 语义保持）');
  });

  console.log('[10c] 跨浏览器/无 BC 通道（独立 LS + 独立 hub）：显式 pull 对账收敛 LWW');
  await ok('两浏览器各自 LS：后写者 flush 落库，先写者显式 pull 收敛（无广播，boot/pull 是唯一入口）', async () => {
    const clock = new FakeClock(0), be = mkBackend();
    be.data = { 'radio.favs': '["sv"]' }; be.rev = 1;
    const A = await mkTab({ clock, be, lsSeed: { 'radio.favs': '["a"]' } }); // A 浏览器
    assert.strictEqual(A.sb.localStorage.getItem('radio.favs'), '["sv"]', 'A 干净 boot 后端为准');
    const B = await mkTab({ clock, be, lsSeed: { 'radio.favs': '["b"]' } }); // B 浏览器（独立 LS、无共享 hub）
    A.Store.set('radio.favs', '["A2"]');
    await A.Store.flush(); await drain();
    assert.strictEqual(be.data['radio.favs'], '["A2"]', 'A 推送落库');
    await B.Store.pull(); await drain(); // 无 BC 通道：B 靠显式 pull（真实等价 = 下次 boot 对账）
    assert.strictEqual(B.sb.localStorage.getItem('radio.favs'), '["A2"]', 'B 收敛到后端最新');
    assert.strictEqual(B.Store.mem['radio.favs'], '["A2"]', 'B 内存基线同步');
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

  console.log('[14] 空覆盖门（issue #42）：空库开局页不得以全空快照整库覆盖他端写入');
  await ok('核心面：空库开局页在他页写入后 unload flush → 零 POST + 改走 pull 对账（他端数据拉回镜像）', async () => {
    const be = mkBackend(); // 空库开局（本页 boot 见空 data）
    const t = await mkTab({ be });
    assert.strictEqual(t.Store.sawData, false, '空库开局 sawData 应为 false');
    be.data = { 'radio.favs': '["他页"]', 'radio.theme': 'dark' }; be.rev = 5; // 此后他页写入后端（本页无 BC 通道/未感知）
    t.sb._winEv.beforeunload.forEach(fn => fn()); // unload 触发 flush(true)（debounce 规则③）
    await drain();
    assert.strictEqual(t.be.posts().length, 0, '全空快照 + 未见过非空数据：必须拦下不发 POST（wipe 面，issue #42 核心）');
    assert.strictEqual(be.data['radio.favs'], '["他页"]', '后端数据原样（未被空快照覆盖）');
    const gets = t.be.calls.filter(c => c.m === 'GET');
    assert.ok(gets.length >= 1, '拦下后必须改走 pull 对账先行（issue #42 A：不发推、先对账）');
    assert.strictEqual(t.sb.localStorage.getItem('radio.favs'), '["他页"]', '对账把他页数据拉回本页镜像（收敛）');
    assert.strictEqual(t.Store.sawData, true, 'pull apply 非空数据后 sawData 置位（此后本页恢复正常推送资格）');
  });
  await ok('放行面①：空库开局页自己写过键 → 快照非空 → flush 照常 POST（正常 LWW 不受门影响）', async () => {
    const be = mkBackend();
    const t = await mkTab({ be });
    t.Store.set('radio.vol', '55'); // 本页写（快照不再全空）
    t.sb._winEv.beforeunload.forEach(fn => fn());
    await drain();
    assert.strictEqual(t.be.posts().length, 1, '非空快照必须照常推送');
    assert.strictEqual(be.data['radio.vol'], '55', '本页写入落库');
  });
  await ok('放行面②：本页 apply 过非空服务端数据（sawData）→ 即使镜像被清空也不拦（防「合法清空态」误伤）', async () => {
    const be = mkBackend(); be.data = { 'radio.favs': '["sv"]' }; be.rev = 3; // 开局后端已非空（第二实例晚开 = 常态）
    const t = await mkTab({ be });
    assert.strictEqual(t.Store.sawData, true, 'boot 见非空数据即置 sawData');
    t.Store.KEYS.forEach(k => t.sb.localStorage.removeItem(k)); // 模拟极端清空（业务无删键路径，防未来误拦）
    await t.Store.flush(); await drain();
    assert.strictEqual(t.be.posts().length, 1, 'sawData 页的全空快照不拦（该页见过数据，全空是其自身明确状态）');
    assert.deepStrictEqual(be.data, {}, 'POST 照常全量覆盖（LWW 语义保持）');
  });
  await ok('放行面③：合法删除零回归——收藏清空（空数组值）快照照常 POST，键在值空不是全空', async () => {
    const be = mkBackend(); be.data = { 'radio.favs': '["a"]', 'radio.vol': '30' }; be.rev = 2;
    const t = await mkTab({ be });
    t.Store.set('radio.favs', '[]'); // 业务唯一删除语义：值表达（非删键）
    t.sb._winEv.beforeunload.forEach(fn => fn());
    await drain();
    assert.strictEqual(t.be.posts().length, 1, '空数组值快照必须照常推送（门只看键全缺，不看值空）');
    assert.strictEqual(be.data['radio.favs'], '[]', '收藏清空落库（合法删除）');
    assert.strictEqual(be.data['radio.vol'], '30', '同快照其余键随行');
  });
  await ok('门后自愈：被拦页对账拉回数据后再写 → flush 恢复正常推送（无死锁/无卡态）', async () => {
    const be = mkBackend();
    const t = await mkTab({ be });
    be.data = { 'radio.favs': '["x"]' }; be.rev = 1;
    t.sb._winEv.beforeunload.forEach(fn => fn()); // 拦 + pull 对账
    await drain();
    t.Store.set('radio.theme', 'light'); // 本页此后正常写
    await t.Store.flush(); await drain();
    assert.strictEqual(t.be.posts().length, 1, '对账后（sawData=true、快照非空）推送恢复正常');
    assert.strictEqual(be.data['radio.theme'], 'light', '写入落库');
    assert.strictEqual(be.data['radio.favs'], '["x"]', '拉回的他页数据随本页快照汇合（缺键保留语义）');
  });

  console.log('[15] flush 单飞串行 + 尾随重推（review#37 P1-4：乱序响应不得清掉新改动的 dirty 资格）');
  await ok('在飞期间新 flush 只挂尾随：POST 不并发，补发读最新内存', async () => {
    const be = mkBackend(); be.defer = true;
    const t = await mkTab({ be });
    t.Store.set('radio.vol', '1');
    const f1 = t.Store.flush(); await drain(); // POST#0 挂起（携带 vol=1）
    assert.strictEqual(be.posts().length, 1, '第一发已出');
    t.Store.set('radio.vol', '2');
    const f2 = t.Store.flush(); await drain(); // 单飞：挂尾随，不发第二发
    assert.strictEqual(be.posts().length, 1, '在飞期间不得并发第二发（乱序窗口结构性消除）');
    be.release(0, 'ok'); await drain();
    assert.strictEqual(be.posts().length, 2, '尾随补发自动触发');
    assert.strictEqual(bodyData(be.posts()[1])['radio.vol'], '2', '补发读当前内存（规则①）');
    be.release(1, 'ok');
    await f1; await f2; await drain();
    assert.strictEqual(t.sb.localStorage.getItem('radio.storeDirty'), null, '全部成功清 dirty');
    assert.strictEqual(be.data['radio.vol'], '2', '服务端收敛最新值');
  });
  await ok('旧快照失败置 dirty → 尾随新快照成功才清：dirty 资格不被旧终态清掉', async () => {
    const be = mkBackend(); be.defer = true;
    const t = await mkTab({ be });
    t.Store.set('radio.vol', '1');
    const f1 = t.Store.flush(); await drain(); // POST#0（旧快照 vol=1）挂起
    t.Store.set('radio.vol', '2');
    const f2 = t.Store.flush(); await drain(); // 尾随（将携新快照 vol=2）
    be.release(0, 'fail'); await drain(); // 旧快照失败：dirty=true + 尾随补发触发
    assert.strictEqual(t.sb.localStorage.getItem('radio.storeDirty'), '1', '失败置 dirty');
    assert.strictEqual(be.posts().length, 2, '尾随已发（vol=2）');
    be.release(1, 'ok'); // 新快照成功——此时才清 dirty（旧终态不得越过新快照清 dirty）
    await f1; await f2; await drain();
    assert.strictEqual(t.sb.localStorage.getItem('radio.storeDirty'), null, '最新快照成功 → dirty 清');
    assert.strictEqual(be.data['radio.vol'], '2', '服务端为最新值（本地不失去重推资格）');
  });
  await ok('keepalive（unload）旁路直发：在飞时也不排队（页将亡，排队=确定丢写）', async () => {
    const be = mkBackend(); be.defer = true;
    const t = await mkTab({ be });
    t.Store.set('radio.vol', '1');
    const f1 = t.Store.flush(); await drain();
    t.Store.set('radio.vol', '2');
    t.sb._winEv.beforeunload.forEach(fn => fn()); // unload flush(true)
    await drain();
    assert.strictEqual(be.posts().length, 2, 'keepalive 必须并行直发，不等在飞 POST');
    assert.ok(be.posts()[1].keepalive, 'unload 侧 keepalive=true');
    assert.strictEqual(bodyData(be.posts()[1])['radio.vol'], '2', '携带最新内存');
    be.release(0, 'ok'); be.release(1, 'ok');
    await f1; await drain();
  });

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('store 测试异常：', e); process.exit(1); });
