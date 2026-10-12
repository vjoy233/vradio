/* VRadio 应用层 —— 列表/搜索/分类/收藏/最近播放/导入导出/渲染的唯一所有者（模块契约见 docs/review.md 十一节债务 2）。
   播放一律经 Player 接口；同步/体检由 sync.js 编排本文件暴露的方法；台标数据经 Logos 模块获取（本文件只拼渲染片段）。
   身份公理（债务 1）：URL = 持久身份（收藏/最近记录源 URL，名字漂移后按 URL 回绑），名字 = 显示层。 */

/* ---------- 内置精选（地址已实测直连可用；含同一电台的多个备选源。l = 台标，蜻蜓频道页封面实测可直连） ---------- */
const STARTER = [
  { c:'常听', n:'Love Radio FM103.7 经典金曲', u:['http://lhttp.qingting.fm/live/273/64k.mp3','http://ls.qingting.fm/live/273.m3u8'], l:'http://pic.qtfm.cn/2014/0909/20140909125130474.jpg!200' },
  { c:'常听', n:'动感101 FM101.7', u:['http://lhttp.qingting.fm/live/274/64k.mp3','http://live.xmcdn.com/live/53/64.m3u8'], l:'http://pic.qtfm.cn/2014/0909/20140909123511693.jpg!200' },
  { c:'常听', n:'经典947 FM94.7', u:['http://lhttp.qingting.fm/live/267/64k.mp3'], l:'http://pic.qtfm.cn/sso/48/1641437907698_k0NNOUP54.jpeg!200' },
  { c:'常听', n:'上海东广新闻台', u:['http://lhttp.qingting.fm/live/275/64k.mp3'], l:'http://pic.qtfm.cn/sso/198/1606449636209_K8-0Zavn2.png!200' },
  { c:'常听', n:'上海交通台 FM105.7', u:['http://lhttp.qingting.fm/live/266/64k.mp3','http://ls.qingting.fm/live/266.m3u8'], l:'http://pic.qtfm.cn/sso/48/1641437453117_JxQnTn1vv.jpeg!200' },
  { c:'常听', n:'CNR 中国之声', u:['http://ngcdn001.cnr.cn/live/zgzs/index.m3u8'] },
  { c:'常听', n:'CNR 音乐之声', u:['http://ngcdn003.cnr.cn/live/yyzs/index.m3u8'] },
  { c:'常听', n:'CRI 环球资讯广播 FM90.5', u:['http://sk.cri.cn/905.m3u8'] },
  { c:'常听', n:'CRI 怀旧金曲频道', u:['https://lhttp.qingting.fm/live/5022038/64k.mp3'], l:'http://pic.qtfm.cn/2024/0726/20240726111933.png!200' },
  { c:'常听', n:'Asia FM 亚洲经典台', u:['https://lhttp.qingting.fm/live/5021912/64k.mp3'], l:'http://pic.qtfm.cn/2022/0712/20220712122112.jpeg!200' },
  { c:'亚洲·港台', n:'YES 933 (新加坡)', u:['http://playerservices.streamtheworld.com/api/livestream-redirect/YES933AAC.aac'] },
  { c:'亚洲·港台', n:'Class 95 (新加坡)', u:['http://playerservices.streamtheworld.com/api/livestream-redirect/CLASS95AAC.aac'] },
  { c:'亚洲·港台', n:'Listen.Moe JPop', u:['https://listen.moe/stream'] },
  { c:'欧美音乐', n:'Nightwave Plaza', u:['http://radio.plaza.one/opus'] },
];

const $ = id => document.getElementById(id);
const keyOf = s => s.c + '|' + s.n;

const App = {
  /* 集中状态（docs/review.md 架构-风险 2）：stations 数据 + 渲染哨兵 + 行索引（体检增量更新用，去 O(n²)）
     view：网格/列表视图（boot 从 localStorage 恢复，网格为默认——单列长列表浪费纵向空间）
     showDead：无效源（体检 ✗）台是否显示，默认隐藏（boot 从 localStorage 恢复）
     theme：auto/light/dark，默认跟随系统（boot 从 localStorage 恢复，写 <html data-theme>） */
  state: { stations: STARTER.slice(), cat: '全部', keyword: '', view: 'grid', showDead: false, theme: 'auto', stamp: 0, index: new Map() },
  favs: [],    // [{k, u:[源URL…]}] —— 带 URL 的条目永不回收（休眠待回绑），旧名字键回绑失败即刻回收
  recents: [], // [{k, n, u:[…]}] 最近在前、≤20；队首即「上次收听」（E3 与 lastKey 合并为单一队列）
  cfg: null,   // 个人维护层（radio.cfg，owner 三批拍板）：分类重命名/隐藏/自建 + 电台移动/重命名/隐藏。
               // 键 = 源 URL（身份公理），同步重建后自动复用；tag = URL→原始台名快照，仅供失配清单显示
  songFor: '', lastSong: '', // 曲讯（B-6/B-7）：songFor=曲讯归属台（切台即清零重取）；lastSong=最近一次拿到的曲名（换歌时旧歌入史）

  /* ---------- 持久化（localStorage 全部容错读取 + 旧格式迁移） ---------- */
  loadStore() {
    let favs; try { favs = JSON.parse(localStorage.getItem('radio.favs') || '[]'); } catch (_) { favs = []; }
    this.favs = (Array.isArray(favs) ? favs : []).map(f => typeof f === 'string' ? { k: f, u: [] } : { k: String(f.k), u: Array.isArray(f.u) ? f.u : [] });
    let rec; try { rec = JSON.parse(localStorage.getItem('radio.recents') || '[]'); } catch (_) { rec = []; }
    rec = Array.isArray(rec) ? rec : [];
    const last = localStorage.getItem('radio.last'); // 旧「上次收听」键 → 并入 recents 队首
    if (last && !rec.some(r => r.k === last)) rec.unshift({ k: last, n: '', u: [] });
    localStorage.removeItem('radio.last');
    this.recents = rec.slice(0, 20).map(r => ({ k: String(r.k), n: r.n || String(r.k).split('|').pop() || '', u: Array.isArray(r.u) ? r.u : [] }));
    // 死台标记持久化（radio.health）：键 → { u:[源URL快照], t }。TTL 7 天对齐 Logos 负缓存——流地址天然漂移，
    // 陈年死标不值得永久埋台；✓ 标记不持久化（会话级反馈即可，隐藏只关心死台）
    let hp; try { hp = JSON.parse(localStorage.getItem('radio.health') || '{}'); } catch (_) { hp = {}; }
    this.healthMarks = {};
    for (const k of Object.keys(hp || {})) { const e = hp[k]; if (e && Array.isArray(e.u) && Date.now() - (e.t || 0) < 7 * 86400000) this.healthMarks[k] = e; }
  },
  saveFavs() { localStorage.setItem('radio.favs', JSON.stringify(this.favs)); },
  saveRecents() { localStorage.setItem('radio.recents', JSON.stringify(this.recents)); },
  saveHealth() { // FIFO 500 封顶防膨胀（全量体检标死几百台的场景）
    const keys = Object.keys(this.healthMarks).sort((a, b) => (this.healthMarks[a].t || 0) - (this.healthMarks[b].t || 0));
    while (keys.length > 500) delete this.healthMarks[keys.shift()];
    try { localStorage.setItem('radio.health', JSON.stringify(this.healthMarks)); } catch (_) {}
  },

  /* ---------- 维护配置（radio.cfg）：localStorage 全部容错读取，结构与导入共用一套校验 ---------- */
  loadCfg() {
    let c; try { c = JSON.parse(localStorage.getItem('radio.cfg') || 'null'); } catch (_) { c = null; }
    this.cfg = this.normCfg(c);
  },
  normCfg(c) { // 结构校验/补齐（导入的 JSON 也走这里，坏形状回退空配置）
    c = c && typeof c === 'object' && !Array.isArray(c) ? c : {};
    for (const k of ['moves', 'names', 'tag']) c[k] = this.normStrMap(c[k]);                      // URL → 字符串
    c.renames = this.normStrMap(c.renames, true);                                                // 分类名 → 分类名（键非 URL，不做 URL 过滤）
    const urlKeys = m => Object.fromEntries(Object.entries(m).filter(([k]) => /^https?:\/\//.test(k)));
    c.hideS = c.hideS && typeof c.hideS === 'object' ? urlKeys(c.hideS) : {};                   // URL → 1（手藏电台）
    const strKeys = m => Object.fromEntries(Object.entries(m).filter(([k, v]) => typeof k === 'string' && k.trim() && v !== null && v !== false));
    c.hideC = c.hideC && typeof c.hideC === 'object' ? strKeys(c.hideC) : {};                   // 分类名 → 1（藏分类）
    if (!Array.isArray(c.cats)) c.cats = [];
    c.cats = [...new Set(c.cats.filter(x => typeof x === 'string' && x.trim() && !x.includes('|')).map(x => x.trim()))];
    return c;
  },
  normStrMap(m, anyKey) { const o = {}; for (const [k, v] of Object.entries(m || {})) if (typeof v === 'string' && v.trim() && (anyKey || /^https?:\/\//.test(k))) o[k.trim()] = v.trim(); return o; },
  saveCfg() { try { localStorage.setItem('radio.cfg', JSON.stringify(this.cfg)); } catch (_) {} },

  /* ---------- 列表解析：radio.txt（"分类,#genre#" 分节 + 名字,地址 行）与 m3u（#EXTINF + URL 行）双格式 ---------- */
  parse(text) {
    const map = new Map(); let sec = '未分类', pend = null;
    const add = (c, n, u) => {
      if (!n || !/^https?:\/\//.test(u)) return;
      const k = c + '|' + n;
      if (!map.has(k)) map.set(k, { c, n, u: [] });
      if (!map.get(k).u.includes(u)) map.get(k).u.push(u);
    };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#VRADIO')) continue; // 本项目导出标记行（E4），不影响导入
      if (line.endsWith('#genre#')) { sec = line.replace(/,#genre#$/, ''); continue; }
      if (/^#EXTINF:/i.test(line)) {
        // 属性值可含逗号（如 tvg-logo="http://a/b,c.png"）：引号外的第一个逗号才是「属性区,台名」分隔符
        let q = false, sep = -1;
        for (let j = 8; j < line.length; j++) { const ch = line[j]; if (ch === '"') q = !q; else if (ch === ',' && !q) { sep = j; break; } }
        const attrs = sep >= 0 ? line.slice(0, sep) : '', name = sep >= 0 ? line.slice(sep + 1).trim() : '';
        const g = attrs.match(/group-title="([^"]*)"/);
        pend = { c: (g && g[1].trim()) || sec, n: name };
        continue;
      }
      if (line.startsWith('#')) continue;
      if (/^https?:\/\//.test(line)) { if (pend) { add(pend.c, pend.n, line); pend = null; } continue; } // m3u 的 URL 行
      const i = line.lastIndexOf(','); if (i < 0) continue; // csv 风格：名字,地址
      add(sec, line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    return [...map.values()];
  },

  /* ---------- 数据装配（决策 B/C）：主列表 replace + STARTER 精选层（按精确名去重）+ 个人层常驻 ---------- */
  applySources(mainList, myList) {
    const byKey = new Map(), byName = new Set();
    for (const s of mainList) { byKey.set(keyOf(s), s); byName.add(s.n); }
    for (const st of STARTER) if (!byName.has(st.n)) { // 决策 C：与主列表精确重名的精选台不再并入（http 模式下常听=纯重复）
      byKey.set(keyOf(st), { c: st.c, n: st.n, u: st.u.slice(), l: st.l }); byName.add(st.n);
    }
    for (const s of myList || []) {
      const cur = byKey.get(keyOf(s));
      if (cur) s.u.forEach(u => !cur.u.includes(u) && cur.u.push(u));
      else { byKey.set(keyOf(s), s); byName.add(s.n); }
    }
    this.state.stations = [...byKey.values()];
    for (const s of this.state.stations) { s.dCat = s.c; s.dName = s.n; } // 同步默认口径留底（面板 ↺恢复/撤回移动用）
    this.applyCfg(); // 维护层最后套用（覆盖分类/台名/隐藏，收藏随后按 URL 回绑不受影响）
    this.rebind(); // 收藏/最近按 URL 回绑（债务 1）
    this.buildCats(); this.render();
    if (!Player.station) this.showLast();
  },
  /* 维护层套用：电台移动/重命名/手动隐藏按「任一源 URL 命中」（变体换序免疫）；
     手动隐藏 = 彻底消失（全部/收藏/搜索/体检一律不可见，owner 拍板无正在播例外——手动是明确意图，
     与死台隐藏的「正在播例外」口径不同）；分类重命名最后映射（移动目标在改名时已级联改写） */
  applyCfg() {
    const { moves, names, hideS, renames } = this.cfg;
    for (const s of this.state.stations) {
      s.hidden = false;
      for (const u of s.u) {
        if (hideS[u]) s.hidden = true;
        if (moves[u]) s.c = moves[u];
        if (names[u]) s.n = names[u];
      }
      if (renames[s.c]) s.c = renames[s.c];
    }
  },
  reapplyCfg() { // 面板改动后即时生效：回滚到装配默认再重套，并重走回绑/分类条/渲染/面板自身
    for (const s of this.state.stations) { if (s.dCat !== undefined) { s.c = s.dCat; s.n = s.dName; } }
    this.applyCfg();
    this.rebind(); this.buildCats(); this.render(); this.renderManage();
  },
  /* 主列表（radio.txt）+ 个人层（my-radio.txt）重拉重并；仅 http:// 下可用（file:// 下 fetch 必失败，P3-12 同源守卫） */
  async reloadMain() {
    if (!location.protocol.startsWith('http')) return false;
    const get = f => fetch(f + (f === 'radio.txt' ? '?t=' + Date.now() : '')).then(r => r.ok ? r.text() : Promise.reject()).catch(() => null);
    const main = await get('radio.txt');
    if (main === null) return false; // 主列表拉不到就不动（保底，绝不清空）
    const my = await get('my-radio.txt');
    this.applySources(this.parse(main), my ? this.parse(my) : []);
    return true;
  },

  /* ---------- 收藏/最近的 URL 回绑与存取（债务 1） ---------- */
  rebind() {
    const find = e => this.state.stations.find(s => keyOf(s) === e.k)
      || (e.u.length && this.state.stations.find(s => s.u.some(u => e.u.includes(u))));
    const nf = [];
    for (const f of this.favs) {
      const st = find(f);
      if (st) nf.push({ k: keyOf(st), u: st.u.slice(0, 6) }); // 回绑成功：刷新键与 URL 快照
      else if (f.u.length) nf.push(f); // 带 URL 的休眠条目永不回收，待上游恢复/换名后自动回绑
      // 旧名字键（无 URL）回绑失败 → 即刻回收（迁移策略）
    }
    this.favs = nf;
    // recents 回绑后按键去重：上游改名会让新旧两条解析到同一台，「最近」不出现重复行
    const seen = new Set();
    this.recents = this.recents.map(r => { const st = find(r); return st ? { k: keyOf(st), n: st.n, u: st.u.slice(0, 6) } : r; })
      .filter(r => { if (seen.has(r.k)) return false; seen.add(r.k); return r.u.length || this.state.stations.some(s => keyOf(s) === r.k); })
      .slice(0, 20);
    // 死台标记按 URL 身份回绑（上游改名/换分类后仍对得上）：命中即 s.health='dead'（刷新后依然默认隐藏），
    // 键与 URL 快照随之刷新；对不上当前列表的休眠保留待 TTL 过期
    const hm = {};
    for (const k of Object.keys(this.healthMarks)) {
      const e = this.healthMarks[k];
      const st = this.state.stations.find(s => keyOf(s) === k)
        || (e.u.length && this.state.stations.find(s => s.u.some(u => e.u.includes(u))));
      if (st) { st.health = 'dead'; hm[keyOf(st)] = { u: st.u.slice(0, 6), t: e.t }; }
      else hm[k] = e;
    }
    this.healthMarks = hm; this.saveHealth();
    this.saveFavs(); this.saveRecents();
  },
  favKeys() { return new Set(this.favs.map(f => f.k)); },
  toggleFav(s) {
    const k = keyOf(s);
    const i = this.favs.findIndex(f => f.k === k);
    if (i >= 0) this.favs.splice(i, 1); else { this.favs.push({ k, u: s.u.slice(0, 6) }); this.logosEnsure(); } // 新收藏优先补台标
    this.saveFavs(); this.render();
  },
  remember(s) { // 播放即记入最近（队首 = 上次收听）
    const k = keyOf(s);
    this.recents = this.recents.filter(r => r.k !== k);
    this.recents.unshift({ k, n: s.n, u: s.u.slice(0, 6) });
    this.recents = this.recents.slice(0, 20);
    this.saveRecents();
  },
  /* 按键或 URL 解析 station（收藏回绑/续播共用） */
  resolve(entry) {
    if (!entry) return null;
    return this.state.stations.find(s => keyOf(s) === entry.k)
      || (entry.u && entry.u.length && this.state.stations.find(s => s.u.some(u => entry.u.includes(u))))
      || null;
  },
  scopeFavRecent(max = 30) { // 静默体检范围（B-10，Sync 调用）：收藏 + 最近播放（键/URL 回绑解析、去重、上限）；手动隐藏的台不测——隐藏是明确意图
    const seen = new Set(), list = [];
    const push = e => { const s = this.resolve(e); if (s && !s.hidden && !seen.has(keyOf(s))) { seen.add(keyOf(s)); list.push(s); } };
    for (const f of this.favs) push(f);
    for (const r of this.recents) push(r);
    return list.slice(0, max);
  },
  showLast() {
    const s = this.recents[0] && this.resolve(this.recents[0]);
    $('nowline').textContent = s ? '上次收听：' + s.n : '未在播放';
  },

  /* ---------- 渲染（唯一入口）：网格 = 精简卡片 / 列表 = 两行详情（元信息行含「正在播」节目） ---------- */
  keepFocus(box, ...attrs) { // innerHTML 整表重建会把键盘焦点弹回 body：重建前后找回同节点
    const ae = document.activeElement;
    if (!box.contains(ae) || !ae.dataset) return () => {};
    const pair = attrs.map(a => [a, ae.dataset[a]]).find(([, v]) => v != null);
    return () => { if (pair) box.querySelector(`[data-${pair[0]}="${CSS.escape(pair[1])}"]`)?.focus({ preventScroll: true }); };
  },
  favBtn(k, on, s) {
    return `<button type="button" class="fav${on ? ' on' : ''}" data-fav="${this.esc(k)}" aria-pressed="${on}" aria-label="${on ? '取消收藏' : '收藏'}：${this.esc(s.n)}" title="${on ? '取消收藏' : '收藏'}">${on ? '★' : '☆'}</button>`;
  },
  buildCats() {
    const restore = this.keepFocus($('cats'), 'c');
    const present = new Set(this.state.stations.filter(s => !s.hidden && !this.cfg.hideC[s.c]).map(s => s.c));
    const pins = [...new Set(['华语音乐', '欧美音乐'].map(c => this.cfg.renames[c] || c))]; // 音乐置顶（owner 拍板）；重命名跟随新名；双音乐类互相合并后去重防重复 chip
    const hid = c => this.cfg.hideC[c];
    const order = [...pins.filter(c => present.has(c)),                                  // 置顶双音乐类
      ...this.cfg.cats.filter(c => present.has(c) && !hid(c) && !pins.includes(c)),       // 自建分类（移入台后才出现）
      ...[...present].filter(c => !pins.includes(c) && !this.cfg.cats.includes(c))];     // 其余按数据序
    const cats = ['全部', '★收藏', '最近', ...order];
    if (!cats.includes(this.state.cat)) this.state.cat = '全部'; // 数据更新/分类被藏后回退全部
    // 互斥单选语义用 aria-current（aria-pressed 是独立开关语义，不适用）
    $('cats').innerHTML = cats.map(c => `<button type="button" class="chip${c === this.state.cat ? ' on' : ''}" data-c="${this.esc(c)}"${c === this.state.cat ? ' aria-current="true"' : ''}>${this.esc(c)}</button>`).join('');
    restore();
  },
  visible(all) {
    const st = this.state, kw = st.keyword.toLowerCase(), favs = this.favKeys();
    // 手动维护层（隐藏台/隐藏分类）彻底消失（owner 拍板：全部/收藏/搜索/体检均不可见）；
    // 死台默认隐藏的「正在播例外」只豁免自动标记，不豁免手动隐藏。all=true 供空态判断「只是被死台隐藏」
    const show = s => !s.hidden && !this.cfg.hideC[s.c] && (all || st.showDead || s.health !== 'dead'
      || (Player.station && keyOf(Player.station) === keyOf(s)) || (Player.connecting && keyOf(Player.connecting) === keyOf(s)));
    if (st.cat === '最近') { // 最近播放（E3）：按 recents 队序（键或 URL 回绑解析），上限 20
      const hits = [];
      for (const r of this.recents.slice(0, 20)) { const s = this.resolve(r); if (s && (!kw || s.n.toLowerCase().includes(kw)) && show(s)) hits.push(s); }
      return hits;
    }
    return st.stations.filter(s =>
      (st.cat === '全部' || (st.cat === '★收藏' ? favs.has(keyOf(s)) : s.c === st.cat)) &&
      (!kw || s.n.toLowerCase().includes(kw)) && show(s));
  },
  // 电台名/分类来自远程上游仓库，渲染前必须转义（防注入）
  esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  emptyHtml() { // 空态给出原因和下一步动作
    const msg = this.state.cat === '★收藏' && !this.favs.length ? '还没有收藏电台——点电台左侧 ☆ 即可收藏'
      : this.state.cat === '最近' && !this.recents.length ? '还没有播放记录——点任意电台即开始收听'
      : this.visible(true).length ? '当前筛选的电台均已体检不可用（默认隐藏）——点上方「✗ 无效源」开关显示它们'
      : this.state.keyword ? `没有匹配「${this.esc(this.state.keyword)}」的电台，换个关键词试试` : '该分类暂无电台';
    return `<div class="empty">${msg}</div>`;
  },
  render() {
    const restore = this.keepFocus($('list'), 'k', 'fav'); // 焦点在行/卡片或按钮上都找回
    const list = this.visible();
    $('deadBtn').hidden = !this.state.stations.some(s => s.health === 'dead'); // 出现过死台才亮「无效源」开关
    this.state.stamp++;
    this.state.index = new Map(list.map((s, i) => [s, i])); // 行索引（体检增量更新用，替代 indexOf 的 O(n²)）
    const pk = Player.station && keyOf(Player.station), ck = Player.connecting && keyOf(Player.connecting);
    const favs = this.favKeys(), grid = this.state.view === 'grid';
    $('list').className = grid ? 'grid' : '';
    $('list').innerHTML = list.map((s, i) => {
      const k = keyOf(s), on = favs.has(k), playing = k === pk;
      const base = `${playing ? ' playing' : ''}${k === ck ? ' connecting' : ''}${s.health === 'dead' ? ' dead' : ''}`;
      const attrs = `data-k="${this.esc(k)}" data-i="${i}" role="listitem" tabindex="0" aria-label="${this.esc(s.n)}${playing ? '（播放中）' : ''}"${playing ? ' aria-current="true"' : ''}${s.health === 'dead' ? ' title="体检不可用，点击仍可尝试播放"' : ''}`;
      const hp = s.health ? `<span class="health ${s.health === 'ok' ? 'ok' : 'bad'}" title="体检${s.health === 'ok' ? '可用' : '不可用'}">${s.health === 'ok' ? '✓' : '✗'}</span>` : '';
      if (grid) return `<div class="card${base}" ${attrs}><div class="chead">${Logos.img(s)}<span class="cname">${this.esc(s.n)}</span>${this.favBtn(k, on, s)}</div><div class="cfoot"><span class="badge">${this.esc(s.c)}</span><span class="srcs" title="备选源数量">${s.u.length}源</span>${hp}</div></div>`;
      return `<div class="row${base}" ${attrs}>${this.favBtn(k, on, s)}<div class="col"><div class="l1">${Logos.img(s)}<span class="name">${this.esc(s.n)}</span>${hp}</div><div class="meta"><span class="badge">${this.esc(s.c)}</span><span class="srcs" title="备选源数量">${s.u.length}源</span></div></div></div>`;
    }).join('') || this.emptyHtml();
    restore();
  },
  /* 体检增量落库（sync.js 调用）：stamp 未变时顺手更新该行 DOM，否则只落数据由结束时的兜底 render 收口（P3-13）。
     healthMarks 只改内存，落盘由 Sync.health 收尾统一一次——全量体检标死几百台时逐台全量写 localStorage 会卡主线程；
     复活即撤销标记，体检结束的兜底 render 会让它回归列表 */
  patchHealth(s, ok, stamp) {
    s.health = ok ? 'ok' : 'dead';
    if (ok) delete this.healthMarks[keyOf(s)];
    else { this.healthMarks[keyOf(s)] = { u: s.u.slice(0, 6), t: Date.now() }; $('deadBtn').hidden = false; } // 首个死台出现即亮开关
    if (this.state.stamp !== stamp) return;
    const row = $('list').querySelector(`[data-i="${this.state.index.get(s)}"]`); // 行/卡片通用
    if (!row) return;
    if (!ok && !this.state.showDead
      && !(Player.station && keyOf(Player.station) === keyOf(s)) && !(Player.connecting && keyOf(Player.connecting) === keyOf(s))) {
      row.remove(); return; // 默认隐藏：死台行当场消失，与 visible() 口径一致（正在播/连接中的台不消失）
    }
    row.classList.toggle('dead', !ok);
    const old = row.querySelector('.health'); if (old) old.remove();
    const sp = document.createElement('span'); sp.className = 'health ' + (ok ? 'ok' : 'bad'); sp.textContent = ok ? '✓' : '✗';
    row.querySelector('.l1, .cfoot').appendChild(sp);
  },

  togglePlay(k) { // 再点当前台 = 暂停/继续；点其他台 = 切换
    const s = this.state.stations.find(x => keyOf(x) === k); if (!s) return;
    if (Player.station && keyOf(Player.station) === k) {
      Player.isPaused() ? Player.resume() : Player.pause();
      return;
    }
    this.remember(s);
    this.logosEnsure(); // 正在播的台也优先补台标
    if (this.state.cat === '最近') this.render(); // 最近队列头插后刷新顺序
    Player.play(s);
  },
  stepFav(d) { // ←/→ 在收藏间切台（A-5）：顺序取当前可见列表内的收藏台；当前台不在收藏则从队首/队尾起步
    const favs = this.favKeys();
    const list = this.visible().filter(s => favs.has(keyOf(s)));
    if (!list.length) { $('status').textContent = '还没有收藏电台——点电台左侧 ☆ 收藏后可用 ←/→ 键切换'; return; }
    const cur = Player.station ? list.findIndex(s => keyOf(s) === keyOf(Player.station)) : -1;
    const nx = cur < 0 ? (d > 0 ? 0 : list.length - 1) : (cur + d + list.length) % list.length;
    this.togglePlay(keyOf(list[nx]));
  },
  /* 台标补全（收藏 + 正在播优先，请求量可控）：Logos.ensure 落库后回调重渲一次展示 */
  logosEnsure() {
    if (!location.protocol.startsWith('http')) return;
    const seen = new Set(), list = [];
    for (const f of this.favs) { const s = this.resolve(f); if (s && !seen.has(keyOf(s))) { seen.add(keyOf(s)); list.push(s); } }
    if (Player.station && !seen.has(keyOf(Player.station))) list.push(Player.station);
    Logos.ensure(list, () => this.render());
  },
  /* 底部栏刷新（Player.onstate 用）：当前台名 + 播放/暂停态 + 均衡器动画 */
  playerNow() {
    const s = Player.station;
    if (s) {
      const k = keyOf(s);
      if (this.songFor !== k) { // 切台：曲讯清零（新台从零取，旧曲名不得串台）
        this.songFor = k; this.lastSong = '';
        $('song').hidden = true; $('song').textContent = '';
      }
      $('nowline').textContent = '▶ ' + s.n; $('pp').textContent = (Player.connecting || !Player.isPaused()) ? '⏸' : '▶';
    } else { $('pp').textContent = '▶'; this.showLast(); $('song').hidden = true; }
    $('eq').classList.toggle('on', !!s && !Player.isPaused()); // 均衡器动画（E6）：活着且在播
  },

  /* ---------- 曲讯（B-6）：轮询 /api/nowplaying 取正在播台的 ICY 曲名 ----------
     只对「正在播 + 未暂停 + 页面可见」的台取（http 形态）；m3u8 结构性无 ICY 不空耗探活；
     换歌时旧曲名入史（B-7）+ 曲名写 MediaSession（锁屏同步显示） */
  async tickSong() {
    const s = Player.station;
    if (!s || Player.isPaused() || document.hidden || !location.protocol.startsWith('http')) return;
    const raw = Player.curUrl;
    if (!raw || /\.m3u8(\?|$)/.test(raw)) return;
    let j;
    try { j = await fetch('/api/nowplaying?url=' + encodeURIComponent(raw)).then(x => x.json()); } catch (_) { return; }
    const t = (j && j.title) || '';
    if (!Player.station || keyOf(Player.station) !== this.songFor) return; // 轮询期间切台：丢弃过期结果
    if (t === this.lastSong) return;
    if (this.lastSong && t) this.pushSongHist(keyOf(s), this.lastSong); // 换歌：旧歌入史（B-7）
    this.lastSong = t;
    if (t) { $('song').textContent = '♪ ' + t; $('song').hidden = false; Player.setSong(t); }
  },

  /* ---------- 歌曲历史（B-7）：换歌时旧歌入史（当前曲只显示不入史），按台存 localStorage（radio.songs） ---------- */
  pushSongHist(k, title) {
    if (!title) return;
    let songs; try { songs = JSON.parse(localStorage.getItem('radio.songs') || '{}'); } catch (_) { songs = {}; }
    const list = songs[k] || [];
    if (!list.length || list[0].t !== title) { list.unshift({ t: title, at: Date.now() }); songs[k] = list.slice(0, 12); } // 每台 12 首封顶
    const ks = Object.keys(songs).sort((a, b) => (songs[b][0] ? songs[b][0].at : 0) - (songs[a][0] ? songs[a][0].at : 0));
    for (const x of ks.slice(50)) delete songs[x]; // 台数 50 FIFO（按最近有歌活动排序砍最旧）
    try { localStorage.setItem('radio.songs', JSON.stringify(songs)); } catch (_) {}
  },
  toggleSongHist() { // 点击曲名行：本台最近播放浮层（当前曲在曲名行本身，不入列）
    const el = $('songhist');
    if (!el.hidden) { el.hidden = true; return; }
    if (!Player.station) return;
    let songs; try { songs = JSON.parse(localStorage.getItem('radio.songs') || '{}'); } catch (_) { songs = {}; }
    const list = (songs[this.songFor] || []).slice(0, 12);
    el.innerHTML = '<b>本台最近播放</b>' + (list.length
      ? list.map(x => `<div class="shrow">${this.esc(x.t)}</div>`).join('')
      : '<div class="shrow" style="color:var(--dim)">暂无历史（换歌后自动记录）</div>');
    el.hidden = false;
  },

  /* ---------- 收藏导出/导入（Tier 1 E4）：导出 = 带 #VRADIO:FAV 标记的 m3u（通用播放器可读），
     导回同文件时恢复收藏态；round-trip 即天然回归用例（docs/review.md G 组） ---------- */
  exportFavs() {
    const favs = this.favKeys();
    const list = this.state.stations.filter(s => favs.has(keyOf(s)));
    if (!list.length) { $('status').textContent = '还没有收藏，先点 ☆ 收藏再导出'; return; }
    const lines = ['#EXTM3U', '#VRADIO:FAV'];
    for (const s of list) for (const u of s.u) // m3u 是纯文本：只清分隔/换行符，不过 HTML 转义（否则 R&B 会腐蚀成 R&amp;B）
      lines.push(`#EXTINF:-1 group-title="${s.c.replace(/["\r\n]/g, '')}",${s.n.replace(/[\r\n,]/g, ' ')}`, u);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' }));
    a.download = 'vradio-favorites.m3u';
    a.click(); URL.revokeObjectURL(a.href);
    $('status').textContent = `已导出 ${list.length} 个收藏电台（vradio-favorites.m3u）`;
  },

  /* ---------- 维护面板（⚙，owner 两轮拍板）：个人分类/电台调整的编辑界面。
     分类页：重命名（撞名=合并，confirm 提示不易拆）/隐藏/删除自建（台撤回默认）；电台页：搜索定位后
     移动（含新建分类）/重命名/隐藏/单台 ↺ 恢复默认；失配清单：同步后 URL 漂移的个人调整可观测 ---------- */
  mTab: 'cats', mKw: '',
  manageOpen() { $('manage').hidden = false; this.renderManage(); },
  manageClose() { $('manage').hidden = true; },
  renderManage() {
    if ($('manage').hidden) return;
    const cats = this.mTab !== 'st';
    $('mTabC').classList.toggle('on', cats); $('mTabS').classList.toggle('on', !cats);
    $('mTabC').setAttribute('aria-pressed', String(cats)); $('mTabS').setAttribute('aria-pressed', String(!cats));
    $('mCats').hidden = !cats; $('mStations').hidden = cats;
    this.renderMiss();
    if (cats) this.renderMCats(); else this.renderMStations();
  },
  askName(title, def = '') { // 弹名 + 校验：非空、无 |（keyOf 分隔符）、24 字内
    let v = null; try { v = prompt(title + '（不能含 |，24 字以内）', def); } catch (_) { return ''; }
    return v === null ? '' : v.trim().replace(/\|/g, ' ').slice(0, 24);
  },
  mCatOptions() { // 分类下拉选项 = 当前生效分类（数据序，含重命名后名——与分类条一致）+ 自建分类
    const seen = new Set(); for (const s of this.state.stations) if (s.c) seen.add(s.c);
    return [...seen, ...this.cfg.cats];
  },
  cfgTag(s) { for (const u of s.u) this.cfg.tag[u] = s.dName; }, // 原始台名快照：失配清单显示/再搜索用

  /* —— 分类页 —— */
  renderMCats() {
    const cnt = new Map(); for (const s of this.state.stations) cnt.set(s.c, (cnt.get(s.c) || 0) + 1); // 数据口径（含隐藏台）
    const rows = [], seen = new Set();
    const row = c => {
      if (seen.has(c)) return; seen.add(c);
      const hid = !!this.cfg.hideC[c], custom = this.cfg.cats.includes(c);
      rows.push(`<div class="mrow${hid ? ' hidden-item' : ''}" data-cat="${this.esc(c)}">
        <span class="nm">${this.esc(c)}</span><span class="cnt">${cnt.get(c) || 0} 台${hid ? '·已隐藏' : ''}</span>
        <button type="button" class="btn mbtn" data-act="rename" title="重命名；改成已有分类名 = 合并（不易拆分）">✎</button>
        <button type="button" class="btn mbtn" data-act="hide" title="${hid ? '恢复显示该分类' : '隐藏该分类（彻底消失，含全部/搜索）'}">${hid ? '👁' : '🙈'}</button>
        ${custom ? `<button type="button" class="btn mbtn" data-act="del" title="删除自建分类（其中电台回到同步默认分类）">🗑</button>` : ''}
      </div>`);
    };
    for (const s of this.state.stations) row(s.c); // 含被隐藏分类（可在此恢复）
    for (const c of this.cfg.cats) row(c); // 空自建分类也要能改名/删除
    $('mCats').innerHTML = rows.join('') + `<div style="padding:10px 0"><button type="button" class="btn" data-act="new">＋ 新建分类</button><span class="cnt" style="margin-left:8px">新建后出现在「电台」页的移动下拉；分类条要移入电台才显示</span></div>`;
  },
  catNew() {
    const c = this.askName('新建分类'); if (!c) return;
    if (this.mCatOptions().includes(c)) { alert('已有同名分类'); return; }
    this.cfg.cats.push(c); this.saveCfg(); this.renderManage();
  },
  catRename(c) {
    const neu = this.askName(`重命名分类「${c}」`, c); if (!neu || neu === c) return;
    const exists = this.mCatOptions().includes(neu);
    if (exists && !confirm(`「${c}」将并入「${neu}」——合并后按一个分类处理，不易拆分（想拆只能逐台移动）。继续？`)) return;
    if (this.cfg.cats.includes(c)) // 自建分类：并入已有名则让位消失，否则数组内改名
      this.cfg.cats = exists ? this.cfg.cats.filter(x => x !== c) : this.cfg.cats.map(x => x === c ? neu : x);
    else { const org = Object.keys(this.cfg.renames).find(k => this.cfg.renames[k] === c); // 已重命名过的再改名：改映射值
      if (org) this.cfg.renames[org] = neu; else this.cfg.renames[c] = neu; }
    for (const k of Object.keys(this.cfg.moves)) if (this.cfg.moves[k] === c) this.cfg.moves[k] = neu; // 移动目标级联
    if (this.cfg.hideC[c]) { this.cfg.hideC[neu] = 1; delete this.cfg.hideC[c]; }
    if (this.state.cat === c) this.state.cat = neu;
    this.saveCfg(); this.reapplyCfg();
  },
  catHide(c) {
    if (this.cfg.hideC[c]) delete this.cfg.hideC[c];
    else { this.cfg.hideC[c] = 1; if (this.state.cat === c) this.state.cat = '全部'; }
    this.saveCfg(); this.reapplyCfg();
  },
  catDel(c) {
    if (!confirm(`删除自建分类「${c}」？其中电台将回到同步默认分类。`)) return;
    for (const k of Object.keys(this.cfg.moves)) if (this.cfg.moves[k] === c) { delete this.cfg.moves[k]; delete this.cfg.tag[k]; } // 台撤回默认，tag 快照一并清
    this.cfg.cats = this.cfg.cats.filter(x => x !== c); delete this.cfg.hideC[c];
    if (this.state.cat === c) this.state.cat = '全部';
    this.saveCfg(); this.reapplyCfg();
  },

  /* —— 电台页（搜索含已隐藏台，恢复入口也在这）—— */
  renderMStations() {
    const box = $('mlist'), keepScroll = box.scrollTop; // innerHTML 重建丢滚动位置：先记后还
    const kw = (this.mKw || '').toLowerCase(), all = this.state.stations;
    // 命中当前名或原始名（改过名的用旧名也搜得到）；无关键词只列前 100，避免 1600+ 行整表渲染
    // dName/dCat 用 || 兜底（file:// 降级模式 boot 已快照，双保险防再漏）
    const list = kw ? all.filter(s => s.n.toLowerCase().includes(kw) || (s.dName || s.n).toLowerCase().includes(kw)) : all.slice(0, 100);
    const opts = this.mCatOptions();
    // 添加电台表单（A-2）分类下拉随行刷新；默认选中当前分类（全部/收藏/最近等非数据分类则落第一项）
    $('mACat').innerHTML = opts.map(c => `<option value="${this.esc(c)}"${c === this.state.cat ? ' selected' : ''}>${this.esc(c)}</option>`).join('');
    box.innerHTML = list.map(s => {
      const dC = s.dCat || s.c, dN = s.dName || s.n;
      const k = keyOf(s), moved = s.c !== dC, named = s.n !== dN;
      return `<div class="mrow${s.hidden ? ' hidden-item' : ''}" data-k="${this.esc(k)}">
        <span class="nm" title="${this.esc(named ? '原名：' + dN : s.n)}${s.hidden ? '（已隐藏）' : ''}">${this.esc(s.n)}</span>
        <select data-act="move" aria-label="「${this.esc(s.n)}」的分类">${opts.map(c => `<option value="${this.esc(c)}"${c === s.c ? ' selected' : ''}>${this.esc(c)}${this.cfg.hideC[c] ? '（已隐藏）' : ''}</option>`).join('')}<option value="__new">＋新建分类…</option><option value="__def">↺ 默认（${this.esc(this.cfg.renames[dC] || dC)}）</option></select>
        ${(moved || named || s.hidden) ? `<button type="button" class="btn mbtn" data-act="reset" title="撤销此台全部个人调整（回到默认分类/默认名/显示）">↺</button>` : ''}
        <button type="button" class="btn mbtn" data-act="rename" title="重命名电台（仅显示层，收藏按 URL 不受影响；台标若因改名失配可重新收藏触发解析）">✎</button>
        <button type="button" class="btn mbtn" data-act="hide" title="${s.hidden ? '取消隐藏' : '隐藏电台（彻底消失，含全部/搜索）'}">${s.hidden ? '👁' : '🙈'}</button>
      </div>`;
    }).join('') || '<div class="empty">没有匹配的电台</div>';
    if (!kw && all.length > 100) box.innerHTML += '<div class="empty" style="padding:8px 30px;">电台较多，仅列前 100 台——用上方搜索缩小范围</div>';
    box.scrollTop = keepScroll;
  },
  stMove(s, v) {
    if (v === s.c) return;
    if (v === '__def') { for (const u of s.u) delete this.cfg.moves[u]; }
    else {
      if (v === '__new') {
        v = this.askName('新建分类并移入');
        if (!v) { this.renderManage(); return; }
        if (!this.cfg.cats.includes(v) && !this.mCatOptions().includes(v)) this.cfg.cats.push(v);
      }
      for (const u of s.u) this.cfg.moves[u] = v;
    }
    this.cfgTag(s); this.saveCfg(); this.reapplyCfg();
  },
  stRename(s) {
    const neu = this.askName(`重命名「${s.n}」`, s.n); if (!neu || neu === s.n) return;
    if (this.state.stations.some(x => x !== s && x.c === s.c && x.n === neu)) { alert('该分类下已有同名电台，换个名字（重名会串台）'); return; }
    for (const u of s.u) this.cfg.names[u] = neu;
    this.cfgTag(s); this.saveCfg(); this.reapplyCfg();
  },
  stHide(s) {
    const on = !s.hidden;
    for (const u of s.u) { if (on) this.cfg.hideS[u] = 1; else delete this.cfg.hideS[u]; }
    this.cfgTag(s); this.saveCfg(); this.reapplyCfg();
  },
  cfgResetStation(s) {
    for (const u of s.u) { delete this.cfg.moves[u]; delete this.cfg.names[u]; delete this.cfg.hideS[u]; delete this.cfg.tag[u]; } // tag 只在失配清单用，恢复默认即清（防只增不减）
    this.saveCfg(); this.reapplyCfg();
  },

  /* —— 失配清单：moves/names/hideS 的键没命中任何当前台的源 URL = 上游 URL 漂移（欧美台同步重建常见） —— */
  missList() {
    const used = new Set(); for (const s of this.state.stations) for (const u of s.u) used.add(u);
    const bad = [];
    for (const [m, kind] of [[this.cfg.moves, '移动'], [this.cfg.names, '改名'], [this.cfg.hideS, '隐藏']])
      for (const u of Object.keys(m)) if (!used.has(u)) bad.push({ u, kind, name: this.cfg.tag[u] || u.replace(/^https?:\/\//, '').slice(0, 40) });
    return bad;
  },
  renderMiss() {
    const bad = this.missList();
    $('mMiss').innerHTML = !bad.length ? '' : `<div class="miss"><b>⚠ ${bad.length} 条个人调整已失配</b>（上游同步后源地址漂移，多为欧美台重建）：${bad.map(b => `${this.esc(b.name)}（${b.kind}）`).join('、')}。在「电台」页搜台名可重新指定，<button type="button" class="btn mbtn" data-act="missclear">或清理这些失配项</button></div>`;
  },

  /* —— 配置导入导出（owner 拍板：只含维护层；收藏另有 m3u 导出）—— */
  cfgCount(c) { return Object.keys(c.moves).length + Object.keys(c.names).length + Object.keys(c.hideS).length + Object.keys(c.renames).length + Object.keys(c.hideC).length + c.cats.length; },
  exportCfg() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ v: 1, cfg: this.cfg }, null, 2)], { type: 'application/json' }));
    a.download = 'vradio-config.json'; a.click(); URL.revokeObjectURL(a.href);
    $('status').textContent = `已导出维护配置（${this.cfgCount(this.cfg)} 项，vradio-config.json）`;
  },
  importCfg(text) {
    let j; try { j = JSON.parse(text); } catch (_) { alert('导入失败：不是合法 JSON 文件'); return; }
    const c = this.normCfg(j && j.cfg);
    if (!confirm(`导入将覆盖本地全部维护配置（新配置共 ${this.cfgCount(c)} 项，含 ${c.cats.length} 个自建分类）。继续？`)) return;
    this.cfg = c; this.saveCfg(); this.reapplyCfg();
    $('status').textContent = '已导入维护配置';
  },
  resetCfg() {
    if (!confirm('清空全部维护配置？分类与电台将回到同步默认（电台数据本身不受影响）。')) return;
    this.cfg = this.normCfg(null); this.saveCfg(); this.state.cat = '全部'; this.reapplyCfg();
    $('status').textContent = '已重置维护配置';
  },

  boot() {
    this.loadStore();
    localStorage.removeItem('radio.epg'); // 节目单（EPG）功能已移除：顺手清掉旧版留下的缓存（不存在则 no-op）
    // 音量持久化（读取夹取 0-100，坏值回退 90）
    const savedVol = localStorage.getItem('radio.vol'), vol0 = +savedVol;
    const vol = savedVol !== null && Number.isFinite(vol0) && vol0 >= 0 && vol0 <= 100 ? vol0 : 90;
    $('vol').value = vol;
    Player.init($('audio'), vol / 100);

    // Player 状态回调：full=true 需整表重渲（行高亮/连接中变化），否则只轻量更新底部
    Player.onstate = full => { this.playerNow(); if (full) this.render(); };
    Player.onstatus = t => { $('status').textContent = t; };
    Player.onfail = () => this.showLast();
    // 睡眠定时（E2）：未设置时点击循环 15→30→60 分钟；进行中点击直接取消
    const SLEEPS = [15, 30, 60]; let si = -1;
    $('sleepBtn').onclick = () => {
      if (Player.sleepId) { si = -1; Player.sleep(0); return; }
      si = (si + 1) % SLEEPS.length; Player.sleep(SLEEPS[si]);
    };
    Player.ontick = ms => {
      const b = $('sleepBtn');
      if (ms > 0) { const s = Math.ceil(ms / 1000); b.textContent = '😴 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); b.title = '睡眠定时进行中，点击取消'; }
      else { b.textContent = '😴'; b.title = '睡眠定时：点击设置 15/30/60 分钟'; }
    };

    // 曲讯轮询（B-6）：15s 常驻轮（条件不满足时空转不发包）；页面重新可见时立刻补一轮
    setInterval(() => this.tickSong(), 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.tickSong(); });
    // 歌曲历史浮层（B-7）：点曲名行开关；点别处收起
    $('song').onclick = () => this.toggleSongHist();
    document.addEventListener('click', e => { if (!e.target.closest('#songhist,#song')) $('songhist').hidden = true; });

    // 搜索：120ms 防抖，避免 1600+ 行列表每键整表重渲；Esc 清空；任意位置按 / 聚焦
    let timer = 0;
    $('q').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { this.state.keyword = e.target.value.trim(); this.render(); }, 120); };
    $('q').onkeydown = e => { if (e.key === 'Escape') { e.target.value = ''; clearTimeout(timer); this.state.keyword = ''; this.render(); } };
    document.addEventListener('keydown', e => { // 全局快捷键（A-5）：/ 聚焦搜索、空格 播放/暂停、←/→ 收藏间切台
      if (e.ctrlKey || e.altKey || e.metaKey) return; // 不抢组合键（Ctrl+/ 等）
      const t = e.target, tag = t && t.tagName;
      // 焦点在交互件/列表行/维护面板/歌曲浮层上：让位原生行为（行内 Enter/Space 已有处理、面板有自己的 Esc 语义、按钮空格原生触发 click）
      if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag) || t.isContentEditable || (t.closest && t.closest('#list,#manage,#songhist'))) return;
      if (e.key === '/') { e.preventDefault(); $('q').focus(); return; }
      if (e.key === ' ') { e.preventDefault(); $('pp').click(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); this.stepFav(e.key === 'ArrowRight' ? 1 : -1); }
    });

    // 分类与列表（行/卡片可用键盘操作：Enter/Space 播放；收藏按钮由原生 button 处理）
    $('cats').onclick = e => { const c = e.target.closest('.chip'); if (c) { this.state.cat = c.dataset.c; this.buildCats(); this.render(); } };
    $('list').onclick = e => {
      const fav = e.target.closest('.fav');
      if (fav) {
        const s = this.state.stations.find(x => keyOf(x) === fav.dataset.fav);
        if (s) this.toggleFav(s);
        return;
      }
      const row = e.target.closest('.row,.card'); if (row) this.togglePlay(row.dataset.k);
    };
    $('list').onkeydown = e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.row,.card');
      if (row && e.target === row) { e.preventDefault(); this.togglePlay(row.dataset.k); }
    };

    // 视图切换（网格=精简卡片 / 列表=两行详情）与无效源显隐，均持久化到 localStorage
    const syncView = () => {
      $('gridBtn').classList.toggle('on', this.state.view === 'grid'); $('gridBtn').setAttribute('aria-pressed', String(this.state.view === 'grid'));
      $('listBtn').classList.toggle('on', this.state.view === 'list'); $('listBtn').setAttribute('aria-pressed', String(this.state.view === 'list'));
    };
    const setView = v => { if (this.state.view === v) return; this.state.view = v; localStorage.setItem('radio.view', v); syncView(); this.render(); };
    $('gridBtn').onclick = () => setView('grid');
    $('listBtn').onclick = () => setView('list');
    this.state.view = localStorage.getItem('radio.view') === 'list' ? 'list' : 'grid'; // 网格为默认
    syncView();
    const syncDead = () => {
      $('deadBtn').classList.toggle('on', this.state.showDead); $('deadBtn').setAttribute('aria-pressed', String(this.state.showDead));
    };
    $('deadBtn').onclick = () => { this.state.showDead = !this.state.showDead; localStorage.setItem('radio.showdead', this.state.showDead ? '1' : '0'); syncDead(); this.render(); };
    this.state.showDead = localStorage.getItem('radio.showdead') === '1'; // 默认隐藏无效台
    syncDead();

    // 主题：🌓 跟随系统（默认）→ ☀️ 浅色 → 🌙 深色 循环，持久化 radio.theme；
    // 生效值写 <html data-theme>，浅色变量只认它（auto 由 matchMedia 实时换算，系统切换即时跟随）
    const mq = matchMedia('(prefers-color-scheme: light)');
    const themeName = { auto: '跟随系统', light: '浅色', dark: '深色' };
    const applyTheme = () => {
      document.documentElement.dataset.theme = this.state.theme === 'auto' ? (mq.matches ? 'light' : 'dark') : this.state.theme;
      $('themeBtn').textContent = { auto: '🌓', light: '☀️', dark: '🌙' }[this.state.theme];
      $('themeBtn').setAttribute('aria-label', '主题：' + themeName[this.state.theme] + '，点击切换');
      $('themeBtn').title = '主题：' + themeName[this.state.theme] + '（点击循环：跟随系统 → 浅色 → 深色）';
    };
    this.state.theme = ['auto', 'light', 'dark'].includes(localStorage.getItem('radio.theme')) ? localStorage.getItem('radio.theme') : 'auto';
    $('themeBtn').onclick = () => { this.state.theme = { auto: 'light', light: 'dark', dark: 'auto' }[this.state.theme]; localStorage.setItem('radio.theme', this.state.theme); applyTheme(); };
    mq.addEventListener('change', () => { if (this.state.theme === 'auto') applyTheme(); });
    applyTheme();

    // 维护面板（⚙）：个人分类/电台调整，全部落 radio.cfg（localStorage），同步重跑后按 URL 回绑自动复用
    this.loadCfg();
    // file:// 降级模式（reloadMain 必失败）下 stations 停留在 STARTER、不走 applySources 的留底循环——
    // 此处补快照，否则维护面板「电台」页读 s.dName 直接抛错（渲染处另有 || 兜底双保险）
    for (const s of this.state.stations) { if (s.dCat === undefined) { s.dCat = s.c; s.dName = s.n; } }
    $('manageBtn').onclick = () => this.manageOpen();
    $('mClose').onclick = () => this.manageClose();
    $('manage').onclick = e => { if (e.target === $('manage')) this.manageClose(); }; // 点遮罩关闭
    document.addEventListener('keydown', e => { // Esc 关面板（焦点在输入框/下拉里时不抢，让它们先清自身）
      if (e.key === 'Escape' && !$('manage').hidden && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) this.manageClose();
    });
    $('mTabC').onclick = () => { this.mTab = 'cats'; this.renderManage(); };
    $('mTabS').onclick = () => { this.mTab = 'st'; this.renderManage(); };
    let mtimer = 0;
    $('mq').oninput = e => { clearTimeout(mtimer); mtimer = setTimeout(() => { this.mKw = e.target.value.trim(); this.renderMStations(); }, 120); };
    $('mq').onkeydown = e => { if (e.key === 'Escape') { e.target.value = ''; clearTimeout(mtimer); this.mKw = ''; this.renderMStations(); } }; // Esc 清搜索（焦点在输入框时不关面板）
    $('mCats').onclick = e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'new') return this.catNew();
      const c = b.dataset.cat || (b.closest('.mrow') || {}).dataset.cat; if (!c) return;
      if (b.dataset.act === 'rename') this.catRename(c);
      else if (b.dataset.act === 'hide') this.catHide(c);
      else if (b.dataset.act === 'del') this.catDel(c);
    };
    $('mlist').onchange = e => {
      const sel = e.target.closest('select[data-act="move"]'); if (!sel) return;
      const s = this.state.stations.find(x => keyOf(x) === sel.closest('.mrow').dataset.k);
      if (s) this.stMove(s, sel.value);
    };
    $('mlist').onclick = e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const s = this.state.stations.find(x => keyOf(x) === b.closest('.mrow').dataset.k); if (!s) return;
      if (b.dataset.act === 'rename') this.stRename(s);
      else if (b.dataset.act === 'hide') this.stHide(s);
      else if (b.dataset.act === 'reset') this.cfgResetStation(s);
    };
    $('mMiss').onclick = e => {
      if (!e.target.closest('[data-act="missclear"]')) return;
      for (const b of this.missList()) { delete this.cfg.moves[b.u]; delete this.cfg.names[b.u]; delete this.cfg.hideS[b.u]; delete this.cfg.tag[b.u]; }
      this.saveCfg(); this.renderManage();
    };
    $('mExport').onclick = () => this.exportCfg();
    $('mImport').onclick = () => $('mfile').click();
    $('mfile').onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => this.importCfg(String(r.result)); r.readAsText(f, 'utf-8'); e.target.value = ''; };
    $('mReset').onclick = () => this.resetCfg();

    // 添加自定义电台（A-2）：面板内表单 → /api/mystation（服务端先探活拒绝假流/死链，再原子写 my-radio.txt；
    // 与 cfg 的分工 = cfg 调整既有台的显示层（localStorage），这里新增列表里不存在的台（数据层文件，跨浏览器持久））
    const addOk = location.protocol.startsWith('http');
    $('mAddBtn').disabled = !addOk;
    $('mAddBtn').title = addOk ? '先探活（拒绝假流/死链），可用才写入个人列表 my-radio.txt' : 'file:// 降级模式无后端，npm start 后可用';
    $('mAddBtn').onclick = async () => {
      const n = $('mAName').value.trim().replace(/[,\r\n|]/g, ' ').slice(0, 40);
      const u = $('mAUrl').value.trim();
      if (!n) { $('status').textContent = '请填写电台名'; return; }
      if (!/^https?:\/\//.test(u)) { $('status').textContent = '流地址需以 http(s):// 开头'; return; }
      const c = $('mACat').value;
      $('mAddBtn').disabled = true; $('mAddBtn').textContent = '探活中…';
      try {
        const r = await fetch('/api/mystation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n, u, c }) }).then(x => x.json());
        if (r.ok) {
          $('mAName').value = $('mAUrl').value = '';
          await this.reloadMain(); // 重拉重并（个人层常驻），列表与面板同步出现新台
          this.renderManage();
          $('status').textContent = `已添加「${n}」到「${c}」（持久于 my-radio.txt，同步不覆盖）`;
        } else $('status').textContent = '添加失败：' + (r.detail || r.error || '未知错误');
      } catch (e) { $('status').textContent = '添加失败：' + (e && e.message || e); }
      $('mAddBtn').disabled = false; $('mAddBtn').textContent = '＋ 添加';
    };

    // 台标：缓存 + 数据文件（http 下才有后端/代理）
    Logos.load();
    if (location.protocol.startsWith('http')) {
      fetch('logos.txt').then(r => r.ok ? r.text() : '').then(t => { Logos.loadFile(t); this.render(); this.logosEnsure(); }).catch(() => this.logosEnsure());
    }

    // 底部控制：未播放时 ▶ = 续播上次收听（按键或 URL 回绑解析）；播放中 = 暂停；暂停 = 继续
    const resumeLast = () => {
      const s = this.resolve(this.recents[0]);
      if (s) Player.play(s); else $('status').textContent = '上次收听的电台已不在列表中，请直接点播';
    };
    Player.onplaylast = resumeLast; // 锁屏/媒体键 play 空台时与 pp 按钮同语义（AIbot P3-1）
    $('pp').onclick = () => {
      if (!Player.station) return resumeLast();
      Player.isPaused() ? Player.resume() : Player.pause();
    };
    $('vol').oninput = e => { Player.setVolume(e.target.value / 100); localStorage.setItem('radio.vol', e.target.value); };

    // 导入列表：csv 风格 txt 与标准 m3u 双格式（P1-1）；本项目导出的收藏备份（#VRADIO:FAV 标记）另恢复收藏态（E4）
    $('importBtn').onclick = () => $('file').click();
    $('exportBtn').onclick = () => this.exportFavs();
    $('file').onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = async () => {
        const text = String(r.result);
        const isFavBackup = text.includes('#VRADIO:FAV');
        const list = this.parse(text);
        if (!list.length) { $('status').textContent = '导入失败：未解析到任何电台（支持 radio.txt / m3u）'; return; }
        if (isFavBackup) {
          // 收藏备份恢复：主列表不动（http 下重拉全量），只恢复收藏态——避免「导入备份后列表只剩收藏」的换机困惑
          for (const s of list) { const k = keyOf(s); if (!this.favs.some(f2 => f2.k === k)) this.favs.push({ k, u: s.u.slice(0, 6) }); }
          const ok = await this.reloadMain();
          if (!ok) { this.rebind(); this.render(); } // file:// 或拉取失败：在当前列表上回绑
          $('status').textContent = `已恢复收藏：${list.length} 个电台`;
        } else {
          let my = [];
          if (location.protocol.startsWith('http')) { // file:// 边界：无后端不拉 my-radio，导入后 = 精选 + 导入列表
            my = await fetch('my-radio.txt').then(r => r.ok ? r.text() : '').then(t => t ? this.parse(t) : []).catch(() => []);
          }
          this.applySources(list, my);
          $('status').textContent = `已导入 ${list.length} 台`;
        }
        $('hint').style.display = 'none';
      };
      r.readAsText(f, 'utf-8');
    };

    // 初始数据：radio.txt + my-radio.txt（http 下），file:// 下回退内置精选 + 手动导入
    this.reloadMain().then(ok => {
      if (!ok) $('hint').style.display = 'block';
      this.logosEnsure();
      // 开机静默体检（B-10）：首屏渲染/台标补全之后 4s 再跑收藏+最近范围，死台自动隐藏无需手动点「体检」
      if (ok) setTimeout(() => Sync.silentHealth(), 4000);
    });
    this.buildCats(); this.render(); this.showLast(); // file:// 降级模式下也补齐「上次收听」提示
  },
};

App.boot();
