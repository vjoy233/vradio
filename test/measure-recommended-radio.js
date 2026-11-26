'use strict';
const assert=require('assert'), http=require('http'), {parse,normalize,mainUrls,prepare,measure,summarize}=require('../tools/measure-recommended-radio');
const {checkDetail}=require('../update-sources');
(async()=>{
 const text='#EXTM3U\n#EXTINF:-1 tvg-logo="x",One\nhttp://EXAMPLE.com:80/a?x=1\n#EXTINF:-1,Same\nhttp://other.test/live\n';
 const a=parse(text,'jazz'), b=parse('#EXTINF:-1,One\nhttp://EXAMPLE.com:80/a?x=1\n','rock');
 assert.strictEqual(a.length,2); assert.strictEqual(a[0].logo,'x'); assert.strictEqual(normalize(a[0].url),'http://example.com/a?x=1'); assert.notStrictEqual(normalize('http://example.com/a?x=2'),normalize(a[0].url));
 const main='One,http://example.com/a?x=1\nSame,http://different.test/live\n';
 const p=prepare(a.concat(b),mainUrls(main),1,main); assert.strictEqual(p.all.length,2); assert.strictEqual(p.selected.length,1); assert.strictEqual(p.all[0].normalizedOverlap,true); assert.strictEqual(p.all[0].exactOverlap,false); assert.deepStrictEqual(p.all[0].slugs,['jazz','rock']); assert.strictEqual(p.all[1].possibleNameOverlap,true);
 const many=Array.from({length:305},(_,i)=>({url:'http://x.test/'+String(i).padStart(3,'0'),slug:'g',name:'n',logo:''})); assert.strictEqual(prepare(many,[],300,'').selected.length,300);
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'audio/mpeg'});res.end(Buffer.alloc(9000,1));}); await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try { const u='http://127.0.0.1:'+server.address().port+'/stream'; const result=await measure([{url:u,names:['local'],slugs:['g'],exactOverlap:false}],x=>checkDetail(x,0,{testHook:{safe:x=>x,lookup:(host,opts,cb)=>cb(null,'127.0.0.1',4)}}),4,Date.now()+10000); assert.strictEqual(result[0].result.code,'OK'); const s=summarize(a,p.all,p.selected,result); assert.strictEqual(s.newOk,1); assert.strictEqual(s.capTruncated,1); assert.strictEqual(s.genres.g.ok,1); const failures=await measure([{url:'bad'}],()=>{throw Error('upstream failure');},1,Date.now()+1000); assert.match(failures[0].exception,/upstream failure/); assert.strictEqual((await measure([{url:'never'}],()=>{throw Error('unexpected');},1,0)).length,0); } finally {server.close();}
 console.log('C2 离线测量测试通过');
})().catch(e=>{console.error(e);process.exitCode=1;});
