/* VRadio 本地收听统计（B3-B，plan-expansion-r4 §7.2）—— 只记真实播放时间：状态机 IDLE/CONNECTING/PLAYING/
   PAUSED/FAILED 中只有 PLAYING 累加；暂停/后台无播放/连接中/失败不计；诊断成功不算收听（本模块只接 Player
   播放回调，体检通道不进来）。单调时钟（performance.now）算增量 + wall clock（Date.now）本地自然日分桶；
   系统时间回拨不出负值；跨午夜按时间比例把一个 tick 拆进两个自然日。
   sessions 口径（§7.2 双端冻结，与 Android ListenTracker/CONTRACTS.md 同文）：session = 从非 PLAYING 进入
   PLAYING 且不属于「同一台同一源」的暂停恢复——play/切台/切源/断流重连首达 PLAYING 均计一次；暂停后续播
   resume 重锚不开新 session、暂停时长不计。
   日期键严格校验（AIbot P1-1）：自然日桶键必须是历法有效的 YYYY-MM-DD（02-31、13-01、非闰年 02-29 一律
   拒绝）——lsDayKeyOk 双端同规则；lsMerge/lsTrim/装载侧全部过滤，损坏数据只影响统计自身。
   存储双形态：HTTP = /api/listenstats 服务端 ops+op.id 幂等增量合并（AIbot P1-3，对齐 /api/quality 模式：
   {baseRev,ops:[{id,day,u0,cat,ms,sess}]}——服务端 rev 唯一发号、同 op.id 去重、日桶累加；多标签同 base
   各自 POST 不同增量不互相覆盖）；GET ?rev=<n> 条件获取（AIbot 复核 P2，对齐 /api/quality：命中当前版本回
   {v,rev,notModified:true}——多标签 BC 重拉零全量传输，pull 带 baseRev）；file:// 或后端不可用降级 localStorage
   'listenstats.local'（非 radio.* 键，快照覆盖语义）。客户端未确认 ops 失败保留、同 id 重试（服务端幂等兜底，
   响应丢失重放不双计）；409 按机器可读 code 分类处置（AIbot 复核 P1）：schema 丢批留痕（不可恢复）、
   batch-limit 收窄批宽分批重试、无 code/网络/写失败保留 pending 重试——绝不静默丢合法增量。
   90 天裁剪 + 512KB 先删最早日；30s 或页面隐藏/关页 flush；写失败保内存增量下次重试，绝不阻塞播放。
   开关纪律（features.listenStats）：关 = 不消费事件、不 init 不 flush；不清已有数据。
   经典 script + CommonJS 双兼容：lsCreate 工厂（clock/save/load/idFn 可注入）供 test/listen-stats.js require；
   浏览器全局 window.ListenStats（默认浏览器时钟与网络层）。 */

const LSCAPS = { flushMs: 30000, keepDays: 90, fileCap: 512 * 1024, tickMin: 1000, opsMax: 64, pendMax: 512 };

/* ---------- 纯函数（双端同语义黄金：日桶形态/日期键校验/跨午夜拆分/裁剪口径） ---------- */
function lsDayKey(wall) { const d = new Date(wall), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } // 本地时区自然日
/* 日期键历法校验（AIbot P1-1，与 Android ListenStats.validDay 同规则）：形态 YYYY-MM-DD 且月/日真实存在
   （02-31、13-01、2026-02-29 拒；2024-02-29 闰年过）。损坏 sidecar 注入的任意 key 在此一律拦下。 */
function lsDayKeyOk(k) {
  if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
  const y = +k.slice(0, 4), m = +k.slice(5, 7), d = +k.slice(8, 10);
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= dim[m - 1];
}
function lsDayStart(wall) { const d = new Date(wall); d.setHours(0, 0, 0, 0); return d.getTime(); } // wall 所在日 00:00
/* 日桶累加：ms 毫秒入台/分类/总桶，sess 入当日 sessions（ms=0 只记 sessions 也建桶）——ops 应用与本页视图共用 */
function lsBucket(days, day, u0, cat, ms, sess) {
  const d = days[day] || (days[day] = { ms: 0, stations: {}, categories: {}, sessions: 0 });
  d.ms += ms; d.sessions += sess || 0;
  if (u0 && ms) d.stations[u0] = (d.stations[u0] || 0) + ms;
  if (cat && ms) d.categories[cat] = (d.categories[cat] || 0) + ms;
}
/* op → 日桶（单条增量事件的应用，与 server lsApplyOp / Android bucket 同语义） */
function lsApplyOp(days, op) { lsBucket(days, op.day, op.u0 || '', op.cat || '', op.ms || 0, op.sess || 0); }
/* ops 批 → 独立日桶形态（base 合流/flush 确认共用） */
function lsOpsToDays(ops) {
  const days = {};
  for (const op of ops || []) lsApplyOp(days, op);
  return days;
}
/* base + delta → 合并快照（深拷贝，不改入参；日桶 ms/sessions/台/分类各自累加——本页视图 = 服务端态 + 未确认
   ops 重放。非法日期键（AIbot P1-1）在此拦下不进任何快照） */
function lsMerge(base, delta) {
  const days = {};
  const cp = src => {
    for (const day of Object.keys(src || {})) {
      if (!lsDayKeyOk(day)) continue; // 坏键丢弃（损坏 sidecar 只影响统计自身）
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
/* 90 天裁剪 + 超体积先删最早日（ISO 日期字典序 = 时间序；非法键先清——不占裁剪名额也不进体积统计；sizeFn 注入供测试） */
function lsTrim(snap, opt = {}) {
  const keep = opt.keepDays || LSCAPS.keepDays, cap = opt.cap || LSCAPS.fileCap;
  const sizeFn = opt.sizeFn || (() => JSON.stringify(snap).length);
  const days = snap.days;
  for (const k of Object.keys(days)) if (!lsDayKeyOk(k)) delete days[k];
  const ks = Object.keys(days).sort();
  for (const k of ks.slice(0, Math.max(0, ks.length - keep))) delete days[k];
  while (Object.keys(days).length && sizeFn(snap) > cap) delete days[Object.keys(days).sort().shift()];
  return snap;
}

/* ---------- 状态机 + 会话工厂（clock/save/load/idFn 可注入；app.js 经 Player.onstate/onqos 映射驱动） ---------- */
function lsCreate(opt = {}) {
  const clock = opt.clock || { mono: () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()), wall: () => Date.now() };
  const sid = Math.random().toString(36).slice(2, 10); // op.id 前缀：跨标签页唯一（AIbot P1-3 并发不互相去重）
  let seq = 0;
  const idFn = opt.idFn || (() => sid + ':' + Date.now().toString(36) + ':' + (++seq));
  return {
    ST: 'IDLE', cur: null,                // cur = 进行中会话 {u0,cat,src,monoAt,wallAt}；null = 无会话（暂停保留、断流/切源关闭）
    base: { v: 1, days: {} },             // 已确认快照（服务端 rev 态/localStorage 拉回；日期键装载时已过滤）
    baseRev: 0,                           // 服务端观测版本（POST 成功/重拉更新，不自造）
    pend: [],                             // 未确认 ops（POST 失败保留，同 id 重试——服务端 op.id 幂等去重兜底）
    dirty: false, enabled: false, timer: 0, bc: null,
    clock, load: opt.load || null, save: opt.save || null, // 传输层注入（浏览器单例填 fetch/localStorage 实现）

    push(op) { // 增量落未确认队列（越界丢最旧：长期写失败下的内存护栏，与 quality pend 同款）
      this.pend.push(op);
      if (this.pend.length > LSCAPS.pendMax) this.pend.splice(0, this.pend.length - LSCAPS.pendMax);
      this.dirty = true;
    },
    /* 新建流到达 PLAYING（Player.onqos phase='playing'——play/switch/重连首达；resume 不经此）：结算旧 session、
       开新 session、当日 sessions+1。s = station 对象，srcUrl = 到达的源 URL。 */
    enterPlaying(s, srcUrl) {
      this.tick();
      const wall = clock.wall();
      this.cur = { u0: s && s.u ? s.u[0] : '', cat: (s && s.c) || '', src: srcUrl || '', monoAt: clock.mono(), wallAt: wall };
      if (this.cur.u0) this.push({ id: idFn(), day: lsDayKey(wall), u0: this.cur.u0, cat: this.cur.cat, ms: 0, sess: 1 });
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
    tick() { // 单调时钟增量：≥1s 才入账；回拨（负增量）重锚不产生负值。只在 PLAYING 结算——
      // 暂停期 cur 虽保留（resume 重锚资格）但周期 flush 的 tick 不得把暂停时长入账（AIbot P1-3 重写时
      // 顺带修复：与 Android ListenTracker「PAUSED 即 cur=null + pendingResume」同语义；离 PLAYING 前的
      // 最后一段由 onState 迁移分支先行结算，不漏账）
      if (!this.cur || this.ST !== 'PLAYING') return;
      const nm = clock.mono(), nw = clock.wall(), d = Math.round(nm - this.cur.monoAt);
      if (d < 0) { this.cur.monoAt = nm; this.cur.wallAt = nw; return; } // 单钟回拨：重锚
      if (d >= LSCAPS.tickMin) { this.add(this.cur, d, nw); this.cur.monoAt = nm; this.cur.wallAt = nw; }
    },
    add(cur, ms, wallNow) { // 日桶增量 op + 跨午夜拆分：按 [wallAt, wallNow] 时间比例把 ms 拆进两个自然日
      if (!cur || !cur.u0 || !(ms > 0)) return;
      const d0 = lsDayKey(cur.wallAt), d1 = lsDayKey(wallNow);
      let a = ms;
      if (d0 !== d1) {
        const span = wallNow - cur.wallAt, before = Math.min(Math.max(lsDayStart(wallNow) - cur.wallAt, 0), Math.max(span, 1));
        a = span > 0 ? Math.round(ms * before / span) : ms;
        const b = ms - a;
        if (b > 0) this.push({ id: idFn(), day: d1, u0: cur.u0, cat: cur.cat, ms: b, sess: 0 });
      }
      this.push({ id: idFn(), day: d0, u0: cur.u0, cat: cur.cat, ms: a, sess: 0 });
    },
    stop() { this.tick(); this.cur = null; this.ST = 'IDLE'; },
    view() { return lsMerge(this.base.days, lsOpsToDays(this.pend)).days; }, // 本页全量视图 = 服务端态 + 未确认 ops 重放
    snapshot() { return lsTrim(lsMerge(this.base.days, lsOpsToDays(this.pend))); }, // 落盘形态（file:// 快照用；HTTP 由服务端记账）

    async flush(keepalive) { // 增量上送（AIbot P1-3）：分批 POST {baseRev, ops}，成功才出队；失败保 pend 同 id 重试。
      this.tick(); // 服务端单批 64 条上限（契约）：积压分批送，送完即止
      if (!this.enabled || !this.pend.length || !this.save) return;
      let batchMax = LSCAPS.opsMax, transient = false; // batchMax 动态收窄：服务端上限漂移（batch-limit 409）时分批自愈
      try {
        while (this.pend.length) {
          const batch = this.pend.slice(0, batchMax);
          const r = await this.save(batch, this.baseRev, !!keepalive) || {};
          if (r.reject) { // 409 按 code 分类处置（AIbot 复核 P1，对齐 quality 409 分类方案）：
            if (r.code === 'batch-limit' && batch.length > 1) { batchMax = Math.max(1, Math.ceil(batch.length / 2)); continue; } // 超批：收窄批宽重试（增量不丢）
            if (r.code === 'schema' || r.code === 'batch-limit') {
              console.warn('[vradio] listenstats 批次被服务端拒（' + r.code + '），丢弃 ' + batch.length + ' 条增量'); // 不可恢复（schema/单条仍超限）：丢批留痕防无限重试
              this.pend = this.pend.slice(batch.length); this.dirty = this.pend.length > 0; continue;
            }
            transient = true; break; // 无 code（旧服务端/未知 409）：视为暂时失败，pend 原样保留下次 flush 重试
          }
          this.base = { v: 1, days: lsMerge(this.base.days, lsOpsToDays(batch)).days }; // 确认入账（base 只增不减）
          if (Number.isFinite(r.rev)) this.baseRev = r.rev;
          this.pend = this.pend.slice(batch.length);
          this.dirty = this.pend.length > 0;
        }
        if (!transient && this.bc) { try { this.bc.postMessage('rev'); } catch (_) {} } // 他页重拉（pend 各自保留，重放其上）
      } catch (_) {} // 网络/写失败：未确认 ops 原样保留（op.id 幂等，重试/重放不双计）
    },
    async pull() { // 多标签通知重拉 / init 装载：条件获取（带已见 rev，命中 notModified 跳过全量替换——AIbot 复核 P2）；
      // 只换 base+rev（pend 是本页未确认增量，重放其上）
      if (!this.load) return;
      try {
        const s = await this.load(this.baseRev);
        if (s && s.notModified) return; // 服务端态与本地同 rev：免全量传输（BC 重拉零放大）
        if (s && s.days && typeof s.days === 'object') {
          this.base = { v: 1, days: lsMerge(s.days, null).days }; // lsMerge 顺带过滤非法日期键（AIbot P1-1）
          if (Number.isFinite(s.rev)) this.baseRev = s.rev;
        }
      } catch (_) {}
    },
    summary(n = 7, now) { // 近 n 日合计视图（测试/后续 UI 用）：总时长/场次 + 逐日 + 电台榜
      this.tick();
      const days = this.view();
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
  load(baseRev) { // 条件获取（AIbot 复核 P2）：带已见 rev，命中回 {v,rev,notModified}；否则服务端 {v,rev,days}；
    // file:// 或后端不可用 → localStorage 降级（返回 null 即空库；旧服务端无 ?rev= 语义时忽略参数返回全量，兼容）
    if (location.protocol.startsWith('http'))
      return fetch('/api/listenstats' + (Number.isFinite(baseRev) ? '?rev=' + baseRev : '')).then(r => r.json()).then(j =>
        (j && j.v === 1 && (j.notModified || (j.days && typeof j.days === 'object'))) ? j : null)
        .catch(() => null).then(j => j || lsLocalLoad());
    return Promise.resolve(lsLocalLoad());
  },
  save(batch, baseRev, keepalive) { // HTTP：POST {baseRev, ops} 增量合并（服务端 op.id 幂等 + rev 发号）；失败抛给 flush 保 pend
    if (location.protocol.startsWith('http'))
      return fetch('/api/listenstats', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRev, ops: batch }), keepalive }).then(async r => {
        if (r.status === 409) { // 409 分类透传（AIbot 复核 P1）：code=schema|batch-limit（无 code 视为暂时失败保留 pending）
          const j = await r.json().catch(() => null);
          return { reject: true, code: (j && j.code) || '' };
        }
        const j = await r.json().catch(() => null);
        if (!j || !j.ok) throw new Error(j && j.error || '写失败');
        return j;
      });
    let cur = null; try { cur = JSON.parse(localStorage.getItem('listenstats.local') || 'null'); } catch (_) { cur = null; }
    lsLocalSave(lsTrim(lsMerge(cur && cur.days, lsOpsToDays(batch)))); // file://：批增量并进本地快照（trim 后覆盖写）
    return Promise.resolve({});
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
if (typeof module !== 'undefined') module.exports = { ListenStats, lsCreate, lsDayKey, lsDayKeyOk, lsDayStart, lsBucket, lsApplyOp, lsOpsToDays, lsMerge, lsTrim, LSCAPS };
