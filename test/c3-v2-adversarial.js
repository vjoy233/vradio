'use strict';
// 生成一致性测试，不是协议解析器或状态机测试。
const assert = require('assert'), fs = require('fs'), path = require('path');
const crypto = require('crypto'), cp = require('child_process');
const file = path.join(__dirname,'../contracts/fixtures/c3-strict-v2-adversarial.json');
const actual = fs.readFileSync(file);
const generated = cp.execFileSync(process.execPath,[path.join(__dirname,'fixtures/c3-v2-adversarial-generator.js')]);
assert(actual.equals(generated));
const data=JSON.parse(actual); const ids=new Set();
const decode = s => {const v=Buffer.from(s,'base64'); assert.strictEqual(v.toString('base64'),s); return v;};
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
for (const e of data.entries) {
 assert(!ids.has(e.id)); ids.add(e.id);
 const raw=decode(e.rawBase64); assert.strictEqual(raw.length,e.bytes); assert.strictEqual(hash(raw),e.sha256);
 if(e.kind==='manifest') {
  const side=decode(e.sidecarBase64), ptr=JSON.parse(decode(e.pointerBase64));
  const manifest=JSON.parse(raw); assert.strictEqual(hash(side),e.sidecarId);
  assert.strictEqual(ptr.current,e.sidecarId); assert.strictEqual(manifest.sha256,e.sidecarId); assert.strictEqual(manifest.bytes,side.length);
 }
}
for (const c of data.bindingCases) {
 assert(!ids.has(c.id)); ids.add(c.id);
 const side=decode(c.sidecarBase64), manifest=JSON.parse(decode(c.manifestBase64)), pointer=JSON.parse(decode(c.pointerBase64));
 assert.strictEqual(hash(side),c.sidecarId); assert.strictEqual(manifest.sha256,c.sidecarId);
 assert.strictEqual(pointer.current,c.sidecarId); assert.strictEqual(manifest.bytes,side.length);
 const value=JSON.parse(side); assert.strictEqual(value.commit,'a'.repeat(40));
}
const get = id => decode(data.entries.find(e=>e.id===id).rawBase64).toString();
assert(get('version-decimal').includes('"v":2.0,'));
assert(get('version-exponent').includes('"v":2e0,'));
assert(/"bytes":\d+e0/.test(get('manifest-bytes-exponent')));
assert.strictEqual((get('depth-4099').match(/\[/g)||[]).length,4097); // items + 4096
console.log('C3 v2 对抗样本字节、摘要及代绑定一致（非解析器验证）');
