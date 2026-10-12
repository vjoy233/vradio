/* VRadio 台标（Logo）—— 台标地址解析/缓存/按需补全的唯一所有者。不碰渲染细节（app 拼片段）、不碰播放。
   来源优先级：
   ① logos.txt（同步生成的入库数据文件）：欧美音乐分类 = Radio Browser 镜像 m3u 的 tvg-logo，按流 URL 确定性匹配
   ② localStorage 永久缓存（radio.logos）：台标极少更换，正缓存长期有效
   ③ 运行时按需解析（只解析「收藏 + 正在播」的台，控制请求量——全量 1600+ 台不抓）：
      带蜻蜓源 → m.qtfm.cn/channels/{id} 频道页封面（id 与流 URL qingting.fm/live/{id} 同空间，确定性映射）
      无蜻蜓源 → Radio Browser byurl 接口的 favicon（欧美台为主；镜像 de1 实测国内可直连，经 /proxy 稳妥）
   负缓存 7 天自动过期重试；图片本体由 <img> 直连加载（img 不受 CORS 限制，file:// 也可显示），坏图 onerror 移除。 */
const Logos = {
  LS: 'radio.logos', cap: 600, NEG: 7 * 86400000,
  file: new Map(),  // logos.txt：'分类|台名' → URL
  mem: {},          // localStorage：'分类|台名' → { u } 正缓存 | { x:1, t } 负缓存（t 时刻失败）

  load() { let c; try { c = JSON.parse(localStorage.getItem(this.LS) || '{}'); } catch (_) { c = {}; } this.mem = c && typeof c === 'object' ? c : {}; },
  save() { // 总量封顶（FIFO by t），防 localStorage 膨胀
    const keys = Object.keys(this.mem).sort((a, b) => (this.mem[a].t || 0) - (this.mem[b].t || 0));
    while (keys.length > this.cap) delete this.mem[keys.shift()];
    try { localStorage.setItem(this.LS, JSON.stringify(this.mem)); } catch (_) {}
  },
  loadFile(text) {
    this.file = new Map();
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^#/.test(line)) continue;
      const i = line.lastIndexOf(','); if (i < 0) continue; // URL 可含逗号：最后一个逗号才是分隔
      const u = line.slice(i + 1).trim();
      if (/^https?:\/\//.test(u)) this.file.set(line.slice(0, i).trim(), u);
    }
  },
  ekey(c, n) { return c + '|' + n; },
  /* 同步窥探（渲染用，绝不发请求）：STARTER 内置 l 字段 > logos.txt > localStorage */
  get(s) { return s.l || this.file.get(this.ekey(s.c, s.n)) || (this.mem[this.ekey(s.c, s.n)] || {}).u || ''; },
  /* 渲染片段：无台标返回 ''（纯文字回退）；loading=lazy 离屏不拉流量，坏图 onerror 移除 */
  img(s) {
    const u = this.get(s);
    return u ? `<img class="logo" src="${u}" alt="" loading="lazy" onerror="this.remove()">` : '';
  },
  freshNeg(s) { const e = this.mem[this.ekey(s.c, s.n)]; return !!(e && e.x && Date.now() - e.t < this.NEG); },

  /* 批量补全（收藏 + 正在播优先，去重后逐个解析）：全部落库后回调一次由 app 重渲（resolve 内部不碰 DOM） */
  async ensure(stations, done) {
    const seen = new Set(), todo = [];
    for (const s of stations || []) {
      if (!s) continue;
      const k = this.ekey(s.c, s.n);
      if (seen.has(k) || this.get(s) || this.freshNeg(s)) continue;
      seen.add(k); todo.push(s);
    }
    for (const s of todo) {
      const u = await this.resolve(s).catch(() => '');
      this.mem[this.ekey(s.c, s.n)] = u ? { u, t: Date.now() } : { x: 1, t: Date.now() };
    }
    if (todo.length) { this.save(); if (done) done(); }
  },
  async resolve(s) {
    const id = (s.u.map(u => u.match(/qingting\.fm\/live\/(\d+)/)).find(Boolean) || [])[1];
    if (id) { // 蜻蜓频道页封面：class="img" 的 pic.qtfm/qingting 图（首图即台标，alt=台名；回听页无串台问题，仍带校验重试）
      const html = await this.px('https://m.qtfm.cn/channels/' + id + '/', t => /<img class="img" src="/.test(t));
      const m = html.match(/<img class="img" src="(http[^"]+pic\.(?:qtfm|qingting)\.[^"]+)" alt="[^"]*"/);
      if (m) return m[1];
    }
    const r = await this.px('https://de1.api.radio-browser.info/json/stations/byurl?url=' + encodeURIComponent(s.u[0]), t => t.trim().startsWith('['));
    const f = (JSON.parse(r)[0] || {}).favicon;
    return /^https?:\/\//.test(f || '') ? f : '';
  },
  async px(url, ok) { // 经 /proxy 取页/接口（同源无 CORS 问题），ok(text) 校验不过重试一次（蜻蜓 SSR 偶发桩页）
    for (let i = 0; i < 2; i++) {
      const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 8000);
      try {
        const t = await fetch('/proxy?url=' + encodeURIComponent(url), { signal: ac.signal }).then(r2 => { if (!r2.ok) throw new Error(r2.status); return r2.text(); });
        if (!ok || ok(t)) return t;
      } finally { clearTimeout(timer); }
    }
    throw new Error('stub page');
  },
};
