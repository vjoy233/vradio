'use strict';
// 独立实验纯函数：不接线、不联网；摘要函数由调用方注入。
(function (root) {
 function fail() { throw new Error('invalid C3 v2'); }
 function json(bytes, max) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > max || (bytes[0]===239 && bytes[1]===187 && bytes[2]===191)) fail();
  let s; try { s=new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch (_) { fail(); }
  let i=0; const ws=()=>{while (/[ \t\r\n]/.test(s[i] || '\0')) i++;};
  function str() { let start=i++; while(i<s.length) { if(s[i]==='"') { i++; try {return JSON.parse(s.slice(start,i));} catch (_) {fail();} } if(s[i]==='\\') i++; i++; } fail(); }
  function value(depth) { ws(); let c=s[i]; if ((c==='{' || c==='[') && depth>=3) fail(); if(c==='"') return str(); if(c==='{') { i++; ws(); const o=Object.create(null), seen=new Set(); if(s[i]==='}') {i++; return o;} for (;;) {ws(); if(s[i]!=='"') fail(); const k=str(); if(seen.has(k)) fail(); seen.add(k); ws(); if(s[i++]!==':') fail(); o[k]=value(depth+1); ws(); c=s[i++]; if(c==='}') return o; if(c!==',') fail();} } if(c==='[') { i++; ws(); const a=[]; if(s[i]===']') {i++; return a;} for (;;) {a.push(value(depth+1)); ws(); c=s[i++]; if(c===']') return a; if(c!==',') fail();} } const m=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(i)); if(!m || /[.eE]/.test(m[0])) fail(); i+=m[0].length; return JSON.parse(m[0]); }
  const out=value(0); ws(); if(i!==s.length) fail(); return out;
 }
 function fields(o, keys) { if(!o || typeof o!=='object' || Array.isArray(o) || Object.keys(o).length!==keys.length || keys.some(k=>!Object.prototype.hasOwnProperty.call(o,k))) fail(); }
 const hash=s=>typeof s==='string' && /^[0-9a-f]{64}$/.test(s);
 const commit=s=>typeof s==='string' && /^[0-9a-f]{40}$/.test(s);
 function text(s,max,empty) { if(typeof s!=='string' || (!empty && !s.length) || /[\u0000-\u001f\u007f-\u009f]/.test(s) || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s) || new TextEncoder().encode(s).length>max) fail(); }
 function url(s) { if(typeof s!=='string' || s.length>2048 || !/^[\x21-\x7e]+$/.test(s)) fail(); const m=/^https?:\/\/([^\/?#]+)([^#]*)$/.exec(s); if(!m) fail(); const hp=/^([^:]+)(?::([0-9]+))?$/.exec(m[1]); if(!hp || (hp[2]!==undefined && (+hp[2]<1 || +hp[2]>65535))) fail(); const host=hp[1]; if(host.length>253) fail(); const labels=host.split('.'); if(labels.some(x=>!x || x.length>63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(x))) fail(); if(/^[0-9.]+$/.test(host) || /^[0-9]/.test(labels[labels.length-1])) { if(labels.length!==4 || labels.some(x=>!/^(?:0|[1-9][0-9]*)$/.test(x) || +x>255)) fail(); } if(!/^(?:[a-zA-Z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-fA-F]{2})*$/.test(m[2])) fail(); }
 function sidecar(b) { const o=json(b,524288); fields(o,['v','source','license','commit','generatedAt','items']); if(o.v!==2 || o.source!=='recommended-radio-streams' || o.license!=='CC0-1.0' || !commit(o.commit) || typeof o.generatedAt!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(o.generatedAt)) fail(); const d=new Date(o.generatedAt); if(!Number.isFinite(d.getTime()) || d.toISOString()!==o.generatedAt || !Array.isArray(o.items) || o.items.length>300) fail(); const seen=new Set(); for(const x of o.items) {fields(x,['name','url','genre','upstream','commit']); text(x.name,200,false); text(x.genre,120,true); url(x.url); if(x.upstream!==o.source || x.commit!==o.commit || seen.has(x.url)) fail(); seen.add(x.url);} return o; }
 function manifest(b) {const o=json(b,4096); fields(o,['v','sha256','bytes']); if(o.v!==2 || !hash(o.sha256) || !Number.isInteger(o.bytes) || o.bytes<1 || o.bytes>524288) fail(); return o;}
 function pointer(b) {const o=json(b,4096); fields(o,['v','current','previous']); if(o.v!==2 || !hash(o.current) || !(o.previous===null || hash(o.previous)) || o.previous===o.current) fail(); return o;}
 function generation(id, m, b, expectedUpstreamCommit, digest) {if(!hash(id) || (expectedUpstreamCommit != null && !commit(expectedUpstreamCommit))) fail(); const x=manifest(m); if(x.sha256!==id || x.bytes!==b.length || digest(b)!==id) fail(); const out=sidecar(b); if(expectedUpstreamCommit != null && out.commit!==expectedUpstreamCommit) fail(); return {sidecar:out,provenance:'unverified'};}
 const api={sidecar,manifest,pointer,generation}; if(typeof module!=='undefined' && module.exports) module.exports=api; else root.C3StrictV2=api;
})(typeof globalThis==='undefined'?this:globalThis);
