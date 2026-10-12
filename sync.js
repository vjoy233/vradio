/* VRadio 同步/体检编排 —— 只调用 App/Player 暴露的接口，不直接改列表状态（模块契约见 docs/review.md 十一节）。 */

const Sync = {
  busy: '',       // '' | 'manual' | 'silent'：体检互斥（B-10）——手动优先，手动启动时静默版让位退出（不落盘不渲染，收尾由手动接管）
  abort: false,   // 手动体检取消标志（共享给 runCheck）
  silentAbort: false, // 静默版让位/退出标志（与 abort 分开，避免「取消静默」误伤随后启动的手动体检）

  /* ---------- 一键同步最新源（国内上游 + 欧美台逐个实测重建，约1分钟） ---------- */
  async doSync() {
    const b = $('syncBtn'); b.disabled = true; b.textContent = '同步中…';
    $('status').textContent = '同步中：国内上游 + 欧美台逐个实测，约 1 分钟…';
    try {
      const r = await fetch('/api/sync', { method: 'POST' }).then(x => x.json());
      if (r.error) throw new Error(r.error);
      if (r.aborted) {
        $('status').textContent = `同步中止：合并结果异常（仅 ${r.total} 台），已保留原列表`;
      } else {
        await App.reloadMain(); // 决策 B：主列表 replace + 个人层常驻（radio.txt 与 my-radio.txt 重拉重并）
        const eu = r.euKept != null ? `欧美音乐 ${r.euKept} 个实测可用` : '欧美音乐未更新（已保留旧列表）';
        $('status').textContent = `同步完成：共 ${r.total} 台（${r.delta >= 0 ? '+' : ''}${r.delta}；${eu}）`;
      }
    } catch (e) {
      const msg = String(e.message || e);
      $('status').textContent = msg.includes('同步已在进行中') ? msg : '同步失败（file:// 或无后端时请在项目目录跑 node update-sources.js）：' + msg;
    }
    b.disabled = false; b.textContent = '同步源';
  },

  /* ---------- 手动体检：当前列表逐台探测（UI 态编排：按钮/状态栏/ETA） ---------- */
  async health() {
    if (!location.protocol.startsWith('http')) { // P3-12：file:// 下无后端，明确提示且不落任何标记
      $('status').textContent = 'file:// 降级模式无后端，体检不可用——npm start 后再试';
      return;
    }
    const b = $('healthBtn');
    if (b.textContent.includes('取消')) { this.abort = true; return; }
    if (this.busy === 'silent') this.silentAbort = true; // 静默让位（手动优先）
    this.busy = 'manual'; this.abort = false; b.textContent = '取消体检';
    try {
      const list = App.visible(true); let done = 0, alive = 0; // visible(true)：连默认隐藏的死台一起复查，复活即自动回归列表
      const stamp = App.state.stamp, q = list.slice(), t0 = Date.now();
      const worker = async () => {
        while (q.length && !this.abort) {
          const s = q.shift(); let ok = false, marked = true;
          try {
            const qs = s.u.slice(0, 4).map(u => 'url=' + encodeURIComponent(u)).join('&'); // 最多测前4个源
            ok = (await fetch('/api/check?' + qs).then(x => x.json())).ok;
          } catch (_) { marked = false; } // 网络层失败（如页面被挂起）不是探活结论，不落标记（P3-12）
          if (marked) { App.patchHealth(s, ok, stamp); if (ok) alive++; }
          done++;
          if (done % 10 === 0 || !q.length) {
            const rate = done / Math.max(1, (Date.now() - t0) / 1000); // P3-8：按实测速率外推 ETA（按小时级最坏校准）
            const eta = q.length && rate > 0 ? Math.ceil(q.length / rate / 60) : 0;
            $('status').textContent = `体检 ${done}/${list.length}，可用 ${alive}${eta > 0 ? `，预计还需 ~${eta} 分钟` : ''}（点「取消体检」中止）`;
          }
        }
      };
      await Promise.all(Array.from({ length: 5 }, worker));
      App.saveHealth(); // patchHealth 只改内存，收尾统一落盘一次（正常结束/取消都走这里）
      App.render(); // P3-13：途中若发生过整表重渲，结束时兜底一次，标记不丢
      $('status').textContent = this.abort ? `体检已取消：完成 ${done}/${list.length}` : `体检完成：${alive}/${list.length} 可用（✗ 台建议换源或点「同步源」重建）`;
    } finally { b.textContent = '体检'; this.busy = ''; }
  },

  /* ---------- 开机静默体检（B-10 便宜变体）：收藏+最近范围，不碰按钮/状态栏，零服务端改动 ---------- */
  async silentHealth() {
    if (!location.protocol.startsWith('http') || this.busy) return; // file:// 无声跳过；手动体检在跑则让位
    const list = App.scopeFavRecent(30);
    if (!list.length) return;
    this.busy = 'silent'; this.silentAbort = false;
    try {
      let done = 0, alive = 0;
      const stamp = App.state.stamp, q = list.slice();
      const worker = async () => {
        while (q.length && !this.silentAbort) {
          const s = q.shift(); let ok = false, marked = true;
          try {
            const qs = s.u.slice(0, 4).map(u => 'url=' + encodeURIComponent(u)).join('&');
            ok = (await fetch('/api/check?' + qs).then(x => x.json())).ok;
          } catch (_) { marked = false; }
          if (marked) { App.patchHealth(s, ok, stamp); if (ok) alive++; }
          done++;
        }
      };
      await Promise.all(Array.from({ length: 2 }, worker)); // 并发 2：静默版让前台播放/台标补全优先用带宽
      if (!this.silentAbort) { App.saveHealth(); App.render(); } // 被手动接管时跳过：手动跑完自己收尾
    } catch (_) {} finally { if (this.busy === 'silent') this.busy = ''; }
  },
};

$('syncBtn').onclick = () => Sync.doSync();
$('healthBtn').onclick = () => Sync.health().catch(e => { // health() 内部只兜了探活失败，其余异常不兜底会把按钮永久卡在「取消体检」
  $('status').textContent = '体检异常：' + (e && e.message || e);
  $('healthBtn').textContent = '体检';
});
