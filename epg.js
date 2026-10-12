/* VRadio 节目单（EPG）—— 节目单数据拉取/解析/缓存/时区换算的唯一所有者。
   本模块不碰列表与渲染（app 负责），也不碰播放（player 负责）。
   数据源（①②为蜻蜓 SSR 页，经 /proxy 同源取回，2026-10 实测记录见 README）：
   ① m.qtfm.cn/channels/{id}/from/{日}000000 —— id 与流 URL qingting.fm/live/{id} 同空间（确定性映射），
      只含「今天已开播」节目（含正在播，无未来档）；app API（api.qingting.fm / api2.*）已死或需鉴权，全 404。
   ② www.qtfm.cn/search/all/{台名} → /radios/{id} —— 全天节目单；radios 与 channels 是两套 ID 空间，
      只能按台名搜索桥接，故规范化后**严格相等**才采纳 + radios 页 h1 复核，防抓错台。
   ③ epg.txt 手动节目单（可选、gitignored）：支持时区偏移与周几，覆盖 ①② 够不到的台（央广直连源/欧美台）。
   原则：有数据的台才由 app 渲染节目单入口，无数据安静忽略（fetch 失败 = 无数据）。 */
const EPG = {
  LS: 'radio.epg', cap: 400, seq: 0,
  cache: {},                          // { '分类|台名': {day, tz, src, progs, dg, prev, t} } —— progs 时间 = 电台时区当日分钟
  manual: new Map(), manualByName: new Map(), // epg.txt：「分类|台名」完整键 / 裸台名（重名时后节覆盖前节）

  load() { let c; try { c = JSON.parse(localStorage.getItem(this.LS) || '{}'); } catch (_) { c = {}; } this.cache = c && typeof c === 'object' ? c : {};
    let mx = 0; for (const k in this.cache) mx = Math.max(mx, this.cache[k].t || 0); this.seq = mx; }, // seq 接续存量最大 t：跨会话从 0 重置会让 400 封顶时的 FIFO 淘汰次序颠倒

  /* ---------- 时间工具（电台时区 = UTC 偏移分钟；一律用 UTC getter 换算，避免本机时区干扰） ---------- */
  dayStr(tz, off = 0) { const d = new Date(Date.now() + tz * 60000 + off * 86400000); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); },
  nowMin(tz) { const d = new Date(Date.now() + tz * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); },
  dow(tz) { const d = new Date(Date.now() + tz * 60000).getUTCDay(); return d === 0 ? 7 : d; }, // 周一=1…周日=7
  hm(t) { const p = t.split(':'); return +p[0] * 60 + +p[1]; },
  hhmm(min) { const v = ((min % 1440) + 1440) % 1440; return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0'); },
  tzLabel(tz) { const s = tz < 0 ? '-' : '+', a = Math.abs(tz); return s + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''); },
  tzMin(t) { if (!t) return 480; const m = String(t).match(/^([+-]?)(\d{1,2})(?::(\d{2}))?$/); if (!m) return 480; const v = +m[2] * 60 + +(m[3] || 0); return m[1] === '-' ? -v : v; },
  // 当地时间换算：返回 { t:'HH:MM', day:+1/0/-1 }（相对电台日历的日期偏移）
  localTime(min, tz) { const shift = -new Date().getTimezoneOffset() - tz; const v = min + shift; return { t: this.hhmm(v), day: Math.floor(v / 1440) }; },
  /* 当前正在播的节目：elapsed = (now - s + 1440) % 1440 < 时长（跨午夜档自然成立） */
  nowProg(ps, tz) { const n = this.nowMin(tz); return ps.find(p => p.e > p.s && (n - p.s + 1440) % 1440 < p.e - p.s) || null; },

  /* ---------- 资格判断：有手动节目单或带蜻蜓源才算「可能有节目单」，app 据此渲染入口 ---------- */
  ekey(c, n) { return c + '|' + n; },
  qtId(s) { const m = s.u.map(u => u.match(/qingting\.fm\/live\/(\d+)/)).find(Boolean); return m ? m[1] : null; },
  avail(s) {
    if (this.manual.has(this.ekey(s.c, s.n)) || this.manualByName.has(s.n)) return 'manual';
    return this.qtId(s) ? 'auto' : null;
  },
  /* 同步窥探（列表行「正在播」用）：只读缓存与手动数据，绝不发起请求 */
  peek(s) {
    const man = this.manual.get(this.ekey(s.c, s.n)) || this.manualByName.get(s.n);
    if (man) return { tz: man.tz, src: '手动', scope: man.week ? 'week' : 'daily', raw: man, progs: this.dayList(man, this.dow(man.tz)) };
    const e = this.cache[this.ekey(s.c, s.n)];
    return e && !e.miss && e.day === this.dayStr(480) ? this.info(e) : null;
  },
  info(e) {
    const loop = e.prev && e.prev === e.dg ? '每天循环' : ''; // 连续两天节目完全一致才标；「每周循环」需与上周同日对照，缓存只留今昨两天无从验证——标错不如不标
    return { progs: e.progs, tz: e.tz, src: e.src, scope: 'today', loop };
  },

  /* ---------- 拉取（仅 http 页可用；①②并行，全天优先，已开播兜底；任一步失败 = 无数据） ---------- */
  async get(s) {
    const man = this.manual.get(this.ekey(s.c, s.n)) || this.manualByName.get(s.n);
    if (man) return { tz: man.tz, src: '手动', scope: man.week ? 'week' : 'daily', raw: man, progs: this.dayList(man, this.dow(man.tz)) };
    const id = this.qtId(s); if (!id) return null;
    const today = this.dayStr(480), k = this.ekey(s.c, s.n), hit = this.cache[k];
    if (hit && hit.day === today) return hit.miss ? null : this.info(hit);
    const rs = await Promise.allSettled([this.radiosFullDay(s.n), this.channelsSoFar(id)]);
    let progs = null, src = '';
    if (rs[0].status === 'fulfilled' && rs[0].value && rs[0].value.length) { progs = rs[0].value; src = '蜻蜓 · 全天'; }
    else if (rs[1].status === 'fulfilled' && rs[1].value && rs[1].value.length) { progs = rs[1].value; src = '蜻蜓 · 已开播'; }
    if (!progs) { // 负缓存（当天）：无数据台当日不再重放整套抓取链（单台单次最坏约 10 个 /proxy 请求），与 Logos 负缓存对齐
      this.cache[k] = { day: today, miss: 1, t: ++this.seq }; this.save(); return null;
    }
    progs.sort((a, b) => a.s - b.s);
    const e = { day: today, tz: 480, src, progs, dg: this.digest(progs), t: ++this.seq };
    e.prev = hit && hit.dg ? (hit.day === this.dayStr(480, -1) ? hit.dg : hit.prev || '') : ''; // 昨日摘要留存 → 每天循环判断
    this.cache[k] = e; this.save();
    return this.info(e);
  },
  digest(ps) { return ps.map(p => p.s + '~' + p.e + p.n).join(';'); },
  save() { // 只留今昨两天 + 总量封顶（FIFO），防 localStorage 膨胀
    const t = this.dayStr(480), y = this.dayStr(480, -1);
    for (const k of Object.keys(this.cache)) { const d = this.cache[k].day; if (d !== t && d !== y) delete this.cache[k]; }
    const keys = Object.keys(this.cache).sort((a, b) => (this.cache[a].t || 0) - (this.cache[b].t || 0));
    while (keys.length > this.cap) delete this.cache[keys.shift()];
    try { localStorage.setItem(this.LS, JSON.stringify(this.cache)); } catch (_) {}
  },
  /* 取页（经 /proxy）：ok(text) 校验不过则重试一次——蜻蜓 SSR 偶发返回 no-content 桩页（实测约 1/9）；10s 超时防面板长挂 */
  async px(url, ok) {
    for (let i = 0; i < 2; i++) {
      const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 10000);
      try {
        const t = await fetch('/proxy?url=' + encodeURIComponent(url), { signal: ac.signal }).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); });
        if (!ok || ok(t)) return t;
      } finally { clearTimeout(timer); }
    }
    throw new Error('stub page');
  },

  /* ---------- ① 蜻蜓已开播页（确定性：id 来自该台自己的流 URL） ---------- */
  async channelsSoFar(id) {
    const html = await this.px('https://m.qtfm.cn/channels/' + id + '/from/' + this.dayStr(480) + '000000', t => /<h2 class="text">/.test(t));
    const ps = [], re = /<h2 class="text">([^<]+)<\/h2>[\s\S]*?<span class="time">(\d{1,2}:\d{2}) ~ (\d{1,2}:\d{2})<\/span>(?:<div class="sep"><\/div><span class="broadcasters">([^<]*)<\/span>)?/g;
    let m; while ((m = re.exec(html))) ps.push({ s: this.hm(m[2]), e: this.hm(m[3]), n: m[1].trim(), d: (m[4] || '').trim() });
    ps.forEach((p, i) => { if (i && p.e <= p.s) p.e += 1440; }); // 跨午夜档归一（23:30~00:30 → e=+1440，正在播判定才不漏）；首条不归：无前文参照
    return ps;
  },
  /* ---------- ② 蜻蜓全天（按台名搜索桥接 radios 目录；规范化严格相等 + 页面 h1 复核） ---------- */
  norm(n) { return String(n).replace(/[\s\p{P}]/gu, '').toLowerCase(); },
  norm2(n) { // 次严格：再剥 ASCII 字母词（CNR/CRI/FM 前缀），须含 CJK 且剥后 ≥2 字才参与，欧美纯英文名天然不适用
    const v = String(n).replace(/[a-zA-Z\s]/g, '').replace(/[\s\p{P}]/gu, '');
    return /[\u4e00-\u9fff]/.test(n) && v.length >= 2 ? v : '';
  },
  async radiosFullDay(name) {
    const n1 = this.norm(name), n2 = this.norm2(name);
    if (n1.length < 2 && !n2) return null;
    try {
      const sh = await this.px('https://www.qtfm.cn/search/all/' + encodeURIComponent(name), t => /content-item-root radio/.test(t));
      const cands = []; // 同名候选可能不止一个（目录里有新旧重复 id），逐个验证直到 h1 对上
      for (const b of sh.split('content-item-root radio').slice(1)) {
        const mi = b.match(/href="\/radios\/(\d+)"/), mt = b.match(/itemTitleRadio" title="([^"]+)"/);
        if (mi && mt && (this.norm(mt[1]) === n1 || (n2 && this.norm2(mt[1]) === n2)) && !cands.includes(mi[1])) cands.push(mi[1]);
      }
      for (const cid of cands.slice(0, 3)) {
        let ph;
        try { ph = await this.px('https://www.qtfm.cn/radios/' + cid + '/', t => /radio-program-row-root/.test(t)); } catch (_) { continue; }
        const h1 = ph.match(/<h1[^>]*>([^<]*)<\/h1>/);
        // 双保险：radios 页同一 id 偶发渲染别台内容（实测出现过），内容与台名对不上就弃用，退回源①
        if (!h1 || (this.norm(h1[1]) !== n1 && (!n2 || this.norm2(h1[1]) !== n2))) continue;
        const ps = [], re = /radio-program-row-root[\s\S]*?<div>([^<]+)<\/div><\/span><span class="col2">(\d{1,2}:\d{2}) - (\d{1,2}:\d{2})<\/span>/g;
        let m; while ((m = re.exec(ph))) ps.push({ s: this.hm(m[2]), e: this.hm(m[3]), n: m[1].trim(), d: '' });
        ps.forEach((p, i) => { if (i && p.e <= p.s) p.e += 1440; }); // 跨午夜档归一（同 channelsSoFar）
        if (ps.length) return ps;
      }
      return null;
    } catch (_) { return null; }
  },

  /* ---------- ③ 手动 epg.txt：节头「分类|台名,时区」（或裸「台名,时区」），节目行「[周几] HH:MM~HH:MM 名称 / 主播」 ---------- */
  loadManual(text) {
    this.manual.clear(); this.manualByName.clear();
    if (!text) return;
    let cur = null;
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^#/.test(line)) continue;
      const hi = line.lastIndexOf(','), tzS = hi >= 0 ? line.slice(hi + 1).trim() : '';
      if (/^[+-]?\d{1,2}(:\d{2})?$/.test(tzS)) { // 节头（「分类|台名,时区」/「台名,时区」）：时区段可解析才成立，含逗号的节目行落进下方节目匹配
        cur = { tz: this.tzMin(tzS), week: false, progs: [] };
        const key = line.slice(0, hi).trim();
        this.manual.set(key, cur);
        if (!key.includes('|')) this.manualByName.set(key, cur);
        continue;
      }
      if (!cur) continue;
      const m = line.match(/^(?:\[([一二三四五六日]+)\])?\s*(\d{1,2}:\d{2})\s*[~\-—]\s*(\d{1,2}:\d{2})\s+(\S.*?)(?:\s+\/\s+(.+))?$/);
      if (!m) { console.warn('[vradio] epg.txt 无法解析的行（已跳过）：' + line); continue; }
      const p = { s: this.hm(m[2]), e: this.hm(m[3]), n: m[4].trim(), d: (m[5] || '').trim() };
      if (p.e <= p.s) p.e += 1440; // 跨午夜档（23:00~01:00）归一到次日结束
      if (m[1]) { p.w = [...m[1]].map(ch => '一二三四五六日'.indexOf(ch) + 1); cur.week = true; }
      cur.progs.push(p);
    }
  },
  /* 手动周节目单按周几取当日（dow=1…7，电台时区；跨午夜档归 start 日） */
  dayList(man, dow) { return man ? man.progs.filter(p => !p.w || p.w.includes(dow)) : []; },
};
