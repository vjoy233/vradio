// 来源只取 URL 显式证据，旧值兼容且不能把推测当验证。
const assert = require('assert');
const { buildRadioMeta } = require('../update-sources');
const contract = require('../contracts/source-meta.json');
const fixture = require('../contracts/fixtures/source-meta.json');
assert.deepStrictEqual(Object.keys(fixture.source).sort(), Object.keys(contract.source).sort());
const url = fixture.source.url, lines = ['国际新闻·谈话,#genre#', '台,' + url];
const get = (prev, cn, eu, def) => buildRadioMeta(lines, prev, cn, eu, 2000, def).stations[url].sources[0];
assert.deepStrictEqual(get(null, [], null), {url, upstream:'unknown', upstreamId:'', kind:'main', firstSeenAt:2000, lastSeenAt:2000, lastVerifiedAt:0, verification:'unknown'});
assert.strictEqual(get(null, [], null, 'local').upstream, 'local');
const prev = {stations:{[url]:{sources:[{url, upstream:'local', firstSeenAt:1000}]}}};
assert.deepStrictEqual(get(prev, [], null), {url, upstream:'local', upstreamId:'', kind:'main', firstSeenAt:1000, lastSeenAt:2000, lastVerifiedAt:0, verification:'unknown'});
assert.strictEqual(get(prev, [{url, upstream:'gao', upstreamId:'row'}], null).upstreamId, 'row');
const eu = {meta:[{url, uuid:'id', verification:{url, ok:true, checkedAt:1500}}]};
assert.strictEqual(get(prev, [], eu).lastVerifiedAt, 1500);
assert.strictEqual(get(prev, [], eu).verification, 'sync');
for (const evidence of [{url, ok:false, checkedAt:1500}, {url, ok:true, checkedAt:0}, {url:'https://other/', ok:true, checkedAt:1500}]) {
  assert.strictEqual(get(prev, [], {meta:[{url, verification:evidence}]}).verification, 'unknown');
}
prev.stations[url].sources[0].verification = 'sync';
prev.stations[url].sources[0].lastVerifiedAt = 1200;
assert.strictEqual(get(prev, [], null).lastVerifiedAt, 1200);
assert.strictEqual(get(prev, [], null).verification, 'sync');
// 双向来源变更不能继承旧上游 ID；同 URL 的另一候选也不能串入 ID。
const old = (upstream, upstreamId) => ({stations:{[url]:{sources:[{url, upstream, upstreamId, firstSeenAt:1000}]}}});
let s = get(old('eu', 'eu-old'), [{url, upstream:'gao'}], {meta:[{url, uuid:'eu-current'}]});
assert.strictEqual(s.upstream, 'gao'); assert.strictEqual(s.upstreamId, '');
s = get(old('gao', 'gao-old'), [], {meta:[{url}]});
assert.strictEqual(s.upstream, 'eu'); assert.strictEqual(s.upstreamId, '');
assert.strictEqual(get(old('gao', 'gao-old'), [{url, upstream:'gao'}], null).upstreamId, 'gao-old');
assert.strictEqual(get(old('eu', 'eu-old'), [], {meta:[{url}]}).upstreamId, 'eu-old');
assert.strictEqual(get(old('eu', 'eu-old'), [{url, upstream:'gao', upstreamId:'gao-new'}], null).upstreamId, 'gao-new');
assert.strictEqual(get(old('gao', 'gao-old'), [], {meta:[{url, uuid:'eu-new'}]}).upstreamId, 'eu-new');
console.log('来源元数据契约通过');
