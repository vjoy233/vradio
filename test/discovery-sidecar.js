const assert = require('assert');
const S = require('../discovery-sidecar');
assert.deepStrictEqual(S.normalize({v:1,items:[{name:' A\nB ',url:'https://x/a'},{name:'bad',url:'javascript:x'},{name:'dup',url:'https://x/a'}]}), [{name:'A B',url:'https://x/a',genre:'',upstream:'recommended-radio-streams',commit:''}]);
assert.deepStrictEqual(S.normalize({v:2,items:[]}), []);
(async()=>{ assert.deepStrictEqual(await S.load(async()=>({ok:false}), 'x'), []); console.log('discovery-sidecar: 3 passed'); })().catch(e=>{console.error(e);process.exitCode=1});
