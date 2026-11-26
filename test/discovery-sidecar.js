const assert = require('assert');
const S = require('../discovery-sidecar');
assert.deepStrictEqual(S.normalize({v:1,items:[{name:' A\nB ',url:'https://x/a'},{name:'bad',url:'javascript:x'},{name:'dup',url:'https://x/a'}]}), []);
assert.deepStrictEqual(S.normalize({v:2,items:[]}), []);
assert.deepStrictEqual(S.normalize({v:1,source:'recommended-radio-streams',license:'CC0-1.0',commit:'abc',items:[{name:'x',url:'https://x'}]}), [{name:'x',url:'https://x',genre:'',upstream:'recommended-radio-streams',commit:''}]);
(async()=>{
  assert.deepStrictEqual(await S.load(async()=>new Promise(()=>{}), 'x', 5), []);
  assert.deepStrictEqual(await S.load(async()=>({ok:false}), 'x'), []);
  console.log('discovery-sidecar: 4 passed');
})().catch(e=>{ console.error(e); process.exitCode=1; });
