'use strict';
// 真临时目录 + 子进程硬退出，覆盖发布各提交边界；并行读者不得看到半代。
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const P=require('../discovery-publish');
const raw=P.build({commit:'a'.repeat(40),generatedAt:'2026-11-26T00:00:00.000Z',items:[{name:'test',url:'https://example.com/new',ok:true,code:'OK'}]},[]);
const sha=crypto.createHash('sha256').update(JSON.stringify(raw)+'\n').digest('hex');
if (process.argv[2]==='crash') {
 const dir=process.argv[3], point=process.argv[4], write=fs.writeFileSync, rename=fs.renameSync;
 fs.writeFileSync=function(p,...args) { const result=write.call(fs,p,...args); if (path.basename(p)===point) process.exit(71); return result; };
 fs.renameSync=function(a,b) { const result=rename.call(fs,a,b); if (point==='generation-rename' && path.basename(b)===sha) process.exit(71); if (point==='pointer-rename' && path.basename(b)==='current.json') process.exit(71); return result; };
 P.publish(dir,raw); process.exit(0);
}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'vradio-publish-crash-'));
try {
 for (const point of ['radio-discovery.json','manifest.json','generation-rename','pointer-rename']) {
  const dir=path.join(root,point); fs.mkdirSync(dir);
  const old=P.build({commit:'b'.repeat(40),generatedAt:'2026-11-26T00:00:00.000Z',items:[{name:'old',url:'https://example.com/old',ok:true,code:'OK'}]},[]);
  const oldSha=P.publish(dir,old), child=cp.spawnSync(process.execPath,[__filename,'crash',dir,point]);
  assert.strictEqual(child.status,71,point+': '+child.stderr);
  assert.strictEqual(P.load(dir).manifest.sha256,point==='pointer-rename'?sha:oldSha);
  assert.strictEqual(P.publish(dir,raw),sha); assert.strictEqual(P.load(dir).manifest.sha256,sha);
  // 指针提交后退出并重试也不得把 previous 从旧代改成自身。
  const pointer=JSON.parse(fs.readFileSync(path.join(dir,'current.json'),'utf8'));
  assert.strictEqual(pointer.previous,oldSha,point);
  fs.writeFileSync(path.join(dir,sha,'manifest.json'),'broken');
  assert.strictEqual(P.load(dir).manifest.sha256,oldSha,point+' fallback');
 }
 // 重入模拟并发写者：任何写阶段的另一发布必须被拒，且不影响首写。
 const dir=path.join(root,'reentrant'); fs.mkdirSync(dir); const write=fs.writeFileSync; let checked=false;
 try { fs.writeFileSync=function(p,...args) { if (!checked && path.basename(p)==='radio-discovery.json') { checked=true; assert.throws(()=>P.publish(dir,raw),/发布进行中/); assert.strictEqual(P.load(dir),null); } return write.call(fs,p,...args); }; P.publish(dir,raw); } finally { fs.writeFileSync=write; }
 assert(checked); assert.strictEqual(P.load(dir).manifest.sha256,sha);
 // 已引用损坏代不可覆盖，即便回退到 previous。
 const target=path.join(dir,sha,'manifest.json'); fs.writeFileSync(target,'broken');
 assert.throws(()=>P.publish(dir,raw),/同名快照不完整或损坏/); assert.strictEqual(fs.readFileSync(target,'utf8'),'broken');
 console.log('discovery-publish-crash: crash boundaries/retry/reentrancy passed');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
