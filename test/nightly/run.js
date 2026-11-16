// test/nightly/run.js —— 夜间/故障演练层编排入口（P3，docs/testing-strategy-2026-11.md §3 L5 + §5 test:nightly）。
// 跑法：node test/nightly/run.js [--quick] [--real] [--soak=N]
//   默认        = drills + soak(60s)
//   --quick     = 只跑 drills（约 1-2 分钟）；与 --real/--soak 互斥——同给属配置错误 exit 2（r2 意见 4：曾误用 --real --quick 得到只跑 drills 的假绿）
//   --real      = 追加 real-sources（真实源抽样，需公网；探测失败属数据健康类不阻塞，无公网标环境失败）
//   --soak=N    = 覆盖 soak 时长秒数（workflow 夜间用 1800）
// 注意：workflow 的 real-sources job 直调 real-sources.js（不组合 flag——review#41：--quick 曾吞掉 --real 致 job 空跑）。
// 产物隔离（review#41 任务 2 + r2 意见 3）：本轮统一落 docs/test-reports/nightly/<run-id>/（run-id = HEAD 短哈希+时间戳，env
// NIGHTLY_RUN_ID 注入子进程共用同一目录；同 run-id 重试/复用 env 时由编排方经 prepareDir 第 3 参清目录内固定名产物防旧证据混入），
// 收尾写 summary.json 汇总各子套件 {executed,exit,status,signal,error} + 核对各子报告 headSha/runId 属于本轮（不一致判失败）。
// 子进程逐个执行（学 test/run.js 的 spawnSync 聚合退出码）。executed = spawn 无 error 且 status 非 null（r2 意见 2：
// 环境未执行与代码失败分开记账——status:null/signal 记录进 summary，两者都判失败不静默放过）。退出码语义（方案 §5 失败分类）：
// 代码回归（确定性断言破）= 非零；数据健康（真实源探测失败）只进报告 = 子进程 exit 0；环境失败（端口/权限/无公网/spawn 起不来）
// = 非零。本目录不被 test/run.js 自动发现（其只读 test/ 顶层 .js）——夜间层不进普通 PR 门禁。
const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path');
const { runIdOf, prepareDir, sha7, NIGHTLY, ROOT } = require('./report-dir');

const argv = process.argv.slice(2);
const quick = argv.includes('--quick'), real = argv.includes('--real');
const soakArg = (argv.find(a => /^--soak=\d+$/.test(a)) || '').slice(7);
if (quick && (real || soakArg)) // 配置错误而非测试失败：同给会得到只跑 drills 的假绿（r2 意见 4）
  { console.error('配置错误：--quick 与 --real/--soak 互斥——--quick 只跑 drills，真实源在 CI 走直调 real-sources.js；组合不是合法用法。'); process.exit(2); }

const jobs = [{ name: 'drills' }];
if (!quick) {
  if (real) jobs.push({ name: 'real-sources' });
  jobs.push({ name: 'soak' });
}

const runId = runIdOf(), dir = prepareDir(runId, !process.env.NIGHTLY_RUN_ID, true); // 本地自算 run-id 先整目录清；env 注入（CI/workflow/复用）时只清固定名产物防旧证据混入（r2 意见 3，见 report-dir.js）
const startedAt = new Date().toISOString();
let fail = 0;
const suites = [];
for (const j of jobs) {
  console.log(`\n=== nightly/${j.name} ===`);
  const env = Object.assign({}, process.env, { NIGHTLY_RUN_ID: runId });
  if (j.name === 'soak' && soakArg) env.SOAK_SECONDS = soakArg;
  const r = spawnSync(process.execPath, [path.join(__dirname, j.name + '.js')], { stdio: 'inherit', env });
  const executed = r.error == null && r.status !== null; // spawn 真正起来才算执行过；status=null（含被 signal 杀）记环境账（r2 意见 2）
  const s = { name: j.name, exit: r.status, ok: executed && r.status === 0, executed,
    status: r.status, signal: r.signal || null, error: r.error ? String(r.error.message || r.error) : null };
  suites.push(s);
  if (!s.ok) { fail++;
    console.error(`✗ nightly/${j.name} ${executed ? `退出码 ${r.status}${r.signal ? '（signal=' + r.signal + '）' : ''}` : `环境未执行（${r.error ? String(r.error.message || r.error) : 'status=null' + (r.signal ? '，signal=' + r.signal : '')}）`}（见 docs/test-reports/nightly/${runId}/${j.name}.json）`); }
}
// 汇总前核对各子报告属于本轮（r2 意见 3）：headSha/runId 与当前一致——同 run-id 复用混进旧报告在此判失败，不静默当本轮证据
for (const s of suites) {
  if (!s.executed) { s.reportHeadSha = null; continue; } // spawn 未起无报告可核，环境账已记
  let rep = null;
  try { rep = JSON.parse(fs.readFileSync(path.join(dir, s.name + '.json'), 'utf8')); } catch (_) {}
  s.reportHeadSha = rep ? rep.headSha || null : null;
  if (!rep) { fail++; console.error(`✗ nightly/${s.name} 子报告缺失（${s.name}.json）——证据链断裂`); continue; }
  if (rep.headSha !== sha7() || rep.runId !== runId) { fail++;
    console.error(`✗ nightly/${s.name} 子报告属旧轮（headSha/runId ${rep.headSha || '?'}/${rep.runId || '?'} ≠ 本轮 ${sha7()}/${runId}）——复用目录混入旧产物`); }
}
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ runId, headSha: sha7(), startedAt,
  quick, real, soakSeconds: soakArg || null, suites, fail }, null, 2));
console.log(`\n${jobs.length} 个夜间脚本，${fail} 个失败${quick ? '（--quick）' : ''}${soakArg ? '（--soak=' + soakArg + '）' : ''}（报告目录 docs/test-reports/nightly/${runId}/）`);
process.exit(fail ? 1 : 0);
