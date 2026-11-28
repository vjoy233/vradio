// 与 Android JVM 测试共享人工期望；调用实际解析器，不依赖 PR #125。
const assert = require('assert'), fs = require('fs'), path = require('path');
const PI = require('../playlist-import.js');
const { deepDiff } = require('./harness/deep-diff');
const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'contracts', 'fixtures', name), 'utf8');
global.fetch = () => { throw new Error('解析器不得联网'); };
for (const c of JSON.parse(fixture('playlist-expected.json')).cases) {
  const r = PI.parse(fixture(c.file), { format: c.hint, baseUrl: c.baseUrl });
  // Array 附加属性不能通过 JSON 数组携带：显式抽取协议元数据。
  const actual = { format: r.format, invalid: r.invalid, dups: r.dups, entries: Array.from(r) };
  const diffs = deepDiff(c.out, actual);
  // deepDiff 将缺失键与 undefined 视为等价，单独检查各条目的自有可枚举键。
  c.out.entries.forEach((e, i) => {
    if (actual.entries[i]) for (const k of new Set([...Object.keys(e), ...Object.keys(actual.entries[i])]))
      if (!Object.prototype.hasOwnProperty.call(e, k) || !Object.prototype.hasOwnProperty.call(actual.entries[i], k))
        diffs.push(`entries[${i}].${k}: 缺失或多余`);
  });
  assert.strictEqual(diffs.length, 0, `${c.name}: ${diffs.join('; ')}`);
  console.log('✓ shared playlist', c.name);
}
