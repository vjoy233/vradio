'use strict';
// 仅由隔离的 CLI 测试通过 --require 加载；任何意外子进程或探测均失败，不访问网络。
const fs=require('fs'), cp=require('child_process');
const fixture=JSON.parse(fs.readFileSync(process.env.C2_FIXTURE,'utf8'));
cp.execFileSync=(cmd,args)=>{
  if(cmd!=='gh' || args[0]!=='api' || !Object.prototype.hasOwnProperty.call(fixture.responses,args[1])) throw Error('unexpected offline command: '+cmd+' '+args.join(' '));
  const value=fixture.responses[args[1]];
  if(value && value.error) throw Error(value.error);
  return JSON.stringify(value);
};
for(const name of ['http','https']) { const net=require(name); net.request=net.get=()=>{ throw Error('offline network blocked'); }; }
const sync=require('../../update-sources');
sync.checkDetail=async url=>{
  if(!Object.prototype.hasOwnProperty.call(fixture.probes,url)) throw Error('unexpected offline probe: '+url);
  return fixture.probes[url];
};
