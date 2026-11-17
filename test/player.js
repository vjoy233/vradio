// player.js 播放状态机确定性矩阵（P0a，docs/testing-strategy-2026-11.md §3 L1 player 行）。
// fake audio 不自动发事件：状态机推进一律 audio.fire('playing'|'stalled'|'ended'|'pause') 显式驱动；
// audio.onerror 是属性赋值（player.js:233），用例直接 audio.onerror() 触发级联。分节 → 覆盖矩阵：
// [1] variants 三级（直流→m3u8 直连→/proxy 兜底；蜻蜓换算 64k mp3；file:// 无代理级；xhrSetup 代理分片重写）
// [2] 默认源决策链（prefer > srcmem2 记忆 > s.mo 人工序 > 启发式稳定排序；禁用源忽略；NO_ENABLED_SOURCE 全禁善后）
// [3] 世代令牌防串台（切台后旧 playing/error/看门狗一律失效或归属新台，不回跳旧台；含旧闭包/旧 HLS
//     实例句柄的显式重放——mutation 防线：删守卫代码必须炸，review#37 P1-3）
// [4] error 级联自愈（逐 variant 顺延→耗尽善后 onfail/状态清理；playing 写 srcmem2（键=u[0]）；跨重载记忆先行；HLS fatal；畸形 URL 代理级顺延）
// [5] stalled/waiting 看门狗（12s 无进展→先同源重连一次，再败才顺延；timeupdate 撤表；真暂停不掺和；建流期挂死同样自愈）
// [6] ended 自愈 + halt 守卫（有意暂停/让位后 ended、error 级联不得复活播放；resume 接回 heldNext）
// [7] 成功源记忆 FIFO 300（player.js:304 按 t 淘汰最旧）+ 未变不写 + 单源台不写
// [8] forgetSrc 清记忆回启发式（缺省=当前台）
// [9] 每台音量（volperst 记忆优先/gvol 全局锚点（radio.vol 装载）/无记忆台首调随行 radio.vol（r2 语义①）/0 不入记忆/
//     静音切台保持静音 + restoreVol 台记忆→全局/300ms 攒批+reloadMems 先落（AIbot P3-2）/300 封顶（插入序）/跨页对账）
// [10] 多标签让位（后来者赢：pause+halt+connecting 清理；建流期让位不残留 connecting；让位页 error 不复活；
//      非 'on' 消息（Store 'store' 重拉）过滤）
// [11] 睡眠定时（30s 边界线性渐弱、到点 pause+音量按逻辑值恢复+ontick(0)、cancelSleep 恢复、sleep(0) 只取消）
// [12] 曲讯不串台（curUrl/curPlay 随装载更新、/proxy 还原远端、旧台 in-flight 事件不写回旧台）
// [13] 暂停/恢复（halt/sessionPlayed=false/connecting 抑制期不发 paused；resume 不经 load 不重复采样；
//      refresh 当前赢家源整链重开、暂停中直接起播、同源不重写记忆；媒体键 onplaylast/onstepfav）
// [14] 杂项（旧键 radio.srcmem 一次性失效；Hls.isSupported=false 降级 audio.src 直配；getSourceState 只读快照；
//      MediaSession 元数据组装）
// 未覆盖项与原因（黑盒不可观测/不属于本层，均不为测试改生产代码）：
// - 真实 HLS 分片拉取/manifest 解析/缓冲时序：hls.js 内部行为，伪实例只验证 player 对 hls.js 的 API 编排与错误上抛；
// - 真实音频解码与浏览器自动事件（canplay/进度推进）时序：fake audio 显式驱动换取确定性；
// - audio 原生 'play' 事件分支（emit(false)，player.js:54）：桩的 play() 不发事件；
// - 蜻蜓 64k 端点真实可用性、锁屏 artwork 实际加载：网络/系统能力；
// - radio.srcmem2/volperst 经 store.js 的对账回流与多标签存储同步：属 store 域（P0b 用例），此处 Store 桩按
//   localStorage 真行为直读直写。
// 零依赖离线，npm test 随跑。
const assert = require('assert');
const { sandbox, loadPlayer, fakeAudio, bcHub, FakeLS } = require('./harness/fake-browser');
const { FakeClock } = require('./harness/fake-clock');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); } };

// —— 装置 ————————————————————————————————————————————————
const st = (u, over) => Object.assign({ c: '测试分类', n: '台', u: u }, over || {}); // 台对象（app 装配后形态）
const enc = u => '/proxy?url=' + encodeURIComponent(u);
const approx = (a, b) => Math.abs(a - b) < 1e-9;

function fakeHlsFactory() { // HLS 伪实例：每次构造独立实例（review#37 P1-3——单例复用会覆盖旧实例事件，
  // 旧实例迟到回调无法验证防串台守卫）；view 代理「最新实例」保持 p.hls.* 单实例时代的断言写法兼容
  const insts = [];
  function Hls(cfg) {
    const inst = { handlers: {}, cfg: cfg, source: null, media: null, destroyed: false,
      on(ev, fn) { inst.handlers[ev] = fn; }, loadSource(u) { inst.source = u; }, attachMedia(a) { inst.media = a; },
      destroy() { inst.destroyed = true; } };
    insts.push(inst);
    return inst;
  }
  Hls.isSupported = () => true; Hls.Events = { ERROR: 'error' };
  const view = {};
  ['handlers', 'cfg', 'source', 'media', 'destroyed'].forEach(k => Object.defineProperty(view, k, {
    configurable: true, get() { const l = insts[insts.length - 1]; return l ? l[k] : undefined; },
  }));
  return { Hls: Hls, insts: insts, view: view };
}

// 一页装置：独立 sandbox + FakeClock + Store 桩（真 localStorage 行为，记忆持久化可跨重载验证）+ Hls 桩 + spy。
// over: { ls, hub, location, vol0, noHls, t0 }。clock 默认起点 1000ms——qEmittedT0 初始 0，t=0 时 loadT0===qEmittedT0
// 会让 qosPlaying 误判「resume 重复 playing」而跳过采样（player.js:336），起点抬高规避该零点重合。
function mkPage(over) {
  over = over || {};
  const clock = over.clock || new FakeClock(over.t0 || 1000);
  const ls = over.ls || new FakeLS();
  const store = { calls: [], get(k) { return ls.getItem(k); }, set(k, v) { store.calls.push(k); ls.setItem(k, v); } };
  const sb = sandbox({ clock: clock, ls: ls, bcHub: over.hub, location: over.location, globals: { Store: store } });
  let hl = null;
  if (over.noHls) sb.Hls = sb.window.Hls = { isSupported: () => false, Events: { ERROR: 'error' } };
  else { hl = fakeHlsFactory(); sb.Hls = sb.window.Hls = hl.Hls; }
  const Player = loadPlayer(sb);
  const audio = fakeAudio();
  const spy = { state: 0, status: [], fail: 0, vol: [], tick: [], phase: [], qos: [] };
  Player.onstate = function () { spy.state++; };
  Player.onstatus = function (t) { spy.status.push(t); };
  Player.onfail = function () { spy.fail++; };
  Player.onvol = function (v) { spy.vol.push(v); };
  Player.ontick = function (ms) { spy.tick.push(ms); };
  Player.onphase = function (p, s) { spy.phase.push({ ph: p, st: s ? s.n : null }); };
  Player.onqos = function (ev) { spy.qos.push({ ph: ev.phase, trig: ev.trig, si: ev.si, mode: ev.mode, reason: ev.reason, st: ev.station ? ev.station.n : null, lat: ev.lat }); };
  Player.init(audio, over.vol0 != null ? over.vol0 : 0.9);
  return { sb: sb, ls: ls, store: store, Player: Player, audio: audio, spy: spy, clock: clock,
    hls: hl ? hl.view : null, hlsAll: hl ? hl.insts : null };
}
const arr = r => [].slice.call(r); // vm 跨 realm 数组原型失配：deepStrictEqual 前先展开成本地数组（同 ui-scope.js 法）
const said = p => p.spy.status[p.spy.status.length - 1];
const srcmem2 = ls => { const v = ls.getItem('radio.srcmem2'); return v ? JSON.parse(v) : {}; };
const srcmemSetCount = p => p.store.calls.filter(function (k) { return k === 'radio.srcmem2'; }).length;

// [1] variants 三级策略 ————————————————————————————————————
console.log('[1] variants() 三级策略：直流→m3u8 直连→/proxy 兜底');
ok('mp3 直流：[原URL, /proxy] 两级（http 页面）', () => {
  const p = mkPage();
  assert.deepStrictEqual(arr(p.Player.variants('http://x/a.mp3')), ['http://x/a.mp3', enc('http://x/a.mp3')]);
});
ok('m3u8 同两级；蜻蜓 ls.qingting.fm 自动换算 lhttp 64k mp3 置顶（三级）', () => {
  const p = mkPage();
  assert.deepStrictEqual(arr(p.Player.variants('http://x/a.m3u8')), ['http://x/a.m3u8', enc('http://x/a.m3u8')]);
  assert.deepStrictEqual(arr(p.Player.variants('http://ls.qingting.fm/live/1234.m3u8')),
    ['http://lhttp.qingting.fm/live/1234/64k.mp3', 'http://ls.qingting.fm/live/1234.m3u8', enc('http://ls.qingting.fm/live/1234.m3u8')]);
});
ok('file:// 页面无 /proxy 兜底级', () => {
  const p = mkPage({ location: { protocol: 'file:' } });
  assert.deepStrictEqual(arr(p.Player.variants('http://x/a.mp3')), ['http://x/a.mp3']);
  assert.deepStrictEqual(arr(p.Player.variants('http://ls.qingting.fm/live/9.m3u8')),
    ['http://lhttp.qingting.fm/live/9/64k.mp3', 'http://ls.qingting.fm/live/9.m3u8']);
});
ok('srcRank：m3u8 首变体 =1 靠后，直流/蜻蜓换算 =0 优先', () => {
  const p = mkPage();
  assert.strictEqual(p.Player.srcRank('http://x/a.mp3'), 0);
  assert.strictEqual(p.Player.srcRank('http://x/a.m3u8'), 1);
  assert.strictEqual(p.Player.srcRank('http://ls.qingting.fm/live/7.m3u8'), 0);
});
ok('play(m3u8) 走 hls.js 编排：loadSource/attachMedia/play，audio.src 不占用', () => {
  const p = mkPage();
  p.Player.play(st(['http://r/live.m3u8'], { n: 'HLS台' }));
  assert.strictEqual(p.hls.source, 'http://r/live.m3u8');
  assert.strictEqual(p.hls.media, p.audio);
  assert.strictEqual(p.audio.paused, false);
  assert.strictEqual(p.audio.src, '');
  assert.strictEqual(p.Player.curPlay, 'http://r/live.m3u8');
});
ok('proxy 分片重写 xhrSetup：远端绝对/origin 相对分片包 /proxy，已代理形态放行', () => {
  const p = mkPage();
  p.Player.play(st(['http://r/live.m3u8']));
  p.audio.onerror(); // 直连失败 → /proxy 变体（此 load 才有 proxyBase）
  assert.strictEqual(p.Player.curPlay, enc('http://r/live.m3u8'));
  assert.strictEqual(p.hls.source, 'http://r/live.m3u8'); // 代理 m3u8 仍 loadSource 远端原始 URL
  const cfg = p.hls.cfg;
  const mkx = () => ({ opened: null, open(m, u) { this.opened = u; } });
  const x1 = mkx(); cfg.xhrSetup(x1, 'http://else/seg.ts');
  assert.strictEqual(x1.opened, enc('http://else/seg.ts'));
  const x2 = mkx(); cfg.xhrSetup(x2, 'http://127.0.0.1:8137/live/seg1.ts'); // 相对分片拼回远端 base
  assert.strictEqual(x2.opened, enc('http://r/live/seg1.ts'));
  const x3 = mkx(); cfg.xhrSetup(x3, enc('http://r/already.m3u8'));
  assert.strictEqual(x3.opened, null);
});

// [2] 默认源决策链 ————————————————————————————————————————
console.log('[2] 默认源决策链：prefer > 成功源记忆 > 人工序 > 启发式');
ok('启发式：m3u8+mp3 混源台直流先行；同级 mp3 稳定排序保持行序', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/live.m3u8', 'http://b/live.mp3'], { n: '混源台' }));
  assert.strictEqual(p.audio.src, 'http://b/live.mp3');
  assert.strictEqual(p.Player.curSi, 1);
  p.Player.play(st(['http://a/x.mp3', 'http://b/y.mp3', 'http://c/z.m3u8'], { n: '三源台' }));
  assert.strictEqual(p.audio.src, 'http://a/x.mp3'); // 两个 mp3 同级不重排
});
ok('成功源记忆先行：srcmem2 指向 m3u8 → 压过启发式直流优先', () => {
  const ls = new FakeLS({ 'radio.srcmem2': JSON.stringify({ 'http://a/live.m3u8': { i: 0, t: 1 } }) });
  const p = mkPage({ ls: ls });
  p.Player.play(st(['http://a/live.m3u8', 'http://b/live.mp3'], { n: '混源台' }));
  assert.strictEqual(p.hls.source, 'http://a/live.m3u8');
});
ok('手动 prefer 最高优先（压过记忆）；指向禁用源则忽略', () => {
  const ls = new FakeLS({ 'radio.srcmem2': JSON.stringify({ 'http://a/live.m3u8': { i: 0, t: 1 } }) });
  const p = mkPage({ ls: ls });
  p.Player.play(st(['http://a/live.m3u8', 'http://b/live.mp3'], { n: '混源台' }), 1);
  assert.strictEqual(p.audio.src, 'http://b/live.mp3'); // prefer=1 压过记忆 i=0
  p.Player.play(st(['http://a/x.m3u8', 'http://b/y.mp3'], { n: '半禁台', mo: [0] }), 1);
  assert.strictEqual(p.hls.source, 'http://a/x.m3u8'); // 源 1 已禁用：prefer 落空
});
ok('记忆指向禁用源 → 忽略记忆，按启用集启发式', () => {
  const ls = new FakeLS({ 'radio.srcmem2': JSON.stringify({ 'http://a/x.m3u8': { i: 1, t: 1 } }) });
  const p = mkPage({ ls: ls });
  p.Player.play(st(['http://a/x.m3u8', 'http://b/y.mp3'], { n: '半禁台', mo: [0] }));
  assert.strictEqual(p.hls.source, 'http://a/x.m3u8'); // 记忆 i=1 不在启用序 → 不提首
});
ok('s.mo 人工序：无 moManual 仍启发式重排；moManual=true 原样使用', () => {
  const p = mkPage();
  const base = { u: ['http://a/x.mp3', 'http://b/y.mp3', 'http://c/z.m3u8'], n: '手工台' };
  p.Player.play(Object.assign({}, base, { mo: [2, 0, 1] }));
  assert.strictEqual(p.audio.src, 'http://a/x.mp3'); // 未标人工 → 启发式覆盖
  p.Player.play(Object.assign({}, base, { mo: [2, 0, 1], moManual: true }));
  assert.strictEqual(p.hls.source, 'http://c/z.m3u8'); // 人工意图压过启发式
});
ok('全禁源：NO_ENABLED_SOURCE——不建连接、清台态、提示、phase idle', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3'], { n: '普通台' }));
  const ret = p.Player.play(st(['http://a/x.mp3'], { n: '禁用台', mo: [] }));
  assert.strictEqual(ret, 'NO_ENABLED_SOURCE');
  assert.strictEqual(p.Player.station, null);
  assert.strictEqual(p.Player.connecting, null);
  assert.strictEqual(p.audio.src, '');
  assert.strictEqual(said(p), '该台所有源都已手动禁用，请先启用一个源');
  assert.deepStrictEqual(p.spy.phase[p.spy.phase.length - 1], { ph: 'idle', st: null });
});

// [3] 世代令牌防串台 ——————————————————————————————————————
console.log('[3] 世代令牌防串台：切台后旧台事件一律失效或归属新台');
ok('play(A) 后立即 play(B)：B 正常装载，当前台不再回跳 A', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/a1.mp3', 'http://a/a2.mp3'], { n: 'A台' }));
  p.Player.play(st(['http://b/b1.mp3'], { n: 'B台' }));
  assert.strictEqual(p.Player.station.n, 'B台');
  assert.strictEqual(p.audio.src, 'http://b/b1.mp3');
});
ok('旧台时点的迟到 playing 归属当前台 B：不回跳 A、不写 A 记忆', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/a1.mp3', 'http://a/a2.mp3'], { n: 'A台' }));
  p.Player.play(st(['http://b/b1.mp3'], { n: 'B台' }));
  p.audio.fire('playing');
  assert.strictEqual(p.Player.station.n, 'B台');
  assert.strictEqual(p.Player.connecting, null);
  assert.strictEqual(said(p), '直播中');
  const q = p.spy.qos[p.spy.qos.length - 1];
  assert.deepStrictEqual({ ph: q.ph, st: q.st, si: q.si }, { ph: 'playing', st: 'B台', si: 0 });
  assert.deepStrictEqual(p.spy.phase[p.spy.phase.length - 1], { ph: 'playing', st: 'B台' });
  assert.deepStrictEqual(srcmem2(p.ls), {}); // B 单源台不写记忆，A 也从未到达 playing
});
ok('旧台时点的 error 只推进当前台 B 的级联（A 的备源不得被装载）', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/a1.mp3', 'http://a/a2.mp3'], { n: 'A台' })); // 4 个 variant
  p.Player.play(st(['http://b/b1.mp3'], { n: 'B台' })); // 2 个 variant
  p.audio.onerror(); // 令牌若失效会去装 A 的 a2/proxy（「源2/4」）
  assert.strictEqual(p.Player.curPlay, enc('http://b/b1.mp3'));
  assert.strictEqual(p.audio.src, enc('http://b/b1.mp3'));
  assert.strictEqual(said(p), '连接中… 源2/2'); // 计数按 B 的 variant 总数
  p.audio.onerror();
  assert.strictEqual(p.spy.fail, 1); // B 耗尽即善后，不串 A 余量
  assert.strictEqual(p.Player.station, null);
});
ok('旧台武装的看门狗切台后到点：不动作（不重连旧源、不提示）', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://a/y.mp3'], { n: 'W台' }));
  p.audio.fire('stalled'); // W 台令牌下武装
  p.Player.play(st(['http://b/z.mp3'], { n: 'V台' })); // 切台 token++
  p.clock.tick(12000);
  assert.strictEqual(p.spy.status.indexOf('流卡住，自动恢复…'), -1);
  assert.strictEqual(p.Player.curPlay, 'http://b/z.mp3');
  assert.strictEqual(p.Player.station.n, 'V台');
});
// review#37 P1-3：上面三例触发的是「当前」闭包（audio.onerror 已被 B 覆写），删掉 player.js 的
// 世代令牌守卫它们仍然全绿（mutation 实证）。以下两例直接保存并重放「A 时代的旧闭包/旧实例句柄」，
// 是令牌守卫与 HLS 句柄守卫的 mutation 防线。
ok('旧闭包真测：保存 A 的 onerror 闭包，play(B) 后重放 → B 零扰动（无级联/无提示/无 qos）', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/a1.mp3', 'http://a/a2.mp3'], { n: 'A台' }));
  const aErr = p.audio.onerror; // A 首装载的 onFail 闭包（捕获 A 世代令牌）
  assert.strictEqual(typeof aErr, 'function', 'load 必须以属性赋值挂 onerror');
  p.Player.play(st(['http://b/b1.mp3'], { n: 'B台' }));
  const nStatus = p.spy.status.length, nQos = p.spy.qos.length;
  aErr(); // 迟到旧闭包：令牌守卫必须整链吞掉（mutation 面：删 `if (my === this.token)` 此处必炸）
  assert.strictEqual(p.Player.station.n, 'B台', '旧闭包不得动当前台');
  assert.strictEqual(p.Player.curPlay, 'http://b/b1.mp3', 'B 首装载不得被顺延');
  assert.strictEqual(p.audio.src, 'http://b/b1.mp3', 'B 的直流装载不得被替换');
  assert.strictEqual(p.Player.curSi, 0, '源序号不动');
  assert.strictEqual(p.spy.status.length, nStatus, '旧闭包不得产生任何新提示');
  assert.strictEqual(p.spy.qos.length, nQos, '旧闭包不得产生 qos 样本');
  assert.strictEqual(p.spy.fail, 0, '旧闭包不得触发善后');
});
ok('旧 HLS 实例 fatal 迟到：不销毁当前 B 实例、不级联（句柄守卫 + 令牌双防线）', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.m3u8'], { n: 'A台' }));
  const aInst = p.hlsAll[p.hlsAll.length - 1]; // A 的 HLS 实例（fatal 处理器随实例闭包）
  p.Player.play(st(['http://b/y.m3u8'], { n: 'B台' }));
  const bInst = p.hlsAll[p.hlsAll.length - 1];
  assert.notStrictEqual(aInst, bInst, '两次装载必须是两个实例（真实 hls.js 语义）');
  const nStatus = p.spy.status.length;
  aInst.handlers['error'](null, { fatal: true }); // A 实例迟到 fatal：真实 hls.js destroy 后不再发，此处验证防御纵深
  assert.strictEqual(bInst.destroyed, false, '旧实例 fatal 不得销毁当前实例（stopHls 句柄守卫）');
  assert.strictEqual(p.Player.hls, bInst, 'Player.hls 仍指向 B 实例');
  assert.strictEqual(bInst.source, 'http://b/y.m3u8', 'B 的装载不动');
  assert.strictEqual(p.Player.station.n, 'B台');
  assert.strictEqual(p.spy.status.length, nStatus, '令牌守卫吞掉 onFail：无级联提示');
});

// [4] error 级联自愈 + 成功源记忆 ————————————————————————————
console.log('[4] error 级联自愈：逐 variant 顺延 → 耗尽善后；playing 写 srcmem2');
ok('级联按三级策略逐 variant 顺延（同源直流→代理→次源…），curSi 按源分组', () => {
  const p = mkPage();
  const s = st(['http://a/x.m3u8', 'http://b/y.mp3'], { n: '级联台' }); // 启发式 [1,0] → 4 variants
  p.Player.play(s);
  assert.strictEqual(p.audio.src, 'http://b/y.mp3');
  p.audio.onerror();
  assert.strictEqual(p.Player.curPlay, enc('http://b/y.mp3'));
  assert.strictEqual(p.Player.curSi, 1);
  assert.strictEqual(p.Player.connecting, s); // 换源重试保持连接中指示
  p.audio.onerror();
  assert.strictEqual(p.Player.curPlay, 'http://a/x.m3u8');
  assert.strictEqual(p.hls.source, 'http://a/x.m3u8');
  assert.strictEqual(p.Player.curSi, 0);
  p.audio.onerror();
  assert.strictEqual(p.Player.curPlay, enc('http://a/x.m3u8'));
  assert.strictEqual(p.Player.curUrl, 'http://a/x.m3u8'); // 代理形态已还原远端（曲讯用）
  assert.strictEqual(p.Player.curSi, 0);
});
ok('全部源耗尽：onfail 一次、台态清理不残留、qos exhaust、状态栏指引', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.m3u8', 'http://b/y.mp3'], { n: '级联台' }));
  p.audio.onerror(); p.audio.onerror(); p.audio.onerror(); p.audio.onerror();
  assert.strictEqual(p.spy.fail, 1);
  assert.strictEqual(p.Player.station, null);
  assert.strictEqual(p.Player.connecting, null);
  assert.strictEqual(said(p), '⚠ 全部源失败，建议点「体检」或「同步源」');
  const q = p.spy.qos[p.spy.qos.length - 1];
  assert.deepStrictEqual({ ph: q.ph, si: q.si, mode: q.mode, st: q.st }, { ph: 'exhaust', si: 0, mode: 'proxy', st: '级联台' });
  assert.deepStrictEqual(p.spy.phase[p.spy.phase.length - 1], { ph: 'idle', st: null });
  assert.deepStrictEqual(srcmem2(p.ls), {}); // 未达 playing 不写记忆
});
ok('到达 playing 写成功源记忆（键=台主 URL，值=源序号）+ qos playing 采样（trig/lat）', () => {
  const p = mkPage(); // clock 起点 1000
  const s = st(['http://a/x.m3u8', 'http://b/y.mp3'], { n: '级联台' });
  p.Player.play(s); // loadT0=1000
  p.audio.onerror(); p.audio.onerror(); // 顺延到次源 m3u8
  p.clock.tick(500);
  p.audio.fire('playing');
  const m = srcmem2(p.ls);
  assert.strictEqual(m['http://a/x.m3u8'] && m['http://a/x.m3u8'].i, 0);
  const q = p.spy.qos[p.spy.qos.length - 1];
  assert.deepStrictEqual({ ph: q.ph, trig: q.trig, si: q.si, mode: q.mode, st: q.st },
    { ph: 'playing', trig: 'play', si: 0, mode: 'hls', st: '级联台' });
  assert.strictEqual(q.lat, 500); // 建流延迟 = now - loadT0
  assert.strictEqual(p.Player.connecting, null);
  assert.strictEqual(said(p), '直播中');
});
ok('跨 Player 重载：记忆源下次点播先行（无记忆时应先试启发式 mp3）', () => {
  const ls = new FakeLS();
  const s = st(['http://a/x.m3u8', 'http://b/y.mp3'], { n: '级联台' });
  const p1 = mkPage({ ls: ls });
  p1.Player.play(s);
  p1.audio.onerror(); p1.audio.onerror();
  p1.audio.fire('playing'); // m3u8 通 → 记忆 {i:0}
  const p2 = mkPage({ ls: ls });
  p2.Player.play(s);
  assert.strictEqual(p2.hls.source, 'http://a/x.m3u8');
});
ok('HLS fatal 错误销毁实例并顺延下一 variant；非 fatal 不动作', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.m3u8'], { n: '纯H台' }));
  p.hls.handlers['error'](null, { fatal: false });
  assert.strictEqual(p.Player.curPlay, 'http://a/x.m3u8'); // 非 fatal：不级联
  assert.strictEqual(said(p), '连接中… 源1/2');
  p.hls.handlers['error'](null, { fatal: true });
  assert.strictEqual(p.Player.curPlay, enc('http://a/x.m3u8')); // fatal：顺延代理变体
  assert.ok(p.Player.hls, 'fatal 后应已建新 hls 实例');
  assert.strictEqual(p.hls.destroyed, false);
  assert.strictEqual(p.hls.source, 'http://a/x.m3u8');
});
ok('畸形源 URL：代理级 new URL 抛错按源失败顺延（不炸 play 链、UI 不卡连接中）', () => {
  const p = mkPage();
  p.Player.play(st(['not-a-url'], { n: '坏源台' })); // 直流级照常装载
  assert.strictEqual(p.audio.src, 'not-a-url');
  p.audio.onerror(); // 代理级解析失败 → onFail → 耗尽
  assert.strictEqual(p.spy.fail, 1);
  assert.strictEqual(p.Player.station, null);
  assert.strictEqual(said(p), '⚠ 全部源失败，建议点「体检」或「同步源」');
});

// [5] stalled/waiting 看门狗 ————————————————————————————————
console.log('[5] 看门狗：12s 无进展先同源重连一次，再败才顺延');
ok('playing 后 stalled → 12s → 重连当前源（curPlay/curSi 不变）+ 断流采样', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://a/y.mp3'], { n: 'W台' }));
  p.audio.fire('playing');
  p.audio.fire('stalled');
  assert.strictEqual(p.clock.pending(), 1); // 看门狗已武装
  p.clock.tick(12000);
  assert.ok(p.spy.status.indexOf('流卡住，自动恢复…') >= 0);
  assert.strictEqual(said(p), '重连当前源…');
  assert.strictEqual(p.Player.curPlay, 'http://a/x.mp3');
  assert.strictEqual(p.audio.src, 'http://a/x.mp3');
  const d = p.spy.qos.filter(function (e) { return e.ph === 'disconnect'; })[0];
  assert.deepStrictEqual({ ph: d.ph, reason: d.reason, st: d.st }, { ph: 'disconnect', reason: 'watchdog', st: 'W台' });
});
ok('重连后再 stalled → 12s → 才顺延下一 variant（retried 语义）', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://a/y.mp3'], { n: 'W台' }));
  p.audio.fire('playing');
  p.audio.fire('stalled'); p.clock.tick(12000); // 第一次：同源重连
  p.audio.fire('stalled'); p.clock.tick(12000); // 第二次：顺延
  assert.strictEqual(p.Player.curPlay, enc('http://a/x.mp3'));
});
ok('timeupdate 有实际进展即撤看门狗：12s 内无动作', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://a/y.mp3'], { n: 'W台' }));
  p.audio.fire('playing');
  p.audio.fire('stalled');
  p.audio.fire('timeupdate'); // paused=false → 撤表
  assert.strictEqual(p.clock.pending(), 0);
  p.clock.tick(12000);
  assert.strictEqual(p.spy.status.indexOf('流卡住，自动恢复…'), -1);
  assert.strictEqual(p.Player.curPlay, 'http://a/x.mp3');
});
ok('真暂停（元素 paused 且非 connecting）不武装看门狗', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://a/y.mp3'], { n: 'W台' }));
  p.audio.fire('playing');
  p.audio.pause(); // 元素级暂停（非 Player.pause）
  p.audio.fire('stalled');
  assert.strictEqual(p.clock.pending(), 0);
  p.clock.tick(12000);
  assert.strictEqual(p.Player.curPlay, 'http://a/x.mp3');
});
ok('Player.pause 撤武装中的看门狗（12s 后不强拉起播，AIbot P2-3）', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://a/y.mp3'], { n: 'W台' }));
  p.audio.fire('playing');
  p.audio.fire('stalled');
  p.Player.pause();
  assert.strictEqual(p.clock.pending(), 0);
  p.clock.tick(12000);
  assert.strictEqual(p.audio.paused, true);
});
ok('建流期 waiting 挂死同样 12s 自愈（重连当前源）', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://a/y.mp3'], { n: 'W台' })); // connecting、audio.play 已调
  p.audio.fire('waiting');
  p.clock.tick(12000);
  assert.strictEqual(said(p), '重连当前源…');
  assert.strictEqual(p.Player.curPlay, 'http://a/x.mp3');
  assert.strictEqual(p.Player.connecting.n, 'W台');
});

// [6] ended 自愈 + halt 守卫 ————————————————————————————————
console.log('[6] ended 自愈 + 有意暂停 halt 守卫（AIbot P2-1）');
ok('直播 ended：先同源重连一次（retried），重连成功后再 ended 才顺延', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://b/y.mp3'], { n: 'E台' }));
  p.audio.fire('playing');
  p.audio.fire('ended');
  assert.strictEqual(said(p), '重连当前源…');
  assert.strictEqual(p.Player.curPlay, 'http://a/x.mp3');
  p.audio.fire('playing'); // 重连成功：connecting 清、retried 保持
  p.audio.fire('ended'); // 再断：retried 已置位 → 顺延
  assert.strictEqual(p.Player.curPlay, enc('http://a/x.mp3'));
});
ok('有意暂停后 ended 不得复活播放（heldNext 搁浅，resume 接回重连）', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://b/y.mp3'], { n: 'E台' }));
  p.audio.fire('playing');
  p.Player.pause();
  p.audio.fire('ended'); // halt → 不重连不复活
  assert.strictEqual(p.Player.curPlay, 'http://a/x.mp3');
  assert.strictEqual(p.audio.paused, true);
  assert.deepStrictEqual(p.spy.phase[p.spy.phase.length - 1], { ph: 'paused', st: 'E台' }); // 无 idle 假态
  p.Player.resume(); // 接回 heldNext → 立即重连当前源
  assert.strictEqual(p.audio.paused, false);
  assert.strictEqual(p.Player.curPlay, 'http://a/x.mp3');
  assert.strictEqual(said(p), '重连当前源…');
});
ok('有意暂停后 error 级联不得复活播放（级联挡下，resume 接回）', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://b/y.mp3'], { n: 'E台' }));
  p.audio.fire('playing');
  p.Player.pause();
  p.audio.onerror(); // halt && i>0 → 挡下
  assert.strictEqual(p.Player.curPlay, 'http://a/x.mp3'); // 未顺延
  assert.strictEqual(p.audio.src, 'http://a/x.mp3');
  assert.strictEqual(p.audio.paused, true); // 未起播
  p.Player.resume();
  assert.strictEqual(p.audio.paused, false); // retryOrNext 重连起播
  assert.strictEqual(p.Player.curPlay, 'http://a/x.mp3');
});

// [7] 成功源记忆 FIFO 300 ————————————————————————————————
console.log('[7] 成功源记忆 FIFO 300（onAir 按 t 淘汰最旧，player.js:304）');
ok('第 302 条记忆入列 → 按 t 淘汰最旧两条，总量封顶 300', () => {
  const seed = {};
  for (let i = 0; i < 301; i++) seed['http://old' + i + '/x'] = { i: 0, t: i };
  const ls = new FakeLS({ 'radio.srcmem2': JSON.stringify(seed) });
  const p = mkPage({ ls: ls, t0: 10000 }); // 新记忆 t=10000 > 全部旧值 → 必留
  p.Player.play(st(['http://new/x.mp3', 'http://new/y.mp3'], { n: '新台' }));
  p.audio.fire('playing');
  const m = srcmem2(p.ls);
  assert.strictEqual(Object.keys(m).length, 300);
  assert.strictEqual(m['http://new/x.mp3'] && m['http://new/x.mp3'].i, 0);
  assert.strictEqual('http://old0/x' in m, false); // t 最旧者先出局
  assert.strictEqual('http://old1/x' in m, false);
  assert.strictEqual('http://old2/x' in m, true);
});
ok('同源重复 playing（resume/重连到达）不重复写记忆', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://a/y.mp3'], { n: '双源台' }));
  p.audio.fire('playing');
  p.audio.fire('playing');
  assert.strictEqual(srcmemSetCount(p), 1);
});
ok('单源台不写成功源记忆（仅多源台记忆）', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3'], { n: '单源台' }));
  p.audio.fire('playing');
  assert.strictEqual(p.ls.getItem('radio.srcmem2'), null);
});

// [8] forgetSrc ————————————————————————————————————————
console.log('[8] forgetSrc：清指定台记忆回启发式');
ok('playing 写入后 forgetSrc(s) → 记忆清空落盘，重播回启发式首源', () => {
  const p = mkPage();
  const s = st(['http://a/x.m3u8', 'http://b/y.mp3'], { n: 'F台' });
  p.Player.play(s);
  p.audio.onerror(); p.audio.onerror();
  p.audio.fire('playing'); // 次源 m3u8 通 → 记忆 {i:0}
  assert.strictEqual(p.Player.forgetSrc(s), true);
  assert.deepStrictEqual(srcmem2(p.ls), {});
  p.Player.play(s);
  assert.strictEqual(p.audio.src, 'http://b/y.mp3'); // 无记忆 → 启发式 mp3 先行
  assert.strictEqual(p.Player.forgetSrc(s), false); // 无记忆可清
});
ok('forgetSrc() 缺省清当前台', () => {
  const p = mkPage();
  const s = st(['http://a/x.m3u8', 'http://b/y.mp3'], { n: 'F台' });
  p.Player.play(s);
  p.audio.onerror(); p.audio.onerror();
  p.audio.fire('playing');
  assert.strictEqual(p.Player.forgetSrc(), true);
  assert.deepStrictEqual(srcmem2(p.ls), {});
});

// [9] 每台音量 ————————————————————————————————————————
console.log('[9] 每台音量：记忆优先 / 全局锚点 / 首调随行 / 0 不入记忆 / 静音切台');
ok('有记忆台点播套用 radio.volperst；无记忆台用全局 gvol（radio.vol 装载）', () => {
  const ls = new FakeLS({ 'radio.volperst': '{"http://a/x.mp3":55}', 'radio.vol': '70' });
  const p = mkPage({ ls: ls });
  p.Player.play(st(['http://a/x.mp3'], { n: 'A台' }));
  assert.strictEqual(p.audio.volume, 0.55);
  assert.strictEqual(p.spy.vol[p.spy.vol.length - 1], 0.55);
  p.Player.play(st(['http://b/y.mp3'], { n: 'B台' }));
  assert.strictEqual(p.audio.volume, 0.7); // gvol 来自 radio.vol=70
});
ok('无记忆台首调 rememberVol：写台记忆且全局锚点随行（r2 语义①）；再调不再牵动全局', () => {
  const ls = new FakeLS({ 'radio.volperst': '{"http://a/x.mp3":55}', 'radio.vol': '70' });
  const p = mkPage({ ls: ls });
  p.Player.play(st(['http://b/y.mp3'], { n: 'B台' }));
  p.Player.rememberVol(40);
  assert.strictEqual(p.ls.getItem('radio.vol'), '40'); // 首调随行（立写不攒批）
  assert.strictEqual(p.ls.getItem('radio.volperst'), '{"http://a/x.mp3":55}'); // 台记忆 300ms 攒批未落
  p.clock.tick(300);
  assert.deepStrictEqual(JSON.parse(p.ls.getItem('radio.volperst')), { 'http://a/x.mp3': 55, 'http://b/y.mp3': 40 });
  p.Player.rememberVol(50); // 非首调：只动台记忆
  assert.strictEqual(p.ls.getItem('radio.vol'), '40');
  p.clock.tick(300);
  assert.strictEqual(JSON.parse(p.ls.getItem('radio.volperst'))['http://b/y.mp3'], 50);
});
ok('0 视为静音瞬态不入记忆', () => {
  const p = mkPage();
  p.Player.play(st(['http://b/y.mp3'], { n: 'B台' }));
  p.Player.rememberVol(50);
  p.Player.rememberVol(0);
  p.clock.tick(300);
  assert.strictEqual(JSON.parse(p.ls.getItem('radio.volperst'))['http://b/y.mp3'], 50);
});
ok('无台 rememberVol 只写全局；reloadMems 先落未攒完的台记忆（AIbot P3-2 防旧值回写压掉）', () => {
  const ls = new FakeLS({ 'radio.volperst': '{"http://a/x.mp3":55}' });
  const p = mkPage({ ls: ls });
  p.Player.play(st(['http://a/x.mp3'], { n: 'A台' }));
  p.Player.rememberVol(60); // 攒批中
  p.Player.reloadMems(); // 对账重载：先落台记忆再重读
  assert.deepStrictEqual(JSON.parse(p.ls.getItem('radio.volperst')), { 'http://a/x.mp3': 60 });
  p.Player.stop();
  p.Player.rememberVol(30); // 无台 → 只写全局
  assert.strictEqual(p.ls.getItem('radio.vol'), '30');
});
ok('静音态切台保持静音（onvol(0)、不套用新台音量）；restoreVol 按台记忆→全局恢复', () => {
  const ls = new FakeLS({ 'radio.volperst': '{"http://a/x.mp3":55}', 'radio.vol': '70' });
  const p = mkPage({ ls: ls });
  p.Player.play(st(['http://a/x.mp3'], { n: 'A台' }));
  p.Player.setVolume(0);
  p.Player.play(st(['http://c/z.mp3'], { n: 'C台' })); // 无记忆台
  assert.strictEqual(p.audio.volume, 0); // vol=0 → 不套用 want
  assert.strictEqual(p.spy.vol[p.spy.vol.length - 1], 0);
  assert.strictEqual(p.Player.restoreVol(), 0.7); // C 台无记忆 → 全局
  p.Player.play(st(['http://a/x.mp3'], { n: 'A台' })); // 静音保持
  assert.strictEqual(p.audio.volume, 0);
  assert.strictEqual(p.Player.restoreVol(), 0.55); // A 台有记忆 55
});
ok('volperst 300 封顶：第 301 台挤掉最旧（插入序，player.js:121）', () => {
  const seed = {};
  for (let i = 0; i < 300; i++) seed['http://k' + i + '/x'] = 10;
  const ls = new FakeLS({ 'radio.volperst': JSON.stringify(seed) });
  const p = mkPage({ ls: ls });
  p.Player.play(st(['http://n/z.mp3'], { n: 'N台' }));
  p.Player.rememberVol(45);
  p.clock.tick(300);
  const m = JSON.parse(p.ls.getItem('radio.volperst'));
  assert.strictEqual(Object.keys(m).length, 300);
  assert.strictEqual('http://k0/x' in m, false);
  assert.strictEqual(m['http://n/z.mp3'], 45);
});
ok('跨页全局锚点：他页改 radio.vol，本页 reloadMems 后点播无记忆台用新值（AIbot P3-2）', () => {
  const ls = new FakeLS({ 'radio.vol': '70' });
  const A = mkPage({ ls: ls });
  const B = mkPage({ ls: ls }); // B 初始化时 gvol=0.7
  A.Player.stop();
  A.Player.rememberVol(25); // A 无台改全局
  B.Player.reloadMems(); // B 对账
  B.Player.play(st(['http://d/w.mp3'], { n: 'D台' }));
  assert.strictEqual(B.audio.volume, 0.25);
});

// [10] 多标签让位 ————————————————————————————————————————
console.log('[10] 多标签让位：后来者赢（BroadcastChannel \'on\'）');
ok('他页开播：在播页让位 pause+halt+connecting 清理，台位保留；未播页不受扰', () => {
  const hub = bcHub();
  const A = mkPage({ hub: hub });
  const B = mkPage({ hub: hub });
  const SA = st(['http://a/x.mp3', 'http://a/y.mp3'], { n: 'A台' });
  A.Player.play(SA);
  A.audio.fire('playing'); // 广播 'on' → B 未播（paused）不受扰
  assert.strictEqual(B.Player.station, null);
  B.Player.play(st(['http://b/z.mp3'], { n: 'B台' }));
  B.audio.fire('playing'); // B 开播广播 → A 让位
  assert.strictEqual(A.audio.paused, true);
  assert.strictEqual(A.Player.halt, true);
  assert.strictEqual(A.Player.connecting, null);
  assert.strictEqual(A.Player.station, SA); // 台位保留可续播
  A.clock.tick(0); // 让位文案 setTimeout(0)
  assert.strictEqual(said(A), '另一标签页已开播，本页已自动暂停');
});
ok('让位页后续 error 不得复活播放；resume 接回重连当前源', () => {
  const hub = bcHub();
  const A = mkPage({ hub: hub });
  const B = mkPage({ hub: hub });
  const SA = st(['http://a/x.mp3', 'http://a/y.mp3'], { n: 'A台' });
  A.Player.play(SA);
  A.audio.fire('playing');
  B.Player.play(st(['http://b/z.mp3'], { n: 'B台' }));
  B.audio.fire('playing'); // A 让位（halt 置位）
  A.audio.onerror(); // halt && i>0 → 级联挡下
  assert.strictEqual(A.audio.paused, true);
  assert.strictEqual(A.Player.curPlay, 'http://a/x.mp3');
  A.Player.resume();
  assert.strictEqual(A.audio.paused, false);
  assert.strictEqual(A.Player.curPlay, 'http://a/x.mp3');
});
ok('建流期让位：connecting 指示被清理，不残留（N3/r2 ⑤）', () => {
  const hub = bcHub();
  const C = mkPage({ hub: hub });
  const D = mkPage({ hub: hub });
  C.Player.play(st(['http://c/x.mp3', 'http://c/y.mp3'], { n: 'C台' }));
  C.audio.fire('playing');
  D.Player.play(st(['http://d/z.mp3'], { n: 'D台' })); // D 建流中（connecting、audio.play 已调）
  C.audio.fire('playing'); // C 再广播 → D 建流期让位
  assert.strictEqual(D.Player.connecting, null);
  assert.strictEqual(D.Player.halt, true);
  assert.strictEqual(D.audio.paused, true);
  assert.strictEqual(D.Player.station.n, 'D台'); // 台位保留
  D.clock.tick(0);
  assert.strictEqual(said(D), '另一标签页已开播，本页已自动暂停');
});
ok("非 'on' 消息（如 Store 的 'store' 重拉）不触发让位", () => {
  const hub = bcHub();
  const A = mkPage({ hub: hub });
  const B = mkPage({ hub: hub });
  A.Player.play(st(['http://a/x.mp3'], { n: 'A台' }));
  A.audio.fire('playing');
  const ch = new hub.FakeBC('other');
  ch.postMessage('store');
  assert.strictEqual(A.audio.paused, false); // 未让位
  assert.strictEqual(B.Player.station, null);
});

// [11] 睡眠定时 ————————————————————————————————————————
console.log('[11] 睡眠定时：30s 边界线性渐弱 → 到点暂停恢复');
ok('sleep(1)：ontick(60000) 即发；30s 边界起线性渐弱', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3'], { n: 'S台' }));
  p.Player.sleep(1);
  assert.deepStrictEqual(p.spy.tick, [60000]);
  p.clock.tick(1000);
  assert.strictEqual(p.audio.volume, 0.9); // 30s 前不渐弱
  p.clock.tick(29000); // t 越过 30s 边界：left=30000 → 恰全量
  assert.ok(approx(p.audio.volume, 0.9));
  p.clock.tick(15000); // left=15000 → 一半
  assert.ok(approx(p.audio.volume, 0.45));
});
ok('到点：暂停 + 音量按逻辑值恢复 + ontick(0) + 提示 + 清表', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3'], { n: 'S台' }));
  p.Player.sleep(1);
  p.clock.tick(45000);
  p.clock.tick(15000); // left=0
  assert.strictEqual(p.audio.paused, true);
  assert.strictEqual(p.audio.volume, 0.9);
  assert.strictEqual(p.spy.tick[p.spy.tick.length - 1], 0);
  assert.strictEqual(said(p), '😴 睡眠定时已到，已停止播放');
  assert.strictEqual(p.clock.pending(), 0);
});
ok('cancelSleep 中途取消：清表、恢复音量、ontick(0)', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3'], { n: 'S台' }));
  p.Player.sleep(1);
  p.clock.tick(45000);
  p.Player.cancelSleep();
  assert.strictEqual(p.audio.volume, 0.9);
  assert.strictEqual(p.spy.tick[p.spy.tick.length - 1], 0);
  assert.strictEqual(p.clock.pending(), 0);
});
ok('sleep(0)：只取消旧表，不新建定时', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3'], { n: 'S台' }));
  p.Player.sleep(1);
  p.Player.sleep(0);
  assert.strictEqual(p.clock.pending(), 0);
  assert.strictEqual(p.audio.volume, 0.9);
});

// [12] 曲讯不串台 ————————————————————————————————————————
console.log('[12] 曲讯不串台：curUrl 随当前装载更新，旧台事件不写回');
ok('换台后 curUrl/curPlay 立即切新台；代理形态 curUrl 还原远端', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://a/y.mp3'], { n: 'A台' }));
  assert.strictEqual(p.Player.curUrl, 'http://a/x.mp3');
  p.audio.onerror(); // A 的代理变体
  assert.strictEqual(p.Player.curUrl, 'http://a/x.mp3'); // /proxy 还原
  p.Player.play(st(['http://b/z.m3u8', 'http://b/w.mp3'], { n: 'B台' })); // 启发式 w.mp3 先行
  assert.strictEqual(p.Player.curUrl, 'http://b/w.mp3');
  assert.strictEqual(p.Player.curSi, 1);
});
ok('旧台时点的 playing/error 只归属新台：curUrl 不回写旧台、记忆只落新台', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://a/y.mp3'], { n: 'A台' }));
  p.audio.onerror(); // A 代理变体在飞
  p.Player.play(st(['http://b/z.m3u8', 'http://b/w.mp3'], { n: 'B台' }));
  p.audio.fire('playing'); // 迟到 playing → 归属 B
  assert.strictEqual(p.Player.station.n, 'B台');
  assert.strictEqual(p.Player.curUrl, 'http://b/w.mp3');
  const m = srcmem2(p.ls);
  assert.deepStrictEqual(Object.keys(m), ['http://b/z.m3u8']); // 只落 B 台主 URL
  assert.strictEqual(m['http://b/z.m3u8'].i, 1);
  p.audio.onerror(); // B 级联继续（proxy w）
  assert.strictEqual(p.Player.curUrl, 'http://b/w.mp3');
  assert.strictEqual(p.Player.curUrl.indexOf('http://a/'), -1);
});

// [13] 暂停/恢复 + 手动刷新 ————————————————————————————————
console.log('[13] 暂停/恢复语义 + refresh 回直播头');
ok('pause 置 halt/sessionPlayed=false；resume 接回且重复 playing 不重复采样', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://b/y.mp3'], { n: 'P台' }));
  p.audio.fire('playing');
  assert.strictEqual(p.sb.navigator.mediaSession.playbackState, 'playing');
  p.Player.pause();
  assert.strictEqual(p.audio.paused, true);
  assert.strictEqual(p.Player.halt, true);
  assert.strictEqual(p.sb.navigator.mediaSession.playbackState, 'paused');
  assert.strictEqual(said(p), '已暂停');
  p.Player.resume();
  assert.strictEqual(p.audio.paused, false);
  assert.strictEqual(p.sb.navigator.mediaSession.playbackState, 'playing');
  assert.strictEqual(said(p), '连接中…');
  p.audio.fire('playing'); // resume 不经 load：loadT0 未变 → 不重复采样
  assert.strictEqual(p.spy.qos.filter(function (e) { return e.ph === 'playing'; }).length, 1);
  assert.strictEqual(said(p), '直播中');
});
ok('建流期 pause：元素 pause 事件被 connecting 抑制（不发「已暂停」/paused 阶段）', () => {
  const p = mkPage();
  p.Player.play(st(['http://a/x.mp3', 'http://b/y.mp3'], { n: 'P台' })); // connecting 中
  p.Player.pause();
  assert.strictEqual(p.spy.status.indexOf('已暂停'), -1);
  assert.deepStrictEqual(p.spy.phase.filter(function (e) { return e.ph === 'paused'; }), []);
  assert.strictEqual(p.audio.paused, true);
});
ok('无台 resume/refresh：无动作不报错', () => {
  const p = mkPage();
  const n0 = p.spy.status.length;
  p.Player.stop();
  p.Player.resume();
  p.Player.refresh();
  assert.strictEqual(p.Player.station, null);
  assert.strictEqual(p.spy.status.length, n0);
});
ok('refresh：当前赢家源整链重开（prefer=curSi），暂停中直接起播，同源不重写记忆', () => {
  const p = mkPage();
  const s = st(['http://a/x.mp3', 'http://a/y.mp3'], { n: 'R台' });
  p.Player.play(s);
  p.audio.onerror(); p.audio.onerror(); // 顺延到次源 y.mp3
  p.audio.fire('playing'); // curSi=1，记忆 i=1
  p.clock.tick(1000);
  p.Player.refresh();
  assert.strictEqual(p.Player.curPlay, 'http://a/y.mp3'); // 赢家源重开
  assert.strictEqual(p.Player.curSi, 1);
  assert.strictEqual(p.audio.paused, false);
  p.audio.fire('playing');
  assert.strictEqual(srcmemSetCount(p), 1); // 同源到达：onAir 早退不重写
  const q2 = p.spy.qos[p.spy.qos.length - 1];
  assert.deepStrictEqual({ ph: q2.ph, trig: q2.trig, si: q2.si }, { ph: 'playing', trig: 'play', si: 1 });
  p.Player.pause();
  p.Player.refresh(); // 暂停中刷新 = 要听最新 → 直接起播
  assert.strictEqual(p.audio.paused, false);
});
ok('媒体键：空台 play 转 onplaylast；⏮⏭ 转 onstepfav（序列精确 [-1,1]，review#37 P3）', () => {
  const p = mkPage();
  let last = 0; const seq = [];
  p.Player.onplaylast = function () { last++; };
  p.Player.onstepfav = function (d) { seq.push(d); };
  p.Player.stop();
  p.sb.navigator.mediaSession.actions['play']();
  assert.strictEqual(last, 1);
  p.sb.navigator.mediaSession.actions['previoustrack']();
  p.sb.navigator.mediaSession.actions['nexttrack']();
  assert.deepStrictEqual(seq, [-1, 1], '调用序列必须精确（两 handler 都变 no-op 或乱序都必须炸）');
});

// [14] 杂项 ————————————————————————————————————————————
console.log('[14] 杂项：旧键失效 / Hls 不支持降级 / 只读快照 / MediaSession 元数据');
ok('旧记忆键 radio.srcmem 装载时一次性移除（键升级失效）', () => {
  const ls = new FakeLS({ 'radio.srcmem': '{"http://a/x":1}' });
  mkPage({ ls: ls });
  assert.strictEqual(ls.getItem('radio.srcmem'), null);
});
ok('Hls.isSupported=false：m3u8 直连走 audio.src 直配（含代理级），级联不受阻', () => {
  const p = mkPage({ noHls: true });
  p.Player.play(st(['http://a/x.m3u8'], { n: '纯H台' }));
  assert.strictEqual(p.audio.src, 'http://a/x.m3u8');
  p.audio.onerror();
  assert.strictEqual(p.audio.src, enc('http://a/x.m3u8')); // 代理级同为 audio.src 形态
  assert.strictEqual(p.Player.curUrl, 'http://a/x.m3u8');
});
ok('getSourceState 只读快照：连接中/到达 playing 两态字段正确', () => {
  const p = mkPage();
  const s = st(['http://a/live.m3u8', 'http://b/live.mp3'], { n: '快照台' });
  p.Player.play(s); // 启发式 → si=1 直流
  const v = p.Player.getSourceState();
  assert.strictEqual(v.station, s);
  assert.strictEqual(v.sourceIndex, 1);
  assert.strictEqual(v.variantUrl, 'http://b/live.mp3');
  assert.strictEqual(v.connecting, true);
  assert.strictEqual(v.mode, 'direct');
  assert.strictEqual(v.srcMemIndex, -1);
  p.audio.fire('playing');
  assert.strictEqual(p.Player.getSourceState().connecting, false);
});
ok('MediaSession 元数据：台名/分类/artwork 经 onlogo 注入', () => {
  const p = mkPage();
  p.Player.onlogo = function () { return 'http://logo/x.png'; };
  p.Player.play(st(['http://a/x.mp3'], { n: 'M台' }));
  const md = p.sb.navigator.mediaSession.metadata;
  assert.strictEqual(md.title, 'M台');
  assert.strictEqual(md.artist, 'VRadio · 测试分类');
  assert.strictEqual(md.artwork[0].src, 'http://logo/x.png');
});

console.log('\n' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
