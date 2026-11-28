// 同一聚合数据经状态、解释与发现页，冻结时间边界和既有累计规则。
const assert = require('assert');
const { qSummary, qExplain } = require('../quality-store');
const { buildDiscovery } = require('../app');
const f = require('../contracts/fixtures/quality-consistency.json');
for (const c of f.cases) {
  const u = 'https://example.test/live';
  const s = { okCount:c.ok, failCount:c.fail, lastOkAt:c.at, lastFailAt:0, lastPlaybackAt:0,
    latSum:0, latN:0, disconnects:0, modes:['direct'] };
  const q = qSummary({[u]:{cf:0,sources:{[u]:s}}}, u, [u], f.now);
  assert.strictEqual(q.stability, c.stability, c.name);
  const e = qExplain(q, f.now);
  assert.strictEqual(e.reason, c.reason, c.name);
  const d = buildDiscovery({rows:[{k:'x',n:'x',u0:u,u:[u]}], quality:()=>q, explain:qExplain, now:f.now});
  assert.strictEqual(d.groups.stable.length, e.level === 'good' ? 1 : 0, c.name);
}
console.log('质量状态、解释和发现一致性通过');
