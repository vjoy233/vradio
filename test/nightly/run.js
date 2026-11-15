// test/nightly/run.js —— 夜间/故障演练层编排入口（P3，docs/testing-strategy-2026-11.md §3 L5 + §5 test:nightly）。
// 跑法：node test/nightly/run.js [--quick] [--real] [--soak=N]
//   默认        = drills + soak(60s)
//   --quick     = 只跑 drills（约 1-2 分钟；--real/--soak 不生效）
//   --real      = 追加 real-sources（真实源抽样，需公网；探测失败属数据健康类不阻塞，无公网标环境失败）
//   --soak=N    = 覆盖 soak 时长秒数（workflow 夜间用 1800）
// 子进程逐个执行（学 test/run.js 的 spawnSync 聚合退出码）；报告统一落 docs/test-reports/nightly/<name>.json。
// 退出码语义（方案 §5 失败分类）：代码回归（确定性断言破）= 非零；数据健康（真实源探测失败）只进报告 = 子进程
// exit 0；环境失败（端口/权限/无公网）= 子进程 FAIL 明确标「环境未执行」非零——聚合退出码非零。
// package.json 不在本批接线（主控统一加 npm run test:nightly 指向本文件）；本目录不被 test/run.js 自动发现
// （其只读 test/ 顶层 .js）——夜间层不进普通 PR 门禁，属方案 §7 P3。
const { spawnSync } = require('child_process'), path = require('path');

const argv = process.argv.slice(2);
const quick = argv.includes('--quick'), real = argv.includes('--real');
const soakArg = (argv.find(a => /^--soak=\d+$/.test(a)) || '').slice(7);

const jobs = [{ name: 'drills' }];
if (!quick) {
  if (real) jobs.push({ name: 'real-sources' });
  jobs.push({ name: 'soak' });
}

let fail = 0;
for (const j of jobs) {
  console.log(`\n=== nightly/${j.name} ===`);
  const env = j.name === 'soak' && soakArg ? { SOAK_SECONDS: soakArg } : {};
  const r = spawnSync(process.execPath, [path.join(__dirname, j.name + '.js')], { stdio: 'inherit', env: Object.assign({}, process.env, env) });
  if (r.status !== 0) { fail++; console.error(`✗ nightly/${j.name} 退出码 ${r.status}（环境未执行或代码回归，见 docs/test-reports/nightly/${j.name}.json）`); }
}
console.log(`\n${jobs.length} 个夜间脚本，${fail} 个失败${quick ? '（--quick）' : ''}${soakArg ? '（--soak=' + soakArg + '）' : ''}`);
process.exit(fail ? 1 : 0);
