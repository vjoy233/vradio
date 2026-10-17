// VRadio 安卓端 classifyCn 金样生成器（CONTRACTS.md Agent D / M4-A15）。
// 语义：require 仓库根 update-sources.js 的 classifyCn（导出名与 test/smoke.js 同入口），
//   把 radio.txt 全部台行以「未知分类单行节」探针喂入——即「全新上游行」的归类语义
//   （CN_RULES 顺序即优先级 + 国际台捞回 + 兜底综合·其他），与安卓侧 ClassifyCn.classify(name) 同口径；
//   节级语义（新式节原样保留/世界拆分/EU 重建行跳过）在 classifySections，由 ClassifyCnTest 手写用例覆盖。
// 产物：android/app/src/test/resources/classifycn-golden.json = { 台名: 分类 }（fixture 是测试资源，随源码提交）。
// 跑法：cd 仓库根后 node android/tools/gen-classify-fixture.js
const fs = require('fs'), path = require('path');
const { classifyCn } = require(path.join(__dirname, '..', '..', 'update-sources.js'));

const ROOT = path.join(__dirname, '..', '..');
const RADIO = path.join(ROOT, 'radio.txt');
const OUT = path.join(ROOT, 'android', 'app', 'src', 'test', 'resources', 'classifycn-golden.json');
const PROBE = '__probe__'; // 未知分类：不属 CAT_ORDER/世界/欧美系 → 走 CN_RULES 纯台名路径

const lines = fs.readFileSync(RADIO, 'utf8').split(/\r?\n/).map(l => l.trim())
  .filter(l => l && !l.endsWith('#genre#') && !l.startsWith('#'));
const secs = lines.map(l => ({ cat: PROBE, lines: [l] })); // 每行独立节：classifyCn 行级判定与节内同伴无关，可一次性喂入
const r = classifyCn(secs);
const map = {};
for (const [cat, arr] of Object.entries(r.out)) for (const l of arr) map[l.split(',')[0]] = cat;
for (const [cat, arr] of Object.entries(r.euExtra)) for (const l of arr) map[l.split(',')[0]] = cat; // 捞回 → 欧美系两分类
const missing = lines.filter(l => !(l.split(',')[0] in map));
if (missing.length) { console.error('探针有行未落任何分类（不应发生）：', missing.slice(0, 5)); process.exit(1); }

const sorted = {}; Object.keys(map).sort().forEach(k => { sorted[k] = map[k]; }); // 键排序稳定 diff
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(sorted, null, 1) + '\n', 'utf8');
const stat = {};
for (const c of Object.values(sorted)) stat[c] = (stat[c] || 0) + 1;
console.log(`[vradio] classifycn-golden.json：${Object.keys(sorted).length} 个台名`);
console.log(Object.entries(stat).map(([c, n]) => `${c}=${n}`).join('  '));
