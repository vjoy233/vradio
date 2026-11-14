/* VRadio 源顺序/禁用决策（B1，plan-expansion-r4 §5.4）—— 纯函数、零依赖、经典 script + CommonJS 双兼容，
   Web/Android 双端同语义的单一来源（Android 侧按同款规则镜像实现，语义测试对齐）。
   输入索引空间一律是同步原始 s.u[]（身份公理：s.u[0] 是身份键，人工排序绝不物理重排数组）。
   - effective(u, manual, disabled)：manual = 该台的人工顺序 URL 数组（cfg.srcManualOrder），disabled = 被禁
     URL 数组（cfg.srcDisabled）；order = manual 中存在于 u 的（按 manual 序）+ 未列入 manual 的（按 u 原序追加）；
     disabled 命中 u 的索引从 order 剔除进 dis；manual/disabled 中不在 u 的 URL 忽略；无 manual 时 order = [0..n-1]。
   - pick(order, prefer, mem)：播放首选索引——prefer 有效（在 order 内）用 prefer；否则 mem 在 order 内用 mem；
     否则 order[0]；order 空 → -1（= NO_ENABLED_SOURCE，全部源被禁用）。 */
const SrcOrder = {
  effective(u, manual, disabled) {
    const arr = Array.isArray(u) ? u : [];
    let order;
    if (Array.isArray(manual) && manual.length) {
      const seen = new Set();
      order = [];
      for (const m of manual) { const i = arr.indexOf(m); if (i >= 0 && !seen.has(i)) { seen.add(i); order.push(i); } } // manual 序优先；重复条目只取一次
      for (let i = 0; i < arr.length; i++) if (!seen.has(i)) order.push(i); // 未列入 manual 的按 u 原序追加
    } else order = arr.map((_, i) => i);
    const dis = new Set(Array.isArray(disabled) ? disabled : []);
    const ord = [], d = [];
    for (const i of order) (dis.has(arr[i]) ? d : ord).push(i); // 禁用命中进 dis；不在 u 的禁用 URL 天然忽略
    return { order: ord, dis: d };
  },
  pick(order, prefer, mem) {
    const ord = Array.isArray(order) ? order : [];
    if (Number.isInteger(prefer) && prefer >= 0 && ord.includes(prefer)) return prefer;
    if (Number.isInteger(mem) && mem >= 0 && ord.includes(mem)) return mem; // mem 指向禁用源（不在 order）→ 忽略顺延
    return ord.length ? ord[0] : -1;
  },
};
if (typeof window !== 'undefined') window.SrcOrder = SrcOrder;
if (typeof module !== 'undefined') module.exports = SrcOrder;
