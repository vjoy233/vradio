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
        const t = await fetch('radio.txt?t=' + Date.now()).then(x => x.text());
        App.setData(App.parse(t), false);
        const eu = r.euKept != null ? `欧美音乐 ${r.euKept} 个实测可用` : '欧美音乐未更新（已保留旧列表）';
        $('status').textContent = `同步完成：共 ${r.total} 台（${r.delta >= 0 ? '+' : ''}${r.delta}；${eu}）`;
      }
    } catch (e) { $('status').textContent = '同步失败（file:// 或无后端时请在项目目录跑 node update-sources.js）：' + e.message; }
    b.disabled = false; b.textContent = '同步源';
  },

  /* ---------- 体检：当前列表逐台探测（多源任一活即活，服务端检测无 CORS 限制），
     可随时取消，逐行增量更新标记避免整表重渲卡顿 ---------- */
  abort: false,
  async health() {
    const b = $('healthBtn');
    if (b.textContent.includes('取消')) { this.abort = true; return; }
    this.abort = false; b.textContent = '取消体检';
    const list = App.visible(); let done = 0, alive = 0;
    const stamp = App.state.renderStamp, q = list.slice();
    const worker = async () => {
      while (q.length && !this.abort) {
        const s = q.shift(); let ok = false;
        try {
          const qs = s.u.slice(0, 4).map(u => 'url=' + encodeURIComponent(u)).join('&'); // 最多测前4个源
          ok = (await fetch('/api/check?' + qs).then(x => x.json())).ok;
        } catch (_) {}
        s.health = ok ? 'ok' : 'dead'; if (ok) alive++; done++;
        if (App.state.renderStamp === stamp) { // 列表未被重渲时增量更新该行，否则只更新数据等下次 render
          const row = $('list').querySelector(`.row[data-i="${App.state.renderOrder.indexOf(s)}"]`);
          if (row) {
            row.classList.toggle('dead', !ok);
            const old = row.querySelector('.health'); if (old) old.remove();
            const sp = document.createElement('span'); sp.className = 'health ' + (ok ? 'ok' : 'bad'); sp.textContent = ok ? '✓' : '✗';
            row.insertBefore(sp, row.querySelector('.badge'));
          }
        }
        if (done % 10 === 0 || !q.length) $('status').textContent = `体检 ${done}/${list.length}，可用 ${alive}（点「取消体检」中止）`;
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    $('status').textContent = this.abort ? `体检已取消：完成 ${done}/${list.length}` : `体检完成：${alive}/${list.length} 可用（✗ 台建议换源或点「同步源」重建）`;
    b.textContent = '体检';
  },
};

$('syncBtn').onclick = () => Sync.doSync();
$('healthBtn').onclick = () => Sync.health();
