'use strict';
// 测试 fixture 生成和字节关系，不声称已实现或验证协议解析器。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const root = path.join(__dirname, '..');
const file = path.join(root, 'contracts/fixtures/c3-strict-v2-generated.json');
const checked = fs.readFileSync(file);
const generated = cp.execFileSync(process.execPath, [path.join(__dirname, 'fixtures/c3-v2-generator.js')], {maxBuffer: 8 * 1024 * 1024});
assert(checked.equals(generated), 'fixture 与生成器不一致；请重生成');
const data = JSON.parse(checked.toString('utf8'));
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const decode = s => {const b=Buffer.from(s,'base64'); assert.strictEqual(b.toString('base64'),s); return b;};
const ids = new Set();
for (const c of [...data.sidecar, ...data.controls]) {
 assert(!ids.has(c.id)); ids.add(c.id);
 const b=decode(c.rawBase64); assert.strictEqual(b.length,c.bytes); assert.strictEqual(digest(b),c.sha256);
 if(c.accept) assert.deepStrictEqual(JSON.parse(b.toString('utf8')),c.output);
}
for (const c of data.pointer) {
 assert(!ids.has(c.id)); ids.add(c.id); decode(c.pointerBase64);
 for (const [key,g] of Object.entries(c.generations)) {
  const b=decode(g.sidecarBase64), m=JSON.parse(decode(g.manifestBase64).toString('utf8'));
  assert.strictEqual(digest(b),g.id); assert.strictEqual(m.sha256,g.id);
  if(c.id !== 'pointer-id-mismatch') assert.strictEqual(key,g.id);
  if(c.id !== 'fallback' && c.id !== 'same-delivery-different-upstream' && c.id !== 'cross-delivery' && !(c.id === 'invalid-previous' && key !== JSON.parse(decode(c.pointerBase64)).current)) assert.strictEqual(m.bytes,b.length);
 }
}
for (const c of data.localFallback) {
 assert(!ids.has(c.id)); ids.add(c.id); decode(c.pointerBase64);
 const b=decode(c.local.sidecarBase64), m=JSON.parse(decode(c.local.manifestBase64));
 assert.strictEqual(digest(b),m.sha256); assert.strictEqual(m.bytes,b.length);
 if(c.id !== 'invalid-pointer-local-bad-hash') assert.strictEqual(c.local.id,m.sha256);
 else assert.notStrictEqual(c.local.id,m.sha256);
 if(c.expected.selection === 'local') assert.deepStrictEqual(JSON.parse(b),c.expected.output);
}
console.log('C3 v2 fixture 生成及字节一致性通过（非解析器测试）');
