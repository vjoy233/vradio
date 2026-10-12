/* VRadio 播放引擎 —— audio/hls/播放态的唯一所有者（模块契约见 docs/review.md 十一节债务 2）。
   本文件不碰列表与渲染，UI 反馈经 onstate/onstatus/onfail 回调由 app.js 注入；
   经典 script（非 ES modules）是硬约束：file:// 下 module 加载受 CORS 限制必挂。 */
const Player = {
  audio: null, hls: null, token: 0,
  station: null,    // 当前台（引用 app 数据里的 station 对象）
  connecting: null, // 连接中/换源重试中的台（抑制 pause 改图标的闪烁）
  vol: 0.9,         // 逻辑音量（睡眠渐弱后恢复的基准）
  sleepId: 0, sleepEnd: 0,
  srcMem: null,   // 成功源记忆（radio.srcmem，A-1）：台主 URL → {i,t}；多源台点播从上次试通的源先行
  pctx: null,     // 本次 play 的级联上下文 {urls:[{u,si}], i, my}（世代令牌防串台）
  wd: 0,          // 静默挂起看门狗（A-1）：stalled/waiting 后 N 秒无进展按断流处理
  retried: false, // 当前源是否已「先重连一次」（stall/ended 专属；error 级联照旧直接顺延）
  curSi: -1,      // 正在试的源序号（variants 展开前的 s.u 下标；playing 时记忆）
  curPlay: '',    // 当前装载的 variant URL（stall/ended 重连当前源用）
  curUrl: '',     // 正在播的远端原始 URL（app 曲讯轮询用；/proxy 形态已还原回远端）
  onstate: null,    // (full) 播放态变化回调；full=true 时 app 需整表重渲
  onstatus: null,   // (text) 底部状态栏文案
  onfail: null,     // 全部源失败的善后回调（footer 复位）；⚠ 提示文案由本引擎 say，不依赖回调方
  ontick: null,     // (msLeft) 睡眠定时倒计时回调（0 = 已关）
  onplaylast: null, // 媒体键 play 但当前无台时，转交 app 走「续播上次收听」（与 pp 按钮同语义）

  init(el, vol0) {
    this.audio = el; this.vol = vol0; el.volume = vol0;
    el.addEventListener('playing', () => { this.connecting = null; this.stopWatchdog(); this.onAir(); this.say('直播中'); this.emit(true); });
    el.addEventListener('play', () => this.emit(false));
    el.addEventListener('pause', () => { if (!this.connecting) { this.emit(false); if (this.station) this.say('已暂停'); } });
    // 断流自愈（A-1）：error 级联已覆盖「显式失败」，这里补「静默挂起」——
    // stalled/waiting 说明暂时没数据（网络抖动/建流慢，先观察不抢），ended 说明服务端正常断连（直播不该 ended，立即自愈）
    el.addEventListener('timeupdate', () => { if (this.wd && !el.paused) this.stopWatchdog(); }); // 有实际进展即撤看门狗
    el.addEventListener('stalled', () => this.armWatchdog());
    el.addEventListener('waiting', () => this.armWatchdog());
    el.addEventListener('ended', () => { if (this.station && !this.connecting) this.retryOrNext(); });
    try { this.srcMem = JSON.parse(localStorage.getItem('radio.srcmem') || '{}'); } catch (_) { this.srcMem = {}; }
    // MediaSession（Tier 1 E1）：锁屏/蓝牙耳机/键盘媒体键控制 + 台名元数据
    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      try {
        ms.setActionHandler('play', () => this.station ? this.resume() : (this.onplaylast && this.onplaylast()));
        ms.setActionHandler('pause', () => this.pause());
        ms.setActionHandler('stop', () => this.stop());
      } catch (_) {} // 个别浏览器不支持部分 action，单独容错
    }
  },
  emit(full) { if (this.onstate) this.onstate(full); },
  say(t) { if (this.onstatus) this.onstatus(t); },
  isPaused() { return !this.audio || this.audio.paused; },
  setVolume(v) { this.vol = v; if (this.audio) this.audio.volume = v; },

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

  play(s) {
    this.stopWatchdog();
    // 成功源记忆（A-1）：上次试通的源提到最前（流地址天然漂移，省一轮必败等待）；序号对齐原始 s.u
    const order = s.u.map((_, i) => i);
    const mem = this.srcMem[s.u[0]];
    if (mem && Number.isInteger(mem.i) && mem.i > 0 && mem.i < s.u.length) { order.splice(order.indexOf(mem.i), 1); order.unshift(mem.i); }
    const urls = [];
    for (const si of order) for (const v of this.variants(s.u[si])) urls.push({ u: v, si });
    this.pctx = { urls, i: 0, my: ++this.token }; // 世代令牌：快速连续点播时旧链路回调全部失效，防串台
    this.station = this.connecting = s; this.emit(true);
    if ('mediaSession' in navigator) { // 锁屏/媒体键显示当前台（E1）
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: s.n, artist: 'VRadio · ' + s.c }); } catch (_) {}
      navigator.mediaSession.playbackState = 'playing';
    }
    this.next();
  },
  next() { // error 级联：换下一个 variant（顺序不能乱的三级策略展开序）
    const { urls, my } = this.pctx;
    if (my !== this.token) return;
    if (this.pctx.i >= urls.length) { // 全部源失败：状态栏给出结论与下一步指引，footer 由 onfail 复位
      this.station = this.connecting = null; this.stopWatchdog(); this.emit(true);
      this.say('⚠ 全部源失败，建议点「体检」或「同步源」');
      if (this.onfail) this.onfail();
      return;
    }
    const cur = urls[this.pctx.i++];
    this.curSi = cur.si; this.curPlay = cur.u; this.retried = false;
    this.connecting = this.station; this.emit(true); // 换源重试期间保持连接中指示
    this.say('连接中… 源' + this.pctx.i + '/' + urls.length);
    this.load(cur.u, () => { if (my === this.token) this.next(); });
  },

  load(u, onFail) {
    this.stopHls();
    const audio = this.audio;
    const viaProxy = u.startsWith('/proxy');
    const raw = viaProxy ? decodeURIComponent(u.replace(/^\/proxy\?url=/, '')) : u;
    this.curUrl = raw; // 正在播的远端原始 URL（曲讯轮询取 ICY 用）
    const isHls = /\.m3u8(\?|$)/.test(raw);
    // 走代理时的远端基准：相对分片要拼回远端（hls.js 会把相对分片解析到 localhost）
    const proxyBase = viaProxy ? new URL(raw).href : null;
    audio.onerror = onFail;
    if (isHls && window.Hls && Hls.isSupported()) {
      this.hls = new Hls({
        enableWorker: false,
        manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 1, fragLoadingMaxRetry: 2, // 快速失败以便切换备选源
        xhrSetup: (xhr, url) => {
          if (!proxyBase) return;
          if (url.includes('/proxy?url=')) return; // 已是代理形态
          const abs = url.startsWith(location.origin) ? new URL(url.slice(location.origin.length + 1), proxyBase).href : url;
          xhr.open('GET', '/proxy?url=' + encodeURIComponent(abs));
        }
      });
      this.hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { this.stopHls(); onFail(); } });
      this.hls.loadSource(viaProxy ? raw : u);
      this.hls.attachMedia(audio);
      audio.play().catch(() => {});
    } else {
      audio.src = u; audio.play().catch(() => {});
    }
  },
  stopHls() { if (this.hls) { this.hls.destroy(); this.hls = null; } },

  setSong(t) { // 曲讯（B-6）：锁屏/媒体键显示当前歌名；空串回退台名（app 轮询到曲名时调用）
    if (!('mediaSession' in navigator) || !this.station) return;
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: t || this.station.n, artist: 'VRadio · ' + this.station.c }); } catch (_) {}
  },

  stop() {
    this.token++; this.stopHls(); this.stopWatchdog();
    this.audio.removeAttribute('src'); this.audio.load();
    this.station = this.connecting = null; this.cancelSleep();
    this.curSi = -1; this.curPlay = this.curUrl = '';
    this.emit(true);
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
      this.say('流卡住，自动恢复…'); this.retryOrNext();
    }, 12000);
  },
  stopWatchdog() { if (this.wd) { clearTimeout(this.wd); this.wd = 0; } },
  retryOrNext() { // stall/ended 自愈：当前源瞬断大概率能自愈，先重连一次，再走 error 级联顺延
    if (!this.station || !this.pctx) return;
    const my = this.pctx.my;
    if (!this.retried) {
      this.retried = true; this.stopWatchdog();
      this.connecting = this.station; this.emit(true); this.say('重连当前源…');
      this.load(this.curPlay, () => { if (my === this.token) this.next(); });
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
    try { localStorage.setItem('radio.srcmem', JSON.stringify(this.srcMem)); } catch (_) {}
  },
  // 暂停恢复：直播流建流慢（蜻蜓 5-10s），先给连接中提示；失败由遗留 onerror 闭包接管换源
  resume() {
    if (!this.station) return; // 无台可续：媒体键空台场景已转 onplaylast，此处兜底
    this.connecting = this.station; this.emit(true); this.say('连接中…');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    this.audio.play().catch(() => {});
  },
  pause() {
    this.stopWatchdog(); // 用户主动暂停是明确意图：武装中的看门狗一并撤（否则 12s 后 retryOrNext 会把流强拉起来——AIbot P2-3）
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
