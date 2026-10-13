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
const DAY = 86400000; // 死台分档各时间阈值共用（TTL/升级跨度/复测间隔/孤儿清理）

const App = {
  /* 集中状态（docs/review.md 架构-风险 2）：stations 数据 + 渲染哨兵 + 行索引（体检增量更新用，去 O(n²)）
     view：网格/列表视图（boot 从 localStorage 恢复，网格为默认——单列长列表浪费纵向空间）
     showDead：无效源（体检 ✗）台是否显示，默认隐藏（boot 从 localStorage 恢复）
     theme：auto/light/dark，默认跟随系统（boot 从 localStorage 恢复，写 <html data-theme>） */
  state: { stations: STARTER.slice(), cat: '全部', keyword: '', view: 'grid', showDead: false, theme: 'auto', stamp: 0, index: new Map() },
  rowIdx: 0, // 方向键导航落点（UI 审计 P2-5）：roving tabindex——仅此行 tabindex=0，Tab 不再穿全库停靠点
  favs: [],    // [{k, u:[源URL…]}] —— 带 URL 的条目永不回收（休眠待回绑），旧名字键回绑失败即刻回收
  recents: [], // [{k, n, u:[…]}] 最近在前、≤20；队首即「上次收听」（E3 与 lastKey 合并为单一队列）
  cfg: null,   // 个人维护层（radio.cfg，owner 三批拍板）：分类重命名/隐藏/自建 + 电台移动/重命名/隐藏 + 追加备选源（P1-a/r2 ⑨）。
               // 键 = 源 URL（身份公理），同步重建后自动复用；tag = URL→原始台名快照，仅供失配清单显示
  songFor: '', lastSong: '', // 曲讯（B-6/B-7）：songFor=曲讯归属台（切台即清零重取）；lastSong=最近一次拿到的曲名（换歌时旧歌入史）

  /* ---------- 持久化（localStorage 全部容错读取 + 旧格式迁移） ---------- */
  loadStore() {
    let favs; try { favs = JSON.parse(Store.get('radio.favs') || '[]'); } catch (_) { favs = []; }
    this.favs = (Array.isArray(favs) ? favs : []).map(f => typeof f === 'string' ? { k: f, u: [] } : { k: String(f.k), u: Array.isArray(f.u) ? f.u : [] });
    let rec; try { rec = JSON.parse(Store.get('radio.recents') || '[]'); } catch (_) { rec = []; }
    rec = Array.isArray(rec) ? rec : [];
    const last = localStorage.getItem('radio.last'); // 旧「上次收听」键 → 并入 recents 队首
    if (last && !rec.some(r => r.k === last)) rec.unshift({ k: last, n: '', u: [] });
    localStorage.removeItem('radio.last');
    this.recents = rec.slice(0, 20).map(r => ({ k: String(r.k), n: r.n || String(r.k).split('|').pop() || '', u: Array.isArray(r.u) ? r.u : [] }));
    // 死台标记持久化（radio.health）：键 → { u:[源URL快照], t:最近确认, t0:首死, n:连续确认数, perm:1=停运档 }。
    // 分档（grill R1-R4 拍板）：疑似档兜底 TTL 180 天（纯数据卫生——静默复测常态化下唯一触发场景 = 半年没开
    // 页面，复活反而是合理探测）；停运档永不过期（复活只走复测撤销，即 patchHealth 的 ok 分支）；
    // ✓ 标记不持久化（会话级反馈即可，隐藏只关心死台）。旧数据兼容：无 t0/n/perm 按「疑似档、n=1、t0=t」读
    let hp; try { hp = JSON.parse(Store.get('radio.health') || '{}'); } catch (_) { hp = {}; }
    this.healthMarks = {};
    for (const k of Object.keys(hp || {})) {
      const e = hp[k]; if (!e || !Array.isArray(e.u)) continue;
      if (!e.perm && Date.now() - (e.t || 0) >= 180 * DAY) continue;
      this.healthMarks[k] = { u: e.u, t: e.t || 0, t0: e.t0 || e.t || 0, n: Math.max(1, e.n | 0), perm: e.perm ? 1 : 0 };
    }
  },
  saveFavs() { Store.set('radio.favs', JSON.stringify(this.favs)); },
  saveRecents() { Store.set('radio.recents', JSON.stringify(this.recents)); },
  saveHealth() { // FIFO 分档封顶（R4 拍板：疑似 1000 + 停运 1000；时间序扫描，停运档最后才挤——只增不减的
    // 停运台天然封顶于 radio.txt 在列数，2000 条合计约 1MB，5MB 配额内可控）
    const ks = Object.keys(this.healthMarks).sort((a, b) => (this.healthMarks[a].t || 0) - (this.healthMarks[b].t || 0));
    let n1 = 0, n2 = 0;
    for (const k of ks) { if (this.healthMarks[k].perm) { if (++n2 > 1000) delete this.healthMarks[k]; } else if (++n1 > 1000) delete this.healthMarks[k]; }
    Store.set('radio.health', JSON.stringify(this.healthMarks));
  },

  /* ---------- 维护配置（radio.cfg）：localStorage 全部容错读取，结构与导入共用一套校验 ---------- */
  loadCfg() {
    let c; try { c = JSON.parse(Store.get('radio.cfg') || 'null'); } catch (_) { c = null; }
    this.cfg = this.normCfg(c);
  },
  normCfg(c) { // 结构校验/补齐（导入的 JSON 也走这里，坏形状回退空配置）
    c = c && typeof c === 'object' && !Array.isArray(c) ? c : {};
    for (const k of ['moves', 'names', 'tag']) c[k] = this.normStrMap(c[k]);                      // URL → 字符串
    c.renames = this.normStrMap(c.renames, true);                                                // 分类名 → 分类名（键非 URL，不做 URL 过滤）
    const urlKeys = m => Object.fromEntries(Object.entries(m).filter(([k]) => /^https?:\/\//.test(k)));
    c.hideS = c.hideS && typeof c.hideS === 'object' ? urlKeys(c.hideS) : {};                   // URL → 1（手藏电台）
    // 追加备选源（P1-a/r2 ⑨）：URL → [追加源 URL…]。条数 6 / 单条 512 封顶对齐 mystation 护栏口径；只追加不动身份
    const urlArrMap = m => { const o = {}; for (const [k, v] of Object.entries(m || {})) if (/^https?:\/\//.test(k) && Array.isArray(v)) { const a = [...new Set(v.map(x => String(x).trim().slice(0, 512)).filter(x => /^https?:\/\//.test(x)))].slice(0, 6); if (a.length) o[k.trim()] = a; } return o; };
    c.srcs = urlArrMap(c.srcs);
    const strKeys = m => Object.fromEntries(Object.entries(m).filter(([k, v]) => typeof k === 'string' && k.trim() && v !== null && v !== false));
    c.hideC = c.hideC && typeof c.hideC === 'object' ? strKeys(c.hideC) : {};                   // 分类名 → 1（藏分类）
    if (!Array.isArray(c.cats)) c.cats = [];
    c.cats = [...new Set(c.cats.filter(x => typeof x === 'string' && x.trim() && !x.includes('|')).map(x => x.trim()))];
    return c;
  },
  normStrMap(m, anyKey) { const o = {}; for (const [k, v] of Object.entries(m || {})) if (typeof v === 'string' && v.trim() && (anyKey || /^https?:\/\//.test(k))) o[k.trim()] = v.trim(); return o; },
  saveCfg() { Store.set('radio.cfg', JSON.stringify(this.cfg)); },

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
    for (const s of this.state.stations) { s.dCat = s.c; s.dName = s.n; s.dU = s.u.slice(); } // 同步默认口径留底（面板 ↺恢复/撤回移动/撤回追加源用）
    this.applyCfg(); // 维护层最后套用（覆盖分类/台名/隐藏，收藏随后按 URL 回绑不受影响）
    this.rebind(); // 收藏/最近按 URL 回绑（债务 1）——一轮即够（audit B1：历史双调，幂等但白做一遍全量回绑 + 3 次落盘）
    this.render();
    if (!Player.station) this.showLast();
  },
  /* 维护层套用：电台移动/重命名/手动隐藏/追加源按「任一源 URL 命中」（变体换序免疫）；
     手动隐藏 = 彻底消失（全部/收藏/搜索/体检一律不可见，owner 拍板无正在播例外——手动是明确意图，
     与死台隐藏的「正在播例外」口径不同）；分类重命名最后映射（移动目标在改名时已级联改写） */
  applyCfg() {
    const { moves, names, hideS, renames, srcs } = this.cfg;
    for (const s of this.state.stations) {
      s.hidden = false;
      for (const u of s.u) {
        if (hideS[u]) s.hidden = true;
        if (moves[u]) s.c = moves[u];
        if (names[u]) s.n = names[u];
      }
      // 追加备选源（P1-a/r2 ⑨）：只挂到台尾——绝不插前/改删原源（s.u[0] 是 srcmem/收藏/健康标记的身份键，
      // 动了四处回绑全断）；先收集后 push，避免遍历中修改 s.u。variants()/srcmem 天然吃新序列，无需另行接线
      const add = [];
      for (const u of s.u) { const a = srcs[u]; if (a) for (const x of a) if (!s.u.includes(x) && !add.includes(x)) add.push(x); }
      if (add.length) s.u.push(...add);
      if (renames[s.c]) s.c = renames[s.c];
    }
  },
  reapplyCfg() { // 面板改动后即时生效：回滚到装配默认再重套，并重走回绑/分类条/渲染/面板自身。
    // u 也随留底回滚——追加源每次从 cfg 重放，撤除/移除即刻生效（P1-a）
    for (const s of this.state.stations) { if (s.dCat !== undefined) { s.c = s.dCat; s.n = s.dName; s.u = s.dU.slice(); } }
    this.applyCfg();
    this.rebind(); this.render(); this.renderManage();
  },
  /* 主列表（radio.txt）+ 个人层（my-radio.txt）重拉重并；仅 http:// 下可用（file:// 下 fetch 必失败，P3-12 同源守卫） */
  async reloadMain() {
    if (!location.protocol.startsWith('http')) return false;
    const get = f => fetch(f + '?t=' + Date.now()).then(r => r.ok ? r.text() : Promise.reject()).catch(() => null); // 双文件同口径穿透缓存（audit D2：添台后 my-radio 旧缓存会让新台不出现）
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
    // 键与 URL 快照随之刷新（t0/n/perm 档位随行，t 保留原值——回绑不是复测，不刷新确认时间）；
    // 回绑不上的休眠孤儿 90 天清理（R4 拍板：上游都找不到这个台了，留着只占 FIFO 配额）
    const hm = {};
    for (const k of Object.keys(this.healthMarks)) {
      const e = this.healthMarks[k];
      const st = this.state.stations.find(s => keyOf(s) === k)
        || (e.u.length && this.state.stations.find(s => s.u.some(u => e.u.includes(u))));
      if (st) { st.health = 'dead'; st.perm = e.perm; hm[keyOf(st)] = { ...e, u: st.u.slice(0, 6) }; }
      else if (Date.now() - e.t0 < 90 * DAY) hm[k] = e;
    }
    this.healthMarks = hm; this.saveHealth();
    this.saveFavs(); this.saveRecents();
  },
  favKeys() { return new Set(this.favs.map(f => f.k)); },
  /* Store 对账后的内存全量重载（方案二：boot 异步对账/多标签重拉/恢复备份共用）——station 对象本身不动
     （Player 引用着），只重载收藏/最近/健康标记/配置与 Player 记忆，再回绑渲染 */
  /* UI 态三键（view/showdead/theme）DOM 同步 + 镜像读取（audit C4）：boot 装载与他页 Store 对账联动
     （applyServerStore）共用——他页改写后本页即时跟随，此前要刷新才生效 */
  syncViewUI() {
    $('gridBtn').classList.toggle('on', this.state.view === 'grid'); $('gridBtn').setAttribute('aria-pressed', String(this.state.view === 'grid'));
    $('listBtn').classList.toggle('on', this.state.view === 'list'); $('listBtn').setAttribute('aria-pressed', String(this.state.view === 'list'));
  },
  syncDeadUI() {
    $('deadBtn').classList.toggle('on', this.state.showDead); $('deadBtn').setAttribute('aria-pressed', String(this.state.showDead));
  },
  syncThemeUI() { // this.mq 由 boot 装配（auto 态系统切换监听也在那）；未装配时现取（matches 只读，无副作用）
    const mq = this.mq || matchMedia('(prefers-color-scheme: light)');
    document.documentElement.dataset.theme = this.state.theme === 'auto' ? (mq.matches ? 'light' : 'dark') : this.state.theme;
    const tn = { auto: '跟随系统', light: '浅色', dark: '深色' }[this.state.theme];
    $('themeBtn').innerHTML = { auto: '<svg class="ic"><use href="#i-auto"/></svg>', light: '<svg class="ic"><use href="#i-sun"/></svg>', dark: '<svg class="ic"><use href="#i-moon"/></svg>' }[this.state.theme];
    $('themeBtn').setAttribute('aria-label', '主题：' + tn + '，点击切换');
    $('themeBtn').title = '主题：' + tn + '（点击循环：跟随系统 → 浅色 → 深色）';
  },
  loadUi3() { // 三键从镜像读入 + 刷 DOM（boot 装载与 applyServerStore 对账联动共用）
    this.state.view = Store.get('radio.view') === 'list' ? 'list' : 'grid'; // 网格为默认
    this.state.showDead = Store.get('radio.showdead') === '1'; // 默认隐藏无效台
    const th = Store.get('radio.theme');
    this.state.theme = ['auto', 'light', 'dark'].includes(th) ? th : 'auto';
    this.syncViewUI(); this.syncDeadUI(); this.syncThemeUI();
  },
  applyServerStore() {
    this.loadStore(); this.loadCfg();
    Player.reloadMems();
    for (const s of this.state.stations) { s.health = ''; s.perm = 0; } // 清旧标记由 rebind 按 healthMarks 重挂
    this.loadUi3(); // view/showdead/theme 三 UI 态随对账联动（audit C4）
    this.rebind(); this.render(); this.renderManage();
  },
  /* 同步消失名单 × 收藏比对（N4/r2 ⑥）：双通道——显示名 + 消失台 URL 集合（AIbot P3-1：经维护面板本地
     改名的收藏台键名已换、按名会漏，URL 快照按身份公理仍对得上）。必须在 reloadMain 之后调用——
     URL 回绑已救回「改名台」（新名不在消失名单，天然不误报），撞上名单/URL 且当前解析不到的才是真消失 */
  favsGone(names, urls) {
    const set = new Set(names || []), uset = new Set(urls || []), hits = [];
    for (const f of this.favs) {
      const nm = f.k.slice(f.k.lastIndexOf('|') + 1);
      if ((set.has(nm) || f.u.some(u => uset.has(u))) && !this.resolve(f)) hits.push(nm);
    }
    return hits;
  },
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
  scopeDead(now = Date.now()) { // 死标记台复测范围（R4 节流拍板，语义全保留）：t 距今超档位间隔（疑似 24h/
    // 停运 7 天）才入列，最旧优先、每 boot 封顶 200 轮转——FIFO 顶格 2000 时把最坏单次后台探活从 1-2 小时
    // 压回分钟级，终止对已停运台的永久日级探测；档内标记多于 200 时按 t 轮转全覆盖
    const out = []; // O(标记数×台数) 的 find（FIFO 顶格 2000×1600+≈3M 次）：每次 boot 一次性可接受（AIbot P3-6 备忘，量级上来再做 URL→台索引）
    for (const k of Object.keys(this.healthMarks)) {
      const e = this.healthMarks[k];
      if (now - (e.t || 0) < (e.perm ? 7 : 1) * DAY) continue;
      const st = this.state.stations.find(s => keyOf(s) === k)
        || this.state.stations.find(s => s.u.some(u => e.u.includes(u)));
      if (st && !st.hidden) out.push([e.t || 0, st]);
    }
    return out.sort((a, b) => a[0] - b[0]).slice(0, 200).map(x => x[1]);
  },
  baselineList() { // 首启基线范围（R4 拍板）：无体检证据的国内台——欧美两分类同步期已逐个实测跳过
    // （dCat = 维护层套用前的默认分类留底，免疫分类重命名/单台移动的显示层改写）
    return this.visible(true).filter(s => !['欧美音乐', '国际新闻·谈话'].includes(s.dCat || s.c));
  },
  toast(msg, opt = {}) { // 极简 toast（R1 拍板新增）：后台任务专用（增量体检/自动基线/多标签提示），
    // 用户主动操作走 #status——两通道不双写，读屏器不念两遍（R4 分工规则）。action = {label, fn} 确认门槛用；
    // dismiss = 「暂不」类纯关闭按钮的文案（常驻 toast 的显式出口，AIbot P3-5）
    const t = $('toast');
    t.innerHTML = '';
    const sp = document.createElement('span'); sp.textContent = msg; t.appendChild(sp);
    if (opt.action) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn mbtn';
      b.textContent = opt.action.label; b.onclick = () => { t.hidden = true; opt.action.fn(); };
      t.appendChild(b);
    }
    if (opt.dismiss) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn mbtn';
      b.textContent = opt.dismiss; b.onclick = () => { t.hidden = true; };
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(this._toastT);
    if (opt.ms !== 0) this._toastT = setTimeout(() => { t.hidden = true; }, opt.ms || 4000);
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
    return `<button type="button" class="fav${on ? ' on' : ''}" data-fav="${this.esc(k)}" aria-pressed="${on}" aria-label="${on ? '取消收藏' : '收藏'}：${this.esc(s.n)}" title="${on ? '取消收藏' : '收藏'}">${on ? '<svg class="ic"><use href="#i-star-filled"/></svg>' : '<svg class="ic"><use href="#i-star"/></svg>'}</button>`;
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
    // 数量角标（UI 审计 P3-5，owner 拍板）：与 visible() 同口径的可见台数，帮用户预判列表规模
    const cc = this.catCounts();
    const cnt = c => c === '全部' ? cc.all : c === '★收藏' ? cc.favN : c === '最近' ? cc.recN : (cc.m.get(c) || 0);
    // 互斥单选语义用 aria-current（aria-pressed 是独立开关语义，不适用）
    $('cats').innerHTML = cats.map(c => `<button type="button" class="chip${c === this.state.cat ? ' on' : ''}" data-c="${this.esc(c)}"${c === this.state.cat ? ' aria-current="true"' : ''}>${this.esc(c)}<i class="n">${cnt(c)}</i></button>`).join('');
    restore();
    this.updateCatsFade();
  },
  /* chip 角标计数：手动隐藏/藏分类不计；死台默认隐藏不计（正在播/连接中例外，与 visible 一致） */
  catCounts() {
    const pk = Player.station && keyOf(Player.station), ck = Player.connecting && keyOf(Player.connecting), favs = this.favKeys();
    const m = new Map(); let all = 0, favN = 0;
    for (const s of this.state.stations) {
      if (s.hidden || this.cfg.hideC[s.c]) continue;
      if (s.health === 'dead' && !this.state.showDead && keyOf(s) !== pk && keyOf(s) !== ck) continue;
      all++; if (favs.has(keyOf(s))) favN++;
      m.set(s.c, (m.get(s.c) || 0) + 1);
    }
    const recN = this.recents.slice(0, 20).filter(r => {
      const s = this.resolve(r);
      return s && !s.hidden && !this.cfg.hideC[s.c] && (this.state.showDead || s.health !== 'dead' || keyOf(s) === pk || keyOf(s) === ck);
    }).length;
    return { m, all, favN, recN };
  },
  /* 分类条两端渐隐（UI 审计 P3-5）：滚动位置离端点远才渐隐该端，提示横向可滚（细滚动条已在 CSS） */
  updateCatsFade() {
    const c = $('cats');
    c.classList.toggle('fade-l', c.scrollLeft > 4);
    c.classList.toggle('fade-r', c.scrollLeft + c.clientWidth < c.scrollWidth - 4);
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
    this.buildCats(); // 角标与列表同源刷新（AIbot PR#9 review P2-a）：render 内统一调，调用方无需再单独调 buildCats
    const restore = this.keepFocus($('list'), 'k', 'fav'); // 焦点在行/卡片或按钮上都找回
    const list = this.visible();
    $('deadBtn').hidden = !this.state.stations.some(s => s.health === 'dead'); // 出现过死台才亮「无效源」开关
    this.state.stamp++;
    this.state.index = new Map(list.map((s, i) => [s, i])); // 行索引（体检增量更新用，替代 indexOf 的 O(n²)）
    const pk = Player.station && keyOf(Player.station), ck = Player.connecting && keyOf(Player.connecting);
    const favs = this.favKeys(), grid = this.state.view === 'grid';
    $('list').className = grid ? 'grid' : '';
    const ri = Math.min(this.rowIdx || 0, list.length - 1); // roving tabindex（P2-5）：仅落点行可 Tab 停靠
    $('list').innerHTML = list.map((s, i) => {
      const k = keyOf(s), on = favs.has(k), playing = k === pk;
      const base = `${playing ? ' playing' : ''}${k === ck ? ' connecting' : ''}${s.health === 'dead' ? ' dead' : ''}`;
      // title=全名（UI 审计 P3-9）：截断长名（最长 84 字）此前无处可看全名；死台按档位叠加提示（R1 拍板分文案）
      const attrs = `data-k="${this.esc(k)}" data-i="${i}" role="listitem" tabindex="${i === ri ? 0 : -1}" aria-label="${this.esc(s.n)}${playing ? '（播放中）' : ''}"${playing ? ' aria-current="true"' : ''} title="${this.esc(s.n)}${s.health === 'dead' ? (s.perm ? '（长期确认停运）' : '（疑似不可达，点击仍可尝试播放）') : ''}"`;
      const hp = s.health ? `<span class="health ${s.health === 'ok' ? 'ok' : 'bad'}" title="体检${s.health === 'ok' ? '可用' : (s.perm ? '长期确认停运' : '疑似不可用')}">${s.health === 'ok' ? '<svg class="ic"><use href="#i-check"/></svg>' : '<svg class="ic"><use href="#i-x"/></svg>'}</span>` : '';
      // 信息降噪（UI 审计 P2-1/P2-2，owner 拍板）：① 台名剥离「[国别]」后缀进 meta（搜索/aria/身份仍用全名，
      // 数据层不动）；② meta 行按视图降级——分类 badge 只在 全部/收藏/最近 显示（分类视图下 100% 冗余），
      // 源数只在 ≥2 源时显示；国别在 meta 与源数并列展示
      const cm = s.n.match(/\s*\[([^\]]+)\]\s*$/), cn = cm ? cm[1] : '', dn = cm ? s.n.slice(0, s.n.length - cm[0].length) : s.n;
      const inCat = this.state.cat !== '全部' && this.state.cat !== '★收藏' && this.state.cat !== '最近';
      const parts = `${s.perm ? '<span class="badge permb" title="长期确认停运（复测可达会自动回归）">已停运</span>' : ''}${!inCat ? `<span class="badge">${this.esc(s.c)}</span>` : ''}${cn ? `<span class="srcs" title="国家/地区">${this.esc(cn)}</span>` : ''}${s.u.length > 1 ? `<span class="srcs" title="备选源数量">${s.u.length}源</span>` : ''}`;
      const cfoot = (parts || hp) ? `<div class="cfoot">${parts}${hp}</div>` : '';
      if (grid) return `<div class="card${base}" ${attrs}><div class="chead">${Logos.visual(s)}<span class="cname">${this.esc(dn)}</span>${this.favBtn(k, on, s)}</div>${cfoot}</div>`;
      const meta = parts ? `<div class="meta">${parts}</div>` : '';
      return `<div class="row${base}" ${attrs}>${this.favBtn(k, on, s)}<div class="col"><div class="l1">${Logos.visual(s)}<span class="name">${this.esc(dn)}</span>${hp}</div>${meta}</div></div>`;
    }).join('') || this.emptyHtml();
    restore();
    const ae = document.activeElement; // 重渲后焦点行找回（keepFocus）：同步 roving 落点，防 Tab 跳回别行
    if (ae && ae.dataset && ae.dataset.i != null) this.rowIdx = +ae.dataset.i;
    // 定位闪烁窗口（N5/r2 ⑦）：flash 生效期内的重渲保持高亮与视口（1s 超时后不干扰常规浏览）
    if (this._flashK) {
      const fr = $('list').querySelector(`[data-k="${CSS.escape(this._flashK)}"]`);
      if (fr) { fr.classList.add('flash'); fr.scrollIntoView({ block: 'center' }); }
    }
  },
  /* 方向键导航落点（UI 审计 P2-5）：焦点搬家 + 滚动跟随；搜索框 ↓ 也落到列表首行 */
  focusRow(i) {
    const t = $('list').querySelector(`[data-i="${i}"]`);
    if (!t) return;
    const p = $('list').querySelector('[tabindex="0"]'); // roving 落点随焦点搬家（AIbot PR#9 review P3-1）：Tab 离开列表再回来不跳回旧行
    if (p && p !== t) p.tabIndex = -1;
    t.tabIndex = 0;
    this.rowIdx = i; t.focus(); t.scrollIntoView({ block: 'nearest' });
  },
  /* 切换淡入（E 批）：swap 类挂期间行/卡片 140ms 淡入；搜索逐键重渲不挂类不闪；reduced-motion 由 CSS 关 */
  swapRender() {
    const l = $('list');
    l.classList.add('swap');
    this.render();
    clearTimeout(this._swapT);
    this._swapT = setTimeout(() => l.classList.remove('swap'), 160);
  },
  /* 体检增量落库（sync.js 调用）：stamp 未变时顺手更新该行 DOM，否则只落数据由结束时的兜底 render 收口（P3-13）。
     healthMarks 只改内存，落盘由 Sync 各收尾统一一次——全量体检标死几百台时逐台全量写 localStorage 会卡主线程；
     复活即撤销标记，体检结束的兜底 render 会让它回归列表。返回档位（'ok'|'sus'|'perm'）供编排方分档统计 */
  patchHealth(s, ok, stamp) {
    const k = keyOf(s);
    s.health = ok ? 'ok' : 'dead';
    if (ok) { s.perm = 0; delete this.healthMarks[k]; }
    else {
      const old = this.healthMarks[k], now = Date.now();
      const t0 = old ? old.t0 : now, n = old ? (old.n || 1) + 1 : 1;
      // 升级停运档（D1 拍板）：复测连续确认 ≥3 次且首死 ≥30 天——单次探活分不出「停运」与「被墙/运维」，
      // 分档证据只能来自持续复测（时长×次数），30 天跨度防短窗口网络抖动误升级
      const perm = (old && old.perm) || (n >= 3 && now - t0 >= 30 * DAY) ? 1 : 0;
      s.perm = perm;
      this.healthMarks[k] = { u: s.u.slice(0, 6), t: now, t0, n, perm };
      $('deadBtn').hidden = false; // 首个死台出现即亮开关
    }
    const r = ok ? 'ok' : (s.perm ? 'perm' : 'sus');
    if (this.state.stamp !== stamp) return r;
    const row = $('list').querySelector(`[data-i="${this.state.index.get(s)}"]`); // 行/卡片通用
    if (!row) return r;
    if (!ok && !this.state.showDead
      && !(Player.station && keyOf(Player.station) === k) && !(Player.connecting && keyOf(Player.connecting) === k)) {
      row.remove(); return r; // 默认隐藏：死台行当场消失，与 visible() 口径一致（正在播/连接中的台不消失）
    }
    row.classList.toggle('dead', !ok);
    row.title = s.n + (ok ? '' : (s.perm ? '（长期确认停运）' : '（疑似不可达，点击仍可尝试播放）')); // 与整表 render 的 title 口径一致（AIbot PR#9 review P3-5）
    const old2 = row.querySelector('.health'); if (old2) old2.remove();
    const sp = document.createElement('span'); sp.className = 'health ' + (ok ? 'ok' : 'bad');
    sp.title = ok ? '体检可用' : (s.perm ? '体检长期确认停运' : '体检疑似不可用');
    sp.innerHTML = ok ? '<svg class="ic"><use href="#i-check"/></svg>' : '<svg class="ic"><use href="#i-x"/></svg>';
    // meta 行按视图降级后（UI 审计 P2-1）分类视图的卡片可能没有 cfoot：兜底挂到 chead（台名行）
    const tgt = row.querySelector('.cfoot, .l1, .chead'); if (tgt) tgt.appendChild(sp);
    return r;
  },

  togglePlay(k) { // 再点当前台 = 暂停/继续；点其他台 = 切换
    const s = this.state.stations.find(x => keyOf(x) === k); if (!s) return;
    if (Player.station && keyOf(Player.station) === k) {
      Player.isPaused() ? Player.resume() : Player.pause();
      return;
    }
    this.startPlay(s);
  },
  startPlay(s, prefer) { // 点播装配共用（remember + 台标 + 最近重排）；prefer=手动指定源序号（②：footer 浮层/⚙ 面板传入，当次最高优先）
    this.remember(s);
    this.logosEnsure(); // 正在播的台也优先补台标
    if (this.state.cat === '最近') this.render(); // 最近队列头插后刷新顺序
    Player.play(s, prefer);
  },
  stepFav(d) { // ←/→ 在收藏间切台（A-5）：顺序取当前可见列表内的收藏台；当前台不在收藏则从队首/队尾起步
    const favs = this.favKeys();
    const list = this.visible().filter(s => favs.has(keyOf(s)));
    if (!list.length) { $('status').textContent = '还没有收藏电台——点电台旁 ☆ 收藏后可用 ←/→ 键切换'; return; } // 「旁」：网格视图收藏钮在卡片右侧（audit C5）
    const cur = Player.station ? list.findIndex(s => keyOf(s) === keyOf(Player.station)) : -1;
    const nx = cur < 0 ? (d > 0 ? 0 : list.length - 1) : (cur + d + list.length) % list.length;
    this.togglePlay(keyOf(list[nx]));
  },
  /* 回到正在播（N5/r2 ⑦）：点 footer 台名定位列表行——当前分类/搜索词下不可见则先切「全部」+清搜索；
     台被手动隐藏/死台隐藏时行不存在，静默不跳（与 visible() 口径一致，不报错） */
  locatePlaying() {
    const s = Player.station;
    if (!s) return;
    const k = keyOf(s);
    if (!this.visible().some(x => keyOf(x) === k)) {
      this.state.cat = '全部'; this.state.keyword = ''; $('q').value = '';
    }
    this.render(); // 整表重建：定位必须放在 render 之后
    const row = $('list').querySelector(`[data-k="${CSS.escape(k)}"]`);
    if (!row) return;
    const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ block: 'center', behavior: rm ? 'auto' : 'smooth' });
    row.classList.add('flash'); // 立即挂（此时 _flashK 尚未设置，render 尾部管的是后续重渲）
    this._flashK = k;
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => {
      this._flashK = '';
      for (const x of $('list').querySelectorAll('.flash')) x.classList.remove('flash');
    }, 1000);
  },

  /* 台标补全（收藏 + 正在播优先，请求量可控）：Logos.ensure 落库后回调重渲一次展示；
     正在播台的台标若此刻才解析到，顺手刷一次锁屏元数据（r2 ⑩——ICY 曲讯 setSong 只覆盖直流台，
     m3u8 台等不到换歌，后解析的台标在这里补上） */
  logosEnsure() {
    if (!location.protocol.startsWith('http')) return;
    const seen = new Set(), list = [];
    for (const f of this.favs) { const s = this.resolve(f); if (s && !seen.has(keyOf(s))) { seen.add(keyOf(s)); list.push(s); } }
    if (Player.station && !seen.has(keyOf(Player.station))) list.push(Player.station);
    Logos.ensure(list, () => { this.render(); if (Player.station) Player.setSong(this.lastSong); });
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
      $('nowline').textContent = s.n;
      $('nowline').classList.add('canfind'); $('nowline').title = '点击回到正在播的电台（N5）'; // 台名可点定位（r2 ⑦）
      $('pp').innerHTML = (Player.connecting || !Player.isPaused()) ? '<svg class="ic"><use href="#i-pause"/></svg>' : '<svg class="ic"><use href="#i-play"/></svg>'; // 台名不再带 ▶（UI 审计 P3-4）：与列表行的 ▶ 前缀重复，footer 已有按钮+均衡器表达状态
    } else { $('pp').innerHTML = '<svg class="ic"><use href="#i-play"/></svg>'; this.showLast(); $('song').hidden = true; $('nowline').classList.remove('canfind'); $('nowline').title = ''; }
    $('eq').classList.toggle('on', !!s && !Player.isPaused()); // 均衡器动画（E6）：活着且在播
    // 选源按钮（②a）：多源台且播/暂停中才亮（按次渲染动态判定——同步后单源变多源自动出现）；切台后浮层过期即收起
    $('srcWrap').hidden = !(s && s.u.length > 1);
    if (!$('srcMenu').hidden && this.srcPopK !== (s ? keyOf(s) : '')) this.srcPopClose();
  },

  /* ---------- footer 选源浮层（②a/grill 拍板）：正在听时发现源不好，四步深的 ⚙ 面板救不了急——
     这里是主入口（⚙ 为管理+预选源的双入口副）。内容随打开时刻重算，级联中不自动跳变 ---------- */
  srcPopK: '',
  srcPopClose() { // 收起选源浮层统一口（Esc/点外/行点击/切台收起，AIbot P2-1/P3-4）：焦点原在浮层内则还给源按钮，键盘流连续开关不掉焦
    const m = $('srcMenu');
    if (m.hidden) return;
    const back = m.contains(document.activeElement);
    m.hidden = true; $('srcBtn').setAttribute('aria-expanded', 'false');
    if (back && !$('srcWrap').hidden) $('srcBtn').focus(); // 单源台切台收起时按钮已隐藏，focus 无落点则跳过
  },
  renderSrcPop() {
    const s = Player.station;
    if (!s || s.u.length < 2) return;
    this.srcPopK = keyOf(s);
    const dft = Player.srcOrder(s)[0], mem = Player.srcMem[s.u[0]];
    const okMem = mem && Number.isInteger(mem.i) && mem.i >= 0 && mem.i < s.u.length; // 与 play() 同口径（AIbot P3-2）：坏形状/越界按无记忆，序号不再经 innerHTML 进 DOM
    const rows = s.u.map((u, i) => `<button type="button" class="btn srcrow${Player.curSi === i ? ' cur' : ''}" data-i="${i}" title="${this.esc(u)}">
      <i class="idx">${i + 1}</i><span class="u">${this.esc(u)}</span>${this.srcBadges(s, i, dft)}
    </button>`).join('');
    $('srcMenu').innerHTML = `<div class="st">${this.esc(s.n)} · ${s.u.length} 个源，点行切换（失败自动顺延）</div>` + rows
      // 记忆源=默认源时按钮自指（清了又立刻记回同源，AIbot P3-1），不渲染
      + (okMem && mem.i !== dft ? `<button type="button" class="btn srcrow" data-act="srcreset" title="清掉「上次成功的源」记忆，立即从默认源（直流优先）重播"><svg class="ic"><use href="#i-undo"/></svg><span>恢复默认源（忘掉源 ${mem.i + 1} 的记忆）</span></button>` : '');
    $('srcMenu').hidden = false;
    $('srcBtn').setAttribute('aria-expanded', 'true');
    $('srcMenu').querySelector('button')?.focus(); // 与睡眠菜单同口径：开即移焦
  },
  srcReset() { // 恢复默认源（②c/grill 拍板）：清当前台 srcmem + 立即按启发式默认重播
    const s = Player.station; if (!s) return;
    const had = Player.forgetSrc();
    this.startPlay(s); // 无 prefer 且记忆已清 → 纯启发式序
    $('status').textContent = had ? '已恢复默认源，从默认源重播' : '本无源记忆，按默认序重播';
  },

  /* ---------- 曲讯（B-6）：轮询 /api/nowplaying 取正在播台的 ICY 曲名 ----------
     只对「正在播 + 未暂停 + 页面可见」的台取（http 形态）；m3u8 结构性无 ICY 不空耗探活；
     换歌时旧曲名入史（B-7）+ 曲名写 MediaSession（锁屏同步显示） */
  async tickSong() {
    const s = Player.station;
    if (!s || Player.isPaused() || document.hidden || !location.protocol.startsWith('http')) return;
    const raw = Player.curUrl;
    if (!raw || /\.m3u8(\?|$)/i.test(raw)) return;
    let j;
    try { j = await fetch('/api/nowplaying?url=' + encodeURIComponent(raw)).then(x => x.json()); } catch (_) { return; }
    const t = (j && j.title) || '';
    if (!Player.station || keyOf(Player.station) !== this.songFor) return; // 轮询期间切台：丢弃过期结果
    if (t === this.lastSong) return;
    if (this.lastSong && t) this.pushSongHist(s.u[0], this.lastSong); // 换歌：旧歌入史（B-7，键=台主 URL——身份公理，改名/换分类不丢）
    this.lastSong = t;
    if (t) { $('song').textContent = '♪ ' + t + (j && +j.br > 0 ? ' · ' + j.br + 'kbps' : ''); $('song').hidden = false; Player.setSong(t); } // 码率（③）：ICY 直流才有，随曲讯同帧到达
  },

  /* ---------- 歌曲历史（B-7）：换歌时旧歌入史（当前曲只显示不入史），按台主 URL 存 localStorage（radio.songs，身份公理——AIbot P3-6） ---------- */
  pushSongHist(u0, title) {
    if (!title) return;
    let songs; try { songs = JSON.parse(Store.get('radio.songs') || '{}'); } catch (_) { songs = {}; }
    const list = songs[u0] || [];
    if (!list.length || list[0].t !== title) { list.unshift({ t: title, at: Date.now() }); songs[u0] = list.slice(0, 12); } // 每台 12 首封顶
    const ks = Object.keys(songs).sort((a, b) => (songs[b][0] ? songs[b][0].at : 0) - (songs[a][0] ? songs[a][0].at : 0));
    for (const x of ks.slice(50)) delete songs[x]; // 台数 50 FIFO（按最近有歌活动排序砍最旧）
    Store.set('radio.songs', JSON.stringify(songs));
  },
  toggleSongHist() { // 点击曲名行：本台最近播放浮层（当前曲在曲名行本身，不入列）
    const el = $('songhist');
    if (!el.hidden) { el.hidden = true; return; }
    if (!Player.station) return;
    let songs; try { songs = JSON.parse(Store.get('radio.songs') || '{}'); } catch (_) { songs = {}; }
    const list = (songs[Player.station.u[0]] || []).slice(0, 12); // 同 pushSongHist 的 URL 键
    el.innerHTML = '<div class="shhead"><b>本台最近播放</b><button type="button" class="btn mbtn" data-act="exportsongs" title="导出所有台的收听历史为 txt（拿去音乐 App 搜）">导出全部</button></div>' + (list.length
      ? list.map(x => `<div class="shrow">${this.esc(x.t)}</div>`).join('')
      : '<div class="shrow" style="color:var(--dim)">暂无历史（换歌后自动记录）</div>');
    el.hidden = false;
    $('keys').hidden = true; // 与快捷键浮层互斥（AIbot P3-3）：同位会重叠，开一方关另一方
    el.querySelector('[data-act="exportsongs"]').onclick = () => this.exportSongs();
  },
  exportSongs() { // 歌曲历史导出（N2/r2 ④）：全部台历史按时间倒序拼 txt；台名按台主 URL 反解，休眠台用 URL 截断兜底
    let songs; try { songs = JSON.parse(Store.get('radio.songs') || '{}'); } catch (_) { songs = {}; }
    const rows = [];
    for (const u0 of Object.keys(songs)) {
      const st = this.state.stations.find(s => s.u.includes(u0));
      const nm = st ? st.n : u0.replace(/^https?:\/\//, '').slice(0, 40);
      for (const it of songs[u0] || []) rows.push({ t: it.t, at: it.at, nm });
    }
    if (!rows.length) { $('status').textContent = '暂无歌曲历史（换歌后自动记录）'; return; }
    rows.sort((a, b) => b.at - a.at);
    const p = n => String(n).padStart(2, '0'), fmt = ts => { const d = new Date(ts); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
    const lines = rows.map(r => `${r.t}（${r.nm} · ${fmt(r.at)}）`); // 纯文本文件不过 HTML 转义（exportFavs 同口径）
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    a.download = 'vradio-songs.txt';
    a.click(); URL.revokeObjectURL(a.href);
    $('status').textContent = `已导出 ${rows.length} 条收听历史（vradio-songs.txt）`;
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
  mExp: '',     // 电台页展开备选源管理的台（keyOf；P1-a/r2 ⑨）——innerHTML 全量重渲，展开态必须外置
  mSrcVal: '',  // 展开行输入框内容（重渲不清输入，同 mq 持久做法）
  manageOpen() { this.mOpener = document.activeElement; $('manage').hidden = false; this.renderManage(); $('mClose').focus(); }, // 打开即移焦 + 记录归还点（P2-7）
  manageClose() {
    $('manage').hidden = true;
    const b = this.mOpener && this.mOpener.isConnected ? this.mOpener : $('manageBtn');
    if (b && b.focus) b.focus();
  },
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
        <button type="button" class="btn mbtn" data-act="rename" title="重命名；改成已有分类名 = 合并（不易拆分）"><svg class="ic"><use href="#i-pencil"/></svg></button>
        <button type="button" class="btn mbtn" data-act="hide" title="${hid ? '恢复显示该分类' : '隐藏该分类（彻底消失，含全部/搜索）'}">${hid ? '<svg class="ic"><use href="#i-eye"/></svg>' : '<svg class="ic"><use href="#i-eye-off"/></svg>'}</button>
        ${custom ? `<button type="button" class="btn mbtn" data-act="del" title="删除自建分类（其中电台回到同步默认分类）"><svg class="ic"><use href="#i-trash"/></svg></button>` : ''}
      </div>`);
    };
    for (const s of this.state.stations) row(s.c); // 含被隐藏分类（可在此恢复）
    for (const c of this.cfg.cats) row(c); // 空自建分类也要能改名/删除
    $('mCats').innerHTML = rows.join('') + `<div style="padding:10px 0"><button type="button" class="btn" data-act="new"><svg class="ic"><use href="#i-plus"/></svg><span>新建分类</span></button><span class="cnt" style="margin-left:8px">新建后出现在「电台」页的移动下拉；分类条要移入电台才显示</span></div>`;
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
      // moved 按 moves 键命中而非 s.c !== dC：分类级重命名会把整类台的 s.c 都改掉，但那不是单台移动，
      // ↺ 也撤不掉分类改名——按名字比较会让全类台误亮 ↺（PR#5 二轮 review 微小观察）
      const k = keyOf(s), moved = s.u.some(u => this.cfg.moves[u]), named = s.n !== dN;
      const srcd = s.u.some(u => !s.dU.includes(u)); // 有追加源（P1-a）：↺ 一并撤销
      return `<div class="mrow${s.hidden ? ' hidden-item' : ''}" data-k="${this.esc(k)}">
        <span class="nm" title="${this.esc(named ? '原名：' + dN : s.n)}${s.hidden ? '（已隐藏）' : ''}">${this.esc(s.n)}</span>
        <select data-act="move" aria-label="「${this.esc(s.n)}」的分类">${opts.map(c => `<option value="${this.esc(c)}"${c === s.c ? ' selected' : ''}>${this.esc(c)}${this.cfg.hideC[c] ? '（已隐藏）' : ''}</option>`).join('')}<option value="__new">＋新建分类…</option><option value="__def">↺ 默认（${this.esc(this.cfg.renames[dC] || dC)}）</option></select>
        ${(moved || named || s.hidden || srcd) ? `<button type="button" class="btn mbtn" data-act="reset" title="撤销此台全部个人调整（回到默认分类/默认名/显示/移除全部追加源）"><svg class="ic"><use href="#i-undo"/></svg></button>` : ''}
        <button type="button" class="btn mbtn" data-act="rename" title="重命名电台（仅显示层，收藏按 URL 不受影响；台标若因改名失配可重新收藏触发解析）"><svg class="ic"><use href="#i-pencil"/></svg></button>
        <button type="button" class="btn mbtn" data-act="hide" title="${s.hidden ? '取消隐藏' : '隐藏电台（彻底消失，含全部/搜索）'}">${s.hidden ? '<svg class="ic"><use href="#i-eye"/></svg>' : '<svg class="ic"><use href="#i-eye-off"/></svg>'}</button>
        <button type="button" class="btn mbtn" data-act="srcs" aria-expanded="${k === this.mExp}" title="备选源管理：查看全部源 / 探活追加（流地址漂移的手动救援） / 移除追加"><svg class="ic"><use href="#i-dots"/></svg></button>
        ${k === this.mExp ? this.srcRowHtml(s) : ''}
      </div>`;
    }).join('') || '<div class="empty">没有匹配的电台</div>';
    if (!kw && all.length > 100) box.innerHTML += '<div class="empty" style="padding:8px 30px;">电台较多，仅列前 100 台——用上方搜索缩小范围</div>';
    box.scrollTop = keepScroll;
  },
  /* —— 备选源管理（P1-a/r2 ⑨ + ②手动选源）：展开行内列出全部源（追加的可移除，原源只读——身份公理：s.u[0] 是
     srcmem/收藏/健康标记的身份键）+ 「▶ 用此源播放」（与 footer 浮层双入口）+ 先 /api/check 探活再收的追加输入 —— */
  srcBadges(s, i, dft) { // 源行徽标片段（⚙ 面板与 footer 浮层共用）：默认=启发式首选（①）、正在用=curSi 所在源、追加=个人补充源
    // 正在用按 keyOf 而非引用相等（AIbot P3-3）：同步重建 stations 后 Player.station 仍指旧对象，引用比较会丢高亮
    const on = Player.station && keyOf(Player.station) === keyOf(s);
    return (i === dft ? '<span class="badge">默认</span>' : '')
      + (on && Player.curSi === i ? '<span class="badge acc">正在用</span>' : '')
      + (s.dU.includes(s.u[i]) ? '' : '<span class="badge">追加</span>');
  },
  srcRowHtml(s) {
    const dft = Player.srcOrder(s)[0]; // 与 play() 同一决策基座，「默认」徽标/「恢复默认」的落点
    const on = Player.station && keyOf(Player.station) === keyOf(s); // keyOf 口径（AIbot P3-3），同 srcBadges
    const rows = s.u.map((u, i) => `<div class="srcline${on && Player.curSi === i ? ' cur' : ''}">
      <i class="idx">${i + 1}</i><span class="u" title="${this.esc(u)}">${this.esc(u)}</span>${this.srcBadges(s, i, dft)}
      ${s.dU.includes(u) ? '' : `<button type="button" class="btn mbtn" data-act="srcdel" data-u="${this.esc(u)}" title="移除这条追加源（原源不可删）"><svg class="ic"><use href="#i-x"/></svg></button>`}
      <button type="button" class="btn mbtn" data-act="srcplay" data-i="${i}" title="用此源立即播放（失败自动顺延，成功后记住此源）"><svg class="ic"><use href="#i-play"/></svg></button>
    </div>`).join('');
    const ok = location.protocol.startsWith('http'); // 探活依赖后端，file:// 降级禁用（同添加电台口径）
    return `<div class="msrc">
      <div class="msrc-t">备选源 ${s.u.length} 条——点播失败自动逐个切换；追加源只挂本台，不动原源与收藏</div>
      ${rows}
      <div class="msrc-add">
        <input type="url" value="${this.esc(this.mSrcVal || '')}" placeholder="追加流地址 http(s)://…（mp3/aac 直流或 m3u8）" aria-label="追加备选源地址"${ok ? '' : ' disabled title="file:// 降级模式无后端探活，npm start 后可用"'}>
        <button type="button" class="btn mbtn" data-act="srcadd"${ok ? '' : ' disabled'}>探活并追加</button>
      </div>
    </div>`;
  },
  async srcAppend(s, btn) {
    const inp = btn.closest('.msrc-add').querySelector('input');
    const u = (inp.value || '').trim().replace(/\s+/g, ''); // URL 内不该有空白/换行，容错顺手清（坑③）
    if (!/^https?:\/\//.test(u)) { $('status').textContent = '追加源需以 http(s):// 开头'; return; }
    if (s.u.includes(u)) { $('status').textContent = '该地址已在源列表中'; return; }
    // 挂键 = 台上任一已有 srcs 键（变体换序免疫，与移动/改名同机制），否则主 URL；判满前置到探活之前——
    // 否则第 7 条会过完探活才被 slice(0,6) 静默砍掉、状态栏还报成功（AIbot P1-2）
    const key = s.u.find(x => this.cfg.srcs[x]) || s.u[0];
    const arr = this.cfg.srcs[key] || [];
    if (arr.length >= 6) { $('status').textContent = '该台追加源已达上限（6 条），先移除一条再追加'; return; }
    btn.disabled = true; btn.textContent = '探活中…';
    let r = null;
    // t=12000 与 /api/mystation 同口径（AIbot P1-1）：主打场景是给蜻蜓系慢源救援，建流 5-10s 属正常，
    // 默认 4.5s 窗口会整类误拒；批量体检路径不带 t 仍是 4.5s（ETA 按最坏校准不能放慢）
    try { r = await fetch('/api/check?t=12000&url=' + encodeURIComponent(u)).then(x => x.json()); }
    catch (e) { $('status').textContent = '追加失败（探活请求）：' + (e && e.message || e); }
    if (!r || !r.ok) {
      if (r) $('status').textContent = '探活未通过，未追加：' + (r.detail || '源不可用（假流/死链）');
      btn.disabled = false; btn.textContent = '探活并追加';
      return;
    }
    if (!arr.includes(u)) arr.push(u);
    this.cfg.srcs[key] = arr;
    this.cfgTag(s); this.mSrcVal = ''; this.saveCfg(); this.reapplyCfg(); // reapplyCfg 内含面板重渲
    $('status').textContent = `已追加备选源（${r.detail || '探活通过'}）——点播时进入自动切换序列`;
  },
  srcRemove(u) {
    for (const k of Object.keys(this.cfg.srcs)) {
      const i = this.cfg.srcs[k].indexOf(u); // 原源不在 cfg.srcs 值域里，能找到的必是追加源（UI 也只对追加放 ✕）
      if (i >= 0) { this.cfg.srcs[k].splice(i, 1); if (!this.cfg.srcs[k].length) delete this.cfg.srcs[k]; break; }
    }
    // 移除后该台已无任何个人调整时，tag 快照一并清（audit B2：tag 只增不减的口之二）
    const st = this.state.stations.find(x => x.u.includes(u));
    if (st && !st.u.some(x => this.cfg.moves[x] || this.cfg.names[x] || this.cfg.hideS[x] || this.cfg.srcs[x])) for (const x of st.u) delete this.cfg.tag[x];
    this.saveCfg(); this.reapplyCfg();
    $('status').textContent = '已移除该追加源';
  },

  stMove(s, v) {
    if (v === s.c) return;
    // 选中「等同默认分类」的目标视同 ↺ 默认：只删 moves 键，不写 moves[u]=默认分类——
    // 否则位置没变却留下键，↺ 亮起且点了无效果（PR#8 review P3-1；默认分类重命名后按现名比对）
    const def = this.cfg.renames[s.dCat || s.c] || s.dCat || s.c;
    if (v === '__def' || v === def) { for (const u of s.u) { delete this.cfg.moves[u]; delete this.cfg.tag[u]; } } // 撤回默认：tag 快照一并清且不再补写（audit B2——无调整即无失配可挂）
    else {
      if (v === '__new') {
        v = this.askName('新建分类并移入');
        if (!v) { this.renderManage(); return; }
        if (!this.cfg.cats.includes(v) && !this.mCatOptions().includes(v)) this.cfg.cats.push(v);
      }
      for (const u of s.u) this.cfg.moves[u] = v;
      this.cfgTag(s);
    }
    this.saveCfg(); this.reapplyCfg();
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
    for (const k of Object.keys(this.cfg.srcs)) if (s.u.includes(k)) delete this.cfg.srcs[k]; // 追加源一并撤（键=任一源 URL，均在此台 s.u 内）
    this.saveCfg(); this.reapplyCfg();
  },

  /* —— 失配清单：moves/names/hideS/srcs 的键没命中任何当前台的源 URL = 上游 URL 漂移（欧美台同步重建常见） —— */
  missList() {
    const used = new Set(); for (const s of this.state.stations) for (const u of s.u) used.add(u);
    const bad = [];
    for (const [m, kind] of [[this.cfg.moves, '移动'], [this.cfg.names, '改名'], [this.cfg.hideS, '隐藏'], [this.cfg.srcs, '备源']])
      for (const u of Object.keys(m)) if (!used.has(u)) bad.push({ u, kind, name: this.cfg.tag[u] || u.replace(/^https?:\/\//, '').slice(0, 40) });
    return bad;
  },
  renderMiss() {
    const bad = this.missList();
    $('mMiss').innerHTML = !bad.length ? '' : `<div class="miss"><b><svg class="ic"><use href="#i-warn"/></svg> ${bad.length} 条个人调整已失配</b>（上游同步后源地址漂移，多为欧美台重建）：${bad.map(b => `${this.esc(b.name)}（${b.kind}）`).join('、')}。在「电台」页搜台名可重新指定，<button type="button" class="btn mbtn" data-act="missclear">或清理这些失配项</button></div>`;
  },

  /* —— 配置导入导出（owner 拍板：只含维护层；收藏另有 m3u 导出）—— */
  cfgCount(c) { return Object.keys(c.moves).length + Object.keys(c.names).length + Object.keys(c.hideS).length + Object.keys(c.renames).length + Object.keys(c.hideC).length + Object.keys(c.srcs).length + c.cats.length; },
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

  /* —— 完整备份导出/导入（方案二/R4 拍板）：全部 radio.* 打包单 JSON——不走后端的迁移通道（换浏览器/换机兜底，
     与既有三个单项导出并存：m3u 给外部播放器、songs 给音乐 App、config 给轻量迁移，本项给完整恢复） —— */
  exportAll() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ v: 1, at: Date.now(), data: Store.snapshot() }, null, 2)], { type: 'application/json' }));
    a.download = 'vradio-backup.json'; a.click(); URL.revokeObjectURL(a.href);
    $('status').textContent = '已导出完整备份（vradio-backup.json：收藏/配置/健康标记/歌曲历史等持久数据；台标缓存可重建不包含）';
  },
  importAll(text) {
    let j; try { j = JSON.parse(text); } catch (_) { alert('导入失败：不是合法 JSON 文件'); return; }
    const d = j && j.data && typeof j.data === 'object' ? j.data : null;
    if (!d) { alert('导入失败：不是 vradio 完整备份文件'); return; }
    const n = Store.KEYS.filter(k => typeof d[k] === 'string').length;
    if (!n) { alert('导入失败：备份中无有效数据'); return; }
    if (!confirm(`导入将覆盖本地全部数据（备份含 ${n} 个数据项：收藏/维护配置/健康标记/歌曲历史全部替换）。继续？`)) return;
    for (const k of Store.KEYS) { if (typeof d[k] === 'string') localStorage.setItem(k, d[k]); else localStorage.removeItem(k); } // 白名单键直接落镜像（原生写）
    Store.flush(); // 推后端（http 形态）；file:// 下 no-op
    this.applyServerStore();
    $('status').textContent = '已恢复完整备份';
  },

  boot() {
    Store.init(); // 存储收敛层（方案二）：BC 监听 + 关页 flush 兜底，须在 Player.init 读记忆之前
    this.loadStore();
    localStorage.removeItem('radio.epg'); // 节目单（EPG）功能已移除：顺手清掉旧版留下的缓存（不存在则 no-op）
    // 音量持久化（读取夹取 0-100，坏值回退 90）
    const savedVol = Store.get('radio.vol'), vol0 = +savedVol;
    const vol = savedVol !== null && Number.isFinite(vol0) && vol0 >= 0 && vol0 <= 100 ? vol0 : 90;
    $('vol').value = vol;
    Player.init($('audio'), vol / 100);

    // Player 状态回调：full=true 需整表重渲（行高亮/连接中变化），否则只轻量更新底部
    Player.onstate = full => { this.playerNow(); if (full) this.render(); };
    Player.onstatus = t => { $('status').textContent = t; };
    Player.onfail = () => this.showLast();
    Player.onlogo = s => Logos.get(s); // 锁屏 artwork 台标（r2 ⑩）：同步窥探绝不发请求，无台标回空数组静默缺省
    Player.onstepfav = d => this.stepFav(d); // 锁屏/媒体键 ⏮⏭ = 收藏间切台（r2 ①）：无收藏时 stepFav 自身走状态栏提示
    // 睡眠定时（E2 + UI 审计 P3-7）：菜单一次点选 15/30/60（循环模式要点三下才到 60）；进行中点击按钮直接取消
    $('sleepBtn').onclick = () => {
      if (Player.sleepId) { Player.sleep(0); return; }
      const m = $('sleepMenu');
      m.hidden = !m.hidden;
      if (!m.hidden) m.querySelector('button')?.focus();
    };
    $('sleepMenu').onclick = e => {
      const b = e.target.closest('[data-min]'); if (!b) return;
      $('sleepMenu').hidden = true; Player.sleep(+b.dataset.min);
    };
    document.addEventListener('click', e => { if (!e.target.closest('#sleepWrap')) $('sleepMenu').hidden = true; });
    // footer 选源浮层（②a）：正在听的多源台一键切源（一律立即起播，暂停态同）；行点击 = 用此源播放，底部 = 恢复默认
    $('srcBtn').onclick = () => {
      if (!$('srcMenu').hidden) { this.srcPopClose(); return; }
      this.renderSrcPop();
    };
    $('srcMenu').onclick = e => {
      const row = e.target.closest('[data-i]');
      if (row) { const s = Player.station; this.srcPopClose(); if (s) this.startPlay(s, +row.dataset.i); return; }
      if (e.target.closest('[data-act="srcreset"]')) { this.srcPopClose(); this.srcReset(); }
    };
    document.addEventListener('click', e => { if (!e.target.closest('#srcWrap')) this.srcPopClose(); });
    Player.ontick = ms => {
      const b = $('sleepBtn'), lab = $('sleepLab');
      if (ms > 0) { const s = Math.ceil(ms / 1000); lab.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); b.title = '睡眠定时进行中，点击取消'; }
      else { lab.textContent = ''; b.title = '睡眠定时：点击选择时长'; }
    };

    // 曲讯轮询（B-6）：15s 常驻轮（条件不满足时空转不发包）；页面重新可见时立刻补一轮
    setInterval(() => this.tickSong(), 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.tickSong(); });
    // 歌曲历史浮层（B-7）：点曲名行开关；点别处收起
    $('song').onclick = () => this.toggleSongHist();
    // 快捷键帮助（N8/r2 ⑧）：? 呼出，Esc/点外关闭，焦点归还呼出点；与歌曲历史浮层互斥（AIbot P3-3）
    const keysOpen = () => { this.kOpener = document.activeElement; $('songhist').hidden = true; $('keys').hidden = false; $('keys').focus(); };
    const keysClose = () => {
      if ($('keys').hidden) return;
      $('keys').hidden = true;
      const b = this.kOpener && this.kOpener.isConnected ? this.kOpener : null;
      if (b && b.focus) b.focus();
    };
    document.addEventListener('click', e => { if (!e.target.closest('#songhist,#song,#keys')) { $('songhist').hidden = true; keysClose(); } });
    // footer 台名可点（N5/r2 ⑦）：回到正在播行并高亮一闪
    $('nowline').onclick = () => this.locatePlaying();

    // 搜索：120ms 防抖，避免 1600+ 行列表每键整表重渲；Esc 清空；任意位置按 / 聚焦；↓ 接力列表首行（P2-5）
    let timer = 0;
    $('q').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { this.state.keyword = e.target.value.trim(); this.render(); }, 120); };
    $('q').onkeydown = e => {
      if (e.key === 'Escape') { e.target.value = ''; clearTimeout(timer); this.state.keyword = ''; this.render(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.focusRow(0); }
    };
    document.addEventListener('keydown', e => { // 全局快捷键（A-5）：/ 聚焦搜索、空格 播放/暂停、←/→ 收藏间切台
      if (e.ctrlKey || e.altKey || e.metaKey) return; // 不抢组合键（Ctrl+/ 等）
      const t = e.target, tag = t && t.tagName;
      // 焦点在交互件/列表行/维护面板/歌曲浮层/快捷键浮层上：让位原生行为（行内 Enter/Space 已有处理、面板有自己的 Esc 语义、按钮空格原生触发 click）。
      // #keys 进让位（AIbot P3-4）：dialog 持焦点时空格/←/→ 不再直控播放（与 songhist 口径一致）；关浮层走 Esc/点外（cheatsheet 自述）
      if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag) || t.isContentEditable || (t.closest && t.closest('#list,#manage,#songhist,#keys'))) return;
      if (e.key === '/') { e.preventDefault(); $('q').focus(); return; }
      if (e.key === '?') { e.preventDefault(); $('keys').hidden ? keysOpen() : keysClose(); return; } // cheatsheet（N8）
      if (e.key === ' ') { e.preventDefault(); $('pp').click(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); this.stepFav(e.key === 'ArrowRight' ? 1 : -1); }
    });

    // 分类与列表（行/卡片可用键盘操作：Enter/Space 播放；收藏按钮由原生 button 处理）
    $('cats').addEventListener('scroll', () => this.updateCatsFade(), { passive:true }); // 分类条渐隐随滚动切换（P3-5）
    addEventListener('resize', () => this.updateCatsFade());
    $('cats').onclick = e => { const c = e.target.closest('.chip'); if (c) { this.state.cat = c.dataset.c; this.swapRender(); } };
    $('list').onclick = e => {
      const fav = e.target.closest('.fav');
      if (fav) {
        const s = this.state.stations.find(x => keyOf(x) === fav.dataset.fav);
        if (s) this.toggleFav(s);
        return;
      }
      const row = e.target.closest('.row,.card'); if (row) this.togglePlay(row.dataset.k);
    };
    $('list').onkeydown = e => { // Enter/Space 播放 + ↑↓/Home/End 方向键导航（UI 审计 P2-5）
      const row = e.target.closest && e.target.closest('.row,.card');
      if (!row || e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.togglePlay(row.dataset.k); return; }
      const n = this.visible().length, cur = +row.dataset.i; let to = -1;
      if (e.key === 'ArrowDown') to = Math.min(n - 1, cur + 1);
      else if (e.key === 'ArrowUp') to = Math.max(0, cur - 1);
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = n - 1;
      if (to < 0 || to === cur) return;
      e.preventDefault(); this.focusRow(to);
    };

    // 视图切换（网格=精简卡片 / 列表=两行详情）与无效源显隐/主题，均持久化到 localStorage——
    // 读取与 DOM 同步统一走 loadUi3（与他页 Store 对账联动共用，audit C4），交互入口只改 state 再点对刷新
    const setView = v => { if (this.state.view === v) return; this.state.view = v; Store.set('radio.view', v); this.syncViewUI(); this.swapRender(); };
    $('gridBtn').onclick = () => setView('grid');
    $('listBtn').onclick = () => setView('list');
    $('deadBtn').onclick = () => { this.state.showDead = !this.state.showDead; Store.set('radio.showdead', this.state.showDead ? '1' : '0'); this.syncDeadUI(); this.render(); };
    // 主题：🌓 跟随系统（默认）→ ☀️ 浅色 → 🌙 深色 循环，持久化 radio.theme；
    // 生效值写 <html data-theme>，浅色变量只认它（auto 由 matchMedia 实时换算，系统切换即时跟随）
    this.mq = matchMedia('(prefers-color-scheme: light)');
    $('themeBtn').onclick = () => { this.state.theme = { auto: 'light', light: 'dark', dark: 'auto' }[this.state.theme]; Store.set('radio.theme', this.state.theme); this.syncThemeUI(); };
    this.mq.addEventListener('change', () => { if (this.state.theme === 'auto') this.syncThemeUI(); });
    this.loadUi3();

    // 维护面板（⚙）：个人分类/电台调整，全部落 radio.cfg（localStorage），同步重跑后按 URL 回绑自动复用
    this.loadCfg();
    // file:// 降级模式（reloadMain 必失败）下 stations 停留在 STARTER、不走 applySources 的留底循环——
    // 此处补快照，否则维护面板「电台」页读 s.dName 直接抛错（渲染处另有 || 兜底双保险）
    for (const s of this.state.stations) { if (s.dCat === undefined) { s.dCat = s.c; s.dName = s.n; s.dU = s.u.slice(); } }
    $('manageBtn').onclick = () => this.manageOpen();
    $('mClose').onclick = () => this.manageClose();
    $('manage').onclick = e => { if (e.target === $('manage')) this.manageClose(); }; // 点遮罩关闭
    document.addEventListener('keydown', e => { // Esc 关面板（焦点在输入框/下拉里时不抢，让它们先清自身）+ 收起浮层菜单
      if (e.key === 'Escape') {
        keysClose(); // 快捷键浮层（N8）：最上层，先关
        if (!$('manage').hidden && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) this.manageClose();
        $('lowfreq').classList.remove('open'); $('moreBtn').setAttribute('aria-expanded', 'false');
        $('sleepMenu').hidden = true;
        this.srcPopClose(); // 选源浮层（AIbot P2-1）：Esc 收起 + 焦点归还，与 ? 帮助的 Esc 自述一致
      }
      if (e.key === 'Tab' && !$('manage').hidden) { // 焦点困在弹窗内（UI 审计 P2-7）：aria-modal 此前 Tab 可穿透到被遮罩的主页
        const f = [...$('manage').querySelectorAll('button,input,select')].filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    // 更多菜单（UI 审计 P2-6）：≤640px 收纳低频操作；桌面由 CSS display:contents 原样排布，按钮不可见
    $('moreBtn').onclick = e => {
      e.stopPropagation();
      const on = $('lowfreq').classList.toggle('open');
      $('moreBtn').setAttribute('aria-expanded', String(on));
    };
    $('lowfreq').addEventListener('click', e => { if (e.target.closest('.btn')) { $('lowfreq').classList.remove('open'); $('moreBtn').setAttribute('aria-expanded', 'false'); } }); // 点操作项后收起
    document.addEventListener('click', e => {
      if ($('lowfreq').classList.contains('open') && !e.target.closest('#lowfreq,#moreBtn')) { $('lowfreq').classList.remove('open'); $('moreBtn').setAttribute('aria-expanded', 'false'); }
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
      else if (b.dataset.act === 'srcs') { // 展开/收起备选源管理（P1-a/r2 ⑨）；换台展开时清输入残留
        this.mExp = this.mExp === keyOf(s) ? '' : keyOf(s);
        this.mSrcVal = '';
        this.renderMStations();
        const i = $('mlist').querySelector('.msrc-add input');
        if (i && this.mExp) i.focus();
      }
      else if (b.dataset.act === 'srcplay') { this.manageClose(); this.startPlay(s, +b.dataset.i); } // 用此源播放（②）：关面板起播，状态栏可见连接进展
      else if (b.dataset.act === 'srcadd') this.srcAppend(s, b);
      else if (b.dataset.act === 'srcdel') this.srcRemove(b.dataset.u);
    };
    $('mlist').addEventListener('input', e => { if (e.target.matches('.msrc-add input')) this.mSrcVal = e.target.value; }); // 重渲不清输入（坑④）
    $('mlist').addEventListener('keydown', e => { // Enter 直接触发探活追加
      if (e.key === 'Enter' && e.target.matches('.msrc-add input')) {
        e.preventDefault();
        const b2 = e.target.closest('.msrc-add').querySelector('[data-act="srcadd"]');
        if (b2 && !b2.disabled) b2.click();
      }
    });
    $('mMiss').onclick = e => {
      if (!e.target.closest('[data-act="missclear"]')) return;
      for (const b of this.missList()) { delete this.cfg.moves[b.u]; delete this.cfg.names[b.u]; delete this.cfg.hideS[b.u]; delete this.cfg.srcs[b.u]; delete this.cfg.tag[b.u]; }
      this.saveCfg(); this.renderManage();
    };
    $('mExport').onclick = () => this.exportCfg();
    $('mImport').onclick = () => $('mfile').click();
    $('mfile').onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => this.importCfg(String(r.result)); r.readAsText(f, 'utf-8'); e.target.value = ''; };
    $('mReset').onclick = () => this.resetCfg();
    $('mBackup').onclick = () => this.exportAll();
    $('mRestore').onclick = () => $('mfile2').click();
    $('mfile2').onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => this.importAll(String(r.result)); r.readAsText(f, 'utf-8'); e.target.value = ''; };

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
      $('mAddBtn').disabled = true; $('mAddBtn').querySelector('span').textContent = '探活中…';
      try {
        const r = await fetch('/api/mystation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n, u, c }) }).then(x => x.json());
        if (r.ok) {
          $('mAName').value = $('mAUrl').value = '';
          await this.reloadMain(); // 重拉重并（个人层常驻），列表与面板同步出现新台
          this.renderManage();
          $('status').textContent = `已添加「${n}」到「${c}」（持久于 my-radio.txt，同步不覆盖）`;
        } else $('status').textContent = '添加失败：' + (r.detail || r.error || '未知错误');
      } catch (e) { $('status').textContent = '添加失败：' + (e && e.message || e); }
      $('mAddBtn').disabled = false; $('mAddBtn').querySelector('span').textContent = '添加';
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
    // 音量：静音键 + 拖动百分比反馈（UI 审计 P3-6）；每台音量记忆（A3/r2 ②语义①）——
    // 拖动经 rememberVol 分流（正在播写台记忆、台首调全局锚点随行、无台写全局），0 与静音同为瞬态不入记忆
    const syncMute = () => {
      const muted = !+$('vol').value;
      $('muteBtn').innerHTML = muted ? '<svg class="ic"><use href="#i-mute"/></svg>' : '<svg class="ic"><use href="#i-vol"/></svg>';
      $('muteBtn').setAttribute('aria-label', muted ? '取消静音' : '静音');
    };
    Player.onvol = v => { $('vol').value = Math.round(v * 100); syncMute(); }; // 点播套用每台音量后回写滑杆（r2 ②）
    $('muteBtn').onclick = () => {
      if (+$('vol').value > 0) { Player.setVolume(0); $('vol').value = 0; $('status').textContent = '已静音'; }
      else { const r = Player.restoreVol(); Player.setVolume(r); $('vol').value = Math.round(r * 100); $('status').textContent = '音量 ' + Math.round(r * 100) + '%'; }
      syncMute();
    };
    syncMute();
    $('vol').oninput = e => { const v = +e.target.value; Player.setVolume(v / 100); Player.rememberVol(v); $('status').textContent = '音量 ' + v + '%'; syncMute(); };

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

    // 初始数据：radio.txt + my-radio.txt（http 下）；file:// 降级链（N1/r2 ③）：radio-data.js 全库直读
    // （同步产出的经典 script 全局，fetch 被拦但 script 加载不会）→ 再退内置精选；hint 只在两者皆无时提示
    Store.boot(); // 主源对账（异步，镜像先行渲染不阻塞首屏）：后端较新应用之/首次迁移回填/dirty 重推
    this.reloadMain().then(ok => {
      if (!ok) {
        if (window.RADIO_DATA) this.applySources(this.parse(window.RADIO_DATA), []); // 代理级 m3u8 台播不了，直流台照常
        else $('hint').style.display = 'block';
      }
      this.logosEnsure();
      // 开机后台编排（B-10 + R3/R4 拍板）：基线优先——未建基线（含确认过的中断续跑）不跑常规复测（基线是超集）
      if (ok) setTimeout(() => Sync.bootQuiet(), 4000);
    });
    this.render(); this.showLast(); // file:// 降级模式下也补齐「上次收听」提示
  },
};

App.boot();
