// VRadio 源同步引擎 —— 电台源是这个项目的重中之重，本文件负责：
//   1. 国内源：同步上游社区维护的 gaotianliuyun/gao radio.txt
//   2. 欧美音乐台：拉取 Radio Browser 数据镜像(AlonDrilich/radio-playlists) top-500，
//      过滤欧美国家后逐个实测可用性，只保留能持续吐数据的流（自动感知下线源）
//   3. 合并写入 radio.txt（旧文件备份为 radio.txt.bak），欧美音乐分类整体重建
// 用法：node update-sources.js  或 页面上点「同步源」(POST /api/sync)
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const RADIO = path.join(ROOT, 'radio.txt');
const CN_REPO = 'gaotianliuyun/gao';                 // 国内直播源上游
const EU_REPO = 'AlonDrilich/radio-playlists';       // Radio Browser 镜像
const EU_FILE = 'top/top-500.m3u';                   // 全球票数前500 = 最稳定
const EU_COUNTRIES = { 'United States': '美国', 'United Kingdom': '英国', 'Ireland': '爱尔兰', 'Canada': '加拿大', 'Australia': '澳大利亚', 'New Zealand': '新西兰', 'Germany': '德国', 'France': '法国', 'Netherlands': '荷兰', 'Belgium': '比利时', 'Switzerland': '瑞士', 'Austria': '奥地利', 'Italy': '意大利', 'Spain': '西班牙', 'Portugal': '葡萄牙', 'Sweden': '瑞典', 'Norway': '挪威', 'Denmark': '丹麦', 'Finland': '芬兰', 'Poland': '波兰' };
const EU_CAT = '欧美音乐';

/* ---------- 基础网络 ---------- */
function request(url, { timeout = 10000, headers = {}, text = false, maxBytes = 1 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout, headers: { 'User-Agent': 'vradio/0.1 (+local radio player)', ...headers } }, res => {
      if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location) {
        res.resume(); return request(new URL(res.headers.location, url).href, { timeout, headers, text, maxBytes }).then(resolve, reject);
      }
      const chunks = []; let n = 0, settled = false;
      const finish = () => { if (settled) return; settled = true; resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', bytes: n, body: Buffer.concat(chunks) }); };
      res.on('data', c => { n += c.length; if (n <= maxBytes) chunks.push(c); if (n >= maxBytes) { req.destroy(); finish(); } }); // 直播流攒够即返回
      res.on('end', finish);
      res.on('error', () => { settled || (settled = true, reject(new Error('stream error'))); });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + url.slice(0, 60))); });
    req.on('error', reject);
  });
}

// 流可用性探测：4.5s 内读满 maxBytes 视为活流（m3u8 会先取清单再测分片）
async function checkStream(url) {
  const isHls = /\.m3u8(\?|$)/.test(url);
  if (!isHls) {
    try {
      const r = await request(url, { timeout: 4500, maxBytes: 24000 });
      const ok = r.bytes >= 8000 && /audio|octet|mpegurl/i.test(r.ct) || r.bytes >= 16000;
      return { ok, detail: `${r.ct || '未知类型'} ${r.bytes}B` };
    } catch (e) { return { ok: false, detail: String(e.message || e).slice(0, 40) }; }
  }
  try {
    const pl = await request(url, { timeout: 4500, maxBytes: 8000 });
    if (pl.status !== 200) return { ok: false, detail: `清单 HTTP ${pl.status}` };
    const seg = pl.body.toString('utf8').split(/\r?\n/).find(l => l && !l.startsWith('#'));
    if (!seg) return { ok: false, detail: '清单无分片' };
    const r2 = await request(new URL(seg, url).href, { timeout: 4500, maxBytes: 16000 });
    return { ok: r2.bytes >= 6000, detail: `hls分片 ${r2.bytes}B` };
  } catch (e) { return { ok: false, detail: String(e.message || e).slice(0, 40) }; }
}

// 取 GitHub 文件内容（api.github.com 直连，失败回退 gh CLI）
async function ghFile(repo, file) {
  try {
    const r = await request(`https://api.github.com/repos/${repo}/contents/${file}`, {
      timeout: 15000, headers: { Accept: 'application/vnd.github.raw' }, maxBytes: 4 << 20
    });
    if (r.status === 200 && r.body.length > 100) return r.body.toString('utf8');
  } catch (_) { /* 落到 gh 回退 */ }
  const b64 = execFileSync('gh', ['api', `repos/${repo}/contents/${file}`, '--jq', '.content'], { encoding: 'utf8', timeout: 30000 });
  return Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
}

/* ---------- 解析与构建 ---------- */
function parseM3u(text) {
  const out = [], lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXTINF:.*group-title="([^"]*)"[^,]*,(.+)$/);
    if (m && lines[i + 1] && /^https?:/.test(lines[i + 1].trim()))
      out.push({ country: m[1].trim(), name: m[2].trim(), url: lines[i + 1].trim() });
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const q = items.slice(); let done = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (q.length) { const it = q.shift(); await fn(it, ++done); }
  }));
}

async function buildEuLines(log) {
  const all = parseM3u(await ghFile(EU_REPO, EU_FILE));
  const cand = [];
  const seenUrl = new Set();
  for (const s of all) {
    if (!EU_COUNTRIES[s.country] || seenUrl.has(s.url)) continue;
    seenUrl.add(s.url); cand.push(s);
  }
  log(`欧美候选 ${cand.length} 个，开始实测（约40s）…`);
  await mapLimit(cand, 18, async s => { const r = await checkStream(s.url); s.ok = r.ok; });
  const ok = cand.filter(s => s.ok);
  // 按国家分组排序，名字挂中文国名
  const byC = {}; ok.forEach(s => (byC[s.country] = byC[s.country] || []).push(s));
  const lines = [`${EU_CAT},#genre#`];
  Object.keys(byC).sort((a, b) => byC[b].length - byC[a].length).forEach(c => {
    byC[c].sort((a, b) => a.name.localeCompare(b.name)).forEach(s => lines.push(`${s.name.replace(/,/g, ' ')} [${EU_COUNTRIES[s.country]}],${s.url}`));
  });
  log(`欧美实测通过 ${ok.length}/${cand.length}`);
  return { lines, kept: ok.length, total: cand.length };
}

function splitSections(text) {
  const sections = []; let cur = { cat: '未分类', lines: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.endsWith('#genre#')) {
      if (cur.lines.length) sections.push(cur);
      cur = { cat: line.replace(/,#genre#$/, ''), lines: [] };
    } else if (line) cur.lines.push(line);
  }
  if (cur.lines.length) sections.push(cur);
  return sections;
}

/* ---------- 主流程 ---------- */
async function syncSources(log = () => {}) {
  const summary = {};
  // 1) 欧美音乐（实测重建）
  let euLines = null;
  try {
    euLines = await buildEuLines(log);
    summary.euKept = euLines.kept; summary.euTotal = euLines.total;
  } catch (e) { log('欧美源获取失败：' + (e.message || e)); }

  // 2) 国内源
  let cnText = null;
  try { cnText = await ghFile(CN_REPO, 'radio.txt'); summary.cn = '已更新'; }
  catch (e) { log('国内源上游获取失败，保留本地：' + (e.message || e)); summary.cn = '保留本地'; }

  // 3) 合并：国内 sections（去掉旧欧美音乐）+ 新欧美音乐
  const base = splitSections(cnText || (fs.existsSync(RADIO) ? fs.readFileSync(RADIO, 'utf8') : ''));
  const kept = base.filter(sec => sec.cat !== EU_CAT);
  const before = base.reduce((n, s) => n + s.lines.length, 0);
  const merged = [];
  for (const sec of kept) { merged.push(`${sec.cat},#genre#`, ...sec.lines); }
  if (euLines) merged.push(...euLines.lines);
  const after = merged.filter(l => !l.endsWith('#genre#')).length;

  if (fs.existsSync(RADIO)) fs.copyFileSync(RADIO, RADIO + '.bak');
  fs.writeFileSync(RADIO, merged.join('\r\n') + '\r\n', 'utf8');
  summary.total = after; summary.delta = after - before;
  log(`完成：共 ${after} 台（${summary.delta >= 0 ? '+' : ''}${summary.delta}）`);
  return summary;
}

/* ---------- 入口 ---------- */
if (require.main === module) {
  syncSources(m => console.log('[vradio]', m)).then(s => { console.log(JSON.stringify(s, null, 2)); })
    .catch(e => { console.error('同步失败:', e); process.exit(1); });
}
module.exports = { syncSources, checkStream };
