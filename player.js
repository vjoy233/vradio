/* VRadio 播放引擎 —— audio/hls/播放态的唯一所有者（模块契约见 docs/review.md 十一节债务 2）。
   本文件不碰列表与渲染，UI 反馈经 onstate/onstatus/onfail 回调由 app.js 注入；
   经典 script（非 ES modules）是硬约束：file:// 下 module 加载受 CORS 限制必挂。 */
// 最近一次播放失败事实：仅模块内写入，不持久化、不含诊断推测。
let lastPlaybackFailure = null;
const Player = {
  audio: null, hls: null, token: 0,
  station: null,    // 当前台（引用 app 数据里的 station 对象）
  connecting: null, // 连接中/换源重试中的台（抑制 pause 改图标的闪烁）
  vol: 0.9,         // 逻辑音量（睡眠渐弱后恢复的基准；点播时按台记忆重设，见 play）
  gvol: 0.9,        // 全局默认音量（radio.vol 装载；无记忆台点播用它，「无记忆台首调」时随行更新——r2 ②语义①）
  volMem: null,     // 每台音量记忆（radio.volperst，A3/r2 ②）：台主 URL → 0-100 整数，FIFO 300（插入序，URL 键不退化数组索引）
  sleepId: 0, sleepEnd: 0,
  srcMem: null,   // 成功源记忆（radio.srcmem2，A-1）：台主 URL → {i,t}；多源台点播从上次试通的源先行。
                  // 键带 2 = 决策链改版（手动>记忆>启发式）时一次性失效旧记忆，防止存量「xmcdn 代理旧路」压住启发式
  pctx: null,     // 本次 play 的级联上下文 {urls:[{u,si}], i, my}（世代令牌防串台）
  wd: 0,          // 静默挂起看门狗（A-1）：stalled/waiting 后 N 秒无进展按断流处理
  retried: false, // 当前源是否已「先重连一次」（stall/ended 专属；error 级联照旧直接顺延）
  halt: false,    // 有意暂停标志（AIbot P2-1）：用户/让位/睡眠定时走 pause() 置位。不能拿 isPaused() 判——
                  // 媒体元素加载失败会自动置 paused=true，正常 error 级联会被误当暂停挡死
  heldNext: false, // 暂停期间 error 级联被守卫挡住的标记：resume 时接回（error 事件只发一次，等 play() 再触发是等不到的）
  curSourceUrl: '', // 当前尝试对应的原始源身份（启动时冻结，避免台对象随后变更）
  curSi: -1,      // 正在试的源序号（variants 展开前的 s.u 下标；playing 时记忆）
  curPlay: '',    // 当前装载的 variant URL（stall/ended 重连当前源用）
  curUrl: '',     // 正在播的远端原始 URL（app 曲讯轮询用；/proxy 形态已还原回远端）
  bc: null,       // BroadcastChannel('vradio')：多标签页防双播（N3/r2 ⑤）；null = 不支持/异常，静默降级各自独立
  onstate: null,    // (full) 播放态变化回调；full=true 时 app 需整表重渲
  onstatus: null,   // (text) 底部状态栏文案
  onfail: null,     // 全部源失败的善后回调（footer 复位）；⚠ 提示文案由本引擎 say，不依赖回调方
  ontick: null,     // (msLeft) 睡眠定时倒计时回调（0 = 已关）
  onvol: null,      // (v 0-1) 每台音量套用后回写滑杆 UI（A3/r2 ②）；由 app 注入，player 不碰 DOM
  onplaylast: null, // 媒体键 play 但当前无台时，转交 app 走「续播上次收听」（与 pp 按钮同语义）
  onlogo: null,     // (station) → 台标 URL（锁屏 artwork 大图，r2 ⑩）；由 app 注入 Logos.get，player 不伸手进台标模块
  onstepfav: null,  // (±1) 锁屏/媒体键 ⏮⏭ = 收藏间切台（A2/r2 ①）；由 app 注入 stepFav
  onqos: null,      // (ev) 播放质量原始转换回调（B2）：{phase:'playing'|'disconnect'|'exhaust', station, si, mode,
                    // trig?, reason?, lat}。本引擎只发状态机转换（CONNECTING→PLAYING / PLAYING→CONNECTING / 级联耗尽），
                    // 不感知 QualityStore——trigger 映射（play/switch/watchdog/error）由 app.js 完成（模块契约）
  attemptCount: 0,  // 本轮实际 load 次数（含同源重连）
  loadT0: 0,        // 当前 load() 的建流锚（playing 事件的延迟 = now - loadT0）
  sessionPlayed: false, // 本次 play() 会话内是否已到达过 playing（区分 play 首达/换源到达）
  qLastSi: -1,      // 上次到达 playing 的源序号（同台换源到达 = switch、同源重连到达 = play）
  qDown: false,     // 本次离开 playing 已发过 disconnect（防 watchdog→重连失败→级联双计一次断流）
  qEmittedT0: 0,    // 已发过 playing 事件的 load 锚（resume 不经 load，重复 playing 不采样）
  qLastMode: '',    // 最近一次装载 variant 的 mode（AIbot P1-1：curPlay 已清的耗尽善后边界兜底，onqos 的 mode 永不为空）
  onphase: null,    // (phase, station) 只读播放阶段通知（ui-redesign §6.10，P3）：phase 固定枚举
                    // 'connecting'|'playing'|'buffering'|'paused'|'idle'。不新增状态机——只在既有事件处理器末尾追加
                    // 发布，不覆盖 onstate/onqos 任何副作用；Player 只发布不反向访问 App，消费方（app.js）自行投影

  init(el, vol0) {
    this.audio = el; this.vol = this.gvol = vol0; el.volume = vol0;
    this.reloadMems(); // 每台音量/成功源记忆装载（Store 收敛层出口，方案二：http 下随 /api/store 对账后可重载）
    el.addEventListener('playing', () => {
      this.connecting = null; this.stopWatchdog(); this.onAir(); this.say('直播中'); this.emit(true);
      this.qosPlaying(); // B2 播放质量：CONNECTING→PLAYING 到达事件（app.js 映射 play/switch 样本）
      if (this.bc) this.bc.postMessage('on'); // 多标签页防双播（N3）：建流成功即广播，旧标签页让位
      this.emitPhase('playing'); // P3/§6.10 只读阶段通知（各事件处理器末尾追加，原逻辑零改动）
    });
    el.addEventListener('play', () => this.emit(false));
    el.addEventListener('pause', () => { if (!this.connecting) { this.emit(false); if (this.station) this.say('已暂停'); this.emitPhase('paused'); } }); // connecting 抑制期不发 paused（建流中的元素 pause 是加载噪音，非用户意图）
    // 断流自愈（A-1）：error 级联已覆盖「显式失败」，这里补「静默挂起」——
    // stalled/waiting 说明暂时没数据（网络抖动/建流慢，先观察不抢），ended 说明服务端正常断连（直播不该 ended，立即自愈）
    el.addEventListener('timeupdate', () => { if (this.wd && !el.paused) this.stopWatchdog(); }); // 有实际进展即撤看门狗
    el.addEventListener('stalled', () => { this.armWatchdog(); this.emitPhase('buffering'); });
    el.addEventListener('waiting', () => { this.armWatchdog(); this.emitPhase('buffering'); });
    el.addEventListener('ended', () => { // halt 守卫（三审 B3，audit-r2 P2-2 证实未落地）：暂停/让位页不得被 ended 自愈复活——retryOrNext 重连分支 audio.play() 会广播 'on' 反杀对方标签（AIbot P2-1 的 ping-pong）
      if (!this.station || this.connecting) return;
      if (this.halt) { this.heldNext = true; return; } // 暂停期上游断流：置搁浅标记，resume 走 retryOrNext 立即重连（review P3-1）——否则对已 ended 元素 play() 无效，最坏要等看门狗 12s
      this.qosDown('watchdog'); // B2：直播被服务端断连（不该 ended），先同源重连——断流样本（在播态才计）
      this.emitPhase('idle'); // 直播不该 ended：真实播放标记立即清（重连经 load 再发 connecting，切台清标记语义达成）
      this.retryOrNext();
    });
    try { localStorage.removeItem('radio.srcmem'); } catch (_) {} // 键升级一次性失效：旧记忆多记着「xmcdn 代理旧路」，留着会压住启发式直流优先
    // 多标签页防双播（N3/r2 ⑤）：后来者赢——新标签开播广播，旧标签正在播/建流中则让位暂停（非 stop，保留台位可续播）。
    // 规范保证不回发发送者自身，无需自过滤；⚠ 通道 'vradio' 已与 Store 共享（'store' 重拉消息）——必须按字面量
    // 过滤，否则同页 Store 的 bc 实例收到 'store' 时会把本页播放误暂停（AIbot P0-新，单标签拖音量即必现）
    try {
      this.bc = new BroadcastChannel('vradio');
      this.bc.onmessage = e => {
        if (e.data !== 'on') return; // 只认播放互斥消息；'store'（存储重拉）与本引擎无关
        if (this.isPaused()) return;
        this.connecting = null; // 建流期让位：清连接中指示，pause 事件才能走正常 UI 复位（否则 footer 卡在连接中）
        this.pause(); this.emit(true);
        setTimeout(() => this.say('另一标签页已开播，本页已自动暂停'), 0); // 等 pause 事件的「已暂停」先落地再覆盖成带原因的文案
      };
    } catch (_) { this.bc = null; } // 不支持/file:// 异常即静默降级
    // MediaSession（Tier 1 E1）：锁屏/蓝牙耳机/键盘媒体键控制 + 台名元数据
    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      try {
        ms.setActionHandler('play', () => this.station ? this.resume() : (this.onplaylast && this.onplaylast()));
        ms.setActionHandler('pause', () => this.pause());
        ms.setActionHandler('stop', () => this.stop());
      } catch (_) {} // 个别浏览器不支持部分 action，单独容错
      try { // ⏮⏭ = 收藏间切台（A2/r2 ①）：与 ←/→ 键同语义；独立 try——这两个 action 的支持面更窄，挂了不连累上面三个
        ms.setActionHandler('previoustrack', () => this.onstepfav && this.onstepfav(-1));
        ms.setActionHandler('nexttrack', () => this.onstepfav && this.onstepfav(1));
      } catch (_) {}
    }
  },
  emit(full) { if (this.onstate) this.onstate(full); },
  say(t) { if (this.onstatus) this.onstatus(t); },
  emitPhase(ph) { // 只读阶段发布（P3/§6.10）：try 包裹——消费方异常不得反噬播放引擎
    try { if (this.onphase) this.onphase(ph, this.station); } catch (_) {}
  },
  isPaused() { return !this.audio || this.audio.paused; },
  reloadMems() { // 记忆装载（init 与 Store 对账后重载共用）：容错读取 + 形状清洗
    if (this.volT) { clearTimeout(this.volT); delete this.volT; Store.set('radio.volperst', JSON.stringify(this.volMem)); } // 先落未攒完的音量（AIbot P3-2）：防对账重载 volMem 后，300ms 窗口内到点的旧值回写压掉本次拖动
    let vm; try { vm = JSON.parse(Store.get('radio.volperst') || '{}'); } catch (_) { vm = {}; }
    this.volMem = {};
    if (vm && typeof vm === 'object' && !Array.isArray(vm))
      for (const k of Object.keys(vm)) { const v = +vm[k]; if (/^https?:\/\//.test(k) && Number.isFinite(v) && v >= 0 && v <= 100) this.volMem[k] = Math.round(v); } // 键须 URL、值须 0-100 数值，坏形状丢弃
    try { this.srcMem = JSON.parse(Store.get('radio.srcmem2') || '{}'); } catch (_) { this.srcMem = {}; }
    const gv = Store.get('radio.vol'); const g = +gv; // 全局音量锚点随行重载（AIbot P3-2：他页改了 radio.vol，本页内存不更新则点播无记忆台仍用旧值；滑杆 UI 不动——正在播的台由台记忆主导）
    if (gv !== null && Number.isFinite(g) && g >= 0 && g <= 100) this.gvol = g / 100;
  },
  setVolume(v) { this.vol = v; if (this.audio) this.audio.volume = v; },
  rememberVol(pct) { // 调音量分流（A3/r2 ②语义①，app 滑杆 oninput 调用）：正在播 → 只写当前台记忆（台首调时全局锚点随行，
    // 锚点稳定后不再被有记忆台牵动）；无台 → 写全局。0 视为静音瞬态，同静音按钮一律不入记忆
    if (!(pct > 0)) return;
    const s = this.station;
    if (!s) { this.gvol = pct / 100; Store.set('radio.vol', String(pct)); return; }
    const fresh = this.volMem[s.u[0]] == null;
    this.volMem[s.u[0]] = Math.round(pct);
    if (fresh) { this.gvol = pct / 100; Store.set('radio.vol', String(pct)); }
    const ks = Object.keys(this.volMem);
    while (ks.length > 300) delete this.volMem[ks.shift()];
    // 写放大（audit C2）：volperst 300 键全量序列化随拖动事件频发（每秒几十次），尾随 300ms 攒批一写——
    // 崩溃最多丢最后一段音量拖动，无感损失；server 侧推流 Store.set 内部本就有同款 debounce
    clearTimeout(this.volT);
    this.volT = setTimeout(() => { delete this.volT; Store.set('radio.volperst', JSON.stringify(this.volMem)); }, 300);
  },
  restoreVol() { // 取消静音的恢复值：当前台记忆 → 全局默认 → 0.9（坑①：有记忆时取记忆而非旧全局；切台后旧 lastVol 语义废除）
    const s = this.station, pv = s && this.volMem[s.u[0]];
    return pv > 0 ? pv / 100 : this.gvol > 0 ? this.gvol : 0.9;
  },

  /* 三级播放策略（顺序不能乱，见 AGENTS.md）：
     ① mp3/AAC 直流（<audio> 原生跨域；蜻蜓 ls.qingting.fm/live/{id}.m3u8 自动换算同 id 的 lhttp 64k mp3）
     → ② m3u8 直连 hls.js → ③ 本地 /proxy 兜底（仅 http 页面可用） */
  variants(u) {
    const vs = [];
    const qt = u.match(/ls\.qingting\.fm\/live\/(\d+)\.m3u8/);
    if (qt) vs.push('http://lhttp.qingting.fm/live/' + qt[1] + '/64k.mp3');
    vs.push(u);
    if (location.protocol.startsWith('http')) vs.push('/proxy?url=' + encodeURIComponent(u));
    return vs;
  },

  /* 默认源决策链（grill 拍板 + B1 源生命周期，单次点播内从高到低）：手动指定 prefer > 成功源记忆 srcmem2
     （须在启用序内）> 人工默认顺序（s.mo 头部，仅该台存在 cfg.srcManualOrder 时压过启发式）> 静态启发式
     > 级联自愈顺延。s.mo/s.dis 由 app.applyCfg 经 SrcOrder.effective 挂上台对象（启用有效序/禁用索引），
     本引擎绝不物理重排 s.u[]；未装配的老对象（file:// 早退路径）兜底全量启发式。
     启发式零网络成本只看形态：首个 variant 是直流（mp3/aac 直达，或蜻蜓 m3u8 换算出的 64k mp3）优先——
     不经代理、低延迟、有曲讯；102 台「xmcdn 首源+蜻蜓次源」由此首播直接命中直流 */
  srcRank(u) { return /\.m3u8(\?|$)/i.test(this.variants(u)[0]) ? 1 : 0; },
  srcOrder(s) { // 启用源有效序（B1）：人工序原样使用（用户意图压过启发式）；无人工序对启用集启发式稳定排序（同级保持行序）
    if (Array.isArray(s.mo)) {
      if (!s.mo.length) return []; // 全部源已禁用
      return s.moManual ? s.mo.slice() : s.mo.slice().sort((a, b) => this.srcRank(s.u[a]) - this.srcRank(s.u[b]));
    }
    return s.u.map((_, i) => i).sort((a, b) => this.srcRank(s.u[a]) - this.srcRank(s.u[b]));
  },

  play(s, prefer) {
    this.stopWatchdog();
    this.attemptCount = 0;
    this.halt = this.heldNext = false; // 清上一轮的有意暂停/级联搁浅标记（AIbot P2-1）
    this.sessionPlayed = false; this.qDown = false; this.qEmittedT0 = 0; this.qLastSi = -1; // B2 质量会话复位
    const order = this.srcOrder(s); // 有效序基座（禁用源已剔除，序号对齐原始 s.u）
    if (!order.length) { // 全部源已手动禁用（B1 拍板）：不创建 audio/HLS/代理连接、不写 radio.health、不触发自动
      // 复活/不换身份键；停掉在播旧台（有意停播，非级联失败）+ onstatus 提示 + 可区分返回值
      this.token++; this.stopHls(); this.stopWatchdog();
      this.audio.removeAttribute('src'); this.audio.load();
      this.station = this.connecting = null;
      this.curSi = -1; this.curPlay = this.curUrl = '';
      this.emit(true);
      this.emitPhase('idle'); // 全禁源 = 无连接：真实播放标记清零（P3/§6.10）
      this.say('该台所有源都已手动禁用，请先启用一个源');
      return 'NO_ENABLED_SOURCE';
    }
    const mem = this.srcMem[s.u[0]];
    if (mem && Number.isInteger(mem.i) && mem.i >= 0 && mem.i < s.u.length && order.includes(mem.i)) { order.splice(order.indexOf(mem.i), 1); order.unshift(mem.i); } // 上次试通的源先行（流地址天然漂移，省一轮必败等待）；记忆指向禁用源则忽略顺延
    if (Number.isInteger(prefer) && prefer >= 0 && prefer < s.u.length && order.includes(prefer)) { order.splice(order.indexOf(prefer), 1); order.unshift(prefer); } // 手动选源（②）：当次点播最高优先；禁用源不可 prefer
    const urls = [];
    for (const si of order) for (const v of this.variants(s.u[si])) urls.push({ u: v, si, sourceUrl: s.u[si] });
    this.pctx = { urls, i: 0, my: ++this.token, stationUrl: s.u[0] }; // 世代令牌：快速连续点播时旧链路回调全部失效，防串台
    this.station = this.connecting = s; this.emit(true);
    // 每台音量记忆（A3/r2 ②）：有记忆用记忆、无记忆用全局默认；静音态切台保持静音（恢复值由 restoreVol 按新台取）。
    // setVolume 同步 this.vol 基准——睡眠渐弱/中途取消的恢复都锚在它上
    const pv = this.volMem[s.u[0]];
    const want = pv != null ? pv / 100 : this.gvol;
    if (this.vol > 0) this.setVolume(want);
    if (this.onvol) this.onvol(this.vol > 0 ? want : 0);
    if ('mediaSession' in navigator) { // 锁屏/媒体键显示当前台（E1）+ 台标大图（r2 ⑩）
      this.meta(s.n);
      navigator.mediaSession.playbackState = 'playing';
    }
    this.next();
  },
  next() { // error 级联：换下一个 variant（顺序不能乱的三级策略展开序）
    const { urls, my } = this.pctx;
    if (my !== this.token) return;
    this.qosDown('error'); // B2：级联换源 = 断流样本（在播态失败才计；watchdog 同一次断流已被 qDown 挡）
    if (this.pctx.i >= urls.length) { // 全部源失败：状态栏给出结论与下一步指引，footer 由 onfail 复位
      this.recordFailure('exhaust');
      if (this.onqos && this.station) this.onqos({ phase: 'exhaust', station: this.station, si: this.curSi, mode: this.qosMode() }); // B2：级联耗尽 = error 样本
      this.station = this.connecting = null; this.stopWatchdog(); this.emit(true);
      this.emitPhase('idle'); // 级联耗尽：无连接，真实播放标记清零（P3/§6.10）
      this.say('⚠ 全部源失败，建议点「体检」或「同步源」');
      if (this.onfail) this.onfail();
      return;
    }
    // 有意暂停（用户/让位/睡眠定时）后不再装载下一个源（AIbot P2-1）：否则在飞源报错 → 级联 → audio.play()
    // 会把暂停页自我复活、再广播 'on' 反杀对方（ping-pong）。i>0 区分级联续摊与 play() 首装载（后者时 i 尚为 0）。
    // 耗尽分支不受限：它不起播只善后。heldNext 记级联被挡，resume 时接回——error 事件只发一次，
    // 元素已停在错误态（且会自动置 paused），恢复时靠 play() 再触发 error 是等不到的
    if (this.halt && this.pctx.i > 0) { this.heldNext = true; return; }
    const cur = urls[this.pctx.i++];
    this.curSi = cur.si; this.curSourceUrl = cur.sourceUrl; this.curPlay = cur.u; this.retried = false;
    this.qLastMode = cur.u.startsWith('/proxy') ? 'proxy' : (/\.m3u8(\?|$)/i.test(cur.u) ? 'hls' : 'direct'); // B2：记最近尝试 variant 的 mode（耗尽事件兜底）
    this.connecting = this.station; this.emit(true); // 换源重试期间保持连接中指示
    this.say('连接中… 源' + this.pctx.i + '/' + urls.length);
    this.load(cur.u, () => { if (my === this.token) { this.recordFailure('error'); this.next(); } });
  },

  load(u, onFail) {
    this.stopHls();
    this.attemptCount++;
    const audio = this.audio;
    this.loadT0 = Date.now(); // B2 建流锚：playing 事件的延迟 = now - loadT0
    this.emitPhase('connecting'); // P3/§6.10：装载即连接中——play 请求/切台/级联顺延/重连统一入口，切台立即清真实播放标记
    const viaProxy = u.startsWith('/proxy');
    const raw = viaProxy ? decodeURIComponent(u.replace(/^\/proxy\?url=/, '')) : u;
    this.curUrl = raw; // 正在播的远端原始 URL（曲讯轮询取 ICY 用）
    const isHls = /\.m3u8(\?|$)/i.test(raw);
    // 走代理时的远端基准：相对分片要拼回远端（hls.js 会把相对分片解析到 localhost）。
    // 畸形 URL（导入列表可带过 parse 的前缀校验）在此裸解析会抛错炸掉 play 链、UI 卡「连接中」——按源失败顺延（audit-r2 P2-1 附带）
    let proxyBase = null;
    if (viaProxy) { try { proxyBase = new URL(raw).href; } catch (_) { return onFail(); } }
    audio.onerror = onFail;
    if (isHls && window.Hls && Hls.isSupported()) {
      const h = new Hls({
        enableWorker: false,
        manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 2, // 快速失败以便切换备选源
        xhrSetup: (xhr, url) => {
          if (!proxyBase) return;
          if (url.includes('/proxy?url=')) return; // 已是代理形态
          const abs = url.startsWith(location.origin) ? new URL(url.slice(location.origin.length + 1), proxyBase).href : url;
          xhr.open('GET', '/proxy?url=' + encodeURIComponent(abs));
        }
      });
      this.hls = h;
      // fatal 处理器是随实例的闭包：onFail 有世代令牌兜底，但 stopHls 无——旧实例的迟到 fatal 若无
      // 句柄核对会销毁「当前台的新实例」（review#37 P1-3 防串台不变量收口；真实 hls.js destroy 后
      // 不再发事件，此处是防御纵深，令测试可确定性验证旧实例回调无副作用）
      h.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { if (this.hls === h) this.stopHls(); onFail(); } });
      h.loadSource(viaProxy ? raw : u);
      h.attachMedia(audio);
      audio.play().catch(() => {});
    } else {
      audio.src = u; audio.play().catch(() => {});
    }
  },
  stopHls() { if (this.hls) { this.hls.destroy(); this.hls = null; } },

  meta(title) { // 锁屏元数据组装（E1 + r2 ⑩）：artwork 只给 src——台标 URL 后缀杂乱（jpg/png/无后缀），
    // sizes/type 是可选提示字段，猜错反而挡路；URL 由浏览器直接取图不经 HTML 插值，无 XSS 面
    const logo = this.onlogo && this.station ? this.onlogo(this.station) : '';
    try { navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'VRadio · ' + this.station.c, artwork: logo ? [{ src: logo }] : [] }); } catch (_) {}
  },
  setSong(t) { // 曲讯（B-6）：锁屏/媒体键显示当前歌名；空串回退台名（app 轮询到曲名时调用）。
    // 台标可能在开播后才由 Logos 运行时解析到（收藏+正在播优先补全），此处再取一次即覆盖
    if (!('mediaSession' in navigator) || !this.station) return;
    this.meta(t || this.station.n);
  },

  stop() {
    this.token++; this.stopHls(); this.stopWatchdog(); this.halt = this.heldNext = false;
    this.audio.removeAttribute('src'); this.audio.load();
    this.station = this.connecting = null; this.cancelSleep();
    this.curSi = -1; this.curPlay = this.curUrl = '';
    this.emit(true);
    this.emitPhase('idle'); // 有意停止（P3/§6.10）：真实播放标记清零
  },

  /* ---------- 断流自愈（A-1）：静默挂起看门狗 + 先重连当前源一次 ---------- */
  armWatchdog() { // stalled/waiting 只说明「暂时没数据」（网络抖动/建流慢常见），观察 12s 无进展才按断流处理。
    // 覆盖两种静默挂起：播放中卡流（!paused）与建流期连接挂死（connecting：握手后不出数据，error 永不来）
    if (!this.station || this.wd) return;
    if (this.isPaused() && !this.connecting) return; // 真暂停不掺和
    const my = this.token;
    this.wd = setTimeout(() => {
      this.wd = 0;
      if (my !== this.token || !this.station) return; // 级联已终结（全部源失败/切台）：残留看门狗不说话不动作
      if (this.isPaused()) return; // 武装后用户按了暂停：不强制起播（pause() 亦会撤表，此处双保险——AIbot P2-3）
      this.recordFailure('watchdog');
      this.say('流卡住，自动恢复…'); this.qosDown('watchdog'); this.retryOrNext(); // B2：静默挂起断流（在播态才计）
    }, 12000);
  },
  stopWatchdog() { if (this.wd) { clearTimeout(this.wd); this.wd = 0; } },
  retryOrNext() { // stall/ended 自愈：当前源瞬断大概率能自愈，先重连一次，再走 error 级联顺延
    if (!this.station || !this.pctx) return;
    const my = this.pctx.my;
    if (!this.retried) {
      this.retried = true; this.stopWatchdog();
      this.connecting = this.station; this.emit(true); this.say('重连当前源…');
      this.load(this.curPlay, () => { if (my === this.token) { this.recordFailure('error'); this.next(); } });
    } else this.next();
  },
  onAir() { // 建流成功（playing）：记忆「该台哪个源通了」（仅多源台；台主 URL 为键、FIFO 300 封顶）
    const s = this.station;
    if (!s || s.u.length < 2 || this.curSi < 0 || this.curSi >= s.u.length) return;
    const prev = this.srcMem[s.u[0]];
    if (prev && prev.i === this.curSi) return; // 未变不写（resume 也触发 playing）
    this.srcMem[s.u[0]] = { i: this.curSi, t: Date.now() };
    const ks = Object.keys(this.srcMem).sort((a, b) => this.srcMem[a].t - this.srcMem[b].t);
    while (ks.length > 300) delete this.srcMem[ks.shift()];
    Store.set('radio.srcmem2', JSON.stringify(this.srcMem));
  },
  forgetSrc(s0) { // 「恢复默认源」（②c + B1 两动作之一）：清指定台（缺省=当前台）成功源记忆并落盘；重播由调用方（app）发起——无 prefer 且记忆已空 = 默认序
    const s = s0 || this.station;
    if (!s || this.srcMem[s.u[0]] == null) return false;
    delete this.srcMem[s.u[0]];
    Store.set('radio.srcmem2', JSON.stringify(this.srcMem));
    return true;
  },
  srcToken() { return this.token; }, // 世代令牌只读口（B3 曲讯管线校验旧世代事件用；play/stop 递增，本方法不新增写路径）
  recordFailure(reason) { // 捕获当时的原始源身份和实际 variant；只保存标量，不暴露可变 station 引用
    const s = this.station;
    if (!s || this.curSi < 0 || !this.curPlay) return;
    lastPlaybackFailure = Object.freeze({ stationUrl: this.pctx.stationUrl, sourceUrl: this.curSourceUrl, sourceIndex: this.curSi,
      variantUrl: this.curPlay, mode: this.qosMode(), at: Date.now(), reason, attempts: this.attemptCount });
  },
  getFailureSnapshot() { return lastPlaybackFailure; },
  getSourceState() { // 只读快照（B1 详情中心）：app 不直接读 audio/HLS/token；mode 按 variant URL 形态判（/proxy 包裹的 m3u8 亦判 hls）
    const s = this.station, m = s ? this.srcMem[s.u[0]] : null;
    return {
      station: s, sourceIndex: this.curSi, variantUrl: this.curPlay, connecting: !!this.connecting,
      mode: this.curPlay ? (/\.m3u8(\?|$)/i.test(this.curPlay) ? 'hls' : 'direct') : '',
      srcMemIndex: m && Number.isInteger(m.i) ? m.i : -1,
    };
  },

  /* ---------- B2 播放质量原始转换（本引擎不感知 QualityStore，app.js 经 onqos 映射样本） ----------
     口径与 Android 冻结一致：CONNECTING→PLAYING = 成功（首达/同源重连 play、同台换源到达 switch）；
     PLAYING→CONNECTING = 断流（同源重连 watchdog / 级联换源 error，均计 disconnects，一次断流只计一次）；
     级联耗尽 = error。resume 不经 load 不采样；暂停态不是断流（sessionPlayed 随 pause 清零）。 */
  qosMode() { // curPlay 已清（耗尽善后/边界态）用最近尝试过的 variant mode 兜底——级联耗尽也尝试过具体 variant，
    // 契约 opEvent.mode 必填枚举不允许空（AIbot P1-1；QualityStore.qNormMode 是第二道网）
    if (this.curPlay) return this.curPlay.startsWith('/proxy') ? 'proxy' : (/\.m3u8(\?|$)/i.test(this.curPlay) ? 'hls' : 'direct');
    return this.qLastMode;
  },
  qosPlaying() {
    if (!this.onqos || !this.station) return;
    if (this.qEmittedT0 === this.loadT0) return; // resume/重复 playing：非新建流不采样
    this.qEmittedT0 = this.loadT0;
    const trig = this.sessionPlayed && this.qLastSi !== this.curSi ? 'switch' : 'play';
    this.sessionPlayed = true; this.qLastSi = this.curSi; this.qDown = false;
    this.onqos({ phase: 'playing', station: this.station, si: this.curSi, mode: this.qosMode(), trig, lat: this.loadT0 ? Date.now() - this.loadT0 : 0 });
  },
  qosDown(reason) { // PLAYING→CONNECTING 断流：在播态（sessionPlayed）且本次断流未计过（qDown）才发
    if (!this.onqos || !this.station || !this.sessionPlayed || this.qDown) return;
    this.qDown = true;
    this.onqos({ phase: 'disconnect', station: this.station, si: this.curSi, mode: this.qosMode(), reason });
  },
  refresh() { // 手动刷新回直播头（docs/plan-refresh-live.md §2）：当前赢家源整链重开——play 自带 token 作废在飞链/
    // 清 halt/heldNext/prefer 提首/台记忆音量/MediaSession/连接中指示；暂停态直接起播（刷新=要听最新的，
    // 直播流停在直播头不是稳定态）；空台无响应。不写成功源记忆（onAir 同源早退）
    const s = this.station, si = this.curSi;
    if (!s) return;
    this.play(s, si >= 0 ? si : undefined);
  },
  // 暂停恢复：直播流建流慢（蜻蜓 5-10s），先给连接中提示；失败由遗留 onerror 闭包接管换源。
  // 暂停期间级联被 next() 守卫挡住过（源已报错、error 不再发）→ retryOrNext 接回：先重连当前源一次再顺延
  resume() {
    if (!this.station) return; // 无台可续：媒体键空台场景已转 onplaylast，此处兜底
    this.halt = false;
    this.connecting = this.station; this.emit(true); this.say('连接中…');
    this.emitPhase('connecting'); // P3/§6.10：恢复起播也是建流（不经 load，需单独发）
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    if (this.heldNext) { this.heldNext = false; this.retryOrNext(); return; }
    this.audio.play().catch(() => {});
  },
  pause() {
    this.stopWatchdog(); // 用户主动暂停是明确意图：武装中的看门狗一并撤（否则 12s 后 retryOrNext 会把流强拉起来——AIbot P2-3）
    this.halt = true; // 有意暂停：挡住在飞 error 级联的续摊（AIbot P2-1）
    this.sessionPlayed = false; // B2：暂停态不是断流——之后的级联/重连不产 disconnect 样本
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    this.audio.pause();
  },

  /* 睡眠定时（Tier 1 E2）：到点前 30 秒线性渐弱，停止后音量按逻辑值恢复 */
  sleep(min) {
    this.cancelSleep();
    if (!min) return;
    this.sleepEnd = Date.now() + min * 60000;
    this.sleepId = setInterval(() => {
      const left = this.sleepEnd - Date.now();
      if (left <= 0) {
        clearInterval(this.sleepId); this.sleepId = 0;
        this.pause(); this.audio.volume = this.vol;
        if (this.ontick) this.ontick(0);
        this.say('😴 睡眠定时已到，已停止播放');
        return;
      }
      if (left <= 30000 && !this.isPaused()) this.audio.volume = Math.max(0, this.vol * left / 30000);
      if (this.ontick) this.ontick(left);
    }, 1000);
    if (this.ontick) this.ontick(min * 60000);
  },
  cancelSleep() {
    if (this.sleepId) { clearInterval(this.sleepId); this.sleepId = 0; if (this.ontick) this.ontick(0); }
    if (this.audio) this.audio.volume = this.vol; // 中途取消也恢复音量
  },
};
