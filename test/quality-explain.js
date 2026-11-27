// 双端共享的质量解释黄金样本；投影不得更改输入。
const assert = require('assert');
const { qExplain, diagnosticAction, QualityStore } = require('../quality-store');
const fixture = require('../contracts/fixtures/quality-explain.json');
for (const x of fixture.explain) {
  const before = JSON.stringify(x.summary);
  assert.deepStrictEqual(qExplain(x.summary, x.now), x.expected);
  assert.strictEqual(JSON.stringify(x.summary), before);
}
for (const x of fixture.diagnostic) assert.deepStrictEqual(diagnosticAction(x.code, x.httpStatus), x.expected);
assert.strictEqual(QualityStore.explain, undefined);
assert.strictEqual(diagnosticAction('toString', 0).reason, 'unknown_code');
// HTTP 401/403 优先于 code=OK，避免服务拒绝被误报为可用。
assert.deepStrictEqual(diagnosticAction('OK', 403), { level: 'unknown', action: 'configure', reason: 'service_refused' });
console.log('质量解释黄金样本通过');
