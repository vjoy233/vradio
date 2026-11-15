/* 历史方案取证脚本；当前v2主方案请用contrast-check-v2.js。本脚本含有意FAIL，不作当前CI门槛。 */
/* WCAG 2.1 对比度实测脚本（零依赖，node docs/ui-redesign-assets/contrast-check.js）
   docs/plan-ui-redesign.md §4/§5 的全部色值主张以本脚本输出为准；任何改色必须先改这里复跑全绿再进 CSS。
   口径：sRGB→linear 相对亮度（WCAG 官方公式）；≥4.5 正常文字 AA，≥3.0 大字/功能性图形 AA；
   纯装饰边框/分隔线不承担识别职能，不作 3:1 主张（WCAG 1.4.11 豁免）。 */
'use strict';
const lum = hex => {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
const hsl = (h, s, l) => {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(255 * c).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
};
const T = (name, fg, bg, need) => { const r = ratio(fg, bg); console.log(`${r >= need ? 'PASS' : 'FAIL'} ${r.toFixed(2)}:1  ${name}  (${fg} on ${bg})`); };

console.log('== ① 深色主题文字/强调（§4 token 表）==');
T('tx on bg', '#e9edf2', '#0e1216', 4.5);
T('tx on surface', '#e9edf2', '#161b21', 4.5);
T('tx2 on bg', '#9aa7b4', '#0e1216', 4.5);
T('tx2 on surface', '#9aa7b4', '#161b21', 4.5);
T('tx2 on surface2(hover)', '#9aa7b4', '#1c232b', 4.5);
T('acc on bg', '#4fc08d', '#0e1216', 4.5);
T('acc on surface', '#4fc08d', '#161b21', 4.5);
T('warn on surface', '#e07a5f', '#161b21', 4.5);
T('gold on surface', '#f5c542', '#161b21', 4.5);
console.log('== ② 深色组件（§5 各批）==');
T('acc on acc-soft(激活chip底)', '#4fc08d', '#14352a', 4.5);
T('播放钮字 on acc 实心', '#0e1216', '#4fc08d', 4.5);
T('warn on warn-soft(停运徽标底)', '#e07a5f', '#2e1d18', 4.5);
T('LIVE 红点 on surface(图形)', '#ff6b6b', '#161b21', 3);
T('LIVE 红点 on acc-soft(图形)', '#ff6b6b', '#14352a', 3);
console.log('== ③ 浅色主题 ==');
T('tx on bg', '#1f2733', '#f3f5f7', 4.5);
T('tx on panel', '#1f2733', '#ffffff', 4.5);
T('tx2 on bg', '#55636f', '#f3f5f7', 4.5);
T('tx2 on panel', '#55636f', '#ffffff', 4.5);
T('acc on bg', '#1f7a54', '#f3f5f7', 4.5);
T('acc on panel', '#1f7a54', '#ffffff', 4.5);
T('acc on acc-soft(激活chip底)', '#1f7a54', '#e2f1ea', 4.5);
T('warn on panel', '#b5431a', '#ffffff', 4.5);
T('warn on warn-soft(停运徽标底)', '#b5431a', '#f7e9e2', 4.5);
T('gold on panel', '#8a6508', '#ffffff', 4.5);
T('LIVE 红点 on panel(图形)', '#b3362b', '#ffffff', 3);
console.log('== ④ 首字母色块调色板（白字全检，§5 批次2）==');
const PAL = [
  ['红/新闻谈话', 4, 0.42, 0.42], ['橙/交通', 25, 0.45, 0.40], ['琥珀/华语音乐', 45, 0.50, 0.33],
  ['黄绿/自定义兜底', 80, 0.45, 0.33], ['绿/常听(品牌)', 145, 0.38, 0.34], ['青/财经', 172, 0.40, 0.33],
  ['蓝/欧美音乐', 205, 0.42, 0.38], ['靛/综合其他', 235, 0.38, 0.46], ['紫/文艺生活', 280, 0.38, 0.45],
  ['玫红/亚洲港台', 330, 0.45, 0.40], ['石板/未分类', 215, 0.14, 0.44]];
for (const [n, h, s, l] of PAL) T(`白字 on ${n} ${hsl(h, s, l)}`, '#ffffff', hsl(h, s, l), 4.5);
console.log('== ⑤ 旧→新基线对照（留档）==');
T('旧 tx on 旧bg', '#e8ecf1', '#101418', 4.5);
T('旧 dim on 旧bg', '#8b97a5', '#101418', 4.5);
T('旧 dim on 旧panel', '#8b97a5', '#1a2027', 4.5);
T('旧白字 on 旧色块黄相(最不利)', '#ffffff', hsl(60, 0.42, 0.44), 4.5);
console.log('（末项有意 FAIL：旧 hash 全谱色块黄相白字 2.80:1 不达标——批次2 修复动机）');
