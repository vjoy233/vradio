/* VRadio 应用层 —— 列表/搜索/分类/收藏/渲染的唯一所有者（模块契约见 docs/review.md 十一节债务 2）。
   播放一律经 Player 接口；同步/体检由 sync.js 编排本文件暴露的方法。 */

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
  /* 集中状态（docs/review.md 架构-风险 2）：除 stations 数据外含渲染哨兵，全部变更走 render() */
  state: { stations: STARTER.slice(), cat: '全部', keyword: '', renderOrder: [], renderStamp: 0 },
  favs: new Set(),      // 收藏键（c|n）
  lastKey: null,        // 上次收听，未播放时点 ▶ 续播

  /* ---------- 解析 radio.txt（"分类,#genre#" 分节，每行 名字,地址） ---------- */
  parse(text) {
    const map = new Map(); let sec = '未分类';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim(); if (!line) continue;
      if (line.endsWith('#genre#')) { sec = line.replace(/,#genre#$/, ''); continue; }
      const i = line.lastIndexOf(','); if (i < 0) continue;
      const n = line.slice(0, i).trim(), u = line.slice(i + 1).trim();
      if (!/^https?:\/\//.test(u)) continue;
      const k = sec + '|' + n;
      if (!map.has(k)) map.set(k, { c: sec, n, u: [] });
      if (!map.get(k).u.includes(u)) map.get(k).u.push(u);
    }
    return [...map.values()];
  },
  setData(list, merge) {
    if (!merge) this.state.stations = list;
    else {
      const byKey = new Map(this.state.stations.map(s => [keyOf(s), s]));
      for (const s of list) {
        const k = keyOf(s), cur = byKey.get(k);
        if (cur) s.u.forEach(u => !cur.u.includes(u) && cur.u.push(u));
        else byKey.set(k, s);
      }
      this.state.stations = [...byKey.values()];
    }
    this.buildCats(); this.render();
    if (!Player.station) this.showLast(); // 数据刷新后未播放则提示上次收听（播放中不动）
  },
  showLast() {
    const s = this.lastKey && this.state.stations.find(x => keyOf(x) === this.lastKey);
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
    const cats = ['全部', '★收藏', ...order.filter(c => present.has(c)), ...[...present].filter(c => !order.includes(c))];
    if (!cats.includes(this.state.cat)) this.state.cat = '全部'; // 数据更新后分类可能消失，回退全部
    // 互斥单选语义用 aria-current（aria-pressed 是独立开关语义，不适用）
    $('cats').innerHTML = cats.map(c => `<button type="button" class="chip${c === this.state.cat ? ' on' : ''}" data-c="${this.esc(c)}"${c === this.state.cat ? ' aria-current="true"' : ''}>${this.esc(c)}</button>`).join('');
    restore();
  },
  visible() {
    const st = this.state, kw = st.keyword.toLowerCase();
    return st.stations.filter(s =>
      (st.cat === '全部' || (st.cat === '★收藏' ? this.favs.has(keyOf(s)) : s.c === st.cat)) &&
      (!kw || s.n.toLowerCase().includes(kw)));
  },
  // 电台名/分类来自远程上游仓库，渲染前必须转义（防注入）
  esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  emptyHtml() { // 空态给出原因和下一步动作
    const msg = this.state.cat === '★收藏' && !this.favs.size ? '还没有收藏电台——点电台左侧 ☆ 即可收藏'
      : this.state.keyword ? `没有匹配「${this.esc(this.state.keyword)}」的电台，换个关键词试试` : '该分类暂无电台';
    return `<div class="empty">${msg}</div>`;
  },
  render() {
    const restore = this.keepFocus($('list'), 'k', 'fav'); // 焦点在行或收藏按钮上都找回
    const list = this.visible();
    this.state.renderOrder = list; this.state.renderStamp++;
    const pk = Player.station && keyOf(Player.station), ck = Player.connecting && keyOf(Player.connecting);
    $('list').innerHTML = list.map((s, i) => {
      const k = keyOf(s), on = this.favs.has(k), playing = k === pk;
      const hp = s.health ? `<span class="health ${s.health === 'ok' ? 'ok' : 'bad'}" title="体检${s.health === 'ok' ? '可用' : '不可用'}">${s.health === 'ok' ? '✓' : '✗'}</span>` : '';
      return `<div class="row${playing ? ' playing' : ''}${k === ck ? ' connecting' : ''}${s.health === 'dead' ? ' dead' : ''}" data-k="${this.esc(k)}" data-i="${i}" role="button" tabindex="0" aria-label="${this.esc(s.n)}${playing ? '（播放中）' : ''}"${playing ? ' aria-current="true"' : ''}${s.health === 'dead' ? ' title="体检不可用，点击仍可尝试播放"' : ''}>
        <button type="button" class="fav${on ? ' on' : ''}" data-fav="${this.esc(k)}" aria-pressed="${on}" aria-label="${on ? '取消收藏' : '收藏'}：${this.esc(s.n)}" title="${on ? '取消收藏' : '收藏'}">${on ? '★' : '☆'}</button>
        <span class="name">${this.esc(s.n)}</span>${hp}
        <span class="badge">${this.esc(s.c)}</span><span class="srcs" title="备选源数量">${s.u.length}源</span></div>`;
    }).join('') || this.emptyHtml();
    restore();
  },
  togglePlay(k) { // 再点当前台 = 暂停/继续；点其他台 = 切换
    const s = this.state.stations.find(x => keyOf(x) === k); if (!s) return;
    if (Player.station && keyOf(Player.station) === k) {
      Player.isPaused() ? Player.resume() : Player.pause();
      return;
    }
    this.lastKey = k; localStorage.setItem('radio.last', k);
    Player.play(s);
  },

  boot() {
    // localStorage 可能被外部改坏，全部容错读取（favs 解析失败回退空集）
    try { this.favs = new Set(JSON.parse(localStorage.getItem('radio.favs') || '[]')); } catch (_) { this.favs = new Set(); }
    this.lastKey = localStorage.getItem('radio.last') || null;
    // 音量持久化（读取夹取 0-100，坏值回退 90）
    const savedVol = localStorage.getItem('radio.vol'), vol0 = +savedVol;
    const vol = savedVol !== null && Number.isFinite(vol0) && vol0 >= 0 && vol0 <= 100 ? vol0 : 90;
    if (savedVol !== null && Number.isFinite(vol0) && vol0 >= 0 && vol0 <= 100) $('vol').value = vol0;
    Player.init($('audio'), vol / 100);

    // Player 状态回调：full=true 需整表重渲（行高亮/连接中变化），否则只轻量更新底部
    Player.onstate = full => {
      const s = Player.station;
      if (s) { $('now').textContent = '▶ ' + s.n; $('pp').textContent = (Player.connecting || !Player.isPaused()) ? '⏸' : '▶'; }
      else { $('pp').textContent = '▶'; this.showLast(); }
      if (full) this.render();
    };
    Player.onstatus = t => { $('status').textContent = t; };
    Player.onfail = () => this.showLast();

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
      if (fav) { const k = fav.dataset.fav; this.favs.has(k) ? this.favs.delete(k) : this.favs.add(k); localStorage.setItem('radio.favs', JSON.stringify([...this.favs])); this.render(); return; }
      const row = e.target.closest('.row'); if (row) this.togglePlay(row.dataset.k);
    };
    $('list').onkeydown = e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.row');
      if (row && e.target === row) { e.preventDefault(); this.togglePlay(row.dataset.k); }
    };

    // 底部控制：未播放时 ▶ = 续播上次收听；播放中 = 暂停；暂停 = 继续
    $('pp').onclick = () => {
      if (!Player.station) {
        const s = this.lastKey && this.state.stations.find(x => keyOf(x) === this.lastKey);
        if (s) this.togglePlay(this.lastKey); else $('status').textContent = '上次收听的电台已不在列表中，请直接点播';
        return;
      }
      Player.isPaused() ? Player.resume() : Player.pause();
    };
    $('vol').oninput = e => { Player.setVolume(e.target.value / 100); localStorage.setItem('radio.vol', e.target.value); };

    // 列表加载：radio.txt + 个人补充 my-radio.txt，file:// 下回退内置 + 手动导入
    fetch('radio.txt').then(r => r.ok ? r.text() : Promise.reject())
      .then(t => this.setData(this.parse(t), true))
      .catch(() => { $('hint').style.display = 'block'; });
    fetch('my-radio.txt').then(r => r.ok ? r.text() : Promise.reject()) // 个人自建列表（已 gitignore，不会被同步覆盖）
      .then(t => this.setData(this.parse(t), true)).catch(() => {});
    $('importBtn').onclick = () => $('file').click();
    $('file').onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { this.setData(this.parse(String(r.result)), false); $('hint').style.display = 'none'; };
      r.readAsText(f, 'utf-8');
    };

    this.buildCats(); this.render(); this.showLast(); // file:// 降级模式下也补齐「上次收听」提示
  },
};

App.boot();
