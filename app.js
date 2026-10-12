/* VRadio 应用层 —— 列表/搜索/分类/收藏/最近播放/导入导出/渲染的唯一所有者（模块契约见 docs/review.md 十一节债务 2）。
   播放一律经 Player 接口；同步/体检由 sync.js 编排本文件暴露的方法。
   身份公理（债务 1）：URL = 持久身份（收藏/最近记录源 URL，名字漂移后按 URL 回绑），名字 = 显示层。 */

/* ---------- 内置精选（地址已实测直连可用；含同一电台的多个备选源） ---------- */
const STARTER = [
  { c:'常听', n:'Love Radio FM103.7 经典金曲', u:['http://lhttp.qingting.fm/live/273/64k.mp3','http://ls.qingting.fm/live/273.m3u8'] },
  { c:'常听', n:'动感101 FM101.7', u:['http://lhttp.qingting.fm/live/274/64k.mp3','http://live.xmcdn.com/live/53/64.m3u8'] },
  { c:'常听', n:'经典947 FM94.7', u:['http://lhttp.qingting.fm/live/267/64k.mp3','http://live.xmcdn.com/live/54/64.m3u8'] },
  { c:'常听', n:'上海东广新闻台', u:['http://lhttp.qingting.fm/live/275/64k.mp3'] },
  { c:'常听', n:'上海交通台 FM105.7', u:['http://lhttp.qingting.fm/live/266/64k.mp3','http://ls.qingting.fm/live/266.m3u8'] },
  { c:'常听', n:'CNR 中国之声', u:['http://ngcdn001.cnr.cn/live/zgzs/index.m3u8'] },
  { c:'常听', n:'CNR 音乐之声', u:['http://ngcdn003.cnr.cn/live/yyzs/index.m3u8'] },
  { c:'常听', n:'CRI 环球资讯广播 FM90.5', u:['http://sk.cri.cn/905.m3u8'] },
  { c:'常听', n:'CRI 怀旧金曲频道', u:['https://lhttp.qingting.fm/live/5022038/64k.mp3'] },
  { c:'常听', n:'Asia FM 亚洲经典台', u:['https://lhttp.qingting.fm/live/5021912/64k.mp3'] },
  { c:'世界', n:'YES 933 (新加坡)', u:['http://playerservices.streamtheworld.com/api/livestream-redirect/YES933AAC.aac'] },
  { c:'世界', n:'Class 95 (新加坡)', u:['http://playerservices.streamtheworld.com/api/livestream-redirect/CLASS95AAC.aac'] },
  { c:'世界', n:'Listen.Moe JPop', u:['https://listen.moe/stream'] },
  { c:'世界', n:'Nightwave Plaza', u:['http://radio.plaza.one/opus'] },
];

const $ = id => document.getElementById(id);
const keyOf = s => s.c + '|' + s.n;

const App = {
  /* 集中状态（docs/review.md 架构-风险 2）：stations 数据 + 渲染哨兵 + 行索引（体检增量更新用，去 O(n²)） */
  state: { stations: STARTER.slice(), cat: '全部', keyword: '', stamp: 0, index: new Map() },
  favs: [],    // [{k, u:[源URL…]}] —— 带 URL 的条目永不回收（休眠待回绑），旧名字键回绑失败即刻回收
  recents: [], // [{k, n, u:[…]}] 最近在前、≤20；队首即「上次收听」（E3 与 lastKey 合并为单一队列）

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
  },
  saveFavs() { localStorage.setItem('radio.favs', JSON.stringify(this.favs)); },
  saveRecents() { localStorage.setItem('radio.recents', JSON.stringify(this.recents)); },

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
      byKey.set(keyOf(st), { c: st.c, n: st.n, u: st.u.slice() }); byName.add(st.n);
    }
    for (const s of myList || []) {
      const cur = byKey.get(keyOf(s));
      if (cur) s.u.forEach(u => !cur.u.includes(u) && cur.u.push(u));
      else { byKey.set(keyOf(s), s); byName.add(s.n); }
    }
    this.state.stations = [...byKey.values()];
    this.rebind(); // 收藏/最近按 URL 回绑（债务 1）
    this.buildCats(); this.render();
    if (!Player.station) this.showLast();
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
    this.saveFavs(); this.saveRecents();
  },
  favKeys() { return new Set(this.favs.map(f => f.k)); },
  toggleFav(s) {
    const k = keyOf(s);
    const i = this.favs.findIndex(f => f.k === k);
    if (i >= 0) this.favs.splice(i, 1); else this.favs.push({ k, u: s.u.slice(0, 6) });
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
  showLast() {
    const s = this.recents[0] && this.resolve(this.recents[0]);
    $('now').textContent = s ? '上次收听：' + s.n : '未在播放';
  },

  /* ---------- 渲染（唯一入口） ---------- */
  keepFocus(box, ...attrs) { // innerHTML 整表重建会把键盘焦点弹回 body：重建前后找回同节点
    const ae = document.activeElement;
    if (!box.contains(ae) || !ae.dataset) return () => {};
    const pair = attrs.map(a => [a, ae.dataset[a]]).find(([, v]) => v != null);
    return () => { if (pair) box.querySelector(`[data-${pair[0]}="${CSS.escape(pair[1])}"]`)?.focus({ preventScroll: true }); };
  },
  buildCats() {
    const restore = this.keepFocus($('cats'), 'c');
    const present = new Set(this.state.stations.map(s => s.c));
    const order = ['音乐', '欧美音乐']; // 音乐场景置顶
    const cats = ['全部', '★收藏', '最近', ...order.filter(c => present.has(c)), ...[...present].filter(c => !order.includes(c))];
    if (!cats.includes(this.state.cat)) this.state.cat = '全部'; // 数据更新后分类可能消失，回退全部
    // 互斥单选语义用 aria-current（aria-pressed 是独立开关语义，不适用）
    $('cats').innerHTML = cats.map(c => `<button type="button" class="chip${c === this.state.cat ? ' on' : ''}" data-c="${this.esc(c)}"${c === this.state.cat ? ' aria-current="true"' : ''}>${this.esc(c)}</button>`).join('');
    restore();
  },
  visible() {
    const st = this.state, kw = st.keyword.toLowerCase(), favs = this.favKeys();
    if (st.cat === '最近') { // 最近播放（E3）：按 recents 队序（键或 URL 回绑解析），上限 20
      const hits = [];
      for (const r of this.recents.slice(0, 20)) { const s = this.resolve(r); if (s && (!kw || s.n.toLowerCase().includes(kw))) hits.push(s); }
      return hits;
    }
    return st.stations.filter(s =>
      (st.cat === '全部' || (st.cat === '★收藏' ? favs.has(keyOf(s)) : s.c === st.cat)) &&
      (!kw || s.n.toLowerCase().includes(kw)));
  },
  // 电台名/分类来自远程上游仓库，渲染前必须转义（防注入）
  esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  emptyHtml() { // 空态给出原因和下一步动作
    const msg = this.state.cat === '★收藏' && !this.favs.length ? '还没有收藏电台——点电台左侧 ☆ 即可收藏'
      : this.state.cat === '最近' && !this.recents.length ? '还没有播放记录——点任意电台即开始收听'
      : this.state.keyword ? `没有匹配「${this.esc(this.state.keyword)}」的电台，换个关键词试试` : '该分类暂无电台';
    return `<div class="empty">${msg}</div>`;
  },
  render() {
    const restore = this.keepFocus($('list'), 'k', 'fav'); // 焦点在行或收藏按钮上都找回
    const list = this.visible();
    this.state.stamp++;
    this.state.index = new Map(list.map((s, i) => [s, i])); // 行索引（体检增量更新用，替代 indexOf 的 O(n²)）
    const pk = Player.station && keyOf(Player.station), ck = Player.connecting && keyOf(Player.connecting);
    const favs = this.favKeys();
    $('list').innerHTML = list.map((s, i) => {
      const k = keyOf(s), on = favs.has(k), playing = k === pk;
      const hp = s.health ? `<span class="health ${s.health === 'ok' ? 'ok' : 'bad'}" title="体检${s.health === 'ok' ? '可用' : '不可用'}">${s.health === 'ok' ? '✓' : '✗'}</span>` : '';
      return `<div class="row${playing ? ' playing' : ''}${k === ck ? ' connecting' : ''}${s.health === 'dead' ? ' dead' : ''}" data-k="${this.esc(k)}" data-i="${i}" role="listitem" tabindex="0" aria-label="${this.esc(s.n)}${playing ? '（播放中）' : ''}"${playing ? ' aria-current="true"' : ''}${s.health === 'dead' ? ' title="体检不可用，点击仍可尝试播放"' : ''}>
        <button type="button" class="fav${on ? ' on' : ''}" data-fav="${this.esc(k)}" aria-pressed="${on}" aria-label="${on ? '取消收藏' : '收藏'}：${this.esc(s.n)}" title="${on ? '取消收藏' : '收藏'}">${on ? '★' : '☆'}</button>
        <span class="name">${this.esc(s.n)}</span>${hp}
        <span class="badge">${this.esc(s.c)}</span><span class="srcs" title="备选源数量">${s.u.length}源</span></div>`;
    }).join('') || this.emptyHtml();
    restore();
  },
  /* 体检增量落库（sync.js 调用）：stamp 未变时顺手更新该行 DOM，否则只落数据由结束时的兜底 render 收口（P3-13） */
  patchHealth(s, ok, stamp) {
    s.health = ok ? 'ok' : 'dead';
    if (this.state.stamp !== stamp) return;
    const row = $('list').querySelector(`.row[data-i="${this.state.index.get(s)}"]`);
    if (!row) return;
    row.classList.toggle('dead', !ok);
    const old = row.querySelector('.health'); if (old) old.remove();
    const sp = document.createElement('span'); sp.className = 'health ' + (ok ? 'ok' : 'bad'); sp.textContent = ok ? '✓' : '✗';
    row.insertBefore(sp, row.querySelector('.badge'));
  },

  togglePlay(k) { // 再点当前台 = 暂停/继续；点其他台 = 切换
    const s = this.state.stations.find(x => keyOf(x) === k); if (!s) return;
    if (Player.station && keyOf(Player.station) === k) {
      Player.isPaused() ? Player.resume() : Player.pause();
      return;
    }
    this.remember(s);
    if (this.state.cat === '最近') this.render(); // 最近队列头插后刷新顺序
    Player.play(s);
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

  boot() {
    this.loadStore();
    // 音量持久化（读取夹取 0-100，坏值回退 90）
    const savedVol = localStorage.getItem('radio.vol'), vol0 = +savedVol;
    const vol = savedVol !== null && Number.isFinite(vol0) && vol0 >= 0 && vol0 <= 100 ? vol0 : 90;
    $('vol').value = vol;
    Player.init($('audio'), vol / 100);

    // Player 状态回调：full=true 需整表重渲（行高亮/连接中变化），否则只轻量更新底部
    Player.onstate = full => {
      const s = Player.station;
      if (s) { $('now').textContent = '▶ ' + s.n; $('pp').textContent = (Player.connecting || !Player.isPaused()) ? '⏸' : '▶'; }
      else { $('pp').textContent = '▶'; this.showLast(); }
      $('eq').classList.toggle('on', !!s && !Player.isPaused()); // 均衡器动画（E6）：活着且在播
      if (full) this.render();
    };
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

    // 搜索：120ms 防抖，避免 1600+ 行列表每键整表重渲；Esc 清空；任意位置按 / 聚焦
    let timer = 0;
    $('q').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { this.state.keyword = e.target.value.trim(); this.render(); }, 120); };
    $('q').onkeydown = e => { if (e.key === 'Escape') { e.target.value = ''; clearTimeout(timer); this.state.keyword = ''; this.render(); } };
    document.addEventListener('keydown', e => { // 排除修饰键组合，避免误抢 Ctrl+/ 等
      if (e.key === '/' && !e.ctrlKey && !e.altKey && !e.metaKey && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) { e.preventDefault(); $('q').focus(); }
    });

    // 分类与列表（行可用键盘操作：Enter/Space 播放；收藏按钮由原生 button 处理）
    $('cats').onclick = e => { const c = e.target.closest('.chip'); if (c) { this.state.cat = c.dataset.c; this.buildCats(); this.render(); } };
    $('list').onclick = e => {
      const fav = e.target.closest('.fav');
      if (fav) {
        const s = this.state.stations.find(x => keyOf(x) === fav.dataset.fav);
        if (s) this.toggleFav(s);
        return;
      }
      const row = e.target.closest('.row'); if (row) this.togglePlay(row.dataset.k);
    };
    $('list').onkeydown = e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.row');
      if (row && e.target === row) { e.preventDefault(); this.togglePlay(row.dataset.k); }
    };

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
    this.reloadMain().then(ok => { if (!ok) $('hint').style.display = 'block'; });
    this.buildCats(); this.render(); this.showLast(); // file:// 降级模式下也补齐「上次收听」提示
  },
};

App.boot();
