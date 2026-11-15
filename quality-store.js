/* VRadio 源质量 sidecar 客户端（B2，plan-expansion-r4 §6.1 / contracts/quality-summary.json）——
   本机共享质量数据：HTTP 形态经 /api/quality 读写 data/quality.json（op 事件合并模型，op.id 幂等去重、
   rev 服务端唯一发号）；file:// 或后端不可用降级 localStorage（键 'quality.local'，~200KB 丢最旧台）。
   **不进 radio.* 主 Store、不占 /api/store 2MB 配额、不进备份**；与 radio.health（死台/停运）永不合并，
   聚合结果不得直接改写死台隐藏条件（契约硬点）。
   存储形态分层（AIbot P1-2 修正：内层同构、包装各异，契约 files 节冻结）：本文件/服务端 data/quality.json
   = {v,rev,ops,data}（rev/ops 是 Web 服务端并发机器），Android filesDir/quality.json = {v,stations}（纯本机）；
   **共享的是台/源内层聚合形态**：每台（键 = 身份 URL s.u[0]）→
   {cf, sources:{源URL:{okCount,failCount,lastOkAt,lastFailAt,lastPlaybackAt,latSum,latN,disconnects,
   modes[],lastDiag,lastPlayFail}}}——仅聚合值 + 最近一次诊断 + 最近一次播放失败，不留完整历史。
   ⚠ 与 Android 侧冻结的四个口径（android/CONTRACTS.md B2 节留档，实现逐条对齐）：
   ① 30 天窗近似：存储无逐样本时间戳，「近 30 天成功率/样本数」= lastObservedAt 新鲜度门控
     （超 30 天无观察 → unknown）+ 全量计数器近似；
   ② 连续失败 = 台级 cf 计数器（任一源 ok 清零、fail +1，非逐源），cf≥3 一票否决进 poor；
   ③ metadata(icy|none|mixed) 由观测 modes 派生（op 事件无 icy 字段）：纯 direct → icy、纯 hls → none、
     混合 → mixed（proxy 并入非 icy 侧）；
   ④ trimOrder 下钻实现：非保护集整台优先 → 最久未访问台（同刻 identityUrl 字典序）→ 先清最大历史源的
     lastDiag/lastPlayFail（旧者先）→ 再丢该源 → 台空才整台丢；每 2 步字节复核防过冲。
   样本来源纪律：手动逐源诊断/体检通道（manual|boot|sync）= diagnostic；真实播放成功·断流·重连·切源·
   失败 = playback（play|watchdog|switch|error）——**自动体检绝不产 playback**（接线在 app.js，
   player.js 不引用本模块，经 onqos 中性回调注入）。
   经典 script + CommonJS 双兼容：纯函数（qApplyOp/qTrim/qSummary/qStability）供 server.js require
   复用（服务端 trim/合流与客户端逐字节同语义）；浏览器全局 window.QualityStore。 */

/* ---------- 冻结常量（= Android Consts.kt QUALITY_*，双端同值） ---------- */
const QCAPS = {
  fileHard: 2 * 1024 * 1024,   // quality.json 硬上限 2MB（去重记录+聚合一体受约束）
  localCap: 200 * 1024,        // file:// 降级 localStorage 封顶（~200KB 丢最旧台）
  perSt: 6,                    // 每台源聚合封顶（caps.sourcesPerStation）
  windowMs: 30 * 86400000,     // 稳定性评估窗（近 30 天；超窗无观察 = unknown）
  minSamples: 3,               // 样本 < 3 = unknown
  goodRate: 0.8, goodLat: 2500, goodCf: 3, fairRate: 0.5,
};
const Q_RE_HLS = /\.m3u8?(\?|$)/i; // 直流形态判定（与 CheckStream/getSourceState 同款）

/* ---------- 纯函数：mode 归一（AIbot P1-1，契约 opEvent.mode 必填枚举） ----------
   服务端 /api/quality 对 mode 严格枚举校验（direct|hls|proxy，Q_MODES 不动），空/非法 mode 会 409 整批
   丢样本——所有质量事件入口在此归一：缺失/非法时按「实际尝试过的 variant URL 形态」兜底（m3u8 → hls、
   其余 → direct；级联耗尽/断流等拿不到引擎 mode 的路径也必然尝试过具体 variant）；连 URL 都没有才返回
   空串（调用方丢弃该事件——契约无 unknown 值，不发不造假）。 */
function qNormMode(mode, url) {
  if (mode === 'direct' || mode === 'hls' || mode === 'proxy') return mode;
  if (!url) return '';
  return /\.m3u8?(\?|$)/i.test(url) ? 'hls' : 'direct';
}

/* ---------- 纯函数：op 事件应用（server.js qCommit 与客户端共用） ---------- */
/* op = 契约 opEvent {id,identityUrl,sourceUrl,kind,trigger,ok,latencyMs,bytes,mode,at}；
   stations = {身份URL:{cf,sources:{…}}}，就地修改。源超封顶丢样本（台为新建且已空则回收键）。 */
function qApplyOp(stations, op) {
  const id = op.identityUrl, su = op.sourceUrl;
  if (!stations[id]) stations[id] = { cf: 0, sources: {} };
  const q = stations[id];
  let s = q.sources[su];
  if (!s) {
    if (Object.keys(q.sources).length >= QCAPS.perSt) {           // caps.sourcesPerStation：超出丢样本
      if (!Object.keys(q.sources).length) delete stations[id];
      return;
    }
    s = q.sources[su] = { okCount: 0, failCount: 0, lastOkAt: 0, lastFailAt: 0, lastPlaybackAt: 0,
      latSum: 0, latN: 0, disconnects: 0, modes: [], lastDiag: null, lastPlayFail: null };
  }
  const at = +op.at || 0, lat = +op.latencyMs || 0;
  if (op.ok) {                                                     // 口径②：任一源 ok 清台级 cf
    s.okCount++; s.lastOkAt = Math.max(s.lastOkAt, at); q.cf = 0;
    if (lat > 0) { s.latSum += lat; s.latN++; }
  } else { s.failCount++; s.lastFailAt = Math.max(s.lastFailAt, at); q.cf++; }
  if (op.kind === 'playback') {
    s.lastPlaybackAt = Math.max(s.lastPlaybackAt, at);
    if (!op.ok && (op.trigger === 'error' || op.trigger === 'watchdog')) s.disconnects++;
    if (!op.ok) s.lastPlayFail = { t: op.trigger, ok: false, at, lat };
  }
  if (op.mode && !s.modes.includes(op.mode)) s.modes.push(op.mode);
  if (op.kind === 'diagnostic') s.lastDiag = { t: op.trigger, ok: !!op.ok, at, lat };
}

/* ---------- 纯函数：容量裁剪（契约 trimOrder，下钻式 = Android 拍板） ----------
   sizeFn() 返回当前序列化字节数；keep = 保护集（收藏+最近身份 URL）。 */
function qTrim(stations, keep, sizeFn, cap) {
  const kp = keep instanceof Set ? keep : new Set(keep || []);
  const lastAccess = q => { let m = 0; for (const s of Object.values(q.sources)) m = Math.max(m, s.lastOkAt, s.lastFailAt, s.lastPlaybackAt); return m; };
  const hist = s => s.okCount + s.failCount + s.disconnects;
  let checkIn = 0, guard = 0;
  while (guard++ < 100000) {
    if (checkIn <= 0) {
      if (sizeFn() <= cap || !Object.keys(stations).length) return;
      checkIn = 2;                                                 // 每 2 个淘汰步全量字节复核（不过冲）
    }
    checkIn--;
    let victim = null;
    for (const id of Object.keys(stations).sort()) {               // 同刻按 identityUrl 字典序打破平局
      const q = stations[id];
      const w = [kp.has(id) ? 1 : 0, lastAccess(q), id];
      if (!victim || w[0] < victim.w[0] || (w[0] === victim.w[0] && (w[1] < victim.w[1] ||
        (w[1] === victim.w[1] && w[2] < victim.w[2])))) victim = { id, q, w };
    }
    if (!victim) return;
    let src = null;                                                // 台内最大历史源（hist 平局按源 URL 字典序取大）
    for (const k of Object.keys(victim.q.sources)) {
      const h = hist(victim.q.sources[k]);
      if (!src || h > src.h || (h === src.h && k > src.k)) src = { k, s: victim.q.sources[k], h };
    }
    if (!src) delete stations[victim.id];
    else if (src.s.lastDiag || src.s.lastPlayFail) {
      // 最旧诊断先丢：两者都在时丢 at 较小者（平局丢 lastDiag），再轮到另一条
      const d = src.s.lastDiag, p = src.s.lastPlayFail;
      if (d && (!p || d.at <= p.at)) src.s.lastDiag = null; else src.s.lastPlayFail = null;
    } else delete victim.q.sources[src.k];                         // 诊断对已清完才丢源历史
    if (!Object.keys(victim.q.sources).length) delete stations[victim.id]; // 台空才整台丢
  }
}

/* ---------- 纯函数：稳定性四档（quality-summary.json stabilityRules 逐字，判定次序 unknown→poor→good→fair） ---------- */
function qStability(okCount, failCount, latSum, latN, cf, lastObservedAt, now) {
  const samples = okCount + failCount;
  if (samples < QCAPS.minSamples) return 'unknown';
  if (lastObservedAt > 0 && now - lastObservedAt >= QCAPS.windowMs) return 'unknown'; // 口径①：超 30 天窗无观察
  const rate = okCount / samples;
  if (rate < QCAPS.fairRate || cf >= QCAPS.goodCf) return 'poor';
  if (rate >= QCAPS.goodRate && cf < QCAPS.goodCf &&
    (latN === 0 || Math.floor(latSum / latN) < QCAPS.goodLat)) return 'good'; // 无延迟样本不拦 good
  return 'fair';
}

/* ---------- 纯函数：聚合摘要（契约 QualityAggregate 形态；无记录返回 null） ----------
   sources = 台源表（发现/详情页口径）时 sourceCount/directCount 按它算，否则按已观测源。 */
function qSummary(stations, identityUrl, sources, now) {
  const q = stations[identityUrl];
  if (!q) return null;
  let ok = 0, fail = 0, dsc = 0, lo = 0, lf = 0, lp = 0, latSum = 0, latN = 0, obsDirect = 0;
  const modes = new Set();
  for (const s of Object.values(q.sources)) {
    ok += s.okCount; fail += s.failCount; dsc += s.disconnects;
    lo = Math.max(lo, s.lastOkAt); lf = Math.max(lf, s.lastFailAt); lp = Math.max(lp, s.lastPlaybackAt);
    latSum += s.latSum; latN += s.latN;
    for (const m of (s.modes || [])) modes.add(m);
    if ((s.modes || []).includes('direct')) obsDirect++;
  }
  const list = Array.isArray(sources) && sources.length ? sources : null;
  const lastObservedAt = Math.max(lo, lf, lp);                     // 派生字段，发现侧只用它
  return {
    identityUrl,
    sourceCount: list ? list.length : Object.keys(q.sources).length,
    directCount: list ? list.filter(u => !Q_RE_HLS.test(u)).length : obsDirect,
    okCount: ok, failCount: fail,
    lastOkAt: lo, lastFailAt: lf, lastPlaybackAt: lp, lastObservedAt,
    avgLatencyMs: latN > 0 ? Math.floor(latSum / latN) : 0,
    disconnects: dsc,
    metadata: !modes.size ? 'none' : modes.has('direct') && (modes.has('hls') || modes.has('proxy')) ? 'mixed'
      : modes.has('direct') ? 'icy' : 'none',                      // 口径③：纯 direct→icy、纯 hls/proxy→none、混合→mixed
    stability: qStability(ok, fail, latSum, latN, q.cf, lastObservedAt, now),
  };
}

/* ---------- 客户端单例（HTTP op 合流 / localStorage 降级） ---------- */
const QualityStore = {
  mode: 'local',        // 'server'（HTTP 主源）| 'local'（file:// 或后端不可用降级）
  rev: 0,               // 服务端观测版本（不自造；POST 成功/重拉更新）
  stations: {},         // 聚合态（= 后端 data + 未确认 pend 本地应用）
  pend: [],             // 未确认 op 队列（POST 失败保留，重拉 rev 后重试——op.id 幂等去重由服务端兜底）
  keepHint: [],         // trim 保护集（收藏+最近身份 URL ≤64；app.js 回填，同 Android keepHint）
  bc: null, flushT: 0,
  sid: Math.random().toString(36).slice(2, 10), seq: 0,           // op.id = 随机sessionid:时间戳:序号

  init() { // App.boot 调用：多标签 BroadcastChannel('quality') 收他页通知重拉 + 关页 flush 兜底
    try {
      this.bc = new BroadcastChannel('quality');
      this.bc.onmessage = e => { if (e.data === 'rev') this.pull(); }; // 只通知「有新 rev」，不广播数据
    } catch (_) { this.bc = null; }
    const fl = () => { clearTimeout(this.flushT); this.flush(true); };
    addEventListener('beforeunload', fl);
    document.addEventListener('visibilitychange', () => { if (document.hidden) fl(); });
  },

  async load() { // App.boot 异步调用（不阻塞首屏）：HTTP 拉全量；失败/file:// 降级 localStorage
    if (location.protocol.startsWith('http')) {
      try {
        const r = await fetch('/api/quality').then(x => x.json());
        if (r && typeof r === 'object' && r.data && typeof r.data === 'object') {
          this.mode = 'server'; this.rev = r.rev || 0;
          this.stations = this.rebase(r.data);
          return;
        }
      } catch (_) {}
    }
    this.mode = 'local';
    try { const j = JSON.parse(localStorage.getItem('quality.local') || ''); if (j && j.stations) this.stations = j.stations; } catch (_) { this.stations = {}; }
  },
  rebase(base) { // 重拉后本地视图 = 服务端态 + 未确认 pend 重放（已确认的由服务端 op.id 去重，不重复计数）
    const st = JSON.parse(JSON.stringify(base || {}));
    for (const op of this.pend) qApplyOp(st, op);
    return st;
  },
  async pull() { // 多标签通知重拉：更新 rev/stations，pend 未确认则继续重试
    if (this.mode !== 'server') return;
    try {
      const r = await fetch('/api/quality').then(x => x.json());
      if (!r || typeof r.data !== 'object' || !r.data) return;
      this.rev = r.rev || this.rev;
      this.stations = this.rebase(r.data);
      if (this.pend.length) this.flush();
    } catch (_) {}
  },

  get(identityUrl) { return this.stations[identityUrl] || null; },
  summary(identityUrl, sources) { return qSummary(this.stations, identityUrl, sources, Date.now()); },

  nextId() { return this.sid + ':' + Date.now() + ':' + (++this.seq); },
  emit(op) { qApplyOp(this.stations, op); this.pend.push(op); if (this.pend.length > 256) this.pend.splice(0, this.pend.length - 256); this.save(); },
  /* 手动逐源诊断 / 体检通道样本（trigger = manual|boot|sync）。result = checkDetail 结构（at 用 checkedAt 真实采样时刻）。
     mode 经 qNormMode 归一永不为空（AIbot P1-1：诊断结果缺 mode 按源 URL 形态兜底，归不出即丢事件不造假） */
  recordDiagnostic(identityUrl, result, trigger) {
    if (!identityUrl || !result || !result.url) return;
    const mode = qNormMode(result.mode, result.url);
    if (!mode) return;
    this.emit({ id: this.nextId(), identityUrl, sourceUrl: result.url, kind: 'diagnostic',
      trigger, ok: !!result.ok, latencyMs: result.latencyMs || 0, bytes: result.bytes || 0,
      mode, at: result.checkedAt || Date.now() });
  },
  /* 真实播放样本（trigger = play|watchdog|switch|error；断流类 error/watchdog 计 disconnects——app.js 映射）。
     mode 经 qNormMode 归一永不为空（AIbot P1-1：耗尽/断流等空 mode 路径按实际尝试的 variant 形态兜底） */
  recordPlayback(identityUrl, ev) {
    if (!identityUrl || !ev || !ev.sourceUrl) return;
    const mode = qNormMode(ev.mode, ev.sourceUrl);
    if (!mode) return;
    this.emit({ id: this.nextId(), identityUrl, sourceUrl: ev.sourceUrl, kind: 'playback',
      trigger: ev.trigger, ok: !!ev.ok, latencyMs: ev.latencyMs || 0, bytes: 0,
      mode, at: ev.at || Date.now() });
  },

  sizeOf() { try { return JSON.stringify({ v: 1, stations: this.stations }).length; } catch (_) { return 0; } },
  trim(keep) { qTrim(this.stations, keep || this.keepHint, () => this.sizeOf(), QCAPS.localCap); },
  save() { // local：同步落 localStorage（trim 后写）；server：debounce 攒批 POST（探活批量/播放事件低频，500ms 足够）
    if (this.mode === 'server') { clearTimeout(this.flushT); this.flushT = setTimeout(() => this.flush(), 500); return; }
    try {
      this.trim();
      localStorage.setItem('quality.local', JSON.stringify({ v: 1, stations: this.stations }));
    } catch (_) {} // 配额满等：丢样本不影响播放
  },
  async flush(keepalive, chunk) { // POST {baseRev, ops, keep}：baseRev 只是观测版本不作覆盖条件；keep = trim 保护集 ≤64。
    // chunk = 本批条数上限（batch-limit 409 减半重试时收紧；默认/续投不超服务端单批 32 条契约上限）
    clearTimeout(this.flushT); // 积压分批送，送完即止（keepalive 请求不带分批续投）
    if (this.mode !== 'server' || !this.pend.length) return;
    const batch = this.pend.slice(0, Math.min(chunk || 32, 32));
    const body = JSON.stringify({ baseRev: this.rev, ops: batch, keep: this.keepHint.slice(0, 64) });
    try {
      const x = await fetch('/api/quality', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: !!keepalive });
      let r = null; try { r = await x.json(); } catch (_) {}       // 409 响应体尽力读（超限断连可能读不到 → 按无 code 保守处置）
      if (x.status === 409) { // 机器可读 code 分类处置（AIbot PR#26 复核 P2）：只丢不可恢复批，容量/暂时失败保留重试
        if (r && r.code === 'schema') {                            // 客户端产非法 op（不可恢复）：保守丢整批留痕，防无限重试
          console.warn('[quality] 本批 op schema 被服务端拒，丢弃 ' + batch.length + ' 条：' + (r.error || ''));
          this.pend = this.pend.slice(batch.length);
          if (this.pend.length) await this.flush();                // 后续批是另产的 op，恢复默认批宽重试
        } else if (r && r.code === 'batch-limit' && batch.length > 1) {
          await this.flush(false, Math.max(1, batch.length >> 1));  // 单批超限（可恢复）：减半分批重试；单条仍超限则停手留 pend
        }
        return;                                                    // too-large/无 code（容量/暂时）：pend 保留，下次 load/pull/record 重试
      }
      if (r && r.ok) {
        this.rev = r.rev; this.pend = this.pend.slice(batch.length);
        if (this.bc) this.bc.postMessage('rev');
        if (this.pend.length) await this.flush(false, chunk);      // 续投沿用收紧后的批大小（batch-limit 后不回弹）；await = 调用方 await flush() 即完整清仓
      }
      // 网络失败/写失败：pend 保留，下次 load/pull/record 重试（服务端 op.id 幂等兜底）
    } catch (_) {}
  },
};
if (typeof window !== 'undefined') window.QualityStore = QualityStore;
if (typeof module !== 'undefined') module.exports = { QualityStore, QCAPS, qNormMode, qApplyOp, qTrim, qSummary, qStability };
