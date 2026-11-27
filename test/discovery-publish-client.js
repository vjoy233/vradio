'use strict';
// 真临时目录中的发布结果经真实 Web 快照加载器校验，覆盖指针版本损坏修复。
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const P=require('../discovery-publish'),S=require('../discovery-sidecar');
Object.defineProperty(globalThis,'crypto',{configurable:true,value:crypto.webcrypto});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'vradio-publish-client-'));
const mk=url=>P.build({commit:'a'.repeat(40),generatedAt:'2026-11-26T00:00:00.000Z',items:[{name:url,url,ok:true,code:'OK'}]},[]);
const fetcher=async url=>{ const data=fs.readFileSync(path.join(root,...url.split('/').slice(1))); let done=false; return {ok:true,headers:{get:k=>k==='content-type'?'application/json':null},body:{getReader:()=>({read:async()=>done?{done:true}:(done=true,{done:false,value:data}),cancel:async()=>{}})}}; };
(async()=>{ try {
 const a=mk('https://example.com/a'),b=mk('https://example.com/b'),old=P.publish(root,a),current=P.publish(root,b);
 for (const version of [2,null]) {
  fs.writeFileSync(path.join(root,'current.json'),JSON.stringify({v:version,current,previous:old}));
  assert.deepStrictEqual(await S.loadSnapshot(fetcher,'snap'),[]);
  assert.strictEqual(P.publish(root,b),current);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root,'current.json'),'utf8')).previous,old);
  assert.strictEqual((await S.loadSnapshot(fetcher,'snap'))[0].url,'https://example.com/b');
 }
 fs.writeFileSync(path.join(root,current,'manifest.json'),'broken');
 assert.strictEqual((await S.loadSnapshot(fetcher,'snap'))[0].url,'https://example.com/a');
 console.log('discovery-publish-client: pointer repair and browser fallback passed');
} finally { fs.rmSync(root,{recursive:true,force:true}); } })().catch(e=>{console.error(e);process.exitCode=1;});
