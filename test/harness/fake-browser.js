// 最小浏览器桩（P0a，方案 §3 L2.4）：localStorage/BroadcastChannel/document/navigator/audio + vm 装载器
// （loadStore/loadPlayer，同 test/ui-scope.js 的 vm 沙箱法）。全部同步、零网络；fetch/location/Hls 由用例注入。
// 事件驱动约定：fake audio 不自动发 'playing'——play() 只置 paused=false，用例用 audio.fire('playing')
// 显式驱动状态机（确定性优先；方案 §2.2「真实边界必须可替换」）。Node 14 兼容、零依赖。
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');

class FakeLS { // 内存 localStorage（store.js/player.js 只用 getItem/setItem/removeItem）
  constructor(seed) { this.m = Object.assign({}, seed || {}); }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.m, String(k)) ? this.m[String(k)] : null; }
  setItem(k, v) { this.m[String(k)] = String(v); }
  removeItem(k) { delete this.m[String(k)]; }
  clear() { this.m = {}; }
  key(i) { return Object.keys(this.m)[i] || null; }
  get length() { return Object.keys(this.m).length; }
}

// BroadcastChannel 桩：同 hub 内同步互投（多标签对抗用例共享一个 hub：const hub = bcHub(); 两个 sandbox 各传 over.bcHub）
function bcHub() {
  const chans = [];
  class FakeBC {
    constructor(name) { this.name = name; this.onmessage = null; chans.push(this); }
    postMessage(d) { for (const c of chans.slice()) if (c !== this && c.onmessage) c.onmessage({ data: d }); }
    close() { const i = chans.indexOf(this); if (i >= 0) chans.splice(i, 1); }
  }
  return { chans, FakeBC };
}

function fakeAudio() { // player.js 的 audio 桩：监听捕获 + fire() 手动驱动；onerror 是属性赋值（player.js:233），用例直接调 audio.onerror()
  const L = {};
  const a = {
    paused: true, volume: 1, src: '', listeners: L, loaded: 0,
    addEventListener(ev, fn) { (L[ev] = L[ev] || []).push(fn); },
    removeEventListener(ev, fn) { const q = L[ev] || [], i = q.indexOf(fn); if (i >= 0) q.splice(i, 1); },
    removeAttribute(k) { if (k === 'src') a.src = ''; },
    load() { a.loaded++; },
    play() { a.paused = false; return Promise.resolve(); }, // 不自动 fire 'playing'：时序由用例掌控（见头部约定）
    pause() { if (!a.paused) { a.paused = true; a.fire('pause'); } },
    fire(ev, arg) { for (const fn of (L[ev] || []).slice()) fn.call(a, arg); },
  };
  return a;
}

function fakeDocument() { // store/sync 用 document.addEventListener('visibilitychange')/hidden；$() 取元素按需缓存
  const els = {}, L = {};
  const mkEl = () => { // querySelector 按选择器确定性缓存（sync.js 反复读写 b.querySelector('span').textContent 须同一实例）
    const el = { innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, dataset: {}, _q: {},
      classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, onclick: null };
    el.querySelector = sel => el._q[sel] || (el._q[sel] = mkEl());
    el.querySelectorAll = () => [];
    return el;
  };
  return {
    hidden: false, activeElement: null, _els: els,
    getElementById(id) { return els[id] || (els[id] = mkEl()); },
    createElement(tag) { const el = mkEl(); el.tag = tag; return el; },
    addEventListener(ev, fn) { (L[ev] = L[ev] || []).push(fn); },
    dispatch(ev) { for (const fn of (L[ev] || []).slice()) fn(); },
  };
}

function fakeNavigator(supportMS) { // mediaSession 桩：playbackState/metadata/setActionHandler 记录可断言；false = 完全不支持
  const nav = {};
  if (supportMS !== false) nav.mediaSession = { playbackState: '', metadata: null, actions: {}, setActionHandler(n, fn) { nav.mediaSession.actions[n] = fn; } };
  return nav;
}

// sandbox 组装：over.clock 可选（定时器/Date.now 全走 FakeClock）；over.fetch/location/Hls/… 可覆盖。
// window 自引用满足 player.js 的 window.Hls 引用；MediaMetadata 缺省给桩（player.js try 包裹，缺省也能跑）。
function sandbox(over) {
  over = over || {};
  const clock = over.clock;
  const timers = clock
    ? { setTimeout: (fn, ms) => clock.later(ms, fn), clearTimeout: x => clock.cancel(x), setInterval: (fn, ms) => clock.every(ms, fn), clearInterval: x => clock.cancel(x) }
    : { setTimeout, clearTimeout, setInterval, clearInterval };
  const sb = {
    console, URL,
    localStorage: over.ls || new FakeLS(over.lsSeed),
    location: over.location || { protocol: 'http:', origin: 'http://127.0.0.1:8137' },
    navigator: over.navigator || fakeNavigator(),
    document: over.document || fakeDocument(),
    fetch: over.fetch || (() => Promise.reject(new Error('fetch 未注入（用例自备）'))),
    MediaMetadata: over.MediaMetadata || (function MM(m) { Object.assign(this, m || {}); }),
    Date: over.Date || (clock ? { now: () => clock.now() } : Date), // player.js 只用 Date.now()
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    _winEv: {}, // 全局 addEventListener 记录（beforeunload 等）：sb._winEv.beforeunload 逐个 fn() 手动触发
    addEventListener(ev, fn) { (sb._winEv[ev] = sb._winEv[ev] || []).push(fn); },
  };
  const hub = over.bcHub || bcHub();
  sb.BroadcastChannel = hub.FakeBC; sb._bcHub = hub;
  Object.assign(sb, over.globals || {}); // Store 依赖的 App 桩、Hls 桩等从这里进
  sb.window = sb;
  return sb;
}

const loadFile = (sb, file, expose) => { // 经典 script 装载 + 尾部暴露（test/ui-scope.js 同款法）
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.createContext(sb);
  vm.runInContext(src + '\nthis.' + expose + ' = ' + expose + ';', sb, { filename: file });
  return sb[expose];
};
const loadStore = sb => loadFile(sb, 'store.js', 'Store');
const loadPlayer = sb => loadFile(sb, 'player.js', 'Player');

module.exports = { FakeLS, bcHub, fakeAudio, fakeDocument, fakeNavigator, sandbox, loadStore, loadPlayer, ROOT };
