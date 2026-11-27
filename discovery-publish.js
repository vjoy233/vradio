'use strict';
// C3 独立快照发布。只写调用方指定目录，不参与四资产发布或 /api/sync。
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const Sidecar = require('./discovery-sidecar');
const SOURCE = 'recommended-radio-streams', LICENSE = 'CC0-1.0';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
let publishBusy = false;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function validIso(s) { return ISO.test(String(s)) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s; }
function build(input, mainUrls) {
  if (!input || !/^[a-f0-9]{40}$/.test(input.commit) || !Array.isArray(input.items)) throw Error('候选或 commit 无效');
  const main = new Set(mainUrls || []), seen = new Set();
  const sorted = input.items.filter(x => x && typeof x.url === 'string').slice().sort((a,b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  const items = [];
  for (const x of sorted) {
    if (!x || !x.ok || x.code !== 'OK' || main.has(x.url) || seen.has(x.url)) continue;
    seen.add(x.url); items.push({name:x.name,url:x.url,genre:x.genre || '',upstream:SOURCE,commit:input.commit});
  }
  const raw = {v:1,source:SOURCE,license:LICENSE,commit:input.commit,generatedAt:input.generatedAt,items};
  if (!validIso(raw.generatedAt)) throw Error('生成时间无效');
  raw.items = Sidecar.normalize(raw); if (!raw.items.length) throw Error('无合格候选，不发布空快照');
  return raw;
}
function readSnapshot(dir, generation) {
  try {
    if (!/^[a-f0-9]{64}$/.test(generation)) return null;
    const base = path.join(dir, generation), manifest = JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
    const data = fs.readFileSync(path.join(base,'radio-discovery.json'));
    if (manifest.v !== 1 || manifest.sha256 !== generation || hash(data) !== generation || manifest.bytes !== data.length || data.length > 512*1024) return null;
    const raw = JSON.parse(data.toString('utf8'));
    if (!validIso(raw.generatedAt) || !Sidecar.normalize(raw).length) return null;
    return {manifest,raw};
  } catch (_) { return null; }
}
function load(dir) {
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(dir,'current.json'),'utf8'));
    return readSnapshot(dir,pointer.current) || readSnapshot(dir,pointer.previous) || null;
  } catch (_) { return null; }
}
function publish(dir, raw) {
  if (publishBusy) throw Error('发布进行中');
  publishBusy = true;
  try {
  if (!Sidecar.normalize(raw).length) throw Error('sidecar 无效');
  const data = Buffer.from(JSON.stringify(raw)+'\n'); if (data.length > 512*1024) throw Error('sidecar 超限');
  const sha = hash(data), previous = load(dir); fs.mkdirSync(dir,{recursive:true});
  const base = path.join(dir,sha);
  // 先在同一目录内完成整代，再整体改名；hash 路径一旦出现便永不改写。
  // 单写者是调用方的跨进程约束，publishBusy 只防本进程重入。
  if (!fs.existsSync(base)) {
    const stage = fs.mkdtempSync(path.join(dir,'.publish-'));
    try {
      fs.writeFileSync(path.join(stage,'radio-discovery.json'), data, {flag:'wx'});
      fs.writeFileSync(path.join(stage,'manifest.json'), JSON.stringify({v:1,sha256:sha,bytes:data.length})+'\n', {flag:'wx'});
      fs.renameSync(stage,base);
    } finally { fs.rmSync(stage,{recursive:true,force:true}); }
  }
  // 历史半代无法证明从未被引用，因此绝不修补或替换。
  if (!readSnapshot(dir,sha)) throw Error('同名快照不完整或损坏');
  // 同代仅对客户端认可的指针 no-op；版本损坏时修复并尽可能保留有效旧代。
  let fallback = previous && previous.manifest.sha256 !== sha ? previous.manifest.sha256 : null;
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(dir,'current.json'),'utf8'));
    if (pointer && pointer.v === 1 && pointer.current === sha) return sha;
    if (!fallback && pointer && pointer.previous !== sha && readSnapshot(dir,pointer.previous)) fallback = pointer.previous;
  } catch (_) {}
  const tmp = path.join(dir,'current.'+process.pid+'.'+crypto.randomBytes(8).toString('hex')+'.tmp');
  try { fs.writeFileSync(tmp,JSON.stringify({v:1,current:sha,previous:fallback})+'\n'); fs.renameSync(tmp,path.join(dir,'current.json')); }
  finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  return sha;
  } finally { publishBusy = false; }
}
module.exports = {build,load,publish,readSnapshot};
