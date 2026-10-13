/* VRadio 存储收敛层 —— radio.* 持久键的唯一读写出口（方案二/grill R1-R4 拍板，docs/plan-health-and-storage.md）。
   http 形态下 data/store.json（服务端 /api/store）为主源、localStorage 永远留镜像；file:// 或后端不可用时
   纯 localStorage（行为与旧版完全一致）。仲裁 = 服务端唯一发号（rev 由 POST 成功分配，客户端永不自造）：
   后端写失败标 dirty，boot 先重推 pending 再对账——跨浏览器/换机窗口不再「同 rev 不同数据」静默错乱，
   并发退化为显式 last-write-wins（后同步者胜）。多标签经 BroadcastChannel 'store' 重拉（与播放互斥 'on' 同通道）。

   ⚠ 白名单契约：新增任何 radio.* 持久键必须同步扩本文件 KEYS 与 server.js 的 STORE_KEYS——
   后端只收白名单键，漏扩的表现是换浏览器丢该键（localStorage 镜像仍在，本机无感）。 */

const Store = {
  mode: 'local',  // 'local'（file:// 或后端失败降级，镜像即全部）| 'server'
  rev: 0,         // lastServerRev（服务端发号；客户端不自造）
  dirty: false,   // 后端写失败标记：boot/pull 对账前先重推镜像（R4 拍板）
  pend: 0, bc: null,
  KEYS: ['radio.favs', 'radio.recents', 'radio.health', 'radio.cfg', 'radio.songs', 'radio.volperst', 'radio.srcmem2',
    'radio.vol', 'radio.view', 'radio.showdead', 'radio.theme', 'radio.baseline', 'radio.baselineProg'],

  init() { // App.boot 首行调用（Player.init 读记忆之前）
    try {
      this.bc = new BroadcastChannel('vradio');
      this.bc.onmessage = e => { if (e.data === 'store') this.pull(); }; // 他页已推送：重拉后端（先作废本地 pending，规则②）
    } catch (_) { this.bc = null; }
    // 规则③：关页/切后台前同步 flush——300ms debounce 窗口内的改动不随关页丢失（keepalive 请求可穿 unload）
    const fl = () => this.flush(true);
    addEventListener('beforeunload', fl);
    document.addEventListener('visibilitychange', () => { if (document.hidden) fl(); });
  },

  get(k) { return localStorage.getItem(k); },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} this.schedule(); },
  remove(k) { try { localStorage.removeItem(k); } catch (_) {} this.schedule(); },
  schedule() { clearTimeout(this.pend); this.pend = setTimeout(() => this.flush(), 300); }, // 写放大护栏：音量条拖动等连续写攒批

  snapshot() { const o = {}; for (const k of this.KEYS) { const v = localStorage.getItem(k); if (v != null) o[k] = v; } return o; },

  async boot() { // App.boot 尾部异步调用：镜像先行渲染（首屏不等网络），此处才与后端对账（外部 review P1-3）
    if (!location.protocol.startsWith('http')) return;
    try {
      const r = await fetch('/api/store').then(x => x.json());
      if (!r || typeof r !== 'object' || typeof r.data !== 'object' || !r.data) return;
      this.mode = 'server'; this.rev = r.rev || 0;
      const data = r.data;
      if (!Object.keys(data).length) { // 首次迁移：镜像作初始快照静默推上去（老用户无感）
        if (Object.keys(this.snapshot()).length) await this.flush();
        return;
      }
      if (this.dirty) return this.flush(); // 后端失败期镜像较新：重推 pending 而非回退
      let changed = false; // 后端为准全量应用（原生写不经 set，避免触发回推）
      for (const k of this.KEYS) {
        const v = data[k];
        if (v == null) { if (localStorage.getItem(k) != null) { localStorage.removeItem(k); changed = true; } }
        else if (localStorage.getItem(k) !== v) { localStorage.setItem(k, v); changed = true; }
      }
      if (changed) App.applyServerStore(); // 内存重载：loadStore/cfg + Player 记忆 + rebind + render
    } catch (_) {} // 后端不可用：留 local 模式，镜像即全部
  },

  async flush(keepalive) { // 推镜像全量。序列化时点在 flush 执行时读当前内存（规则①：非 debounce 触发时的旧快照，
    clearTimeout(this.pend); // 他页重拉后本页 pending flush 的是新内存，不压他页改动）
    if (this.mode !== 'server') return;
    const body = JSON.stringify({ data: this.snapshot() });
    try {
      const r = await fetch('/api/store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: !!keepalive }).then(x => x.json());
      if (r && r.ok) { this.dirty = false; this.rev = r.rev; if (this.bc) this.bc.postMessage('store'); }
      else this.dirty = true;
    } catch (_) { this.dirty = true; }
  },

  async pull() { // 多标签重拉（收到他页 'store' 广播）：先作废本地 pending（规则②）→ 后端为准重放 → 内存重载。
    clearTimeout(this.pend);
    if (this.mode !== 'server') return;
    try {
      const r = await fetch('/api/store').then(x => x.json());
      if (!r || typeof r.data !== 'object' || !r.data) return;
      this.rev = r.rev || this.rev; this.dirty = false;
      const data = r.data;
      let changed = false;
      for (const k of this.KEYS) {
        const v = data[k];
        if (v == null) { if (localStorage.getItem(k) != null) { localStorage.removeItem(k); changed = true; } }
        else if (localStorage.getItem(k) !== v) { localStorage.setItem(k, v); changed = true; }
      }
      if (changed) App.applyServerStore();
    } catch (_) {}
  },
};
