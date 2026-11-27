// VRadio 测试总入口（B0）：零依赖逐文件执行 test/*.js（子进程隔离——单文件崩溃不拖垮整场，退出码聚合）。
// smoke.js 负责服务端安全护栏 + API 冒烟；其余文件负责纯函数/fixture/契约（各批随行新增）。
// 字典序执行：contracts.js（键契约）→ 其余纯函数测试 → smoke.js（起真服务）。跑法：npm test。
// P1 profile 拆分（docs/testing-strategy-2026-11.md §5）：npm run test:contract/unit/api 定向入口——
// 显式白名单列举（新文件落错 profile 会在 npm test 全量里被发现，白名单只影响定向跑法不藏文件）；
// 无参默认 = 全量，行为与 B0 完全一致（smoke 压轴不变）。
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

const PROFILES = { // contract = L0 契约/资产门；unit = L1 纯函数/状态机/fake browser（不起长驻服务）；
  contract: ['contracts.js', 'assets.js'],
  unit: ['c3-release-gate.js', 'backup-v3.js', 'contracts.js', 'assets.js', 'diagnostic.js', 'discovery.js', 'discovery-binding.js', 'discovery-race.js', 'discovery-sidecar.js', 'discovery-publish.js', 'listen-stats.js', 'logos.js', 'metadata.js',
    'meta-source.js', 'player.js', 'playlist-import.js', 'quality-explain.js', 'quality-store.js', 'source-lifecycle.js', 'sources.js', 'store.js', 'sync.js',
    'ui-data.js', 'ui-hero.js', 'ui-maintenance.js', 'ui-phase.js', 'ui-scope.js'],
  api: ['boot-lifecycle.js', 'listen-stats-api.js', 'myradio-api.js', 'np-proxy.js', 'quality.js', 'smoke.js', 'station-api.js', 'sync-api.js'], // L2 真服务矩阵（smoke 压轴不变）
};
const profile = process.argv[2] && !/^-/.test(process.argv[2]) ? process.argv[2] : '';

let files = [];
if (profile) {
  const list = PROFILES[profile];
  if (!list) { console.error('未知 profile: ' + profile + '（可用：' + Object.keys(PROFILES).join('/') + ' 或无参全量）'); process.exit(2); }
  const missing = list.filter(f => !fs.existsSync(path.join(__dirname, f)));
  if (missing.length) { console.error('profile 文件缺失: ' + missing.join(', ')); process.exit(2); }
  files = list.slice().sort((a, b) => (a === 'smoke.js') - (b === 'smoke.js') || a.localeCompare(b)); // smoke 压轴（起服最重，旧比较号写反致 smoke 跑在最前——review#39 顺带修正）

} else {
  files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.js') && f !== 'run.js')
    .sort((a, b) => (a === 'smoke.js') - (b === 'smoke.js') || a.localeCompare(b)); // smoke 压轴（起服最重，旧比较号写反致 smoke 跑在最前——review#39 顺带修正）
}

let fail = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) { fail++; console.error(`✗ ${f} 退出码 ${r.status}`); }
}
console.log(`\n${files.length} 个测试文件，${fail} 个失败${profile ? '（profile: ' + profile + '）' : ''}`);
process.exit(fail ? 1 : 0);
