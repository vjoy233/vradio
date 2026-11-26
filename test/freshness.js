// 新鲜度纯状态机：注入 epoch，未知/未来事实与时钟回拨均保守处理。
const assert = require('assert');
const F = require('../freshness');
const now = 1800000000000, fact = t => ({ refreshedAt: t, provenance: 'verified' });
assert.deepStrictEqual(F.normalize('{bad'), { reminderDays: 14, disabled: false, dismissedUntil: 0, lastPromptAt: 0 });
for (const days of [7, 14, 30]) {
  assert.strictEqual(F.state({ reminderDays: days }, fact(now - days * F.DAY), now).age, 'due');
  assert.strictEqual(F.state({ reminderDays: days }, fact(now - days * F.DAY + 1), now).age, 'fresh');
}
assert.strictEqual(F.state({}, fact(now + 1), now).age, 'unknown');
assert.strictEqual(F.state({}, null, now).prompt, true);
assert.strictEqual(F.state({ disabled: true }, null, now).prompt, false);
assert.strictEqual(F.state(F.markDismissed({}, now), null, now + F.DAY - 1).prompt, false);
assert.strictEqual(F.state(F.markDismissed({}, now), null, now + F.DAY).prompt, true);
assert.strictEqual(F.state({ dismissedUntil: now + F.DAY + 1 }, null, now).prompt, true);
assert.strictEqual(F.state({ lastPromptAt: now + 1 }, null, now).prompt, true);
assert.strictEqual(F.state({ lastPromptAt: now - 59999 }, null, now).prompt, false);
assert.strictEqual(F.state({ lastPromptAt: now - 60000 }, null, now).prompt, true);
const fixture = require('../contracts/fixtures/freshness.json');
for (const c of fixture.cases) assert.deepStrictEqual(F.state(c.pref, c.fact, fixture.now), { age: c.age, prompt: c.prompt }, c.name);
// 事实必须由正式发布产生，bootstrap/旧 manifest/资产变动均不可冒充刷新。
const fs = require('fs'), os = require('os'), path = require('path'), U = require('../update-sources');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-fresh-'));
try {
  const arts = {}; for (const name of U.SYNC_ASSETS) arts[name] = 'asset ' + name;
  U.publishSync(root, arts, { version: 'bootstrap', ts: now });
  assert.strictEqual(U.freshnessFact(root), null);
  U.publishSync(root, arts, { version: 'v1', ts: now + 1, freshness: true });
  assert.deepStrictEqual(U.freshnessFact(root), { version: 'v1', refreshedAt: now + 1, provenance: 'pipeline-full' });
  const manifestPath = path.join(root, 'sync-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const logos = manifest.files.find(x => x.path === 'logos.txt');
  fs.writeFileSync(manifestPath, JSON.stringify(Object.assign({}, manifest, { files: [logos, logos, logos, logos] })));
  assert.strictEqual(U.freshnessFact(root), null, '重复文件不能伪造资产绑定');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'radio.txt'), 'changed');
  assert.strictEqual(U.freshnessFact(root), null);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('freshness: 双端 fixture 与资产见证通过');
