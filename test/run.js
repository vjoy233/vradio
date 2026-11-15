// VRadio 测试总入口（B0）：零依赖逐文件执行 test/*.js（子进程隔离——单文件崩溃不拖垮整场，退出码聚合）。
// smoke.js 负责服务端安全护栏 + API 冒烟；其余文件负责纯函数/fixture/契约（各批随行新增）。
// 字典序执行：contracts.js（键契约）→ 其余纯函数测试 → smoke.js（起真服务）。跑法：npm test。
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.js') && f !== 'run.js')
  .sort((a, b) => (b === 'smoke.js') - (a === 'smoke.js') || a.localeCompare(b)); // smoke 压轴（起服最重）

let fail = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) { fail++; console.error(`✗ ${f} 退出码 ${r.status}`); }
}
console.log(`\n${files.length} 个测试文件，${fail} 个失败`);
process.exit(fail ? 1 : 0);
