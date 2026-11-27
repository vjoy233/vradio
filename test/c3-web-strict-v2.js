'use strict';
// 直接消费共享原始字节，测试用 SHA-256 实现与绑定由调用方提供。
const assert=require('assert'), fs=require('fs'), path=require('path'), crypto=require('crypto');
const parser=require('../c3-strict-v2');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../contracts/fixtures/c3-strict-v2-generated.json'),'utf8'));
const bytes=s=>Buffer.from(s,'base64');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const plain=o=>JSON.parse(JSON.stringify(o));
for(const c of fixture.sidecar) {
 const b=bytes(c.rawBase64); assert.strictEqual(b.length,c.bytes,c.id); assert.strictEqual(digest(b),c.sha256,c.id);
 if(c.accept) assert.deepStrictEqual(plain(parser.sidecar(b)),c.output,c.id); else assert.throws(()=>parser.sidecar(b),c.id);
}
for(const c of fixture.controls) {
 const fn=c.id.startsWith('manifest')?parser.manifest:parser.pointer, b=bytes(c.rawBase64);
 assert.strictEqual(b.length,c.bytes,c.id); assert.strictEqual(digest(b),c.sha256,c.id);
 if(c.accept) assert.deepStrictEqual(plain(fn(b)),c.output,c.id); else assert.throws(()=>fn(b),c.id);
}
// 概念草案 URL 案例经真实 sidecar 入口验证，不调用私有 URL helper。
const draft=JSON.parse(fs.readFileSync(path.join(__dirname,'../contracts/fixtures/c3-strict-v2-cases.json'),'utf8'));
const template=JSON.parse(draft.sidecar.find(c=>c.id==='valid-item').raw);
for(const c of draft.urlAdversarial) {
 const specimen=JSON.parse(JSON.stringify(template)); specimen.items[0].url=c.url;
 const b=Buffer.from(JSON.stringify(specimen),'utf8');
 if(c.formatAccept) assert.deepStrictEqual(plain(parser.sidecar(b)),specimen,c.url);
 else assert.throws(()=>parser.sidecar(b),c.url);
}
// 状态选择仅为 fixture 驱动模拟，不是生产实现或可信绑定。
function selection(c) {
 let p; try {p=parser.pointer(bytes(c.pointerBase64));} catch (_) {return {selection:'unavailable'};}
 function get(id) {try {const g=c.generations[id]; if(!g) return null; return parser.generation(id,bytes(g.manifestBase64),bytes(g.sidecarBase64),digest);} catch (_) {return null;}}
 const cur=get(p.current), prev=p.previous && get(p.previous);
 if(cur) return {selection:'current',degraded:!!p.previous && !prev,output:plain(cur)};
 if(prev && (!c.binding || c.binding.currentCommit===c.binding.previousCommit)) return {selection:'previous',output:plain(prev)};
 return {selection:'unavailable'};
}
for(const c of fixture.pointer) assert.deepStrictEqual(selection(c),c.expected,c.id);
// 测试本地回退独立于远端；策略结果仅为注入的测试材料。
for(const c of fixture.localFallback) {
 assert.throws(()=>parser.pointer(bytes(c.pointerBase64)),c.id);
 let output; try {if(c.localRevocationPolicyResult==='allow') output=parser.generation(c.local.id,bytes(c.local.manifestBase64),bytes(c.local.sidecarBase64),digest);} catch (_) {}
 const actual=output?{remote:'unavailable',selection:'local',output:plain(output)}:{remote:'unavailable',selection:'unavailable'};
 assert.deepStrictEqual(actual,c.expected,c.id);
}
console.log('C3 Web v2 原始字节消费测试通过（独立实验，未接生产）');
