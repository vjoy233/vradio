/* VRadio 同步/体检编排 —— 只调用 App/Player 暴露的接口，不直接改列表状态（模块契约见 docs/review.md 十一节）。 */

const Sync = {
  /* ---------- 一键同步最新源（国内上游 + 欧美台实测重建，约1分钟） ---------- */
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
    } catch (e) { $('status').textContent = '同步失败（file:// 或无后端时请在项目目录跑 node update-sources.js）：' + e.message; }
    b.disabled = false; b.textContent = '同步源';
  },

  /* ---------- 体检：当前列表逐台探测（多源任一活即活，服务端检测无 CORS 限制）。
     可随时取消；ETA 按实测速率外推；逐行增量更新（Map 索引）；结束兜底 render 防途中重渲吞标记 ---------- */
  abort: false,
  async health() {
    if (!location.protocol.startsWith('http')) { // P3-12：file:// 下无后端，明确提示且不落任何标记
      $('status').textContent = 'file:// 降级模式无后端，体检不可用——npm start 后再试';
      return;
    }
    const b = $('healthBtn');
    if (b.textContent.includes('取消')) { this.abort = true; return; }
    this.abort = false; b.textContent = '取消体检';
    const list = App.visible(); let done = 0, alive = 0;
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
    App.render(); // P3-13：途中若发生过整表重渲，结束时兜底一次，标记不丢
    $('status').textContent = this.abort ? `体检已取消：完成 ${done}/${list.length}` : `体检完成：${alive}/${list.length} 可用（✗ 台建议换源或点「同步源」重建）`;
    b.textContent = '体检';
  },
};

$('syncBtn').onclick = () => Sync.doSync();
$('healthBtn').onclick = () => Sync.health();
