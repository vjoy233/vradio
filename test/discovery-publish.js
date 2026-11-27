'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const P=require('../discovery-publish');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'vradio-c3-'));
const sha='a'.repeat(40), stamp='2026-11-26T00:00:00.000Z';
const mk=(url)=>({commit:sha,generatedAt:stamp,items:[{name:'test',url,ok:true,code:'OK'}]});
try {
 assert.throws(()=>P.build(mk('https://example.com/a'),['https://example.com/a']));
 assert.throws(()=>P.build({...mk('https://example.com/a'),items:[{name:'x',url:'https://example.com/a',ok:true,code:'NETWORK'}]},[]));
 const a=P.build(mk('https://example.com/a'),[]),b=P.build(mk('https://example.com/b'),[]);
 const first=P.publish(root,a), second=P.publish(root,b);
 assert.equal(P.load(root).manifest.sha256,second);
 fs.writeFileSync(path.join(root,second,'radio-discovery.json'),'broken');
 assert.equal(P.load(root).manifest.sha256,first);
 assert.throws(()=>P.publish(root,b));
 assert.equal(P.load(root).manifest.sha256,first);
 fs.mkdirSync(path.join(root,'orphan')); fs.writeFileSync(path.join(root,'orphan','manifest.json'),'incomplete');
 assert.equal(P.load(root).manifest.sha256,first);
 console.log('discovery-publish: generation/fallback passed');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
