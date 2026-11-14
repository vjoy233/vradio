/* VRadio 同步/体检编排 —— 只调用 App/Player 暴露的接口，不直接改列表状态（模块契约见 docs/review.md 十一节）。
   体检查通道（grill R1-R4 拍板）：手动全量（用户主动，反馈走 #status）/ 开机静默复测（收藏+最近 ∪ 死标记台，
   节流见 App.scopeDead）/ 同步后增量（diff 新增国内台）/ 首启基线（确认门槛 + 中断续跑）——后三者为后台任务，
   busy 互斥手动优先，反馈一律走 toast 不写 #status。 */

const Sync = {
  busy: '',       // '' | 'manual' | 'silent'：体检互斥（B-10）——手动优先，手动启动时静默版让位退出（收尾由手动接管）
  abort: false,   // 手动体检取消标志
  silentAbort: false, // 静默版让位/退出标志（与 abort 分开，避免「取消静默」误伤随后启动的手动体检）

  /* 探活执行器（四通道共用）：逐台 /api/check（前 4 源，任一活即 OK）；网络层失败不是探活结论不落标记（P3-12）。
     手动禁用源不体检（B1 拍板：播放与自动探活都跳过）；全禁用台直接跳过——不请求也不落健康标记。
     返回 { ok, sus, perm, done }——sus/perm 为分档计数（D12 统计用）；onTick(s, 档位) 供基线续跑记进度 */
  async runCheck(list, opt = {}) {
    const stamp = App.state.stamp, q = list.slice(), conc = opt.conc || 5, cnt = { ok: 0, sus: 0, perm: 0, done: 0 };
    const t0 = Date.now();
    const stop = () => opt.silent ? this.silentAbort : this.abort;
    const worker = async () => {
      while (q.length && !stop()) {
        const s = q.shift();
        const urls = (s.dis && s.dis.length ? s.u.filter((_, i) => !s.dis.includes(i)) : s.u).slice(0, 4);
        cnt.done++;
        if (opt.onProgress) opt.onProgress(cnt, q.length, t0);
        if (!urls.length) continue; // 全禁用台：跳过不落标记
        let ok = false, marked = true;
        try {
          const qs = urls.map(u => 'url=' + encodeURIComponent(u)).join('&');
          ok = (await fetch('/api/check?' + qs).then(x => x.json())).ok;
        } catch (_) { marked = false; }
        if (marked) { const r = App.patchHealth(s, ok, stamp); cnt[r]++; if (opt.onTick) opt.onTick(s, r); }
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    return cnt;
  },

  /* ---------- 一键同步最新源（国内上游 + 欧美台逐个实测重建，约1分钟） ---------- */
  async doSync() {
    const b = $('syncBtn'), lab = b.querySelector('span'); b.disabled = true; lab.textContent = '同步中…'; $('prog').hidden = false;
    $('status').textContent = '同步中：国内上游 + 欧美台逐个实测，约 1 分钟…';
    try {
      const r = await fetch('/api/sync', { method: 'POST' }).then(x => x.json());
      if (r.error) throw new Error(r.error);
      if (r.aborted) {
        $('status').textContent = `同步中止：合并结果异常（仅 ${r.total} 台），已保留原列表`;
      } else {
        await App.reloadMain(); // 决策 B：主列表 replace + 个人层常驻（radio.txt 与 my-radio.txt 重拉重并）
        const eu = r.euKept != null ? `欧美音乐 ${r.euKept} 个实测可用` : '欧美音乐未更新（已保留旧列表）';
        const dd = (r.added || r.removed) ? `；新增 ${r.added} 台、消失 ${r.removed} 台` : ''; // 同步 diff 摘要（N4/r2 ⑥）
        let msg = `同步完成：共 ${r.total} 台（${r.delta >= 0 ? '+' : ''}${r.delta}${dd}；${eu}）`;
        const gone = r.removedNames && App.favsGone(r.removedNames, r.removedUrls); // 消失台含收藏台单独点名（收藏在 localStorage，比对必须在前端；名+URL 双通道，AIbot P3-1）
        if (gone && gone.length) {
          const show = gone.length > 5 ? gone.slice(0, 5).join('、') + ` 等 ${gone.length} 个` : gone.join('、');
          msg += ` ⚠ 收藏台已不在新列表：${show}`; // textContent 直写不经 HTML，注入面不存在
        }
        $('status').textContent = msg;
        // 同步后增量体检（D4/R4 拍板）：本次 diff 新增的国内台静默探活（欧美台同步期已实测不在名单），
        // 自动跑 + toast 两态；手动体检在跑则本次放弃（下次同步再测）
        if (r.addedCheck && r.addedCheck.length) setTimeout(() => this.incHealth(r.addedCheck), 800);
      }
    } catch (e) {
      const msg = String(e.message || e);
      $('status').textContent = msg.includes('同步已在进行中') ? msg : '同步失败（file:// 或无后端时请在项目目录跑 node update-sources.js）：' + msg;
    }
    b.disabled = false; lab.textContent = '同步源'; $('prog').hidden = true;
  },

  /* ---------- 手动体检：当前列表逐台探测（UI 态编排：按钮/状态栏/ETA）——用户主动操作，反馈走 #status ---------- */
  async health() {
    if (!location.protocol.startsWith('http')) { // P3-12：file:// 下无后端，明确提示且不落任何标记
      $('status').textContent = 'file:// 降级模式无后端，体检不可用——npm start 后再试';
      return;
    }
    const b = $('healthBtn'), lab = () => b.querySelector('span');
    if (lab().textContent === '取消体检') { this.abort = true; return; }
    if (this.busy === 'silent') this.silentAbort = true; // 静默让位（手动优先）
    this.busy = 'manual'; this.abort = false; lab().textContent = '取消体检'; $('prog').hidden = false;
    try {
      const list = App.visible(true); // visible(true)：连默认隐藏的死台一起复查，复活即自动回归列表
      const cnt = await this.runCheck(list, { conc: 5, onProgress: (c, left, t0) => {
        if (c.done % 10 && left) return; // P3-8：按实测速率外推 ETA（按小时级最坏校准），每 10 台刷一次
        const rate = c.done / Math.max(1, (Date.now() - t0) / 1000);
        const eta = left && rate > 0 ? Math.ceil(left / rate / 60) : 0;
        $('status').textContent = `体检 ${c.done}/${list.length}，可用 ${c.ok}${eta > 0 ? `，预计还需 ~${eta} 分钟` : ''}（点「取消体检」中止）`;
      } });
      App.saveHealth(); // patchHealth 只改内存，收尾统一落盘一次（正常结束/取消都走这里）
      App.render(); // P3-13：途中若发生过整表重渲，结束时兜底一次，标记不丢（含「已停运」徽标收口）
      $('status').textContent = this.abort
        ? `体检已取消：完成 ${cnt.done}/${list.length}（已确认的标记已保留）`
        : `体检完成：可用 ${cnt.ok}、疑似失效 ${cnt.sus}、已停运 ${cnt.perm}（✗ 台建议换源或点「同步源」重建）`; // D12 分档统计
    } finally { lab().textContent = '体检'; this.busy = ''; $('prog').hidden = true; }
  },

  /* ---------- 开机后台编排（R3/R4 拍板）：基线优先——未建基线（含已确认过的中断续跑）不跑常规复测（基线是超集） ---------- */
  bootQuiet() {
    if (Store.get('radio.baselineProg')) return this.baseline(); // 确认过的中断续跑：不再打扰直接续
    if (!Store.get('radio.baseline')) return this.baselinePrompt(); // 从未建基线：toast 确认门槛
    this.silentHealth();
  },

  /* ---------- 开机静默复测（B-10 + R1/R4）：收藏+最近 ∪ 死标记台（节流范围见 App.scopeDead） ---------- */
  async silentHealth() {
    if (!location.protocol.startsWith('http') || this.busy) return; // file:// 无声跳过；手动体检在跑则让位
    const seen = new Set(), list = [];
    for (const s of [...App.scopeFavRecent(30), ...App.scopeDead()]) { const k = keyOf(s); if (!seen.has(k)) { seen.add(k); list.push(s); } }
    if (!list.length) return;
    this.busy = 'silent'; this.silentAbort = false;
    try { await this.runCheck(list, { conc: 2, silent: true }); if (!this.silentAbort) { App.saveHealth(); App.render(); } } // 被手动接管时跳过：手动跑完自己收尾
    catch (_) {} finally { if (this.busy === 'silent') this.busy = ''; }
  },

  /* ---------- 同步后增量体检（D4/R4）：diff 新增国内台静默探活 + toast 两态；被手动接管即放弃（下次同步再测） ---------- */
  async incHealth(names) {
    if (!location.protocol.startsWith('http') || this.busy) return;
    const set = new Set(names), list = App.state.stations.filter(s => set.has(s.n) && !s.hidden);
    if (!list.length) return;
    this.busy = 'silent'; this.silentAbort = false;
    App.toast(`后台体检新增电台 ${list.length} 台…`, { ms: 0 }); // ms=0 常驻，完成态接管；让位/异常分支显式收起（AIbot P2-2）
    try {
      const cnt = await this.runCheck(list, { conc: 2, silent: true });
      if (this.silentAbort) { $('toast').hidden = true; return; } // 让位给手动：已测的标记有效（幂等），未测的下次同步再覆盖
      App.saveHealth(); App.render();
      App.toast(`新增 ${list.length} 台体检完成，${cnt.sus + cnt.perm} 台无效已隐藏`, { ms: 5000 });
    } catch (_) { $('toast').hidden = true; } finally { if (this.busy === 'silent') this.busy = ''; }
  },

  /* ---------- 首启基线（R3+R4 拍板）：存量老台一次清库。确认门槛 toast（开跑时间用户定）→ 后台全量（并发 2，
     排除欧美两分类）→ 中断续跑（radio.baselineProg 记已确认台，重跑跳过）→ 完成置 radio.baseline；
     手动让位即中断（进度已存，下次 boot 无声续跑）；file:// 不跑不置位 ---------- */
  baselinePrompt() {
    if (!location.protocol.startsWith('http') || Store.get('radio.baseline')) return;
    const list = App.baselineList();
    if (!list.length) return this.baselineDone(); // 纯欧美库存（同步期已实测）：无基线可建
    const min = Math.max(1, Math.round(list.length / 30)); // 混合速率粗估（死台快速失败为主）
    App.toast(`检测到 ${list.length} 台电台尚无体检基线（约 ${min} 分钟，后台静默、中断可续）`, {
      ms: 0, // 常驻直到选择（AIbot P3-5：9s 自动消失来不及点，错过要等下轮 boot）；「暂不」= 本次放弃，下次 boot 再提示
      action: { label: '开始基线体检', fn: () => this.baseline() },
      dismiss: '暂不',
    });
  },
  async baseline() {
    if (!location.protocol.startsWith('http') || this.busy) return;
    let prog; try { prog = new Set(JSON.parse(Store.get('radio.baselineProg') || '[]')); } catch (_) { prog = new Set(); }
    const list = App.baselineList().filter(s => !prog.has(keyOf(s))); // 续跑：跳过已确认的（R4 拍板，幂等探活重跑无副作用只是浪费时间）
    if (!list.length) return this.baselineDone();
    this.busy = 'silent'; this.silentAbort = false;
    App.toast(`基线体检进行中：剩余 ${list.length} 台（后台静默，可随时关页中断、下次自动续跑）`, { ms: 6000 });
    let pend = 0;
    try {
      const cnt = await this.runCheck(list, { conc: 2, silent: true, onTick: s => {
        prog.add(keyOf(s));
        if (++pend >= 25) { pend = 0; Store.set('radio.baselineProg', JSON.stringify([...prog])); App.saveHealth(); } // 每 25 台落盘一次：进度与已确认标记必须同批持久化（AIbot P1-1——否则关页中断时 prog 说测过、死标只在内存，续跑跳过 + 基线置 done 后这批台永久无标记且不在任何自动复查通道里）
      } });
      if (this.silentAbort) return; // 让位中断：进度兜底落盘见 finally（防 pend <25 的尾巴丢失）
      Store.set('radio.baselineProg', JSON.stringify([...prog]));
      this.baselineDone();
      App.saveHealth(); App.render();
      App.toast(`基线体检完成：可用 ${cnt.ok}、疑似失效 ${cnt.sus}、已停运 ${cnt.perm}`, { ms: 6000 });
    } catch (_) {} finally {
      if (this.busy === 'silent') this.busy = '';
      if (this.silentAbort) { Store.set('radio.baselineProg', JSON.stringify([...prog])); App.saveHealth(); } // 中断兜底（同 P1-1 口径）
    }
  },
  baselineDone() { Store.set('radio.baseline', 'done'); Store.remove('radio.baselineProg'); },
};

$('syncBtn').onclick = () => Sync.doSync();
$('healthBtn').onclick = () => Sync.health().catch(e => { // health() 内部只兜了探活失败，其余异常不兜底会把按钮永久卡在「取消体检」
  $('status').textContent = '体检异常：' + (e && e.message || e);
  $('healthBtn').querySelector('span').textContent = '体检';
});
