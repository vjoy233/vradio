/* VRadio 台标（Logo）—— 台标地址解析/缓存/按需补全的唯一所有者。不碰渲染细节（app 拼片段）、不碰播放。
   来源优先级：
   ① logos.txt（同步生成的入库数据文件）：欧美音乐分类 = Radio Browser 镜像 m3u 的 tvg-logo，按流 URL 确定性匹配
   ② localStorage 永久缓存（radio.logos）：台标极少更换，正缓存长期有效
   ③ 运行时按需解析（只解析「收藏 + 正在播」的台，控制请求量——全量 1600+ 台不抓）：
      带蜻蜓源 → m.qtfm.cn/channels/{id} 频道页封面（id 与流 URL qingting.fm/live/{id} 同空间，确定性映射）
      无蜻蜓源 → Radio Browser byurl 接口的 favicon（欧美台为主；镜像 de1 实测国内可直连，经 /proxy 稳妥）
   负缓存 7 天自动过期重试；图片本体由 <img> 直连加载（img 不受 CORS 限制，file:// 也可显示），坏图 onerror 换首字母色块。 */
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
      // 引号/空白/尖括号 URL 直接拒收（logos.txt 来自上游镜像仓库，防属性逃逸，与 img() 转义互为纵深）
      if (/^https?:\/\//.test(u) && !/[\s"'<>]/.test(u)) this.file.set(line.slice(0, i).trim(), u);
    }
  },
  ekey(c, n) { return c + '|' + n; },
  /* 同步窥探（渲染用，绝不发请求）：STARTER 内置 l 字段 > logos.txt > localStorage */
  get(s) { return s.l || this.file.get(this.ekey(s.c, s.n)) || (this.mem[this.ekey(s.c, s.n)] || {}).u || ''; },
  /* 上游可控数据（URL/台名首字符）拼进 HTML 属性前必须转义，防属性逃逸 */
  esc(v) { return String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },
  /* 首字兜底参数：剥离 [国别] 后取首个 Unicode 字符大写（禁完整英文 wordmark，ui-redesign §4.2）。
     hue 仅供旧缓存兼容读取，兜底底色已改走 tone() 分类固定色板（§6.10：不做全色相 hash） */
  phd(s) {
    const n = s.n.replace(/\s*\[[^\]]+\]\s*$/, '');
    let h = 0; for (const c of s.c + '|' + s.n) h = (h * 31 + c.charCodeAt(0)) | 0;
    return { ch: ([...n][0] || '?').toUpperCase(), hue: ((h % 360) + 360) % 360 };
  },
  /* 分类 → 低饱和固定色 token（ui-redesign §4.2/§6.10）：按「当前分类」查表，未知/自建分类中性灰兜底，
     不做全色相 hash；data-tone 只存安全 token（固定枚举，非分类名本身），上色全在 CSS [data-tone=…]。
     表覆盖 radio.txt 全部真实分类（2026-11 取证：亚洲·港台/交通广播/华语音乐/国际新闻·谈话/文艺·生活/
     新闻资讯/欧美音乐/综合·其他/财经）；分类重命名后查不中即中性，无第三态 */
  TONES: {
    '华语音乐': 'green', '欧美音乐': 'blue', '亚洲·港台': 'teal',
    '新闻资讯': 'orange', '国际新闻·谈话': 'steel', '交通广播': 'amber',
    '文艺·生活': 'plum', '财经': 'gold', '综合·其他': 'neutral',
  },
  tone(s) { return this.TONES[s.c] || 'neutral'; },
  /* 渲染片段（P3/§6.10 统一外框）：.station-logo 外框负责尺寸/圆角/边框/底色（data-tone 上色），
     内部 img 100% contain 不裁宽图；loading=lazy 离屏不拉流量；坏图 onerror 换首字而非裸删（AIbot
     PR#9 review P2-c）——phf() 用 textContent 重建、不经 HTML 解析，注入面不扩大 */
  /* 外框唯一出口（AIbot PR#31 review P1）：.station-logo 外框只在 wrap() 拼一层，img/visual 复用，
     不得各自再包——嵌套双框会让 border/底色/尺寸规则叠加 */
  wrap(s, inner) { return `<span class="station-logo" data-tone="${this.tone(s)}" aria-hidden="true">${inner}</span>`; },
  img(s) {
    const u = this.get(s);
    if (!u) return '';
    const d = this.phd(s);
    return this.wrap(s, `<img class="logo" src="${this.esc(u)}" alt="" loading="lazy" data-ch="${this.esc(d.ch)}" onerror="Logos.phf(this)">`);
  },
  /* 坏图 onerror：img 就地换首字兜底（aria-hidden 纯装饰）——只换内层节点，外框与 data-tone 底色不动，
     与无台标分支同框同色（色全由外框 CSS 给，内层不再带 inline 背景） */
  phf(el) {
    const sp = document.createElement('span');
    sp.className = 'logo ph'; sp.setAttribute('aria-hidden', 'true');
    sp.textContent = el.dataset.ch || '?';
    el.replaceWith(sp);
  },
  /* 渲染入口（UI 审计 P2-3，owner 拍板）：有台标出图，无台标出首字兜底——有图无图同一外框同一 tone 底色，
     卡片节奏统一；有图直接用 img() 产物（外框已在内、不再包第二层，AIbot PR#31 review P1） */
  visual(s) {
    const d = this.phd(s);
    return this.img(s) || this.wrap(s, `<span class="logo ph">${this.esc(d.ch)}</span>`);
  },
  freshNeg(s) { const e = this.mem[this.ekey(s.c, s.n)]; return !!(e && e.x && Date.now() - e.t < this.NEG); },

  busy: new Set(), // 在飞键集合：logosEnsure 可由收藏/播放/启动/数据文件加载多路并发触发，同一台不重复解析
  /* 批量补全（收藏 + 正在播优先，去重 + 在飞去重后 3 路并行）：全部落库后回调一次由 app 重渲（resolve 内部不碰 DOM） */
  async ensure(stations, done) {
    const seen = new Set(), todo = [];
    for (const s of stations || []) {
      if (!s) continue;
      const k = this.ekey(s.c, s.n);
      if (seen.has(k) || this.busy.has(k) || this.get(s) || this.freshNeg(s)) continue;
      seen.add(k); todo.push(s);
    }
    for (const s of todo) this.busy.add(this.ekey(s.c, s.n)); // 先整批标记在飞（同步段完成，并发调用不会重复捡走）
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const s = todo[i++], k = this.ekey(s.c, s.n);
        try {
          const u = await this.resolve(s).catch(() => '');
          this.mem[k] = u ? { u, t: Date.now() } : { x: 1, t: Date.now() };
        } finally { this.busy.delete(k); }
      }
    };
    await Promise.all([worker(), worker(), worker()]); // 3 路并行：串行时 30 个收藏首补最坏要 8 分钟+
    if (todo.length) { this.save(); if (done) done(); }
  },
  async resolve(s) {
    const id = (s.u.map(u => u.match(/qingting\.fm\/live\/(\d+)/)).find(Boolean) || [])[1];
    if (id) { // 蜻蜓频道页封面：class="img" 的 pic.qtfm/qingting 图（首图即台标，alt=台名；回听页无串台问题，仍带校验重试）
      const html = await this.px('https://m.qtfm.cn/channels/' + id + '/', t => /<img class="img" src="/.test(t));
      const m = html.match(/<img class="img" src="(http[^"]+pic\.(?:qtfm|qingting)\.[^"]+)" alt="[^"]*"/);
      if (m && !/[\s"'<>]/.test(m[1])) return m[1];
    }
    const r = await this.px('https://de1.api.radio-browser.info/json/stations/byurl?url=' + encodeURIComponent(s.u[0]), t => t.trim().startsWith('['));
    const f = (JSON.parse(r)[0] || {}).favicon;
    return /^https?:\/\//.test(f || '') && !/[\s"'<>]/.test(f) ? f : '';
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
