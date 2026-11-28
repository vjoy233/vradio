// 逐字段 diff 工具（P2，方案 §3 L4「差异报告点名段路径和端，不接受整体不相等」）：
// 黄金样本 round-trip 失败时不再只给 deep-equal 整包 dump——按字段路径逐条列出「期望 → 实际」。
// ⚠ 完成范围如实标注（review#40 P2-6，挂账见 docs/testing-strategy-2026-11.md §10 附录）：
// · Web 已接 quality-aggregate expected（test/quality-store.js）及 metadata-golden（test/metadata.js）；
// · Android 侧差异不带字段路径（ContractTest.kt 等仍走整体 assert + 自有消息，无 Kotlin 等价物）；
// · Web 共享格式逐字段门未全覆盖——未接：backup-v2/v3、playlist-pls/xspf/asx、diagnostic-results；
// · 不做生产依赖；两侧各自断言同一 fixture，等价性由双端 round-trip 共同保证。
function walk(a, b, path, out) {
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb || ta === 'null' || tb === 'null' || (ta !== 'object' && ta !== 'array')) {
    if (a !== b) out.push(path + ': 期望 ' + JSON.stringify(a) + ' → 实际 ' + JSON.stringify(b));
    return;
  }
  if (ta === 'array') {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) walk(a[i], b[i], path + '[' + i + ']', out);
    return;
  }
  const keys = Object.keys(a).concat(Object.keys(b).filter(k => !(k in a)));
  for (const k of keys.sort()) walk(a[k], k in b ? b[k] : undefined, path ? path + '.' + k : k, out);
}
function deepDiff(expected, actual) { // 返回差异路径数组（全等 = 空数组）
  const out = [];
  walk(expected, actual, '', out);
  return out;
}
module.exports = { deepDiff };
