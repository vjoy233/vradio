'use strict';
// C2 独立只读测量；上游仅经 gh API 固定 commit 读取，绝不接生产发布。
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const { checkDetail } = require('../update-sources');
const REPO = 'deroverda/recommended-radio-streams';
function gh(endpoint) { return JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })); }
function parse(text, slug) {
  let info = null; const out = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const l = raw.trim();
    if (/^#EXTINF:/i.test(l)) { const comma = l.indexOf(','); info = { name: comma < 0 ? '' : l.slice(comma + 1).trim(), logo: (l.match(/tvg-logo="([^"]*)"/i) || [])[1] || '' }; }
    else if (l && l[0] !== '#') { if (info && /^https?:\/\//i.test(l)) out.push({ url: l, name: info.name, logo: info.logo, slug }); info = null; }
  }
  return out;
}
function normalize(s) { try { const u = new URL(s); if (!/^https?:$/.test(u.protocol)) return s; u.hash = ''; return u.href; } catch (_) { return s; } }
function mainUrls(text) { return text.split(/\r?\n/).map(l => l.slice(l.indexOf(',') + 1).trim()).filter(x => /^https?:\/\//i.test(x)); }
function prepare(entries, main, limit, mainText) {
  const exact = new Set(main), norm = new Set(main.map(normalize)), map = new Map();
  for (const e of entries) { let v = map.get(e.url); if (!v) { v = { url: e.url, names: [], slugs: [], logo: false }; map.set(e.url, v); } if (!v.names.includes(e.name)) v.names.push(e.name); if (!v.slugs.includes(e.slug)) v.slugs.push(e.slug); v.logo = v.logo || !!e.logo; }
  const all = Array.from(map.values()).sort((a,b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  const mainNames = new Map(); for (const l of (mainText || '').split(/\r?\n/)) { const i=l.indexOf(','); if(i>0 && /^https?:\/\//i.test(l.slice(i+1).trim())) { const n=l.slice(0,i).trim().toLowerCase(); if(!mainNames.has(n)) mainNames.set(n,[]); mainNames.get(n).push(l.slice(i+1).trim()); } }
  for (const e of all) { e.exactOverlap = exact.has(e.url); e.normalizedOverlap = norm.has(normalize(e.url)); e.possibleNameOverlap = e.names.some(n => n && (mainNames.get(n.toLowerCase()) || []).some(u => u !== e.url)); }
  return { all, selected: all.slice(0, limit) };
}
function distribution(results, key) { const d = {}; for (const r of results) { const k = key(r); if (k) d[k] = (d[k] || 0) + 1; } return d; }
async function measure(items, probe, concurrency, deadline) {
  let next=0; const results=[];
  async function worker() { while (next < items.length && Date.now() < deadline) { const e=items[next++]; try { const r=await probe(e.url); results.push(Object.assign({}, e, { result:r })); } catch(err) { results.push(Object.assign({}, e, { exception: String(err.stack || err) })); } } }
  await Promise.all(Array.from({length:concurrency}, worker)); return results.sort((a,b)=>a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
}
function summarize(entries, all, selected, results) {
  const valid=results.filter(r=>r.result), ok=valid.filter(r=>r.result.ok), genres={};
  for (const r of valid) for(const g of r.slugs) { const x=genres[g] || (genres[g]={tested:0,ok:0}); x.tested++; if(r.result.ok)x.ok++; }
  for(const x of Object.values(genres)) x.rate=x.ok/x.tested;
  const lat=valid.map(r=>r.result.latencyMs).sort((a,b)=>a-b), percentile=p=>lat.length ? lat[Math.ceil(lat.length*p)-1] : null;
  return { raw:entries.length, unique:all.length, exactOverlap:all.filter(x=>x.exactOverlap).length, exactOverlapRate:all.length ? all.filter(x=>x.exactOverlap).length/all.length : null, normalizedOverlap:all.filter(x=>x.normalizedOverlap).length, normalizedOverlapRate:all.length ? all.filter(x=>x.normalizedOverlap).length/all.length : null, possibleNameOverlap:all.filter(x=>x.possibleNameOverlap).length, selected:selected.length, capTruncated:all.length-selected.length, tested:results.length, untestedSelected:selected.length-results.length, ok:ok.length, survivalRate:valid.length ? ok.length/valid.length : null, newOk:ok.filter(x=>!x.exactOverlap).length, logoCoverage:all.length ? all.filter(x=>x.logo).length/all.length : null, genres, codes:distribution(valid,r=>r.result.code), errno:distribution(valid,r=>(r.result.why.match(/\b(E(?:CONNRESET|CONNREFUSED|TIMEDOUT|HOSTUNREACH|NETUNREACH|AI_AGAIN|NOTFOUND|PIPE)|ENOTFOUND)\b/) || [])[1]), exceptions:results.filter(r=>r.exception).length, latencyMs:{min:lat[0] || null,p50:percentile(.5),p90:percentile(.9),p95:percentile(.95),max:lat.length ? lat[lat.length-1] : null} };
}
async function run() {
  const args=process.argv.slice(2), get=(key, fallback)=>{ const i=args.indexOf(key); return i<0 ? fallback : args[i+1]; };
  const commit=get('--commit',''); const limit=Number(get('--limit','300')), seconds=Number(get('--seconds','120'));
  if (!/^[a-f0-9]{40}$/.test(commit) || !Number.isInteger(limit) || limit<1 || limit>300 || !Number.isFinite(seconds) || seconds<1 || seconds>3600 || args.some((a,i)=>i%2===0 && !['--commit','--limit','--seconds'].includes(a)) || args.length%2) throw Error('用法: --commit 40位SHA [--limit 1..300] [--seconds 1..3600]');
  const started=Date.now(), files=[], entries=[]; let upstreamError=null, license=null;
  try { const l=gh(`repos/${REPO}/contents/LICENSE?ref=${commit}`); const text=Buffer.from((l.content || '').replace(/\s/g,''),'base64').toString('utf8'); if (!/^Creative Commons Legal Code\s+CC0 1\.0 Universal/m.test(text)) throw Error('固定 commit 的许可无法确认 CC0-1.0'); license={spdx:'CC0-1.0',path:l.path,sha:l.sha}; const list=gh(`repos/${REPO}/contents/playlists?ref=${commit}`); if(!Array.isArray(list)) throw Error('播放列表清单无效'); for(const f of list.filter(x=>x.type==='file' && /\.m3u$/i.test(x.name)).sort((a,b)=>a.name.localeCompare(b.name))) { const data=gh(`repos/${REPO}/contents/${f.path}?ref=${commit}`); if(data.encoding!=='base64' || typeof data.content!=='string') throw Error('文件内容无效: '+f.path); const text=Buffer.from(data.content.replace(/\s/g,''),'base64').toString('utf8'); files.push({path:f.path,sha:f.sha,bytes:Buffer.byteLength(text)}); entries.push(...parse(text,f.name.replace(/\.m3u$/i,''))); } if(!files.length) throw Error('未发现播放列表'); } catch(e) { upstreamError=String(e.stack || e); }
  const mainText=fs.readFileSync(path.join(__dirname,'../radio.txt'),'utf8'); const main=mainUrls(mainText); const prep=prepare(entries,main,limit,mainText); const probeStart=Date.now(); const results=upstreamError ? [] : await measure(prep.selected,checkDetail,4,probeStart+seconds*1000);
  const report={repo:REPO,commit,license,startedAt:new Date(started).toISOString(),elapsedMs:Date.now()-started,probeElapsedMs:Date.now()-probeStart,probeBudgetSeconds:seconds,upstreamError,files,environment:{platform:process.platform,release:os.release(),node:process.version,githubTransport:'gh api',probeTransport:'Node http/https 直连，不读取代理环境变量；系统路由未知',proxyVariables:Object.keys(process.env).filter(k=>/^(https?_proxy|all_proxy|no_proxy)$/i.test(k))},limitations:['URL 确定性排序截取，非随机样本；截止仅阻止启动新请求，已运行请求按默认超时收尾。','checkDetail 不保留独立 errno 字段；仅从 why 提取可见 errno，其他不可得。','OK 仅字节/协议通过，不保证内容正确；未做试听。','未确认量化阈值，不判定达标，不实施 C3。'],summary:summarize(entries,prep.all,prep.selected,results),candidates:prep.all,results};
  const dir=path.join(__dirname,'../docs/test-reports/recommended-radio',new Date(started).toISOString().replace(/[:.]/g,'-')); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2)+'\n'); fs.writeFileSync(path.join(dir,'report.md'),`# 第三上游 C2 测量\n\n- commit: ${commit}\n- 许可: ${JSON.stringify(report.license)}\n- 时间: ${report.startedAt}\n- 文件数: ${files.length}\n- 上游错误: ${upstreamError || '无'}\n- 环境: ${JSON.stringify(report.environment)}\n- 耗时: ${report.elapsedMs} ms，探测 ${report.probeElapsedMs} ms\n- 统计: ${JSON.stringify(report.summary,null,2)}\n- 限制: ${report.limitations.join('；')}\n`); console.log(JSON.stringify({directory:dir,summary:report.summary,upstreamError},null,2)); if(upstreamError || report.summary.exceptions) process.exitCode=1;
}
if(require.main===module) run().catch(e=>{console.error(e.stack || e);process.exitCode=1;});
module.exports={parse,normalize,mainUrls,prepare,measure,summarize};
