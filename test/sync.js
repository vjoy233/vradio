// sync.js 同步/体检编排状态机确定性矩阵（P0b，docs/testing-strategy-2026-11.md §3 L1 sync 行）。
// vm 沙箱装载 sync.js（剥尾部 $('syncBtn'/'healthBtn').onclick boot 块，同 test/ui-scope.js 法），
// FakeClock 驱动 syncDone 的 800ms 增量调度与 ETA 时钟（clock.tick + setImmediate 排水两轮），
// 可编程 fetch 桩模拟 /api/check?detail=1 与 /api/sync 两步协议（holdCheck/holdSync 挂起 Promise 手放行验并发），
// App/Store/QualityStore 全 spy 桩（patchHealth 档位可编程 permOf、fetch throw 注入网络层失败）。
// 与 test/smoke.js、test/sources.js 分工：smoke 测服务端安全护栏，sources 测 update-sources 探活管线本体，
// 本文件只测 Sync 编排层（四通道互斥/分流/收尾状态机），探活判定以契约形态结果注入（checkDetail 结构）。
// 覆盖矩阵（11 项全落，编号 = 文件内 [N] 分节）：
//   [1] runCheck 执行器：逐台 /api/check?detail=1（前 4 源封顶）/ok·sus·perm 分档计数与 onTick/网络层失败
//       不落标记不进计数（P3-12）/全禁用台跳过不请求不落标/手动禁用源过滤/recordDiagnostic 逐源一条
//       （trigger 透传 + URL 归一回绑原始源）/conc 并发上限（最大在飞恒 2）/abort·silentAbort 置位队列即停
//   [2] busy 互斥 + 手动优先：busy='manual' 时 silentHealth/incHealth/baseline 直接 return（不请求不出
//       toast）；手动启动遇 busy='silent' 置 silentAbort 让位；手动跑完（busy=''）后静默才能跑
//   [3] bootQuiet 分发：radio.baselineProg 存在 → 直接 baseline 续跑；无 baseline → baselinePrompt 确认
//       门槛；有 baseline → silentHealth
//   [4] 手动体检 health()：file:// 明确提示且不落任何标记；按钮态「取消体检」二次点击取消（未测台不请求、
//       已确认标记保留）；ETA 整 10 刷新 + 速率外推分支；结束分档统计文案 + saveHealth/render + finally
//       复位按钮/busy/prog
//   [5] 开机静默 silentHealth()：范围 = scopeFavRecent(30) ∪ scopeDead 按 keyOf 去重；file:///空范围直接
//       return 不置 busy；feedback 只走 App.render 不写 #status；被手动接管（silentAbort）跳过
//       saveHealth/render 且已测标记有效
//   [6] 同步后增量 incHealth(names)：按名过滤 App.state.stations 且排除 hidden；busy return；toast 两态
//       （ms=0 常驻开场 → ms=5000 完成收尾）；silentAbort 让位 → 收起 toast 且已测标记有效无完成态；
//       runCheck 异常走 catch 兜底收 toast
//   [7] doSync 两步协议：gated&&!ok → gateConfirm 拦截摘要（bypass>0 且有 reportHash 才出「强制同步」toast，
//       不可绕过/缺 hash 不出）；r.error 失败文案；fetch throw（busy 409 直通/其他加降级前缀）；成功 →
//       syncDone；按钮态（disabled/同步中…/prog）全程复位
//   [8] forceSync：先 POST /api/sync/force-token（body 含 reportHash）→ 无 token「强制同步失败」且不发
//       强制 POST → 报告变化（仍 gated）拒绝 → 成功进 syncDone
//   [9] syncDone：aborted → 中止文案且不 reloadMain 不排增量；汇总文案分支（delta 正负/euKept 有无/
//       replacement forced·kept）；收藏台消失点名 favsGone（名+URL 双通道，≤5 全列、>5 截断「等 N 个」）；
//       addedCheck 非空 800ms 后 incHealth（FakeClock 驱动）、空名单不排
//   [10] 首启 baseline()：file:///busy return；确认门槛（prompt toast action.fn 触发才开跑、baselineList
//        空 → 直接 baselineDone）；续跑跳过 radio.baselineProg 已确认台；每 25 台进度+saveHealth 同批落盘；
//        silentAbort 中断兜底落盘且 baselineDone 不执行；完成置 done + 清 prog + 完成分档 toast
//   [11] baselineDone：置 radio.baseline='done' + 清 radio.baselineProg
// 未覆盖项与原因（黑盒不可观测/不属于本层，均不为测试改生产代码）：
// - App 侧 4s boot 调度（app.js 的 setTimeout(() => Sync.bootQuiet(), 4000)）：app.js 域定时器，sync 只暴露入口；
// - scopeDead 的 24h/7 天档位节流与 200 封顶轮转、scopeFavRecent 的 30 上限与收藏回绑解析：app.js 域，
//   sync 只消费其返回值（App 桩直接给定范围；scopeFavRecent 的 30 实参透传有断言）；
// - patchHealth 内部分档升级（连续 ≥3 次且首死 ≥30 天）/saveHealth FIFO 封顶/「最近恢复」记录：app.js 健康
//   存储域，此处 App 桩只回传可编程档位（permOf）；
// - reloadMain 的真实重拉重并（radio.txt/my-radio.txt 解析、_myKeep 三态）：app.js 域，桩只记调用；
// - toast 的 DOM 组装/自动消失时序：App.toast 桩记 {msg,opt}，action.fn 由用例手动触发（真 toast 在 fn 前收起）；
// - 真实 HTTP 层（超时/非 JSON/405/跨源）：服务端护栏见 smoke.js，sync 只消费 response.json() 形态；
// - ETA 的真实时钟速率：FakeClock 时间不自动推进（rate 恒 10 台/s），只验「整 10 刷新 + eta 外推公式」分支；
// - boot 块（$('syncBtn'/'healthBtn').onclick）的异常兜底文案：装载法剥离，事件接线属 index.html 域。
// 零依赖离线，npm test 随跑。
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { sandbox, fakeDocument, FakeLS } = require('./harness/fake-browser');
const { FakeClock } = require('./harness/fake-clock');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });
const drain = async () => { for (let i = 0; i < 2; i++) await new Promise(r => setImmediate(r)); }; // fetch().then 链微任务排水

const UP = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(UP, 'sync.js'), 'utf8');
const BOOT = SRC.match(/\n\$\('syncBtn'\)\.onclick[\s\S]*$/);
assert(BOOT, 'sync.js 尾部 boot 块可剥离（装载法依赖此前提）');

const st = (c, n, u, over) => Object.assign({ c: c, n: n, u: u }, over || {}); // 台对象（app 装配后形态）
const qsUrls = u => u.split('&').filter(x => x.indexOf('url=') === 0).map(x => decodeURIComponent(x.slice(4))); // check URL → 原始源数组

// 一页装置：独立 sandbox + FakeClock + 全 spy 桩。over: { stations, visible, favRecent, dead, baselineList,
// gone, checkBody(url)→body|值, checkFail, holdCheck, syncBody(url,opt)→body|值, syncFail, holdSync,
// tokenBody, lsSeed, location, stamp, permOf(s)→bool, patchThrow(s)→bool }
function mkSync(over) {
  over = over || {};
  const clock = new FakeClock(1000);
  const ls = new FakeLS(over.lsSeed);
  const doc = fakeDocument();
  const calls = { patch: [], save: 0, render: 0, reload: 0, toast: [], favsGone: [], scopeFR: [], scopeDead: 0, baselineList: 0, visible: [] };
  const stations = over.stations || [];
  const app = {
    state: { stamp: over.stamp || 't1', stations: stations },
    patchHealth(s, okFlag, stamp) { // 档位可编程：ok→'ok'，死台按 permOf 回 'perm'/'sus'（分档计数断言用）
      if (over.patchThrow && over.patchThrow(s)) throw new Error('patch 注入异常');
      calls.patch.push({ n: s.n, ok: okFlag, stamp: stamp });
      return okFlag ? 'ok' : (over.permOf && over.permOf(s) ? 'perm' : 'sus');
    },
    saveHealth() { calls.save++; },
    render() { calls.render++; },
    visible(all) { calls.visible.push(all); return over.visible || stations.filter(s => all || !s.health); },
    scopeFavRecent(n) { calls.scopeFR.push(n); return over.favRecent || []; },
    scopeDead() { calls.scopeDead++; return over.dead || []; },
    baselineList() { calls.baselineList++; return over.baselineList || []; },
    favsGone(names, urls) { calls.favsGone.push({ names: names, urls: urls }); return over.gone || []; },
    reloadMain() { calls.reload++; return Promise.resolve(true); },
    toast(msg, opt) { calls.toast.push({ msg: msg, opt: opt || {} }); },
  };
  const store = { calls: [], // get/set/remove 直读写 sandbox.localStorage（真 localStorage 行为，player.js 同法）
    get(k) { return ls.getItem(k); },
    set(k, v) { store.calls.push('set ' + k); ls.setItem(k, v); },
    remove(k) { store.calls.push('remove ' + k); ls.removeItem(k); } };
  const qs = { calls: [], recordDiagnostic(identityUrl, r, trigger) { qs.calls.push({ id: identityUrl, r: r, trig: trigger }); } };
  const f = { calls: [], checkGates: [], maxGates: 0, syncGates: [],
    checkBody: typeof over.checkBody === 'function' ? over.checkBody : function () { return over.checkBody || { ok: true, results: [] }; },
    checkFail: over.checkFail || null,
    syncBody: typeof over.syncBody === 'function' ? over.syncBody : function () { return over.syncBody || {}; },
    syncFail: over.syncFail || null,
    tokenBody: typeof over.tokenBody === 'function' ? over.tokenBody : function () { return over.tokenBody || {}; },
    checks() { return f.calls.filter(c => c.url.indexOf('/api/check') === 0); },
    releaseCheck() { const g = f.checkGates.splice(0); for (const r of g) r(); },
    releaseSync() { const g = f.syncGates.splice(0); for (const r of g) r(); } };
  const fetch = (url, opt) => {
    opt = opt || {};
    f.calls.push({ url: url, opt: opt });
    if (url.indexOf('/api/check') === 0) {
      if (over.holdCheck) return new Promise(res => { // 挂起：releaser 入队，手放行验并发/中止
        f.checkGates.push(function () { res({ json: function () { return Promise.resolve(f.checkBody(url)); } }); });
        if (f.checkGates.length > f.maxGates) f.maxGates = f.checkGates.length;
      });
      if (f.checkFail) return Promise.reject(new Error(f.checkFail));
      return Promise.resolve({ json: function () { return Promise.resolve(f.checkBody(url)); } });
    }
    if (url === '/api/sync') {
      if (over.holdSync && !opt.body) return new Promise(res => f.syncGates.push(function () { res({ json: function () { return Promise.resolve(f.syncBody(url, opt)); } }) }));
      if (f.syncFail) return Promise.reject(new Error(f.syncFail));
      return Promise.resolve({ json: function () { return Promise.resolve(f.syncBody(url, opt)); } });
    }
    if (url === '/api/sync/force-token') return Promise.resolve({ json: function () { return Promise.resolve(f.tokenBody(url, opt)); } });
    return Promise.reject(new Error('意外端点：' + url));
  };
  const sb = sandbox({ clock: clock, ls: ls, document: doc, fetch: fetch, location: over.location,
    globals: { $: function (id) { return doc.getElementById(id); }, App: app, Store: store, QualityStore: qs,
      keyOf: function (s) { return s.c + '|' + s.n; } } });
  vm.createContext(sb);
  vm.runInContext(SRC.slice(0, BOOT.index) + '\nthis.Sync = Sync;', sb, { filename: 'sync.js' });
  const el = function (id) { return doc.getElementById(id); };
  return { sb: sb, Sync: sb.Sync, app: app, store: store, qs: qs, f: f, ls: ls, clock: clock, calls: calls,
    el: el, span: function (id) { return el(id).querySelector('span'); } };
}

(async () => {
  console.log('[1] runCheck 执行器：逐台探活/前 4 源/分档计数/网络失败不落标/禁用源/诊断/并发/中止');
  await ok('逐台 fetch /api/check?detail=1，6 源台只测前 4 源（不变量：探活批量封顶 4）', async () => {
    const s6 = st('新闻', '六源台', ['http://a/1', 'http://a/2', 'http://a/3', 'http://a/4', 'http://a/5', 'http://a/6']);
    const s1 = st('新闻', '单源台', ['http://b/1']);
    const t = mkSync();
    const cnt = await t.Sync.runCheck([s6, s1], { conc: 2 });
    assert.strictEqual(t.f.checks().length, 2, '两台各一次批量请求');
    assert.deepStrictEqual(qsUrls(t.f.checks()[0].url), ['http://a/1', 'http://a/2', 'http://a/3', 'http://a/4'], '第 5/6 源不进探活');
    assert.deepStrictEqual(qsUrls(t.f.checks()[1].url), ['http://b/1'], '单源台只 1 个 url 参数');
    assert.deepStrictEqual({ ok: cnt.ok, sus: cnt.sus, perm: cnt.perm, done: cnt.done }, { ok: 2, sus: 0, perm: 0, done: 2 }, '全活分档计数');
    assert.strictEqual(t.calls.patch[0].stamp, 't1', 'patchHealth 透传 App.state.stamp');
  });
  await ok('j.ok=false → 疑似档、permOf 可编程停运档：分档计数与 onTick 档位一致', async () => {
    const A = st('新闻', 'A', ['http://a/1']), B = st('新闻', 'B', ['http://b/1']), C = st('新闻', 'C', ['http://c/1']);
    const t = mkSync({ checkBody: u => ({ ok: qsUrls(u)[0].indexOf('http://a/') === 0, results: [] }), permOf: s => s.n === 'B' });
    const ticks = [];
    const cnt = await t.Sync.runCheck([A, B, C], { onTick: (s, r) => ticks.push(s.n + ':' + r) });
    assert.deepStrictEqual({ ok: cnt.ok, sus: cnt.sus, perm: cnt.perm }, { ok: 1, sus: 1, perm: 1 }, '三档各计 1（计数来源 = patchHealth 返回档位）');
    assert.deepStrictEqual(ticks.sort(), ['A:ok', 'B:perm', 'C:sus'], 'onTick 收 (台, 档位)');
    assert.strictEqual(t.calls.patch.length, 3, '每台一次 patchHealth');
  });
  await ok('fetch throw（网络层失败）不落任何标记不进计数不进 onTick（P3-12：探活失败 ≠ 死台）', async () => {
    const A = st('新闻', 'A', ['http://a/1']);
    const t = mkSync({ checkFail: '网络断（注入）' });
    const ticks = [];
    const cnt = await t.Sync.runCheck([A], { onTick: (s, r) => ticks.push(r) });
    assert.strictEqual(t.calls.patch.length, 0, 'marked=false 旁路 patchHealth');
    assert.deepStrictEqual(ticks, [], '旁路 onTick');
    assert.deepStrictEqual({ ok: cnt.ok, sus: cnt.sus, perm: cnt.perm }, { ok: 0, sus: 0, perm: 0 }, '分档计数不受网络错污染');
    assert.strictEqual(cnt.done, 1, 'done 只计遍历完成');
  });
  await ok('全禁用台跳过不请求不落标记；部分禁用只测启用源（B1：探活与播放同口径）', async () => {
    const all = st('新闻', '全禁台', ['http://a/1', 'http://a/2'], { dis: [0, 1] });
    const part = st('新闻', '部分禁台', ['http://b/1', 'http://b/2', 'http://b/3'], { dis: [1] });
    const t = mkSync();
    const cnt = await t.Sync.runCheck([all, part]);
    assert.strictEqual(t.f.checks().length, 1, '全禁台零请求');
    assert.deepStrictEqual(qsUrls(t.f.checks()[0].url), ['http://b/1', 'http://b/3'], '禁用索引被滤除');
    assert.strictEqual(t.calls.patch.length, 1, '全禁台不落标记');
    assert.strictEqual(t.calls.patch[0].n, '部分禁台');
    assert.strictEqual(cnt.done, 2, '全禁台仍计 done（遍历口径）');
  });
  await ok('recordDiagnostic 逐源一条：trigger 透传、URL 归一回绑原始源、不命中保留报告值（缺省 manual）', async () => {
    const S = st('新闻', 'X', ['http://a', 'http://a/2']);
    const t = mkSync({ checkBody: () => ({ ok: true, results: [
      { url: 'http://a/', ok: true, code: 'OK', latencyMs: 12 },
      { url: 'http://a/2', ok: true, code: 'OK' },
      { url: 'http://other/9', ok: false, code: 'NETWORK' }] }) });
    await t.Sync.runCheck([S], { trigger: 'boot' });
    assert.strictEqual(t.qs.calls.length, 3, '每源结果一条');
    assert.strictEqual(t.qs.calls[0].id, 'http://a', '身份键 = 台主 URL s.u[0]');
    assert.strictEqual(t.qs.calls[0].trig, 'boot', 'trigger 透传');
    assert.strictEqual(t.qs.calls[0].r.url, 'http://a', 'new URL 根路径补斜杠归一命中 → 回绑原始源 URL');
    assert.strictEqual(t.qs.calls[1].r.url, 'http://a/2', '精确命中回绑');
    assert.strictEqual(t.qs.calls[2].r.url, 'http://other/9', '不命中保留报告原 URL');
    assert.strictEqual(t.qs.calls[2].r.code, 'NETWORK', '契约字段原样透传');
    await t.Sync.runCheck([S]);
    assert.strictEqual(t.qs.calls[3].trig, 'manual', '缺省 trigger=manual');
  });
  await ok('conc 并发上限生效：挂起 fetch 手放行，最大在飞恒 2（conc=2 + 5 台）', async () => {
    const list = [1, 2, 3, 4, 5].map(i => st('新闻', 'N' + i, ['http://n/' + i]));
    const t = mkSync({ holdCheck: true });
    const p = t.Sync.runCheck(list, { conc: 2 });
    await drain();
    assert.strictEqual(t.f.checkGates.length, 2, '在飞 = conc');
    assert.strictEqual(t.f.maxGates, 2, '最大在飞从未超过 conc');
    t.f.releaseCheck(); await drain();
    assert.strictEqual(t.f.checks().length, 4, '放行两台后补位两台');
    assert.strictEqual(t.f.checkGates.length, 2, '仍在飞 2');
    t.f.releaseCheck(); await drain();
    assert.strictEqual(t.f.checkGates.length, 1, '剩 1 台');
    t.f.releaseCheck();
    const cnt = await p;
    assert.strictEqual(cnt.done, 5, '全部完成');
    assert.strictEqual(t.f.maxGates, 2, '全程并发封顶 2');
  });
  await ok('abort / silentAbort 置位后队列停止（手动与静默两通道各自的停止标志）', async () => {
    const mk = () => [1, 2, 3, 4].map(i => st('新闻', 'N' + i, ['http://n/' + i]));
    const t1 = mkSync({ holdCheck: true });
    const p1 = t1.Sync.runCheck(mk(), { conc: 1 });
    await drain(); t1.Sync.abort = true; t1.f.releaseCheck();
    const c1 = await p1;
    assert.strictEqual(t1.f.checks().length, 1, 'abort 后不再取台');
    assert.strictEqual(c1.done, 1);
    const t2 = mkSync({ holdCheck: true });
    const p2 = t2.Sync.runCheck(mk(), { conc: 1, silent: true });
    await drain(); t2.Sync.silentAbort = true; t2.f.releaseCheck();
    const c2 = await p2;
    assert.strictEqual(t2.f.checks().length, 1, 'silentAbort 后不再取台');
    assert.strictEqual(c2.done, 1);
  });

  console.log('[2] busy 互斥 + 手动优先');
  await ok("busy='manual' 时静默三通道直接 return：不请求不出 toast 不动 busy", async () => {
    const A = st('新闻', 'A', ['http://a/1']);
    const t = mkSync({ stations: [A], favRecent: [A], dead: [A], baselineList: [A] });
    t.Sync.busy = 'manual';
    await t.Sync.silentHealth();
    await t.Sync.incHealth(['A']);
    await t.Sync.baseline();
    assert.strictEqual(t.f.calls.length, 0, '互斥期零请求');
    assert.strictEqual(t.calls.toast.length, 0, 'incHealth/baseline 的开场 toast 不出');
    assert.strictEqual(t.Sync.busy, 'manual', '后台通道不得动 busy');
    assert.strictEqual(t.calls.scopeFR.length, 0, 'busy 检查先于范围收集');
  });
  await ok("手动启动遇 busy='silent'：置 silentAbort 让位（手动优先），跑完 busy 复位", async () => {
    const t = mkSync({ visible: [] });
    t.Sync.busy = 'silent'; t.Sync.silentAbort = false;
    await t.Sync.health();
    assert.strictEqual(t.Sync.silentAbort, true, '静默版让位标志已置');
    assert.strictEqual(t.Sync.busy, '', '手动 finally 复位 busy');
  });
  await ok("手动跑完（busy=''）后静默通道才能跑（互斥解除不变量）", async () => {
    const A = st('新闻', 'A', ['http://a/1']);
    const t = mkSync({ favRecent: [A] });
    await t.Sync.health(); // visible=[] 秒完
    assert.strictEqual(t.Sync.busy, '');
    await t.Sync.silentHealth(); await drain();
    assert.strictEqual(t.f.checks().length, 1, 'busy 清空后静默正常发起');
  });

  console.log('[3] bootQuiet 分发：基线优先');
  await ok('radio.baselineProg 存在 → 直接 baseline() 续跑（不再打扰）', () => {
    const t = mkSync({ lsSeed: { 'radio.baselineProg': '["新闻|A"]' } });
    const seen = [];
    t.Sync.baseline = () => seen.push('baseline');
    t.Sync.baselinePrompt = () => seen.push('prompt');
    t.Sync.silentHealth = () => seen.push('silent');
    t.Sync.bootQuiet();
    assert.deepStrictEqual(seen, ['baseline'], '确认过的中断续跑优先于一切');
  });
  await ok('无 baseline 无 prog → baselinePrompt() 确认门槛', () => {
    const t = mkSync();
    const seen = [];
    t.Sync.baseline = () => seen.push('baseline');
    t.Sync.baselinePrompt = () => seen.push('prompt');
    t.Sync.silentHealth = () => seen.push('silent');
    t.Sync.bootQuiet();
    assert.deepStrictEqual(seen, ['prompt'], '从未建基线先过确认门槛（基线是超集）');
  });
  await ok('已有 baseline → silentHealth() 常规复测', () => {
    const t = mkSync({ lsSeed: { 'radio.baseline': 'done' } });
    const seen = [];
    t.Sync.baseline = () => seen.push('baseline');
    t.Sync.baselinePrompt = () => seen.push('prompt');
    t.Sync.silentHealth = () => seen.push('silent');
    t.Sync.bootQuiet();
    assert.deepStrictEqual(seen, ['silent'], '基线已建走收藏+最近静默复测');
  });

  console.log('[4] 手动体检 health()');
  await ok('file:// 明确提示且不落任何标记（P3-12：降级模式无后端不标死台）', async () => {
    const t = mkSync({ location: { protocol: 'file:' }, visible: [st('新闻', 'A', ['http://a/1'])] });
    await t.Sync.health();
    assert.strictEqual(t.el('status').textContent, 'file:// 降级模式无后端，体检不可用——npm start 后再试');
    assert.strictEqual(t.f.calls.length, 0, '零请求');
    assert.strictEqual(t.calls.patch.length, 0, '零标记');
    assert.strictEqual(t.Sync.busy, '', '不置 busy');
    assert.strictEqual(t.calls.save, 0, '不落盘');
  });
  await ok('按钮态「取消体检」→ 二次点击置 abort 取消：未测台不请求、已确认标记保留、finally 复位', async () => {
    // health() 固定 conc=5：6 台时第一波并发 5 台，第 6 台在取消后不入队（未测台不请求不变量）
    const list = [1, 2, 3, 4, 5, 6].map(i => st('新闻', 'N' + i, ['http://n/' + i]));
    const t = mkSync({ visible: list, holdCheck: true });
    const p = t.Sync.health(); await drain();
    assert.strictEqual(t.span('healthBtn').textContent, '取消体检', '按钮切取消态');
    assert.strictEqual(t.el('prog').hidden, false, '进度亮起');
    await t.Sync.health(); // 二次点击 = 取消
    assert.strictEqual(t.Sync.abort, true, '取消标志置位');
    t.f.releaseCheck(); await p; await drain();
    assert.strictEqual(t.f.checks().length, 5, '第 6 台不再请求');
    assert.ok(t.f.checks().every(c => qsUrls(c.url)[0] !== 'http://n/6'), '未测台零请求');
    assert.strictEqual(t.el('status').textContent, '体检已取消：完成 5/6（已确认的标记已保留）');
    assert.strictEqual(t.span('healthBtn').textContent, '体检', 'finally 复位按钮');
    assert.strictEqual(t.Sync.busy, '', 'finally 复位 busy');
    assert.strictEqual(t.el('prog').hidden, true, 'finally 收进度');
    assert.strictEqual(t.calls.save, 1, '取消也统一落盘一次');
    assert.strictEqual(t.calls.render, 1, '取消也兜底渲染');
  });
  await ok('ETA 每 10 台刷新 + 速率外推（FakeClock 驱动），收尾写分档统计文案', async () => {
    const list = []; for (let i = 1; i <= 11; i++) list.push(st('新闻', 'N' + i, ['http://n/' + i]));
    const t = mkSync({ visible: list, holdCheck: true });
    const p = t.Sync.health(); await drain();
    assert.strictEqual(t.el('status').textContent, '', 'done<10 不刷状态栏');
    t.f.releaseCheck(); await drain(); // 第一波 5 台完成 → 第二波在飞（done=10）
    assert.ok(t.el('status').textContent.indexOf('体检 10/11，可用') === 0, '整 10 刷新：' + t.el('status').textContent);
    assert.ok(t.el('status').textContent.indexOf('预计还需 ~1 分钟') > 0, 'ETA 外推分支（rate=10 台/s）');
    t.f.releaseCheck(); await drain(); // 第二波完成 → 第 11 台在飞（done=11 不刷）
    t.f.releaseCheck(); await p; await drain();
    assert.strictEqual(t.el('status').textContent, '体检完成：可用 11、疑似失效 0、已停运 0（✗ 台建议换源或点「同步源」重建）');
    assert.deepStrictEqual(t.calls.visible, [true], 'visible(true)：连默认隐藏的死台一起复查');
  });
  await ok('分档统计：疑似/停运各计 1（permOf 可编程），手动通道 trigger=manual', async () => {
    const A = st('新闻', 'A', ['http://a/1']), B = st('新闻', 'B', ['http://b/1']), C = st('新闻', 'C', ['http://c/1']);
    const t = mkSync({ visible: [A, B, C], permOf: s => s.n === 'C',
      checkBody: u => { const us = qsUrls(u); return { ok: us[0].indexOf('http://a/') === 0, results: [{ url: us[0], ok: true, code: 'OK' }] }; } });
    await t.Sync.health(); await drain();
    assert.strictEqual(t.el('status').textContent, '体检完成：可用 1、疑似失效 1、已停运 1（✗ 台建议换源或点「同步源」重建）');
    assert.strictEqual(t.calls.save, 1, 'patchHealth 只改内存，收尾统一落盘一次');
    assert.strictEqual(t.qs.calls[0].trig, 'manual', '手动通道 trigger=manual');
  });

  console.log('[5] 开机静默 silentHealth()');
  await ok('file:// / 空范围直接 return：不置 busy 不请求', async () => {
    const t1 = mkSync({ location: { protocol: 'file:' }, favRecent: [st('新闻', 'A', ['http://a/1'])] });
    await t1.Sync.silentHealth();
    assert.strictEqual(t1.f.calls.length, 0, 'file:// 零请求');
    assert.strictEqual(t1.calls.scopeFR.length, 0, '协议门先于范围收集');
    const t2 = mkSync();
    await t2.Sync.silentHealth();
    assert.strictEqual(t2.Sync.busy, '', '空范围不置 busy');
    assert.strictEqual(t2.f.calls.length, 0);
  });
  await ok('范围 = 收藏+最近 ∪ 死标记台，keyOf 去重（重叠台只测一次）', async () => {
    const A = st('新闻', 'A', ['http://a/1']);
    const B1 = st('新闻', 'B', ['http://b/1']);
    const B2 = st('新闻', 'B', ['http://b/1']); // 不同实例同 keyOf
    const C = st('新闻', 'C', ['http://c/1']);
    const t = mkSync({ favRecent: [A, B1], dead: [B2, C] });
    await t.Sync.silentHealth(); await drain();
    assert.deepStrictEqual(t.f.checks().map(c => qsUrls(c.url)[0]).sort(), ['http://a/1', 'http://b/1', 'http://c/1'], '去重后 3 台各一次请求');
    assert.strictEqual(t.calls.scopeFR[0], 30, 'scopeFavRecent(30) 实参透传');
    assert.strictEqual(t.Sync.busy, '', '收尾复位 busy');
    assert.strictEqual(t.calls.save, 1, '静默收尾也统一落盘');
    assert.strictEqual(t.calls.render, 1);
  });
  await ok('后台通道不写 #status：手动/后台分流不变量（后台只 toast/渲染）', async () => {
    const t = mkSync({ favRecent: [st('新闻', 'A', ['http://a/1'])] });
    t.el('status').textContent = '哨兵';
    await t.Sync.silentHealth(); await drain();
    assert.strictEqual(t.el('status').textContent, '哨兵', '静默全程不碰状态栏');
    assert.strictEqual(t.calls.toast.length, 0, '静默复测无 toast（与 incHealth 两态区分）');
  });
  await ok('被手动接管（silentAbort）：跳过 saveHealth/render（手动收尾），已测标记有效', async () => {
    const t = mkSync({ favRecent: [st('新闻', 'A', ['http://a/1'])], holdCheck: true, visible: [] });
    const p = t.Sync.silentHealth(); await drain();
    assert.strictEqual(t.Sync.busy, 'silent');
    await t.Sync.health(); // 手动接管：置 silentAbort + busy='manual'，visible=[] 秒完并自行收尾
    const saveMid = t.calls.save, renderMid = t.calls.render;
    assert.strictEqual(t.Sync.silentAbort, true);
    t.f.releaseCheck(); await p; await drain();
    assert.strictEqual(t.calls.patch.length, 1, '已测台标记落内存（幂等有效）');
    assert.strictEqual(t.calls.save, saveMid, '静默被接管不落盘（手动已收尾）');
    assert.strictEqual(t.calls.render, renderMid, '静默被接管不渲染');
    assert.strictEqual(t.Sync.busy, '', 'busy 归手动 finally 所有');
  });

  console.log('[6] 同步后增量 incHealth(names)');
  await ok('按名过滤 App.state.stations 且排除 hidden；名单全不匹配直接 return', async () => {
    const A = st('新闻', 'A台', ['http://a/1']), H = st('新闻', '隐藏台', ['http://h/1'], { hidden: true }), B = st('新闻', 'B台', ['http://b/1']);
    const t = mkSync({ stations: [A, H, B] });
    await t.Sync.incHealth(['A台', '隐藏台', 'B台']); await drain();
    assert.deepStrictEqual(t.f.checks().map(c => qsUrls(c.url)[0]).sort(), ['http://a/1', 'http://b/1'], 'hidden 台排除在增量体检外');
    const t2 = mkSync({ stations: [A] });
    await t2.Sync.incHealth(['不存在的台']);
    assert.strictEqual(t2.f.calls.length, 0, '空名单不发起');
    assert.strictEqual(t2.Sync.busy, '', '空名单不置 busy');
    assert.strictEqual(t2.calls.toast.length, 0);
  });
  await ok('toast 两态：ms=0 常驻开场 → ms=5000 完成收尾 + saveHealth/render', async () => {
    const A = st('新闻', 'A台', ['http://a/1']), B = st('新闻', 'B台', ['http://b/1']);
    const t = mkSync({ stations: [A, B], checkBody: u => ({ ok: qsUrls(u)[0].indexOf('http://a/') === 0, results: [] }) });
    await t.Sync.incHealth(['A台', 'B台']); await drain();
    assert.strictEqual(t.calls.toast.length, 2, '开场 + 收尾两态');
    assert.strictEqual(t.calls.toast[0].opt.ms, 0, '开场常驻（完成态接管）');
    assert.ok(t.calls.toast[0].msg.indexOf('后台体检新增电台 2 台…') === 0);
    assert.strictEqual(t.calls.toast[1].opt.ms, 5000, '完成态自动消失');
    assert.ok(t.calls.toast[1].msg.indexOf('新增 2 台体检完成，1 台无效已隐藏') >= 0, '无效计数 = sus+perm');
    assert.strictEqual(t.calls.save, 1);
    assert.strictEqual(t.calls.render, 1);
  });
  await ok('被手动接管（silentAbort）：收起常驻 toast 且已测标记有效、无完成态', async () => {
    const t = mkSync({ stations: [st('新闻', 'A台', ['http://a/1'])], holdCheck: true, visible: [] });
    const p = t.Sync.incHealth(['A台']); await drain();
    assert.strictEqual(t.calls.toast.length, 1, '开场常驻已出');
    await t.Sync.health(); // 手动接管
    t.f.releaseCheck(); await p; await drain();
    assert.strictEqual(t.el('toast').hidden, true, '让位时显式收起 toast（AIbot P2-2）');
    assert.strictEqual(t.calls.patch.length, 1, '已测标记有效（幂等）');
    assert.strictEqual(t.calls.toast.length, 1, '无完成 toast');
    assert.strictEqual(t.calls.save, 1, '不重复落盘（手动收尾口径）');
  });
  await ok('runCheck 异常 → catch 兜底收 toast、busy 复位（不卡静默互斥）', async () => {
    const t = mkSync({ stations: [st('新闻', 'A台', ['http://a/1'])], patchThrow: () => true });
    await t.Sync.incHealth(['A台']); await drain();
    assert.strictEqual(t.el('toast').hidden, true, '异常分支显式收起');
    assert.strictEqual(t.Sync.busy, '', 'finally 复位 busy');
    assert.strictEqual(t.calls.toast.length, 1, '无完成态');
  });

  console.log('[7] doSync 两步协议');
  await ok('gated 拦截：status 摘要 + bypass/reportHash 具备才出「强制同步」toast，触发走 force-token 两步', async () => {
    const gated = { gated: true, ok: false, reportHash: 'h1', report: { oldTotal: 100, newTotal: 80, reasons: [
      { msg: '台数骤降', bypassable: true }, { msg: '欧美层缺失', bypassable: false } ] } };
    const t = mkSync({ syncBody: (u, o) => o && o.body ? { total: 90, delta: 0, euKept: 90 } : gated, tokenBody: { token: 'tk1' } });
    await t.Sync.doSync(); await drain();
    assert.strictEqual(t.el('status').textContent, '同步被质量门拦截：旧 100 台 → 新 80 台（台数骤降；欧美层缺失）——可确认强制替换');
    assert.strictEqual(t.calls.toast.length, 1, '可绕过才出确认 toast');
    assert.strictEqual(t.calls.toast[0].opt.ms, 0, '常驻直到选择');
    assert.strictEqual(t.calls.toast[0].opt.action.label, '强制同步');
    assert.strictEqual(t.calls.toast[0].opt.dismiss, '暂不');
    assert.ok(t.calls.toast[0].msg.indexOf('将绕过：台数骤降') >= 0, 'toast 只列 bypassable 项');
    t.calls.toast[0].opt.action.fn(); await drain(); // 手动触发强制
    assert.strictEqual(JSON.parse(t.f.calls.filter(c => c.url === '/api/sync/force-token')[0].opt.body).reportHash, 'h1', 'token 绑定报告指纹');
    const posts = t.f.calls.filter(c => c.url === '/api/sync');
    assert.strictEqual(JSON.parse(posts[1].opt.body).forceToken, 'tk1', '带 token 强制发布');
    assert.strictEqual(posts[1].opt.headers['Content-Type'], 'application/json');
    assert.strictEqual(t.el('status').textContent, '同步完成：共 90 台（+0；欧美音乐 90 个实测可用）', '强制成功进 syncDone');
    assert.strictEqual(t.calls.reload, 1, 'reloadMain 重拉重并');
    assert.strictEqual(t.span('syncBtn').textContent, '同步源', '按钮复位');
  });
  await ok('不可绕过（bypass 空）不出 toast，保留原列表口径', async () => {
    const t = mkSync({ syncBody: { gated: true, ok: false, reportHash: 'h1', report: { oldTotal: 100, newTotal: 60, reasons: [ { msg: '欧美层缺失', bypassable: false } ] } } });
    await t.Sync.doSync(); await drain();
    assert.ok(t.el('status').textContent.indexOf('门槛不可绕过，已保留原列表') > 0);
    assert.strictEqual(t.calls.toast.length, 0, '无 bypass 不给强制入口');
    assert.strictEqual(t.f.calls.filter(c => c.url === '/api/sync/force-token').length, 0, '不申请 token');
  });
  await ok('有 bypass 但缺 reportHash 同样不出 toast（令牌无法绑定）', async () => {
    const t = mkSync({ syncBody: { gated: true, ok: false, report: { oldTotal: 10, newTotal: 5, reasons: [ { msg: 'r', bypassable: true } ] } } });
    await t.Sync.doSync(); await drain();
    assert.strictEqual(t.calls.toast.length, 0, '缺 reportHash 不给强制入口');
    assert.strictEqual(t.f.calls.filter(c => c.url === '/api/sync/force-token').length, 0);
  });
  await ok('r.error → status 失败文案（按钮复位）', async () => {
    const t = mkSync({ syncBody: { error: '上游超时' } });
    await t.Sync.doSync(); await drain();
    assert.strictEqual(t.el('status').textContent, '同步失败（file:// 或无后端时请在项目目录跑 node update-sources.js）：上游超时');
    assert.strictEqual(t.span('syncBtn').textContent, '同步源', 'catch 后仍复位按钮');
    assert.strictEqual(t.el('syncBtn').disabled, false);
    assert.strictEqual(t.el('prog').hidden, true);
  });
  await ok('fetch throw：「同步已在进行中」直通、其他错误加降级提示前缀', async () => {
    const t1 = mkSync({ syncFail: '同步已在进行中，请稍后再试' });
    await t1.Sync.doSync(); await drain();
    assert.strictEqual(t1.el('status').textContent, '同步已在进行中，请稍后再试', 'busy 409 直通不加前缀');
    const t2 = mkSync({ syncFail: '后端挂了' });
    await t2.Sync.doSync(); await drain();
    assert.strictEqual(t2.el('status').textContent, '同步失败（file:// 或无后端时请在项目目录跑 node update-sources.js）：后端挂了');
  });
  await ok('进行中按钮态（disabled/同步中…/prog）与成功收尾复位', async () => {
    const t = mkSync({ holdSync: true, syncBody: { total: 10, delta: 0, euKept: 8 } });
    const p = t.Sync.doSync(); await drain();
    assert.strictEqual(t.el('syncBtn').disabled, true, '进行中禁点');
    assert.strictEqual(t.span('syncBtn').textContent, '同步中…');
    assert.strictEqual(t.el('prog').hidden, false);
    assert.strictEqual(t.el('status').textContent, '同步中：国内上游 + 欧美台逐个实测，约 1 分钟…');
    t.f.releaseSync(); await p; await drain();
    assert.strictEqual(t.el('syncBtn').disabled, false, '收尾复位');
    assert.strictEqual(t.span('syncBtn').textContent, '同步源');
    assert.strictEqual(t.el('prog').hidden, true);
    assert.strictEqual(t.el('status').textContent, '同步完成：共 10 台（+0；欧美音乐 8 个实测可用）');
  });

  console.log('[8] forceSync');
  await ok('token 申请失败 → 「强制同步失败」且不发强制 POST', async () => {
    const t = mkSync({ tokenBody: { error: '报告已过期' } });
    await t.Sync.forceSync('h1'); await drain();
    assert.strictEqual(t.el('status').textContent, '强制同步失败：报告已过期');
    assert.strictEqual(t.f.calls.filter(c => c.url === '/api/sync').length, 0, '无 token 不强制发布');
    const t2 = mkSync(); // tokenBody 空 → 无 token
    await t2.Sync.forceSync('h1'); await drain();
    assert.strictEqual(t2.el('status').textContent, '强制同步失败：令牌申请失败');
  });
  await ok('报告已变化（强制仍 gated）→ 拒绝文案', async () => {
    const t = mkSync({ tokenBody: { token: 'tk' }, syncBody: (u, o) => o && o.body ? { gated: true, ok: false } : {} });
    await t.Sync.forceSync('h1'); await drain();
    assert.strictEqual(t.el('status').textContent, '强制同步失败：同步报告已变化，请重新同步确认');
    assert.strictEqual(JSON.parse(t.f.calls.filter(c => c.url === '/api/sync')[0].opt.body).forceToken, 'tk', '仍带 token 尝试');
    assert.strictEqual(t.calls.reload, 0, '拒绝后不动主列表');
  });
  await ok('强制成功 → syncDone 汇总 + replacement=forced 徽记', async () => {
    const t = mkSync({ tokenBody: { token: 'tk' }, syncBody: (u, o) => o && o.body ? { total: 50, delta: 5, euKept: 10, replacement: 'forced' } : {} });
    await t.Sync.forceSync('h9'); await drain();
    assert.strictEqual(JSON.parse(t.f.calls.filter(c => c.url === '/api/sync/force-token')[0].opt.body).reportHash, 'h9', 'token 绑定报告指纹');
    assert.strictEqual(t.calls.reload, 1);
    assert.strictEqual(t.el('status').textContent, '同步完成：共 50 台（+5；欧美音乐 10 个实测可用；已强制替换）');
  });

  console.log('[9] syncDone');
  await ok('aborted → 中止文案且不 reloadMain、不排增量', async () => {
    const t = mkSync();
    await t.Sync.syncDone({ aborted: true, total: 3 });
    assert.strictEqual(t.el('status').textContent, '同步中止：合并结果异常（仅 3 台），已保留原列表');
    assert.strictEqual(t.calls.reload, 0, '中止不动主列表');
    assert.strictEqual(t.clock.pending(), 0, '不排 800ms 增量体检');
  });
  await ok('汇总文案分支：delta 正负/euKept 有无/replacement forced·kept', async () => {
    const t = mkSync();
    await t.Sync.syncDone({ total: 100, delta: -3, added: 2, removed: 5, euKept: 40, replacement: 'kept' });
    assert.strictEqual(t.el('status').textContent, '同步完成：共 100 台（-3；新增 2 台、消失 5 台；欧美音乐 40 个实测可用；欧美层保留旧数据）');
    await t.Sync.syncDone({ total: 90, delta: 5, euKept: null, replacement: 'forced' });
    assert.strictEqual(t.el('status').textContent, '同步完成：共 90 台（+5；欧美音乐未更新（已保留旧列表）；已强制替换）');
    assert.strictEqual(t.calls.favsGone.length, 0, '无 removedNames 不比对');
  });
  await ok('收藏台消失点名：favsGone(名+URL 双通道)，≤5 全列、>5 截断「等 N 个」', async () => {
    const t = mkSync({ gone: ['甲台', '乙台'] });
    await t.Sync.syncDone({ total: 10, delta: 0, euKept: 10, removed: 2, removedNames: ['甲台', '乙台'], removedUrls: ['http://x/1'] });
    assert.deepStrictEqual(t.calls.favsGone[0].names, ['甲台', '乙台'], '显示名通道');
    assert.deepStrictEqual(t.calls.favsGone[0].urls, ['http://x/1'], 'URL 快照通道（改名台不误报）');
    assert.ok(t.el('status').textContent.indexOf('⚠ 收藏台已不在新列表：甲台、乙台') > 0);
    const t2 = mkSync({ gone: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'] });
    await t2.Sync.syncDone({ total: 10, delta: 0, euKept: 10, removedNames: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'] });
    assert.ok(t2.el('status').textContent.indexOf('g1、g2、g3、g4、g5 等 6 个') > 0, '>5 截断（textContent 直写无注入面）');
  });
  await ok('addedCheck 非空 → 800ms 后排 incHealth（FakeClock 驱动）；空名单不排', async () => {
    const t = mkSync({ stations: [st('新闻', 'A台', ['http://a/1'])] });
    await t.Sync.syncDone({ total: 5, delta: 5, euKept: 0, addedCheck: ['A台'] });
    assert.strictEqual(t.clock.pending(), 1, '增量体检已排队（800ms）');
    t.clock.tick(800); await drain();
    assert.strictEqual(t.f.checks().length, 1, 'incHealth 已跑（触发探活）');
    assert.ok(t.calls.toast[0].msg.indexOf('后台体检新增电台 1 台…') === 0, '增量通道开场 toast');
    const t2 = mkSync();
    await t2.Sync.syncDone({ total: 5, delta: 0, euKept: 5 });
    assert.strictEqual(t2.clock.pending(), 0, '无名单不排');
  });

  console.log('[10] 首启 baseline()');
  await ok('file:// / busy 直接 return：不跑不置位', async () => {
    const t1 = mkSync({ location: { protocol: 'file:' }, baselineList: [st('新闻', 'A', ['http://a/1'])] });
    await t1.Sync.baseline();
    assert.strictEqual(t1.f.calls.length, 0);
    assert.strictEqual(t1.ls.getItem('radio.baseline'), null, 'file:// 不置基线');
    const t2 = mkSync({ baselineList: [st('新闻', 'A', ['http://a/1'])] });
    t2.Sync.busy = 'manual';
    await t2.Sync.baseline();
    assert.strictEqual(t2.f.calls.length, 0, 'busy 互斥');
    assert.strictEqual(t2.ls.getItem('radio.baseline'), null);
  });
  await ok('确认门槛：prompt toast 常驻 + action.fn 触发才开跑（ms=0 + dismiss「暂不」）', async () => {
    const A = st('新闻', 'A', ['http://a/1']), B = st('新闻', 'B', ['http://b/1']);
    const t = mkSync({ baselineList: [A, B] });
    t.Sync.baselinePrompt();
    assert.strictEqual(t.calls.toast.length, 1, '只有确认 toast，未开跑');
    assert.strictEqual(t.f.calls.length, 0);
    const to = t.calls.toast[0];
    assert.strictEqual(to.opt.ms, 0, '常驻直到选择（AIbot P3-5）');
    assert.strictEqual(to.opt.action.label, '开始基线体检');
    assert.strictEqual(to.opt.dismiss, '暂不');
    assert.ok(to.msg.indexOf('检测到 2 台电台尚无体检基线') === 0);
    to.opt.action.fn(); await drain();
    assert.strictEqual(t.f.checks().length, 2, '确认后才全量跑');
    assert.strictEqual(t.Sync.busy, '', '跑完复位');
    assert.deepStrictEqual(t.calls.toast.length, 3, '确认 → 进行中 → 完成 三段');
    assert.ok(t.calls.toast[2].msg.indexOf('基线体检完成：可用 2、疑似失效 0、已停运 0') === 0, '完成分档 toast');
    assert.strictEqual(t.ls.getItem('radio.baseline'), 'done');
  });
  await ok('baselineList 空 → 直接 baselineDone（纯欧美库存无基线可建）；file:// prompt 不出', async () => {
    const t = mkSync({ baselineList: [] });
    t.Sync.baselinePrompt();
    assert.strictEqual(t.ls.getItem('radio.baseline'), 'done', '空库存直接置 done');
    assert.strictEqual(t.calls.toast.length, 0);
    assert.strictEqual(t.f.calls.length, 0);
    const t2 = mkSync({ location: { protocol: 'file:' }, baselineList: [st('新闻', 'A', ['http://a/1'])] });
    t2.Sync.baselinePrompt();
    assert.strictEqual(t2.calls.toast.length, 0, 'file:// 协议门');
    assert.strictEqual(t2.ls.getItem('radio.baseline'), null);
  });
  await ok('续跑：radio.baselineProg 已确认台跳过（幂等重跑无副作用只是浪费时间）', async () => {
    const A = st('新闻', 'A', ['http://a/1']), B = st('新闻', 'B', ['http://b/1']);
    const t = mkSync({ lsSeed: { 'radio.baselineProg': JSON.stringify(['新闻|A']) }, baselineList: [A, B] });
    await t.Sync.baseline(); await drain();
    assert.strictEqual(t.f.checks().length, 1, '只测未确认的 B');
    assert.deepStrictEqual(qsUrls(t.f.checks()[0].url), ['http://b/1']);
    assert.strictEqual(t.calls.patch[0].n, 'B');
    assert.strictEqual(t.ls.getItem('radio.baseline'), 'done', '全部确认即完成');
    assert.strictEqual(t.ls.getItem('radio.baselineProg'), null, '完成清进度');
  });
  await ok('每 25 台落盘：进度与已确认标记同批（第 25 台处一次 + 收尾一次）', async () => {
    const list = []; for (let i = 1; i <= 26; i++) list.push(st('新闻', 'N' + i, ['http://n/' + i]));
    const t = mkSync({ baselineList: list });
    await t.Sync.baseline(); await drain();
    const sets = t.store.calls.filter(c => c === 'set radio.baselineProg');
    assert.strictEqual(sets.length, 2, '第 25 台处 + 收尾各一次（只在收尾落 = 1 次即失败）');
    assert.ok(t.store.calls.indexOf('set radio.baselineProg') < t.store.calls.indexOf('set radio.baseline'), '第一次落盘先于置 done（中断兜底口径）');
    assert.strictEqual(t.store.calls.filter(c => c === 'remove radio.baselineProg').length, 1);
    assert.strictEqual(t.calls.save, 2, 'saveHealth 与进度同批（AIbot P1-1）');
    assert.strictEqual(t.ls.getItem('radio.baseline'), 'done');
    assert.strictEqual(t.ls.getItem('radio.baselineProg'), null);
    assert.ok(t.calls.toast[1].msg.indexOf('基线体检完成：可用 26、疑似失效 0、已停运 0') === 0);
  });
  await ok('中断兜底：途中 silentAbort → 进度落盘 + saveHealth，baselineDone 不执行', async () => {
    const A = st('新闻', 'A', ['http://a/1']), B = st('新闻', 'B', ['http://b/1']), C = st('新闻', 'C', ['http://c/1']);
    const t = mkSync({ baselineList: [A, B, C], holdCheck: true });
    const p = t.Sync.baseline(); await drain();
    assert.strictEqual(t.Sync.busy, 'silent');
    t.Sync.silentAbort = true; // 现实路径 = 手动体检接管置位；此处直接驱动标志验证兜底分支
    t.f.releaseCheck(); await p; await drain();
    assert.deepStrictEqual(t.store.calls, ['set radio.baselineProg'], '只兜底落进度（不置 done 不清 prog）');
    assert.strictEqual(t.calls.save, 1, '已确认标记与进度同批落盘');
    assert.deepStrictEqual(JSON.parse(t.ls.getItem('radio.baselineProg')).sort(), ['新闻|A', '新闻|B'], '已测两台进进度');
    assert.strictEqual(t.calls.patch.length, 2, 'conc=2 已测台标记有效');
    assert.strictEqual(t.f.checks().length, 2, 'C 未测');
    assert.strictEqual(t.Sync.busy, '');
    assert.ok(!t.calls.toast.some(x => x.msg.indexOf('基线体检完成') === 0), '无完成 toast');
    assert.strictEqual(t.ls.getItem('radio.baseline'), null);
  });

  console.log('[11] baselineDone');
  await ok('置 radio.baseline=done + 清 radio.baselineProg（完成态不变量）', () => {
    const t = mkSync({ lsSeed: { 'radio.baselineProg': '["新闻|A"]' } });
    t.Sync.baselineDone();
    assert.deepStrictEqual(t.store.calls, ['set radio.baseline', 'remove radio.baselineProg']);
    assert.strictEqual(t.ls.getItem('radio.baseline'), 'done');
    assert.strictEqual(t.ls.getItem('radio.baselineProg'), null);
  });

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('sync 测试异常：', e); process.exit(1); });
