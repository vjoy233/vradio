'use strict';
const assert=require('assert'), http=require('http'), {parse,normalize,mainUrls,prepare,measure,summarize}=require('../tools/measure-recommended-radio');
const {checkDetail}=require('../update-sources');
const fs=require('fs'), path=require('path'), os=require('os'), cp=require('child_process');
function cliFixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vradio-c2-'));
 const files=['tools/measure-recommended-radio.js','update-sources.js','test/harness/c2-offline-preload.js'];
 for(const f of files) { const dest=path.join(root,f); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(path.join(__dirname,'..',f),dest); }
 const protectedFiles=['radio.txt','radio-data.js','logos.txt','radio-meta.json','sync-manifest.json','my-radio.txt','data/store.json'];
 for(const [i,f] of protectedFiles.entries()) { const dest=path.join(root,f); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.writeFileSync(dest,Buffer.from('保护数据 '+i+'\r\n\u0000尾')); }
 const snapshot=()=>protectedFiles.map(f=>fs.readFileSync(path.join(root,f)));
 const before=snapshot(), commit='a'.repeat(40), base='repos/deroverda/recommended-radio-streams/contents/', suffix='?ref='+commit;
 const contents=s=>Buffer.from(s).toString('base64');
 const responses={}; responses[base+'LICENSE'+suffix]={path:'LICENSE',sha:'license-sha',content:contents('Creative Commons Legal Code\nCC0 1.0 Universal\n')};
 responses[base+'playlists'+suffix]=[{type:'file',name:'jazz.m3u',path:'playlists/jazz.m3u',sha:'list-sha'}];
 responses[base+'playlists/jazz.m3u'+suffix]={encoding:'base64',content:contents('#EXTM3U\n#EXTINF:-1,Fixture\nhttp://fixture.invalid/stream\n')};
 const probes={'http://fixture.invalid/stream':{ok:true,code:'OK',why:'',latencyMs:1}};
 const fixture=path.join(root,'fixture.json');
 const invoke=()=>cp.spawnSync(process.execPath,['--require',path.join(root,'test/harness/c2-offline-preload.js'),path.join(root,'tools/measure-recommended-radio.js'),'--commit',commit,'--limit','1','--seconds','1'],{cwd:root,env:Object.assign({},process.env,{C2_FIXTURE:fixture}),encoding:'utf8',timeout:15000});
 try {
  fs.writeFileSync(fixture,JSON.stringify({responses,probes}));
  const success=invoke(); assert.strictEqual(success.status,0,success.stderr); const result=JSON.parse(success.stdout); const report=JSON.parse(fs.readFileSync(path.join(result.directory,'report.json'),'utf8'));
  assert.strictEqual(report.upstreamError,null); assert.strictEqual(report.summary.ok,1); assert.strictEqual(report.files.length,1); assert.strictEqual(report.results[0].url,'http://fixture.invalid/stream'); assert.ok(fs.readFileSync(path.join(result.directory,'report.md'),'utf8').includes('上游错误: 无'));
  assert.deepStrictEqual(snapshot(),before,'成功 CLI 不得改写保护文件');
  responses[base+'playlists/jazz.m3u'+suffix]={error:'fixture upstream failure'}; fs.writeFileSync(fixture,JSON.stringify({responses,probes:{}}));
  const failed=invoke(); assert.strictEqual(failed.status,1,failed.stderr); const failResult=JSON.parse(failed.stdout); assert.notStrictEqual(failResult.directory,result.directory); const failReport=JSON.parse(fs.readFileSync(path.join(failResult.directory,'report.json'),'utf8'));
  assert.match(failReport.upstreamError,/fixture upstream failure/); assert.strictEqual(failReport.results.length,0); assert.strictEqual(failReport.summary.tested,0); assert.ok(fs.readFileSync(path.join(failResult.directory,'report.md'),'utf8').includes('fixture upstream failure'));
  assert.deepStrictEqual(snapshot(),before,'失败 CLI 不得改写保护文件');
 } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
(async()=>{
 const text='#EXTM3U\n#EXTINF:-1 tvg-logo="x",One\nhttp://EXAMPLE.com:80/a?x=1\n#EXTINF:-1,Same\nhttp://other.test/live\n';
 const a=parse(text,'jazz'), b=parse('#EXTINF:-1,One\nhttp://EXAMPLE.com:80/a?x=1\n','rock');
 assert.strictEqual(a.length,2); assert.strictEqual(a[0].logo,'x'); assert.strictEqual(normalize(a[0].url),'http://example.com/a?x=1'); assert.notStrictEqual(normalize('http://example.com/a?x=2'),normalize(a[0].url));
 const main='One,http://example.com/a?x=1\nSame,http://different.test/live\n';
 const p=prepare(a.concat(b),mainUrls(main),1,main); assert.strictEqual(p.all.length,2); assert.strictEqual(p.selected.length,1); assert.strictEqual(p.all[0].normalizedOverlap,true); assert.strictEqual(p.all[0].exactOverlap,false); assert.deepStrictEqual(p.all[0].slugs,['jazz','rock']); assert.strictEqual(p.all[1].possibleNameOverlap,true);
 const many=Array.from({length:305},(_,i)=>({url:'http://x.test/'+String(i).padStart(3,'0'),slug:'g',name:'n',logo:''})); assert.strictEqual(prepare(many,[],300,'').selected.length,300);
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'audio/mpeg'});res.end(Buffer.alloc(9000,1));}); await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try { const u='http://127.0.0.1:'+server.address().port+'/stream'; const result=await measure([{url:u,names:['local'],slugs:['g'],exactOverlap:false}],x=>checkDetail(x,0,{testHook:{safe:x=>x,lookup:(host,opts,cb)=>cb(null,'127.0.0.1',4)}}),4,Date.now()+10000); assert.strictEqual(result[0].result.code,'OK'); const s=summarize(a,p.all,p.selected,result); assert.strictEqual(s.newOk,1); assert.strictEqual(s.capTruncated,1); assert.strictEqual(s.genres.g.ok,1); const failures=await measure([{url:'bad'}],()=>{throw Error('upstream failure');},1,Date.now()+1000); assert.match(failures[0].exception,/upstream failure/); assert.strictEqual((await measure([{url:'never'}],()=>{throw Error('unexpected');},1,0)).length,0); } finally {server.close();}
 cliFixture();
 console.log('C2 离线测量测试通过');
})().catch(e=>{console.error(e);process.exitCode=1;});
