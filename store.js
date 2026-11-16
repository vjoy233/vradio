/* VRadio 存储收敛层 —— radio.* 持久键的唯一读写出口（方案二/grill R1-R4 拍板，docs/plan-health-and-storage.md）。
   http 形态下 data/store.json（服务端 /api/store）为主源、localStorage 永远留镜像；file:// 或后端不可用时
   纯 localStorage（行为与旧版完全一致）。对账语义：后端永远为准 + dirty（后端写失败标记，**持久化在
   localStorage 的 radio.storeDirty**——AIbot P1-2：内存标记跨会话即丢，会让失败期改动被「后端为准」回滚）
   时先重推镜像再对账；rev 由服务端唯一发号（POST 成功分配），客户端只存不比——仲裁实质是「后端为准 +
   dirty 重推」，并发退化为显式 last-write-wins（后同步者胜）。多标签经 BroadcastChannel 'store' 重拉
   （与播放互斥 'on' 同通道；debounce 三规则：flush 时读当前内存/收消息作废 pending/beforeunload+visibilitychange flush）。
   review#37 双修：①apply 重载判定比对本页内存基线 mem（同源标签共享 localStorage，镜像一致 ≠ 内存一致，
   否则他页改动永远不进本页 App）；②flush 单飞串行 + 尾随重推（乱序响应下「旧快照迟到成功」不得清掉
   新改动的 dirty 资格；keepalive 卸载态例外直发）。

   ⚠ 白名单契约：新增任何 radio.* 持久键必须同步扩本文件 KEYS 与 server.js 的 STORE_KEYS——
   后端只收白名单键，漏扩的表现是换浏览器丢该键（localStorage 镜像仍在，本机无感）。
   例外：radio.logos（台标缓存，可重建不入主源）、radio.storeDirty（本层自身状态）。 */

const Store = {
  mode: 'local',  // 'local'（file:// 或后端失败降级，镜像即全部）| 'server'
  rev: 0,         // lastServerRev（服务端发号；调试/可观测用，不参与仲裁比较）
  sawData: false, // 本页见过非空服务端数据（boot/apply 置位，内存标志跨会话不持久——reload 后重新对账重建）
  pend: 0, bc: null,
  mem: null,      // 本页内存基线（KEYS → 本页 App 已见值）：同源多标签共享 localStorage，他页写镜像后本页
                  // 镜像「看起来已一致」，但 App 内存还是旧态——apply 的重载判定必须比对实例基线而非共享镜像（review#37 P1-2）
  inflight: false, trailing: false, // flush 单飞串行 + 尾随重推（review#37 P1-4，见 flush 注释）
  KEYS: ['radio.favs', 'radio.recents', 'radio.health', 'radio.cfg', 'radio.songs', 'radio.volperst', 'radio.srcmem2',
    'radio.vol', 'radio.view', 'radio.showdead', 'radio.theme', 'radio.baseline', 'radio.baselineProg'],

  get dirty() { return localStorage.getItem('radio.storeDirty') === '1'; }, // 持久化标记（非白名单元键，原生读写防自触发推送）
  set dirty(v) { try { v ? localStorage.setItem('radio.storeDirty', '1') : localStorage.removeItem('radio.storeDirty'); } catch (_) {} },

  init() { // App.boot 首行调用（Player.init 读记忆之前）
    this.mem = this.snapshot(); // 内存基线 = 本页开局镜像（App 首屏即从镜像渲染）
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
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} if (this.mem) this.mem[k] = v; this.schedule(); },
  remove(k) { try { localStorage.removeItem(k); } catch (_) {} if (this.mem) delete this.mem[k]; this.schedule(); },
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
      this.sawData = true; // 本页已知服务端非空（issue #42 空覆盖门的放行证据，dirty 重推分支同样置位）
      if (this.dirty) return this.flush(); // 后端失败期镜像较新：重推 pending 而非回退（P1-2：dirty 持久化后跨会话可达）
      this.apply(data);
    } catch (_) {} // 后端不可用：留 local 模式，镜像即全部
  },

  /* 后端为准应用（键级合并，基线开跑前置修复）：后端有该键 = 该键最新写入在后端（覆盖本地）；后端快照缺键
     = 后端侧从未写过该键——**保留本地，随下次 flush 汇合**，绝不能 removeItem：多浏览器首次迁移窗口
     （各浏览器旧 localStorage 尚未汇合到主源）里全量覆盖会把后端没见过的键（收藏/配置）静默抹掉。
     删除语义靠值表达（收藏清空 = favs 空数组、重置 = cfg 空对象），键消失仅 baselineProg 一种且自愈
     （复活 → 续跑空表 → 再置 done）。
     重载判定（review#37 P1-2）：比对「本页内存基线」而非共享镜像——同浏览器多标签共享 localStorage，
     他页 set 即写共享镜像，本页镜像看起来已一致但 App 内存仍是旧态；只看镜像会跳过重载，他页改动
     永远不进本页内存（直到手刷）。镜像写入与内存基线任一有差即视为该键 stale。
     进度类键（基线续跑进度）单独变化时只落盘不重载内存——否则基线期间他页每 ~25 台被广播触发一次
     整表重渲，打断滚动/阅读（AIbot P3-3）；其余键变化才走 App.applyServerStore 内存重载 */
  apply(data) {
    if (!this.mem) this.mem = this.snapshot(); // init 未走的直调 apply：懒初始化（此时镜像即内存基线）
    if (data && Object.keys(data).length) this.sawData = true; // 拉到非空数据即「见过」（pull 链同置，issue #42 门放行证据）
    let changed = false;
    const diff = [];
    for (const k of this.KEYS) {
      const v = data[k];
      if (v == null) continue; // 后端缺键 = 未见过的本地数据，保留待汇合（见上）
      const lsDiff = localStorage.getItem(k) !== v;
      const memDiff = this.mem[k] !== v;
      if (lsDiff) { localStorage.setItem(k, v); changed = true; }
      if (memDiff) this.mem[k] = v;
      if (lsDiff || memDiff) diff.push(k);
    }
    if (diff.some(k => k !== 'radio.baselineProg')) App.applyServerStore();
    return changed;
  },

  async flush(keepalive) { // 推镜像全量。序列化时点在 flush 执行时读当前内存（规则①：非 debounce 触发时的旧快照，
    clearTimeout(this.pend); // 他页重拉后本页 pending flush 的是新内存，不压他页改动）
    if (this.mode !== 'server') return;
    // 空覆盖门（issue #42 A）：空库态开局的页（快照全空 + 从未见过非空服务端数据——跨实例无 BC 通道，
    // unload/visibility 触发的 flush 是它唯一的推送点）以全空快照 POST 会整库覆盖他端写入。这不是
    // last-write-wins（LWW 建立在双方都有数据上）而是 wipe；合法删除语义靠值表达（收藏清空 = favs
    // '[]'、重置 = cfg '{}'），全空快照不承载任何合法状态（App 侧无任何「删 radio.* 键」路径）。
    // 此态改走 pull 对账先行、不上推；dirty 态静默返回（pull 的 dirty 分支会回调 flush 成环，且该组合
    // 业务不可达——置 dirty 的前提是有失败期写、有写快照即非全空）
    const gate = this.snapshot();
    if (!Object.keys(gate).length && !this.sawData) {
      if (!this.dirty) this.pull();
      return;
    }
    // keepalive（unload/切后台）直发，不进单飞状态机：页将亡，排队等价确定丢写；并行旧 POST 至多造成
    // 一次显式 last-write-wins 退化，优于静默丢改动
    if (keepalive) return this._postSnapshot(true);
    // 单飞串行 + 尾随重推（review#37 P1-4）：flush 无并发护栏时，乱序响应会让「旧快照的迟到成功」清掉新
    // 改动的 dirty 资格——flush A（旧快照）在飞 → 本地再改 → flush B 失败置 dirty → A 迟到成功把 dirty 清掉，
    // 本地较新却失去重推资格，下次启动被后端旧值回滚。改为一飞一队：在飞期间新 flush 只挂尾随标记，
    // 当前 POST 终态落定后自动补发（补发重读当前内存，规则①语义保持），乱序窗口结构性消除。
    if (this.inflight) { this.trailing = true; return; }
    this.inflight = true;
    try {
      await this._postSnapshot(false);
    } finally {
      this.inflight = false;
      if (this.trailing) { this.trailing = false; this.flush(); }
    }
  },

  async _postSnapshot(keepalive) { // 单次 POST（flush 的受护栏主体；快照在此刻现读——补发读最新内存）
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
