/* VRadio 播放引擎 —— audio/hls/播放态的唯一所有者（模块契约见 docs/review.md 十一节债务 2）。
   本文件不碰列表与渲染，UI 反馈经 onstate/onstatus/onfail 回调由 app.js 注入；
   经典 script（非 ES modules）是硬约束：file:// 下 module 加载受 CORS 限制必挂。 */
const Player = {
  audio: null, hls: null, token: 0,
  station: null,    // 当前台（引用 app 数据里的 station 对象）
  connecting: null, // 连接中/换源重试中的台（抑制 pause 改图标的闪烁）
  onstate: null,    // (full) 播放态变化回调；full=true 时 app 需整表重渲
  onstatus: null,   // (text) 底部状态栏文案
  onfail: null,     // 全部源失败的善后回调

  init(el) {
    this.audio = el;
    el.addEventListener('playing', () => { this.connecting = null; this.say('直播中'); this.emit(true); });
    el.addEventListener('play', () => this.emit(false));
    el.addEventListener('pause', () => { if (!this.connecting) { this.emit(false); if (this.station) this.say('已暂停'); } });
  },
  emit(full) { if (this.onstate) this.onstate(full); },
  say(t) { if (this.onstatus) this.onstatus(t); },
  isPaused() { return !this.audio || this.audio.paused; },
  setVolume(v) { if (this.audio) this.audio.volume = v; },

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
    const urls = s.u.flatMap(u => this.variants(u)); let i = 0;
    const my = ++this.token; // 世代令牌：快速连续点播时旧链路回调全部失效，防串台
    this.station = this.connecting = s; this.emit(true);
    const next = () => {
      if (my !== this.token) return;
      if (i >= urls.length) { // 全部源失败
        this.station = this.connecting = null; this.emit(true);
        if (this.onfail) this.onfail(); else this.say('⚠ 全部源失败，建议点「体检」或「同步源」');
        return;
      }
      this.connecting = this.station; this.emit(true); // 换源重试期间保持连接中指示
      this.say('连接中… 源' + (i + 1) + '/' + urls.length);
      this.load(urls[i++], () => { if (my === this.token) next(); });
    };
    next();
  },

  load(u, onFail) {
    this.stopHls();
    const audio = this.audio;
    const viaProxy = u.startsWith('/proxy');
    const raw = viaProxy ? decodeURIComponent(u.replace(/^\/proxy\?url=/, '')) : u;
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

  stop() {
    this.token++; this.stopHls();
    this.audio.removeAttribute('src'); this.audio.load();
    this.station = this.connecting = null; this.emit(true);
  },
  // 暂停恢复：直播流建流慢（蜻蜓 5-10s），先给连接中提示；失败由遗留 onerror 闭包接管换源
  resume() {
    this.connecting = this.station; this.emit(true); this.say('连接中…');
    this.audio.play().catch(() => {});
  },
  pause() { this.audio.pause(); },
};
