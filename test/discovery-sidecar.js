const assert = require('assert');
require('./harness/web-api').install();
const S = require('../discovery-sidecar');
const sha = 'a'.repeat(40), raw = {v:1,source:'recommended-radio-streams',license:'CC0-1.0',commit:sha,items:[{name:'x',url:'https://x'}]};
assert.equal(S.normalize(raw).length, 1);
assert.deepStrictEqual(S.normalize({...raw,commit:'abc'}), []);
assert.deepStrictEqual(S.normalize({...raw,license:'invalid'}), []);
assert.deepStrictEqual(S.normalize({...raw,items:[{name:'x',url:'https://x',commit:'b'.repeat(40)}]}), []);
(async()=>{
  let aborted = false;
  assert.deepStrictEqual(await S.load((u,o)=>{o.signal.addEventListener('abort',()=>aborted=true);return new Promise(()=>{});}, 'x', 5), []);
  assert(aborted);
  let cancelled = false;
  const response = data => ({ok:true,headers:{get:k=>k==='content-type'?'application/json':null},body:{getReader:()=>({read:async()=>data.shift() || {done:true},cancel:async()=>{cancelled=true;}})}});
  assert.deepStrictEqual(await S.load(async()=>response([{value:new Uint8Array(512*1024+1),done:false}]), 'x'), []);
  assert(cancelled);
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  assert.equal((await S.load(async()=>response([{value:bytes,done:false}]),'x')).length,1);
  assert.deepStrictEqual(await S.load(async()=>({ok:true,headers:{get:()=>null}}), 'x'), []);
  const crypto = require('crypto'); globalThis.crypto = crypto.webcrypto;
  const valid = {...raw,generatedAt:'2026-11-26T00:00:00.000Z'};
  const payload = Buffer.from(JSON.stringify(valid)), id = crypto.createHash('sha256').update(payload).digest('hex'), broken = 'b'.repeat(64);
  const routes = {'snap/current.json':JSON.stringify({v:1,current:broken,previous:id}), ['snap/'+broken+'/manifest.json']:JSON.stringify({v:1,sha256:broken,bytes:1}), ['snap/'+broken+'/radio-discovery.json']:'x', ['snap/'+id+'/manifest.json']:JSON.stringify({v:1,sha256:id,bytes:payload.length}), ['snap/'+id+'/radio-discovery.json']:payload};
  const fetcher = async url => { if (!(url in routes)) throw Error('missing'); return response([{value:Buffer.from(routes[url]),done:false}]); };
  assert.equal((await S.loadSnapshot(fetcher,'snap')).length,1, 'corrupt current falls back');
  let successfulAbort = false;
  const observeSuccess = (u,o) => { o.signal.addEventListener('abort', () => { successfulAbort = true; }); return fetcher(u,o); };
  assert.equal((await S.loadSnapshot(observeSuccess,'snap')).length,1);
  assert.equal(successfulAbort, false, 'completed stages do not abort');
  const stalled = async (url, opts) => url.includes(broken) ? new Promise(() => {}) : fetcher(url, opts);
  assert.equal((await S.loadSnapshot(stalled,'snap',10)).length,1, 'stalled current falls back within independent deadline');
  let readCancelled = false, readAborted = false;
  const stalledRead = async (u,o) => u.includes(broken) ? {ok:true,headers:{get:k=>k==='content-type'?'application/json':null},body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:async()=>{readCancelled=true;}})}} : fetcher(u,o);
  const observed = (u,o) => { if (u.includes(broken)) o.signal.addEventListener('abort',()=>{readAborted=true;}); return stalledRead(u,o); };
  assert.equal((await S.loadSnapshot(observed,'snap',10)).length,1);
  assert(readCancelled && readAborted, 'stalled reader is cancelled and aborted');
  let streamCancelled = false;
  // 新版 Node 保留真实流覆盖；Node14 无 ReadableStream，用 reader 桩覆盖不完成的 cancel。
  const body = typeof ReadableStream === 'function'
    ? new ReadableStream({pull(){return new Promise(()=>{});},cancel(){streamCancelled=true; return new Promise(()=>{});}})
    : {getReader:()=>({read:()=>new Promise(()=>{}),cancel:()=>{streamCancelled=true; return new Promise(()=>{});}})};
  const realStream = async (u,o) => u.includes(broken) ? {ok:true,headers:{get:k=>k==='content-type'?'application/json':null},body} : fetcher(u,o);
  assert.equal((await S.loadSnapshot(realStream,'snap',10)).length,1, 'real stream cancel never blocks fallback');
  assert(streamCancelled);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {configurable:true, value:undefined});
  assert.equal((await S.loadSnapshot(fetcher,'snap',10)).length, 1, 'insecure context verifies hash without Web Crypto');
  for (const n of [0,1,55,56,63,64,65,1024,524288]) { const b = crypto.randomBytes(n); assert.equal(S.sha256Bytes(b), crypto.createHash('sha256').update(b).digest('hex')); }
  Object.defineProperty(globalThis, 'crypto', descriptor);
  routes['snap/'+id+'/radio-discovery.json'] = 'changed';
  assert.deepStrictEqual(await S.loadSnapshot(fetcher,'snap'), [], 'hash mismatch fails closed');
  const golden = require('../contracts/fixtures/discovery-c3-golden.json');
  for (const c of golden.cases) {
    const body = Buffer.from(JSON.stringify(c.sidecar)), h = crypto.createHash('sha256').update(body).digest('hex');
    const files = {'g/current.json':JSON.stringify({v:1,current:h}), ['g/'+h+'/manifest.json']:JSON.stringify({v:1,sha256:h,bytes:body.length}), ['g/'+h+'/radio-discovery.json']:body};
    const got = await S.loadSnapshot(async u => response([{value:Buffer.from(files[u]),done:false}]), 'g');
    assert.equal(got.length > 0, c.accept, c.id);
  }
  routes['snap/current.json'] = JSON.stringify({v:1,current:'../../attack'});
  assert.deepStrictEqual(await S.loadSnapshot(fetcher,'snap'), [], 'pointer traversal rejected');
  console.log('discovery-sidecar: safety tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
