// test/nightly/report-dir.js —— 夜间层报告产物目录助手（review#41 任务 2/6）。
// 每轮产物落 docs/test-reports/nightly/<run-id>/（与历史人工样例 nightly/samples/ 分目录；运行产物不入 git，见 .gitignore）。
// run-id = HEAD 短哈希 + 时间戳（CI 由 workflow 先算好经 env NIGHTLY_RUN_ID 注入，本地无 env 时自算，附 pid 防同秒冲突）。
// 清空规则：env 注入（编排方 run.js / workflow 已先行建好本轮目录）时只 mkdir 不清；本地自算 run-id 时目录必全新，仍先 rm 兜底——防旧产物混入冒充本轮证据。
const fs = require('fs'), path = require('path'), cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const NIGHTLY = path.join(ROOT, 'docs', 'test-reports', 'nightly');
const sha7 = () => { // 无 git（如独立分发包）退 'nogit'，run-id 仍可用
  try { return String(cp.execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' })).trim() || 'nogit'; } catch (_) { return 'nogit'; }
};
const stamp = () => { const d = new Date(), p = n => (n < 10 ? '0' : '') + n; // 文件系统安全时间戳
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };
const runIdOf = () => (process.env.NIGHTLY_RUN_ID || sha7() + '-' + stamp() + '-' + process.pid).replace(/[^\w.-]/g, '_');
const prepareDir = (runId, wipe) => { const dir = path.join(NIGHTLY, runId);
  if (wipe) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  fs.mkdirSync(dir, { recursive: true }); return dir; };
// 单脚本独立运行入口：建本轮目录并返回报告上下文（runId/headSha/startedAt 固化在开启时刻，报告统一带上）
function openRun() {
  const runId = runIdOf(), dir = prepareDir(runId, !process.env.NIGHTLY_RUN_ID);
  return { runId, dir, headSha: sha7(), startedAt: new Date().toISOString(), file: name => path.join(dir, name + '.json') };
}
module.exports = { runIdOf, prepareDir, openRun, sha7, NIGHTLY, ROOT };
