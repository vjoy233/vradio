'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const E = require('../tools/c3-evidence');
const commit = 'a'.repeat(40), scriptCommit = 'b'.repeat(40);
function fixture() {
  const candidates = Array.from({length:250}, (_,i) => ({url:'https://example.test/'+i,category:'音乐'}));
  return {version:1,commit,scriptCommit,candidates,mainUrls:[],releaseCategories:['音乐'], rounds:['first','second'].map(window => ({window,commit,scriptCommit,results:candidates.map(c => ({url:c.url,code:'OK',latencyMs:6000}))}))};
}
let e = fixture(), r = E.evaluate(e);
assert.equal(r.structure,'VALID'); assert.equal(r.arithmetic,'PASS'); assert.equal(r.decision,'NO_GO');
assert.equal(r.metrics.merged.newOk,250); assert.equal(r.metrics.merged.bothRoundsNewOk,250); assert.equal(r.metrics.merged.p95,6000);
e.rounds[0].results[0].code='NETWORK'; r=E.evaluate(e); assert.equal(r.metrics.merged.network,1); assert.equal(r.metrics.merged.bothRoundsNewOk,249);
e=fixture(); e.approved=true; e.humanReview={verified:true}; assert.equal(E.evaluate(e).decision,'NO_GO');
e=fixture(); e.rounds[0].results.push(e.rounds[0].results[0]); assert.equal(E.evaluate(e).structure,'INVALID');
e=fixture(); e.rounds[0].results[0].code='UNKNOWN'; assert.equal(E.evaluate(e).structure,'INVALID');
e=fixture(); e.rounds[0].results[0].latencyMs=NaN; assert.equal(E.evaluate(e).structure,'INVALID');
e=fixture(); e.rounds[1].window='first'; assert.equal(E.evaluate(e).structure,'INVALID');
e=fixture(); e.rounds[0].results=e.rounds[0].results.slice(0,224); assert.equal(E.evaluate(e).arithmetic,'FAIL');
e=fixture(); e.rounds[0].results.forEach(x=>x.latencyMs=6001); assert.equal(E.evaluate(e).arithmetic,'FAIL');
e=fixture(); e.mainUrls=e.candidates.slice(0,26).map(x=>x.url); assert.equal(E.evaluate(e).arithmetic,'FAIL');
e=fixture(); e.rounds.forEach(a=>a.results.forEach((x,i)=>{if(i<26)x.code='SHORT_BODY';})); assert.equal(E.evaluate(e).arithmetic,'FAIL');
// 300 个候选可隔离重叠和 SHORT_BODY 的 10% 边界，新增 OK 仍 ≥250。
function larger() {
  const x=fixture();
  for(let i=250;i<300;i++) { const c={url:'https://example.test/'+i,category:'音乐'}; x.candidates.push(c); x.rounds.forEach(a=>a.results.push({url:c.url,code:'OK',latencyMs:6000})); }
  return x;
}
e=larger(); e.mainUrls=e.candidates.slice(0,30).map(x=>x.url); assert.equal(E.evaluate(e).arithmetic,'PASS');
e.mainUrls.push(e.candidates[30].url); r=E.evaluate(e); assert.deepStrictEqual(r.failures,['主库精确 URL 重叠率 > 10%']);
e=larger(); e.rounds.forEach(a=>a.results.forEach((x,i)=>{if(i<30)x.code='SHORT_BODY';})); assert.equal(E.evaluate(e).arithmetic,'PASS');
e.rounds.forEach(a=>a.results[30].code='SHORT_BODY'); r=E.evaluate(e); assert.deepStrictEqual(r.failures,['SHORT_BODY > 10%']);
e=fixture(); e.rounds[0].results=e.rounds[0].results.slice(0,225); assert.equal(E.evaluate(e).arithmetic,'PASS');
e=fixture(); e.rounds.forEach(a=>a.results[0].code='NETWORK'); r=E.evaluate(e); assert.deepStrictEqual(r.failures,['真正新增 OK < 250']);
// 隔离断言具体失败门，防止其他门失败掩盖回归。
e=fixture(); e.rounds[0].results=e.rounds[0].results.slice(0,224); assert(E.evaluate(e).failures.some(x=>x.includes('覆盖率')));
e=fixture(); e.rounds[0].results.forEach(x=>x.latencyMs=6001); assert(E.evaluate(e).failures.some(x=>x.includes('p95')));
e=fixture(); e.mainUrls=e.candidates.slice(0,26).map(x=>x.url); assert(E.evaluate(e).failures.some(x=>x.includes('重叠率')));
e=fixture(); e.rounds.forEach(a=>a.results.forEach((x,i)=>{if(i<26)x.code='SHORT_BODY';})); assert(E.evaluate(e).failures.some(x=>x.includes('SHORT_BODY')));
e=fixture(); e.rounds[0].results[0].code='EXCEPTION'; assert(E.evaluate(e).failures.some(x=>x.includes('程序异常')));
e=fixture(); e.rounds[0].results=[]; assert(E.evaluate(e).failures.some(x=>x.includes('覆盖率')));
e=fixture(); e.rounds[0].scriptCommit=commit; assert.equal(E.evaluate(e).structure,'INVALID');
e=fixture(); e.candidates[0].url='https://u:p@example.test/a'; assert.equal(E.evaluate(e).structure,'INVALID');
e=fixture(); e.mainUrls=null; assert.equal(E.evaluate(e).structure,'INVALID');
assert.equal(E.evaluate(null).decision,'NO_GO');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c3-offline-test-'));
try {
  const f=path.join(dir,'evidence.json'); fs.writeFileSync(f,JSON.stringify(fixture())); const before=fs.readFileSync(f);
  let p=cp.spawnSync(process.execPath,[path.join(__dirname,'../tools/c3-evidence.js'),f],{encoding:'utf8'});
  assert.equal(p.status,0,p.stderr); assert.equal(JSON.parse(p.stdout).decision,'NO_GO'); assert.deepStrictEqual(fs.readFileSync(f),before);
  p=cp.spawnSync(process.execPath,[path.join(__dirname,'../tools/c3-evidence.js'),f,path.join(dir,'out.json')],{encoding:'utf8'}); assert.equal(p.status,2); assert(!fs.existsSync(path.join(dir,'out.json')));
  p=cp.spawnSync(process.execPath,[path.join(__dirname,'../tools/c3-evidence.js'),'https://example.test/x.json'],{encoding:'utf8'}); assert.equal(p.status,2);
  const bad=fixture(); bad.rounds[0].results=[]; fs.writeFileSync(f,JSON.stringify(bad)); p=cp.spawnSync(process.execPath,[path.join(__dirname,'../tools/c3-evidence.js'),f],{encoding:'utf8'}); assert.equal(p.status,1); assert.equal(JSON.parse(p.stdout).decision,'NO_GO');
  fs.writeFileSync(f,'{'); p=cp.spawnSync(process.execPath,[path.join(__dirname,'../tools/c3-evidence.js'),f],{encoding:'utf8'}); assert.equal(p.status,2);
} finally { fs.readdirSync(dir).forEach(name => fs.unlinkSync(path.join(dir,name))); fs.rmdirSync(dir); }
console.log('c3-evidence: offline arithmetic and CLI tests passed');
