/* VRadio 存储收敛层 —— radio.* 持久键的唯一读写出口（方案二/grill R1-R4 拍板，docs/plan-health-and-storage.md）。
   http 形态下 data/store.json（服务端 /api/store）为主源、localStorage 永远留镜像；file:// 或后端不可用时
   纯 localStorage（行为与旧版完全一致）。对账语义：后端永远为准 + dirty（后端写失败标记，**持久化在
   localStorage 的 radio.storeDirty**——AIbot P1-2：内存标记跨会话即丢，会让失败期改动被「后端为准」回滚）
   时先重推镜像再对账；rev 由服务端唯一发号（POST 成功分配），客户端只存不比——仲裁实质是「后端为准 +
   dirty 重推」，并发退化为显式 last-write-wins（后同步者胜）。多标签经 BroadcastChannel 'store' 重拉
   （与播放互斥 'on' 同通道；debounce 三规则：flush 时读当前内存/收消息作废 pending/beforeunload+visibilitychange flush）。

   ⚠ 白名单契约：新增任何 radio.* 持久键必须同步扩本文件 KEYS 与 server.js 的 STORE_KEYS——
   后端只收白名单键，漏扩的表现是换浏览器丢该键（localStorage 镜像仍在，本机无感）。
   例外：radio.logos（台标缓存，可重建不入主源）、radio.storeDirty（本层自身状态）。 */

const Store = {
  mode: 'local',  // 'local'（file:// 或后端失败降级，镜像即全部）| 'server'
  rev: 0,         // lastServerRev（服务端发号；调试/可观测用，不参与仲裁比较）
  pend: 0, bc: null,
  KEYS: ['radio.favs', 'radio.recents', 'radio.health', 'radio.cfg', 'radio.songs', 'radio.volperst', 'radio.srcmem2',
    'radio.vol', 'radio.view', 'radio.showdead', 'radio.theme', 'radio.baseline', 'radio.baselineProg'],

  get dirty() { return localStorage.getItem('radio.storeDirty') === '1'; }, // 持久化标记（非白名单元键，原生读写防自触发推送）
  set dirty(v) { try { v ? localStorage.setItem('radio.storeDirty', '1') : localStorage.removeItem('radio.storeDirty'); } catch (_) {} },

  init() { // App.boot 首行调用（Player.init 读记忆之前）
    try {
      this.bc = new BroadcastChannel('vradio');
      this.bc.onmessage = e => { if (e.data === 'store') this.pull(); }; // 他页已推送：重拉后端（先作废本地 pending，规则②）
    } catch (_) { this.bc = null; }
    // 规则③：关页/切后台前同步 flush——300ms debounce 窗口内的改动不随关页丢失（keepalive 请求可穿 unload；
    // 注意 keepalive body 有 64KB 规范上限，大 payload 可能失败——失败置 dirty，下次 boot 重推兜底，best-effort）
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
      if (this.dirty) return this.flush(); // 后端失败期镜像较新：重推 pending 而非回退（P1-2：dirty 持久化后跨会话可达）
      this.apply(data);
    } catch (_) {} // 后端不可用：留 local 模式，镜像即全部
  },

  /* 后端为准全量应用：进度类键（基线续跑进度）单独变化时只落盘不重载内存——否则基线期间他页每 ~25 台
     被广播触发一次整表重渲，打断滚动/阅读（AIbot P3-3）；其余键变化才走 App.applyServerStore 内存重载 */
  apply(data) {
    let changed = false;
    const diff = [];
    for (const k of this.KEYS) {
      const v = data[k];
      if (v == null) { if (localStorage.getItem(k) != null) { localStorage.removeItem(k); changed = true; diff.push(k); } }
      else if (localStorage.getItem(k) !== v) { localStorage.setItem(k, v); changed = true; diff.push(k); }
    }
    if (changed && diff.some(k => k !== 'radio.baselineProg')) App.applyServerStore();
    return changed;
  },

  async flush(keepalive) { // 推镜像全量。序列化时点在 flush 执行时读当前内存（规则①：非 debounce 触发时的旧快照，
    clearTimeout(this.pend); // 他页重拉后本页 pending flush 的是新内存，不压他页改动）
    if (this.mode !== 'server') return;
    const body = JSON.stringify({ data: this.snapshot() });
    try {
      const r = await fetch('/api/store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: !!keepalive }).then(x => x.json());
      if (r && r.ok) { this.dirty = false; this.rev = r.rev; if (this.bc) this.bc.postMessage('store'); }
      else this.dirty = true; // 写失败（含超限被拒）：置 dirty 保镜像，下次 boot/pull 先重推（AIbot P2-3：超限拒绝必须让客户端知道，静默丢键会把镜像也一起抹掉）
    } catch (_) { this.dirty = true; }
  },

  async pull() { // 多标签重拉（收到他页 'store' 广播）：先作废本地 pending（规则②）→ 脏页先重推自己的改动
    clearTimeout(this.pend); // （AIbot P2-1：无条件应用后端会确定性丢掉本页未推送改动）
    if (this.mode !== 'server') return;
    if (this.dirty) return this.flush();
    try {
      const r = await fetch('/api/store').then(x => x.json());
      if (!r || typeof r.data !== 'object' || !r.data) return;
      this.rev = r.rev || this.rev;
      this.apply(r.data);
    } catch (_) {}
  },
};
