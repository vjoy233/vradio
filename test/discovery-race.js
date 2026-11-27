// 发现浮层真实单飞时序：deferred + 虚拟时钟，不让未完成 Promise 掩盖断言。
const assert = require('assert');
const { App } = require('../app');
const { FakeClock, install, restore } = require('./harness/fake-clock');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const flush = async () => { for (let i=0; i<30; i++) await Promise.resolve(); };
const body = {innerHTML:'', insertAdjacentHTML(_, s) { this.innerHTML += s; }, querySelectorAll() { return []; }};
const els = {discovery:{hidden:true}, discBody:body, discClose:{focus(){}}, status:{textContent:''}};
global.document = {activeElement:null,getElementById:id => els[id]};
global.window = {}; global.FEATURES = {discoverySidecar:false,sourceExplain:true};
global.Player = {station:null,connecting:null}; global.QualityStore = {summary:() => null}; global.qExplain = () => ({level:'unknown'});
App.state.stations = []; App.cfg = {hideC:{}}; App.recents = []; App.revives = new Map();
(async () => {
  const clock = new FakeClock(), orig = install(clock);
  try {
    App.metaMain = 'a'; App.metaCache = null;
    let first = deferred(), calls = 0, signal;
    App.loadMeta = (main, s) => { calls++; signal = s; return first.promise; };
    const p = App.openDiscovery(); await flush();
    App.closeDiscovery(); const q = App.openDiscovery(); await flush();
    assert.strictEqual(calls, 1, '关闭重开共享在飞请求');
    first.resolve({stations:{}}); await Promise.all([p,q]);
    assert.deepStrictEqual(App.metaCache, {stations:{}}); assert.strictEqual(signal.aborted, false);

    // 换代的尾随请求必须等旧请求完成，且旧结果不得写入。
    App.closeDiscovery(); App.metaCache = null; App.metaMain = 'old';
    let old = deferred(), fresh = deferred(); calls = 0;
    App.loadMeta = main => { calls++; return main === 'old' ? old.promise : fresh.promise; };
    const a = App.openDiscovery(); await flush();
    App.metaEpoch++; App.metaMain = 'new'; const b = App.refreshDiscovery(); await flush();
    assert.strictEqual(calls, 1); old.resolve({old:true}); await flush();
    assert.strictEqual(calls, 2); assert.strictEqual(App.metaCache, null);
    fresh.resolve({stations:{}}); await Promise.all([a,b]); assert.deepStrictEqual(App.metaCache, {stations:{}});

    // 底层忽略 abort 时 5 秒仍释放逻辑单飞；迟到结果不得覆盖新代。
    App.closeDiscovery(); App.metaCache = null; App.metaMain = 'stuck';
    let stuck = deferred(), next = deferred(); calls = 0;
    App.loadMeta = (main, s) => { calls++; if (main === 'stuck') { signal = s; return stuck.promise; } return next.promise; };
    const c = App.openDiscovery(); await flush(); App.metaEpoch++; App.metaMain = 'next'; const d = App.refreshDiscovery(); await flush();
    clock.tick(4999); await flush(); assert.strictEqual(calls, 1); assert.strictEqual(signal.aborted, false);
    clock.tick(1); await flush(); assert.strictEqual(signal.aborted, true);
    // 超时的等待者仍需为新 main 启动尾随。
    assert.strictEqual(calls, 2); next.resolve({stations:{new:true}}); await Promise.all([c,d]);
    stuck.resolve({old:true}); await flush(); assert.deepStrictEqual(App.metaCache, {stations:{new:true}});

    App.closeDiscovery(); App.discoverySidecar = null; App.metaCache = {stations:{}}; FEATURES.discoverySidecar = true;
    let side = deferred(); calls = 0;
    window.DiscoverySidecar = {loadSnapshot:() => { calls++; return side.promise; }};
    const e = App.openDiscovery(); await flush(); App.closeDiscovery(); const f = App.openDiscovery(); await flush();
    assert.strictEqual(calls, 1); const rows = [{name:'新候选',genre:'精选',url:'https://example.org/'}];
    side.resolve(rows); await Promise.all([e,f]); assert.strictEqual(App.discoverySidecar, rows);
    App.renderDiscovery(); App.renderDiscovery(); assert.strictEqual((body.innerHTML.match(/精选候选（需手动加入）/g) || []).length, 1);
    assert.strictEqual(clock.pending(), 0);
    console.log('发现页单飞、尾随、超时及换代通过');
  } finally { restore(orig); }
})().catch(e => { console.error(e); process.exitCode = 1; });
