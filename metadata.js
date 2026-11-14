/* VRadio 曲讯事件管线（B3-A，plan-expansion-r4 §7.1 / 契约 contracts/metadata-event.json + fixtures/metadata-golden.json）
   —— 归一化纯函数 + 事件管线状态机，Web/Android 双端同语义（Android MetadataEvent.kt/MetadataNormalizer.kt 镜像）。
   黄金样本已冻结：normalizeMetadata(in.raw, in.ctx) 必须逐字段等于样本 out——半/全角连接号（- － — –）前后带
   空格视为 artist/track 分隔；重复台名前缀只剥一层；空白清理；confidence=parsed ⟺ artist 非空；空曲讯产出空形态。
   管线固定顺序（契约 eventOrder）：校验 identityUrl/世代 token → 清洗 → 丢弃过旧事件 → 更新当前曲讯 →
   与上一曲比较 → 必要时写 radio.songs → 更新 MediaSession/UI。source 严格枚举 icy|none（AIbot P2-5）。
   播放引擎不直接写歌曲历史或统计——历史写入由管线决策（{u,t,at}）、App 侧当前生效的 sink
   （Legacy/MetadataV2，二选一，绝不双写）执行。
   经典 script + CommonJS 双兼容：纯函数与状态机供 test/metadata.js require；浏览器全局 window.Metadata。 */

/* ---------- 纯函数：清洗与拆分（黄金样本口径） ---------- */
const META_SEP = /\s+([-－—–])\s+/; // 分隔符 = 前后带空格的半/全角连接号（四种形态任一）
const META_DEDUP_MS = 30000;       // 同曲去重窗口：短时间重复曲名不重复入史

function metaClean(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); } // 前后空 + 连续空格归一

/* ICY title 拆分：artist/track 可选字段，拆分失败 artist=''、track=title；title = 清洗后（可能剥过重复前缀）完整显示文本。
   重复台名前缀（ctx.stationName）：「台名 - 台名 - 余文」形态只剥最外一层（黄金样本 case5；单层「台名 - 歌名」是常见
   前缀形态不误删，case7）。 */
function parseIcyTitle(rawTitle, stationName) {
  const text = metaClean(rawTitle);
  if (!text) return { artist: '', track: '', title: '' };
  let t = text;
  const sn = stationName ? metaClean(stationName) : '';
  if (sn) {
    const m = t.match(META_SEP);
    if (m && m.index > 0 && t.slice(0, m.index) === sn) {
      const rest = t.slice(m.index + m[0].length);
      const m2 = rest.match(META_SEP);
      if (m2 && m2.index > 0 && rest.slice(0, m2.index) === sn) t = rest; // 前缀重复出现才剥，且只剥一层
    }
  }
  const sp = t.match(META_SEP);
  if (sp && sp.index > 0) return { artist: t.slice(0, sp.index), track: t.slice(sp.index + sp[0].length), title: t };
  return { artist: '', track: t, title: t };
}

/* 归一化事件（契约 event 形态）：raw = {title, program?, bitrateKbps?, source?, at?}，ctx = {identityUrl, stationName?}
   source 严格枚举 icy|none（AIbot P2-5，契约允许值全集）：非法/未知来源字符串一律归一为 none——不把任意
   字符串带进 MetadataEvent（历史/统计/发现侧的来源判定只认这两个值），双端同规则（Android 同步归一）。 */
const META_SOURCES = { icy: 1, none: 1 };
function normalizeMetadata(raw, ctx) {
  raw = raw || {}; ctx = ctx || {};
  const p = parseIcyTitle(raw.title, ctx.stationName);
  return {
    stationIdentityUrl: ctx.identityUrl || '',
    title: p.title,
    artist: p.artist,
    track: p.track,
    program: typeof raw.program === 'string' && raw.program ? metaClean(raw.program) : '',
    bitrateKbps: Number(raw.bitrateKbps) || 0,
    source: META_SOURCES[raw.source] ? raw.source : 'none',
    confidence: p.artist ? 'parsed' : 'stream',
    at: raw.at || Date.now(),
  };
}

/* ---------- 管线状态机（App 持有单例；now 可注入供测试） ----------
   世代语义：Player.srcToken()（play 会话世代，切台/刷新/停止递增）+ 台身份 URL 双校验——旧世代/异台事件一律
   丢弃，防旧连接曲讯串台。mpReset 由 App 在切台（playerNow 检出 songFor 变化）/刷新（doRefresh→playerNow）/
   全部源失败（onfail/playerNow 空台分支）调用：先清空旧曲讯，再接受新世代事件。
   入史去重窗口（AIbot P1-2）：dedup30s=false（metadataV2 关，Legacy 路径）= B2 前语义——换歌一律旧曲入史，
   无 30s 窗（B2 app.js 只有 pushSongHist 的连续同名护栏）；dedup30s=true（v2）= 契约 normalizeRules 的
   「短时间重复曲名不重复入史」30s 窗。App.boot 按 FEATURES.metadataV2 定格，双 sink 共用本状态机（§7.1
   「两者共享同一事件入口」），其余决策（空曲讯/同曲 noop/世代丢弃）两路径逐项一致。 */
function mpCreate(opt = {}) {
  return { gen: 0, key: '', last: null, hist: {}, dd30: opt.dedup30s !== false, now: opt.now || (() => Date.now()) }; // hist = {title: 入史时刻}（同曲 30s 窗去重，仅 v2）
}
function mpReset(p, gen, key) { p.gen = gen; p.key = key || ''; p.last = null; p.hist = {}; return { cleared: true }; }
function mpCurrent(p) { return p.last; } // 当前曲讯（null/空形态事件/有效事件；UI 展示用 title 字段）

/* 入史决策（v2）：同名曲 30s 窗口内已入史过则不再入（ICY 换歌帧抖动 A-B-A-B 不重复刷史）；窗口Map 顺手清过期；
   legacy（dd30=false）跳过窗口——换歌旧曲一律入史（B2 前 radio.songs 行为，防抖护栏在 pushSongHist 连续同名判重） */
function mpHistDecide(p, last, now) {
  if (!last || !last.title) return null;
  if (!p.dd30) return { u: p.key, t: last.title, at: last.at || now };
  const at = p.hist[last.title];
  if (at && now - at < META_DEDUP_MS) return null;
  for (const k of Object.keys(p.hist)) if (now - p.hist[k] >= META_DEDUP_MS) delete p.hist[k]; // 窗口外条目回收
  if (Object.keys(p.hist).length > 16) { // 兜底封顶（正常进不来：窗口内条目天然有限）
    const ks = Object.keys(p.hist).sort((a, b) => p.hist[a] - p.hist[b]);
    while (ks.length > 15) delete p.hist[ks.shift()];
  }
  p.hist[last.title] = now;
  return { u: p.key, t: last.title, at: last.at || now };
}

/* 事件入口（固定顺序执行，返回决策由 sink 消费）：
   {st:'stale'}            旧世代/异台事件 → 丢弃（切台后迟到事件在此死掉）
   {st:'noop'}             同曲重复 / 连续空曲讯 → 无动作（同曲去重）
   {st:'gap'}              空曲讯到达且此前有有效曲 → 当前曲讯清空、显示保留旧曲（空曲讯不覆盖有效曲名；不入史）
   {st:'new', first, hist} 换歌/首曲 → 旧曲入史（hist 可空）+ 新曲上屏（first = 本世代第一首） */
function mpAccept(p, ev) {
  if (!ev || ev.token !== p.gen || !p.key || ev.stationIdentityUrl !== p.key) return { st: 'stale' };
  const now = ev.at || p.now();
  if (!ev.title) {                                    // 空曲讯（HLS/ICY 丢失）：产出空形态、不覆盖、不入史
    const had = !!(p.last && p.last.title);
    p.last = { stationIdentityUrl: p.key, title: '', artist: '', track: '', program: ev.program || '',
      bitrateKbps: ev.bitrateKbps || 0, source: ev.source || 'none', confidence: 'stream', at: now };
    return had ? { st: 'gap' } : { st: 'noop' };
  }
  if (p.last && p.last.title === ev.title) return { st: 'noop' }; // 同曲：不重渲、不重复入史
  const hist = p.last && p.last.title ? mpHistDecide(p, p.last, now) : null; // 换歌：旧曲入史（v2 窗口去重/legacy 一律入）
  const first = !(p.last && p.last.title);
  p.last = ev;
  return { st: 'new', first, hist };
}

const Metadata = { META_SEP, META_DEDUP_MS, META_SOURCES, parseIcyTitle, normalizeMetadata, mpCreate, mpReset, mpAccept, mpCurrent };
if (typeof window !== 'undefined') window.Metadata = Metadata;
if (typeof module !== 'undefined') module.exports = Metadata;
