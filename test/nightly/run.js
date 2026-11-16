// test/nightly/run.js —— 夜间/故障演练层编排入口（P3，docs/testing-strategy-2026-11.md §3 L5 + §5 test:nightly）。
// 跑法：node test/nightly/run.js [--quick] [--real] [--soak=N]
//   默认        = drills + soak(60s)
//   --quick     = 只跑 drills（约 1-2 分钟）；--quick 与 --real/--soak 同给时以 --quick 为准（后者不生效，显式提示）
//   --real      = 追加 real-sources（真实源抽样，需公网；探测失败属数据健康类不阻塞，无公网标环境失败）
//   --soak=N    = 覆盖 soak 时长秒数（workflow 夜间用 1800）
// 注意：workflow 的 real-sources job 直调 real-sources.js（不组合 flag——review#41：--quick 曾吞掉 --real 致 job 空跑）。
// 产物隔离（review#41 任务 2）：本轮统一落 docs/test-reports/nightly/<run-id>/（run-id = HEAD 短哈希+时间戳，env
// NIGHTLY_RUN_ID 注入子进程共用同一目录；编排方先行清空目录防旧产物混入），收尾写 summary.json 汇总各子套件 executed/退出码。
// 子进程逐个执行（学 test/run.js 的 spawnSync 聚合退出码）。退出码语义（方案 §5 失败分类）：代码回归（确定性断言破）=
// 非零；数据健康（真实源探测失败）只进报告 = 子进程 exit 0；环境失败（端口/权限/无公网）= 子进程 FAIL 明确标
// 「环境未执行」非零——聚合退出码非零。本目录不被 test/run.js 自动发现（其只读 test/ 顶层 .js）——夜间层不进普通 PR 门禁。
const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path');
const { runIdOf, prepareDir, sha7, NIGHTLY, ROOT } = require('./report-dir');

const argv = process.argv.slice(2);
const quick = argv.includes('--quick'), real = argv.includes('--real');
const soakArg = (argv.find(a => /^--soak=\d+$/.test(a)) || '').slice(7);
if (quick && (real || soakArg)) console.log('提示：--quick 只跑 drills，--real/--soak 不生效（真实源在 CI 走直调 real-sources.js）');

const jobs = [{ name: 'drills' }];
if (!quick) {
  if (real) jobs.push({ name: 'real-sources' });
  jobs.push({ name: 'soak' });
}

const runId = runIdOf(), dir = prepareDir(runId, !process.env.NIGHTLY_RUN_ID); // env 注入（CI/workflow）时目录由编排方已备好，只 mkdir
const startedAt = new Date().toISOString();
let fail = 0;
const suites = [];
for (const j of jobs) {
  console.log(`\n=== nightly/${j.name} ===`);
  const env = Object.assign({}, process.env, { NIGHTLY_RUN_ID: runId });
  if (j.name === 'soak' && soakArg) env.SOAK_SECONDS = soakArg;
  const r = spawnSync(process.execPath, [path.join(__dirname, j.name + '.js')], { stdio: 'inherit', env });
  suites.push({ name: j.name, exit: r.status, ok: r.status === 0, executed: true });
  if (r.status !== 0) { fail++; console.error(`✗ nightly/${j.name} 退出码 ${r.status}（环境未执行或代码回归，见 docs/test-reports/nightly/${runId}/${j.name}.json）`); }
}
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ runId, headSha: sha7(), startedAt,
  quick, real, soakSeconds: soakArg || null, suites, fail }, null, 2));
console.log(`\n${jobs.length} 个夜间脚本，${fail} 个失败${quick ? '（--quick）' : ''}${soakArg ? '（--soak=' + soakArg + '）' : ''}（报告目录 docs/test-reports/nightly/${runId}/）`);
process.exit(fail ? 1 : 0);
