/* VRadio 本地收听统计（B3-B，plan-expansion-r4 §7.2）—— 只记真实播放时间：状态机 IDLE/CONNECTING/PLAYING/
   PAUSED/FAILED 中只有 PLAYING 累加；暂停/后台无播放/连接中/失败不计；诊断成功不算收听（本模块只接 Player
   播放回调，体检通道不进来）。单调时钟（performance.now）算增量 + wall clock（Date.now）本地自然日分桶；
   系统时间回拨不出负值；跨午夜按时间比例把一个 tick 拆进两个自然日；sessions 按进入 PLAYING 次数（新建流到达，
   resume 重锚不开新 session）；切源结束旧 session、新源真进 PLAYING 才建新（同一自然日连续切源累计到同一台）。
   存储 sidecar（与 Android filesDir/listen-stats.json 同构，双端黄金一致）：{v:1, days:{'YYYY-MM-DD':{ms,stations,
   categories,sessions}}}——HTTP 形态 POST 全量快照覆盖到 /api/listenstats（服务端只存不做算术，快照语义天然
   幂等：重试重放同一快照不双计）；file:// 或后端不可用降级 localStorage 'listenstats.local'（非 radio.* 键）。
   多标签：flush 成功经 BroadcastChannel('listenstats') 通知他页重拉——base=服务端快照 + delta=本页未提交增量，
   日桶 ms 累加合并语义在客户端做（他页增量已在其快照里，本页 delta 重放其上不丢不重）。
   90 天裁剪 + 512KB 先删最早日；30s 或页面隐藏/关页 flush；写失败保内存增量下次重试，绝不阻塞播放。
   开关纪律（features.listenStats）：关 = 不消费事件、不 init 不 flush；不清已有数据。
   经典 script + CommonJS 双兼容：lsCreate 工厂（clock/save 可注入）供 test/listen-stats.js require；浏览器全局
   window.ListenStats（默认浏览器时钟与网络层）。 */

const LSCAPS = { flushMs: 30000, keepDays: 90, fileCap: 512 * 1024, tickMin: 1000 };

/* ---------- 纯函数（双端同语义黄金：日桶形态/跨午夜拆分/裁剪口径） ---------- */
function lsDayKey(wall) { const d = new Date(wall), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } // 本地时区自然日
function lsDayStart(wall) { const d = new Date(wall); d.setHours(0, 0, 0, 0); return d.getTime(); } // wall 所在日 00:00
/* 日桶累加：ms 毫秒入台/分类/总桶，sess 入当日 sessions（ms=0 只记 sessions 也建桶） */
function lsBucket(days, day, u0, cat, ms, sess) {
  const d = days[day] || (days[day] = { ms: 0, stations: {}, categories: {}, sessions: 0 });
  d.ms += ms; d.sessions += sess || 0;
  if (u0 && ms) d.stations[u0] = (d.stations[u0] || 0) + ms;
  if (cat && ms) d.categories[cat] = (d.categories[cat] || 0) + ms;
}
/* base + delta → 合并快照（深拷贝，不改入参；日桶 ms/sessions/台/分类各自累加——多标签与本页增量的汇合点） */
function lsMerge(base, delta) {
  const days = {};
  const cp = src => {
    for (const day of Object.keys(src || {})) {
      const d = src[day];
      const t = days[day] || (days[day] = { ms: 0, stations: {}, categories: {}, sessions: 0 });
      t.ms += d.ms || 0; t.sessions += d.sessions || 0;
      for (const [u, v] of Object.entries(d.stations || {})) t.stations[u] = (t.stations[u] || 0) + (v || 0);
      for (const [c, v] of Object.entries(d.categories || {})) t.categories[c] = (t.categories[c] || 0) + (v || 0);
    }
  };
  cp(base); cp(delta);
  return { v: 1, days };
}
/* 90 天裁剪 + 超体积先删最早日（ISO 日期字典序 = 时间序；sizeFn 注入供测试） */
function lsTrim(snap, opt = {}) {
  const keep = opt.keepDays || LSCAPS.keepDays, cap = opt.cap || LSCAPS.fileCap;
  const sizeFn = opt.sizeFn || (() => JSON.stringify(snap).length);
  const days = snap.days;
  const ks = Object.keys(days).sort();
  for (const k of ks.slice(0, Math.max(0, ks.length - keep))) delete days[k];
  while (Object.keys(days).length && sizeFn(snap) > cap) delete days[Object.keys(days).sort().shift()];
  return snap;
}

/* ---------- 状态机 + 会话工厂（clock/save/load 可注入；app.js 经 Player.onstate/onqos 映射驱动） ---------- */
function lsCreate(opt = {}) {
  const clock = opt.clock || { mono: () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()), wall: () => Date.now() };
  return {
    ST: 'IDLE', cur: null,                // cur = 进行中会话 {u0,cat,src,monoAt,wallAt}；null = 无会话（暂停保留、断流/切源关闭）
    base: { v: 1, days: {} },             // 已确认快照（服务端/localStorage 拉回）
    delta: { v: 1, days: {} },            // 本页未提交增量（flush 成功才清；写失败保留重试）
    dirty: false, enabled: false, timer: 0, bc: null,
    clock, load: opt.load || null, save: opt.save || null, // 传输层注入（浏览器单例填 fetch/localStorage 实现）

    /* 新建流到达 PLAYING（Player.onqos phase='playing'——play/switch/重连首达；resume 不经此）：结算旧 session、
       开新 session、当日 sessions+1。s = station 对象，srcUrl = 到达的源 URL。 */
    enterPlaying(s, srcUrl) {
      this.tick();
      const wall = clock.wall();
      this.cur = { u0: s && s.u ? s.u[0] : '', cat: (s && s.c) || '', src: srcUrl || '', monoAt: clock.mono(), wallAt: wall };
      if (this.cur.u0) { lsBucket(this.delta.days, lsDayKey(wall), this.cur.u0, this.cur.cat, 0, 1); this.dirty = true; }
    },
    /* 状态迁移（Player 派生态注入）：PAUSED→PLAYING 且会话还在 = resume 重锚（暂停时长不计、不开新 session）；
       PLAYING→其它 = 结算已播时长（暂停保留会话；连接中/失败/停机关会话——新源真进 PLAYING 才重建） */
    onState(st) {
      if (st === 'PLAYING' && this.ST === 'PAUSED' && this.cur) {
        this.cur.monoAt = clock.mono(); this.cur.wallAt = clock.wall();
      } else if (this.ST === 'PLAYING' && st !== 'PLAYING') {
        this.tick();
        if (st !== 'PAUSED') this.cur = null;
      }
      this.ST = st;
    },
    tick() { // 单调时钟增量：≥1s 才入账；回拨（负增量）重锚不产生负值
      if (!this.cur) return;
      const nm = clock.mono(), nw = clock.wall(), d = Math.round(nm - this.cur.monoAt);
      if (d < 0) { this.cur.monoAt = nm; this.cur.wallAt = nw; return; } // 单钟回拨：重锚
      if (d >= LSCAPS.tickMin) { this.add(this.cur, d, nw); this.cur.monoAt = nm; this.cur.wallAt = nw; }
    },
    add(cur, ms, wallNow) { // 日桶累加 + 跨午夜拆分：按 [wallAt, wallNow] 时间比例把 ms 拆进两个自然日
      if (!cur || !cur.u0 || !(ms > 0)) return;
      const d0 = lsDayKey(cur.wallAt), d1 = lsDayKey(wallNow);
      let a = ms;
      if (d0 !== d1) {
        const span = wallNow - cur.wallAt, before = Math.min(Math.max(lsDayStart(wallNow) - cur.wallAt, 0), Math.max(span, 1));
        a = span > 0 ? Math.round(ms * before / span) : ms;
        const b = ms - a;
        if (b > 0) lsBucket(this.delta.days, d1, cur.u0, cur.cat, b, 0);
      }
      lsBucket(this.delta.days, d0, cur.u0, cur.cat, a, 0);
      this.dirty = true;
    },
    stop() { this.tick(); this.cur = null; this.ST = 'IDLE'; },
    snapshot() { return lsTrim(lsMerge(this.base.days, this.delta.days)); }, // 当前全量视图（flush 与 summary 共用）

    async flush(keepalive) { // 落盘：快照覆盖（幂等——重试重放同一快照）；失败保 delta 下次重试，绝不阻播
      this.tick();
      if (!this.enabled || !this.dirty || !this.save) return;
      const snap = this.snapshot();
      try {
        await this.save(snap, !!keepalive);
        this.base = snap; this.delta = { v: 1, days: {} }; this.dirty = false;
        if (this.bc) { try { this.bc.postMessage('rev'); } catch (_) {} } // 他页重拉（delta 各自保留）
      } catch (_) {} // 写失败：内存增量原样保留
    },
    async pull() { // 多标签通知重拉：只换 base（delta 是本页未提交增量，重放其上）
      if (!this.load) return;
      try { const s = await this.load(); if (s && s.days && typeof s.days === 'object') this.base = { v: 1, days: s.days }; } catch (_) {}
    },
    summary(n = 7, now) { // 近 n 日合计视图（测试/后续 UI 用）：总时长/场次 + 逐日 + 电台榜
      this.tick();
      const days = lsMerge(this.base.days, this.delta.days).days;
      const ks = Object.keys(days).sort().slice(-n), nowKey = lsDayKey(now == null ? clock.wall() : now);
      const out = { ms: 0, sessions: 0, days: {}, stations: {} };
      for (const k of ks) {
        const d = days[k];
        out.ms += d.ms || 0; out.sessions += d.sessions || 0;
        out.days[k] = { ms: d.ms || 0, sessions: d.sessions || 0 };
        for (const [u, v] of Object.entries(d.stations || {})) out.stations[u] = (out.stations[u] || 0) + v;
      }
      out.todayMs = out.days[nowKey] ? out.days[nowKey].ms : 0;
      return out;
    },
  };
}

/* ---------- 浏览器单例：默认时钟 + /api/listenstats 传输层（file:// 降级 localStorage） ---------- */
const ListenStats = lsCreate({
  load() { // 服务端快照；file:// 或后端不可用 → localStorage 降级（返回 null 即空库）
    if (location.protocol.startsWith('http'))
      return fetch('/api/listenstats').then(r => r.json()).then(j => (j && j.v === 1 && j.days && typeof j.days === 'object' ? j : null))
        .catch(() => null).then(j => j || lsLocalLoad());
    return Promise.resolve(lsLocalLoad());
  },
  save(snap, keepalive) { // HTTP：POST 全量快照覆盖（服务端只存；快照语义幂等）；失败抛给 flush 保 delta
    if (location.protocol.startsWith('http'))
      return fetch('/api/listenstats', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snap), keepalive }).then(r => r.json()).then(j => { if (!j || !j.ok) throw new Error(j && j.error || '写失败'); });
    lsLocalSave(snap); return Promise.resolve();
  },
});
function lsLocalLoad() { try { const j = JSON.parse(localStorage.getItem('listenstats.local') || 'null'); return j && j.days ? j : null; } catch (_) { return null; } }
function lsLocalSave(snap) { try { localStorage.setItem('listenstats.local', JSON.stringify(snap)); } catch (_) { throw new Error('local 写失败'); } }
/* 初始化（App.boot 仅在开关开时调用）：装载快照 + 定时/隐藏/关页 flush + 多标签重拉。
   开关关 = 不 init（不消费、不 flush；已有数据不动）。 */
ListenStats.init = async function () {
  this.enabled = true;
  if (typeof document === 'undefined') return; // Node 测试环境：纯状态机驱动，无定时器
  try {
    this.bc = new BroadcastChannel('listenstats');
    this.bc.onmessage = e => { if (e.data === 'rev') this.pull(); };
  } catch (_) { this.bc = null; }
  await this.pull();
  addEventListener('beforeunload', () => this.flush(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) this.flush(true); });
  this.timer = setInterval(() => this.flush(), LSCAPS.flushMs);
};
if (typeof window !== 'undefined') window.ListenStats = ListenStats;
if (typeof module !== 'undefined') module.exports = { ListenStats, lsCreate, lsDayKey, lsDayStart, lsBucket, lsMerge, lsTrim, LSCAPS };
