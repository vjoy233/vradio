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
// 最深合法形态为根对象→items 数组→item 对象；再嵌套即拒绝而非爆栈。
const validDepth=fixture.sidecar.find(c=>c.id==='item');
assert.deepStrictEqual(plain(parser.sidecar(bytes(validDepth.rawBase64))),validDepth.output);
const expectControlledFailure=(fn,b,label)=>assert.throws(()=>fn(b),e=>e.name==='Error' && e.message==='invalid C3 v2',label);
const nested=JSON.parse(JSON.stringify(validDepth.output)); nested.items[0].name={x:1};
expectControlledFailure(parser.sidecar,Buffer.from(JSON.stringify(nested)),'depth 4');
for(const [fn,n] of [[parser.sidecar,100000],[parser.manifest,2000],[parser.pointer,2000]]) {
 expectControlledFailure(fn,Buffer.from('['.repeat(n)+']'.repeat(n)),'deep arrays '+n);
 expectControlledFailure(fn,Buffer.from('{"x":'.repeat(n)+'0'+'}'.repeat(n)),'deep objects '+n);
}
// 消费跨端共享实验性原始字节；proposed 是待评审建议，不是冻结规范。
const adversarial=JSON.parse(fs.readFileSync(path.join(__dirname,'../contracts/fixtures/c3-strict-v2-adversarial.json'),'utf8'));
for(const c of adversarial.entries) {
 const b=bytes(c.rawBase64), fn=c.kind==='sidecar'?parser.sidecar:parser.manifest;
 assert.strictEqual(b.length,c.bytes,c.id); assert.strictEqual(digest(b),c.sha256,c.id);
 if(c.proposed==='accept') fn(b); else expectControlledFailure(fn,b,c.id);
 if(c.kind==='manifest') {
  const side=bytes(c.sidecarBase64), p=parser.pointer(bytes(c.pointerBase64));
  assert.strictEqual(digest(side),c.sidecarId,c.id); assert.strictEqual(p.current,c.sidecarId,c.id);
  if(c.proposed==='accept') parser.generation(p.current,b,side,'a'.repeat(40),digest);
  else expectControlledFailure(()=>parser.generation(p.current,b,side,'a'.repeat(40),digest),null,c.id);
 }
}
// 补充字面量变体，使用原始 JSON 字节。
const rawItem=bytes(validDepth.rawBase64).toString('utf8');
for(const literal of ['2.0','2e0','2E+0']) expectControlledFailure(parser.sidecar,Buffer.from(rawItem.replace('"v":2,','"v":'+literal+',')),'version '+literal);
const goodManifest=Buffer.from(JSON.stringify({v:2,sha256:'a'.repeat(64),bytes:100}));
for(const literal of ['100.0','1e2','1E+2']) expectControlledFailure(parser.manifest,Buffer.from(goodManifest.toString().replace('"bytes":100','"bytes":'+literal)),'bytes '+literal);
for(const u of ['http://example.com/[x]','http://example.com/?x=[y]']) {
 const bad=JSON.parse(rawItem); bad.items[0].url=u; expectControlledFailure(parser.sidecar,Buffer.from(JSON.stringify(bad)),u);
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
// 双端共享 bindingCases：使用原始代字节与外部测试注入，不证明可信来源。
for(const c of adversarial.bindingCases) {
 const raw=bytes(c.sidecarBase64), p=parser.pointer(bytes(c.pointerBase64)), m=bytes(c.manifestBase64);
 assert.strictEqual(digest(raw),c.sidecarId,c.id); assert.strictEqual(p.current,c.sidecarId,c.id);
 const run=()=>parser.generation(p.current,m,raw,c.controlledCommit,digest);
 if(c.proposed==='accept') assert.strictEqual(run().commit,c.controlledCommit,c.id);
 else expectControlledFailure(run,null,c.id);
}
// 绑定来自测试环境而非可信来源；共享 first 的原始代数据验证绑定。
const first=fixture.pointer.find(c=>c.id==='first');
const firstPointer=parser.pointer(bytes(first.pointerBase64));
const firstGeneration=first.generations[firstPointer.current];
const checkBinding=binding=>parser.generation(firstPointer.current,bytes(firstGeneration.manifestBase64),bytes(firstGeneration.sidecarBase64),binding,digest);
assert.deepStrictEqual(plain(checkBinding('a'.repeat(40))),first.expected.output);
for(const binding of ['b'.repeat(40),'','A'.repeat(40),'a'.repeat(39),null,undefined]) expectControlledFailure(()=>checkBinding(binding),null,'binding '+binding);
// 状态选择仅为 fixture 驱动模拟，不是生产实现或可信绑定。
function selection(c) {
 let p; try {p=parser.pointer(bytes(c.pointerBase64));} catch (_) {return {selection:'unavailable'};}
 function get(id) {try {const g=c.generations[id]; if(!g) return null; return parser.generation(id,bytes(g.manifestBase64),bytes(g.sidecarBase64),'a'.repeat(40),digest);} catch (_) {return null;}}
 const cur=get(p.current), prev=p.previous && get(p.previous);
 if(cur) return {selection:'current',degraded:!!p.previous && !prev,output:plain(cur)};
 if(prev && (!c.binding || c.binding.currentCommit===c.binding.previousCommit)) return {selection:'previous',output:plain(prev)};
 return {selection:'unavailable'};
}
for(const c of fixture.pointer) assert.deepStrictEqual(selection(c),c.expected,c.id);
// 测试本地回退独立于远端；策略结果仅为注入的测试材料。
for(const c of fixture.localFallback) {
 assert.throws(()=>parser.pointer(bytes(c.pointerBase64)),c.id);
 let output; try {if(c.localRevocationPolicyResult==='allow') output=parser.generation(c.local.id,bytes(c.local.manifestBase64),bytes(c.local.sidecarBase64),'b'.repeat(40),digest);} catch (_) {}
 const actual=output?{remote:'unavailable',selection:'local',output:plain(output)}:{remote:'unavailable',selection:'unavailable'};
 assert.deepStrictEqual(actual,c.expected,c.id);
}
console.log('C3 Web v2 原始字节消费测试通过（独立实验，未接生产）');
