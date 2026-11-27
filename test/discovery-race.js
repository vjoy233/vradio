// 发现浮层真实单飞时序：deferred + 虚拟时钟，不让未完成 Promise 掩盖断言。
const assert = require('assert');
require('./harness/web-api').install(); // Node 14 测试环境补齐 Web API
// 仅测试沙箱翻转源码门，以覆盖未来启用后的单飞语义；生产文件保持硬关。
const fs = require('fs'), Module = require('module'), path = require('path');
const filename = require.resolve('../app');
const source = fs.readFileSync(filename, 'utf8');
assert(source.includes('const trustedC3Release = false;'));
const fixture = new Module(filename, module); fixture.filename = filename; fixture.paths = Module._nodeModulePaths(path.dirname(filename));
fixture._compile(source.replace('const trustedC3Release = false;', 'const trustedC3Release = true;'), filename);
const { App } = fixture.exports;
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
    // 真正经过 App → loadSnapshot：指针慢接近 5 秒，当前代超时，上一代仍有完整预算。
    App.closeDiscovery(); App.discoverySidecar = null;
    window.DiscoverySidecar = require('../discovery-sidecar');
    const crypto = require('crypto'), raw = {v:1,source:'recommended-radio-streams',license:'CC0-1.0',commit:'a'.repeat(40),generatedAt:'2026-11-26T00:00:00.000Z',items:[{name:'回退候选',url:'https://example.org/'}]};
    const payload = Buffer.from(JSON.stringify(raw)), id = crypto.createHash('sha256').update(payload).digest('hex'), bad = 'b'.repeat(64);
    const pointer = deferred(), previous = deferred(), requested = [];
    const response = data => ({ok:true,headers:{get:k => k === 'content-type' ? 'application/json' : null},body:{getReader:() => { let read = false; return {read:async () => read ? {done:true} : (read=true,{done:false,value:Buffer.from(data)}),cancel:async()=>{},releaseLock(){}}; }}});
    global.fetch = (url, opts) => { requested.push(url); if (url.endsWith('/current.json')) return pointer.promise; if (url.includes(bad)) return new Promise(() => {}); if (url.endsWith('/manifest.json')) return previous.promise; return Promise.resolve(response(payload)); };
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {configurable:true,value:undefined});
    const integration = App.openDiscovery(); await flush();
    clock.tick(4900); pointer.resolve(response(JSON.stringify({v:1,current:bad,previous:id}))); await flush();
    assert(requested.some(x => x.includes(bad)), '当前代已启动');
    clock.tick(5000); await flush(); assert(requested.some(x => x.includes(id)), '当前代超时后启动上一代');
    clock.tick(4900); previous.resolve(response(JSON.stringify({v:1,sha256:id,bytes:payload.length}))); await flush();
    let settled = false; integration.then(() => { settled = true; }); await flush();
    assert(settled, '上一代成功后调用必须完成'); await integration; assert.strictEqual(App.discoverySidecar[0].name, '回退候选');
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); else delete globalThis.crypto;
    App.closeDiscovery(); App.discoverySidecar = null; let sideSignal;
    window.DiscoverySidecar = {loadSnapshot:(fetcher, base, ms, s) => { sideSignal = s; return new Promise(() => {}); }};
    const hung = App.openDiscovery(); await flush(); clock.tick(15999); await flush(); assert(!sideSignal.aborted);
    clock.tick(1); await flush(); assert(sideSignal.aborted); await hung;
    assert.strictEqual(clock.pending(), 0);
    console.log('发现页单飞、尾随、超时及换代通过');
  } finally { restore(orig); }
})().catch(e => { console.error(e); process.exitCode = 1; });
