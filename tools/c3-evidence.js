#!/usr/bin/env node
'use strict';
// 离线算术检查。输入全部不可信；不访问网络，不写任何文件。
const fs = require('fs');
const crypto = require('crypto');
const CODES = ['OK', 'NETWORK', 'HTML', 'HTTP', 'EMPTY_PLAYLIST', 'NO_SEGMENT', 'SHORT_BODY', 'REDIRECT_REJECTED', 'INVALID_URL', 'EXCEPTION'];
const SHA = /^[a-f0-9]{40}$/;
function text(x) { return typeof x === 'string' && !!x.trim(); }
function list(x) { return Array.isArray(x) ? x : []; }
function validUrl(s) {
  try { const u = new URL(s); return typeof s === 'string' && ['http:', 'https:'].includes(u.protocol) && !!u.hostname && !u.username && !u.password; } catch (_) { return false; }
}
function evaluate(e) {
  const errors = [], failures = [], metrics = {};
  const err = s => errors.push(s), gate = (ok, s) => { if (!ok) failures.push(s); };
  if (!e || typeof e !== 'object' || Array.isArray(e)) return {structure:'INVALID', arithmetic:'NOT_EVALUATED', decision:'NO_GO', errors:['证据必须是对象']};
  if (e.version !== 1 || typeof e.commit !== 'string' || !SHA.test(e.commit) || typeof e.scriptCommit !== 'string' || !SHA.test(e.scriptCommit)) err('version/commit/scriptCommit 无效');
  const candidates = list(e.candidates), mainUrls = list(e.mainUrls), categories = list(e.releaseCategories), rounds = list(e.rounds);
  const urls = new Set(), mains = new Set(), cats = new Set();
  candidates.forEach((c, i) => {
    if (!c || !validUrl(c.url) || !text(c.category) || urls.has(c.url)) err('候选无效或重复 #' + i);
    else urls.add(c.url);
  });
  if (!candidates.length) err('缺候选');
  mainUrls.forEach(u => { if (!validUrl(u) || mains.has(u)) err('主库 URL 无效或重复'); else mains.add(u); });
  if (!Array.isArray(e.mainUrls)) err('缺主库 URL 清单（空数组表示明确的空主库）');
  categories.forEach(c => { if (!text(c) || cats.has(c)) err('分类无效或重复'); else cats.add(c); });
  if (!categories.length) err('缺拟投放分类');
  if (rounds.length !== 2) err('必须恰好两轮');
  let resultSets = [], all = [], times = [];
  rounds.forEach((r, i) => {
    if (!r || !text(r.window) || r.commit !== e.commit || r.scriptCommit !== e.scriptCommit || !Array.isArray(r.results)) { err('轮次元数据无效 #' + i); return; }
    times.push(r.window); const seen = new Set(), rows = [];
    r.results.forEach(x => {
      if (!x || !urls.has(x.url) || seen.has(x.url) || !CODES.includes(x.code) || !Number.isFinite(x.latencyMs) || x.latencyMs < 0) { err('结果无效/重复/不属候选 #' + i); return; }
      seen.add(x.url); rows.push(x);
    });
    resultSets.push(rows); all = all.concat(rows);
  });
  if (times.length === 2 && times[0] === times[1]) err('两个时间窗口相同');
  if (errors.length) return {structure:'INVALID', arithmetic:'NOT_EVALUATED', decision:'NO_GO', errors, limitations:['自报和哈希不证明真实性；需要独立可信审查']};
  metrics.rounds = resultSets.map((rows, i) => {
    const ok = rows.filter(x => x.code === 'OK').length;
    const coverage = rows.length / candidates.length, survival = rows.length ? ok / rows.length : 0;
    gate(coverage >= .90, '第 ' + (i + 1) + ' 轮覆盖率 < 90%');
    gate(survival >= .65, '第 ' + (i + 1) + ' 轮存活率 < 65%');
    return {tested:rows.length, ok, coverage, survival};
  });
  const count = code => all.filter(x => x.code === code).length;
  const ok = count('OK'), tested = all.length, latencies = all.map(x => x.latencyMs).sort((a,b) => a-b);
  const p95 = latencies.length ? latencies[Math.ceil(latencies.length * .95) - 1] : null;
  const overlap = candidates.filter(c => mains.has(c.url)).length;
  const newOk = new Set(all.filter(x => x.code === 'OK' && !mains.has(x.url)).map(x => x.url)).size;
  const okFirst = new Set(resultSets[0].filter(x => x.code === 'OK').map(x => x.url));
  const bothOk = resultSets[1].filter(x => x.code === 'OK' && okFirst.has(x.url) && !mains.has(x.url)).length;
  metrics.merged = {tested, ok, survival:tested ? ok/tested : 0, shortBody:count('SHORT_BODY'), network:count('NETWORK'), exceptions:count('EXCEPTION'), p95, newOk, bothRoundsNewOk:bothOk, overlap, overlapRate:overlap/candidates.length};
  gate(tested > 0 && ok/tested >= .70, '合并存活率 < 70%'); gate(newOk >= 250, '真正新增 OK < 250');
  gate(overlap/candidates.length <= .10, '主库精确 URL 重叠率 > 10%'); gate(p95 !== null && p95 <= 6000, 'p95 > 6000ms 或无样本');
  gate(count('EXCEPTION') === 0, '存在程序异常'); gate(tested > 0 && count('SHORT_BODY')/tested <= .10, 'SHORT_BODY > 10%');
  metrics.categories = categories.map(category => {
    const members = new Set(candidates.filter(c => c.category === category).map(c => c.url));
    const rows = all.filter(x => members.has(x.url)), successes = rows.filter(x => x.code === 'OK').length;
    const survival = rows.length ? successes/rows.length : 0;
    gate(members.size >= 20, category + ': 候选 < 20'); gate(rows.length > 0 && survival >= .60, category + ': 存活率 < 60%');
    const roundCoverage = resultSets.map(set => { const n = set.filter(x => members.has(x.url)).length; return {tested:n, missing:members.size-n, coverage:members.size ? n/members.size : 0}; });
    return {category, candidates:members.size, tested:rows.length, ok:successes, survival, roundCoverage};
  });
  return {structure:'VALID', arithmetic:failures.length ? 'FAIL' : 'PASS', decision:'NO_GO', errors, failures, metrics,
    limitations:['输入均为自报；本工具没有可信身份、签名信任根、真实测量、真人试听、国内直连、许可或设备验证能力。', '算术 PASS 不是发布许可；缺独立可信审核仍为 NO_GO。']};
}
function main(args) {
  if (args.length !== 1 || !/\.json$/i.test(args[0])) { console.error('用法：node tools/c3-evidence.js <只读 JSON 文件>'); return 2; }
  try {
    const stat = fs.lstatSync(args[0]);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw Error('仅接受不超过 8 MiB 的普通文件（拒绝最终符号链接）');
    const bytes = fs.readFileSync(args[0]);
    const result = evaluate(JSON.parse(bytes.toString('utf8')));
    result.inputSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    console.log(JSON.stringify(result, null, 2));
    return result.structure === 'VALID' && result.arithmetic === 'PASS' ? 0 : 1;
  } catch (e) { console.error('无法读取或解析证据：' + e.message); return 2; }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { evaluate, main };
