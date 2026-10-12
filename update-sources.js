// VRadio 源同步引擎 —— 电台源是这个项目的重中之重，本文件负责：
//   1. 国内源：同步上游社区维护的 gaotianliuyun/gao radio.txt（内容可疑时保留本地）
//   2. 欧美音乐台：拉取 Radio Browser 数据镜像(AlonDrilich/radio-playlists) top-500，
//      过滤欧美国家后逐个实测可用性，只保留能持续吐数据的流（自动感知下线源）
//   3. 合并写入 radio.txt（temp+rename 原子替换，旧文件备份为 radio.txt.bak）；
//      欧美获取失败时保留旧分类；合并结果低于下限时中止写盘
// 用法：node update-sources.js  或 页面上点「同步源」(POST /api/sync)
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const RADIO = path.join(ROOT, 'radio.txt');
const CN_REPO = 'gaotianliuyun/gao';                 // 国内直播源上游
const EU_REPO = 'AlonDrilich/radio-playlists';       // Radio Browser 镜像
const EU_FILE = 'top/top-500.m3u';                   // 全球票数前500 = 最稳定
const EU_COUNTRIES = { 'United States': '美国', 'United Kingdom': '英国', 'Ireland': '爱尔兰', 'Canada': '加拿大', 'Australia': '澳大利亚', 'New Zealand': '新西兰', 'Germany': '德国', 'France': '法国', 'Netherlands': '荷兰', 'Belgium': '比利时', 'Switzerland': '瑞士', 'Austria': '奥地利', 'Italy': '意大利', 'Spain': '西班牙', 'Portugal': '葡萄牙', 'Sweden': '瑞典', 'Norway': '挪威', 'Denmark': '丹麦', 'Finland': '芬兰', 'Poland': '波兰' };
const EU_CAT = '欧美音乐';
const MIN_TOTAL = 800;      // 合并结果条目数下限，低于视为异常中止写盘
const MIN_CN_ENTRIES = 500; // 国内上游内容条目数下限，低于视为上游异常

/* ---------- 基础网络 ---------- */
function request(url, { timeout = 10000, headers = {}, maxBytes = 1 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout, headers: { 'User-Agent': 'vradio/0.1 (+local radio player)', ...headers } }, res => {
      if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location) {
        res.resume(); return request(new URL(res.headers.location, url).href, { timeout, headers, maxBytes }).then(resolve, reject);
      }
      const chunks = []; let n = 0, settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(deadline); resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', bytes: n, body: Buffer.concat(chunks) }); };
      res.on('data', c => { n += c.length; if (n <= maxBytes) chunks.push(c); if (n >= maxBytes) { req.destroy(); finish(); } }); // 直播流攒够即返回
      res.on('end', finish);
      res.on('error', () => { if (!settled) { settled = true; clearTimeout(deadline); reject(new Error('stream error')); } });
    });
    // 绝对截止：socket timeout 只覆盖静默期，慢速活流必须靠硬上限兜底（否则同步会悬挂）
    const deadline = setTimeout(() => { req.destroy(); reject(new Error('deadline ' + url.slice(0, 50))); }, timeout + 1500);
    req.on('timeout', () => { clearTimeout(deadline); req.destroy(); reject(new Error('timeout ' + url.slice(0, 50))); });
    req.on('error', e => { clearTimeout(deadline); reject(e); });
  });
}

// 流可用性探测：按「持续吐数据 + 非HTML」判定活流（m3u8 先取清单再测分片，master playlist 递归解一层）
async function checkStream(url, depth = 0) {
  const isHls = /\.m3u8?(\?|$)/.test(url);
  if (!isHls) {
    try {
      const r = await request(url, { timeout: 4500, maxBytes: 24000 });
      const ok = r.bytes >= 8000 && !/text\/html/i.test(r.ct); // 显式判定；HTML 错误页不算活流
      return { ok, detail: `${r.ct || '未知类型'} ${r.bytes}B` };
    } catch (e) { return { ok: false, detail: String(e.message || e).slice(0, 40) }; }
  }
  try {
    const pl = await request(url, { timeout: 4500, maxBytes: 8000 });
    if (pl.status !== 200) return { ok: false, detail: `清单 HTTP ${pl.status}` };
    const seg = pl.body.toString('utf8').split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (!seg) return { ok: false, detail: '清单无分片' };
    const segUrl = new URL(seg, url).href;
    if (/\.m3u8?(\?|$)/.test(segUrl) && depth < 2) return checkStream(segUrl, depth + 1); // master → variant 再解一层
    const r2 = await request(segUrl, { timeout: 4500, maxBytes: 16000 });
    return { ok: r2.bytes >= 6000 && !/text\/html/i.test(r2.ct), detail: `hls分片 ${r2.bytes}B` };
  } catch (e) { return { ok: false, detail: String(e.message || e).slice(0, 40) }; }
}

// 取 GitHub 文件内容（api.github.com 直连，失败异步回退 gh CLI，不阻塞事件循环）
function ghFile(repo, file) {
  return request(`https://api.github.com/repos/${repo}/contents/${file}`, {
    timeout: 15000, headers: { Accept: 'application/vnd.github.raw' }, maxBytes: 4 << 20
  }).then(r => {
    if (r.status === 200 && r.body.length > 100) return r.body.toString('utf8');
    throw new Error(`HTTP ${r.status}`);
  }).catch(() => new Promise((resolve, reject) =>
    execFile('gh', ['api', `repos/${repo}/contents/${file}`, '--jq', '.content'],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 10 << 20 },
      (e, stdout) => e ? reject(e) : resolve(Buffer.from(stdout.replace(/\s/g, ''), 'base64').toString('utf8')))
  ));
}

/* ---------- 解析与构建 ---------- */
function parseM3u(text, log) {
  const out = [], lines = text.split(/\r?\n/);
  let noGroup = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXTINF:.*group-title="([^"]*)"[^,]*,(.+)$/);
    if (m && lines[i + 1] && /^https?:/.test(lines[i + 1].trim()))
      out.push({ country: m[1].trim(), name: m[2].trim(), url: lines[i + 1].trim() });
    else if (/^#EXTINF:/.test(lines[i])) noGroup++;
  }
  if (noGroup) log(`跳过 ${noGroup} 条无 group-title/格式异常的条目`);
  return out;
}

async function mapLimit(items, limit, fn) {
  const q = items.slice();
  await Promise.all(Array.from({ length: limit }, async () => {
    while (q.length) await fn(q.shift());
  }));
}

async function buildEuLines(log) {
  const all = parseM3u(await ghFile(EU_REPO, EU_FILE), log);
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
const countEntries = lines => lines.filter(l => l && !l.endsWith('#genre#')).length;

/* ---------- 主流程 ---------- */
async function syncSources(log = () => {}) {
  const summary = {};

  // 1) 欧美音乐（实测重建；失败时保留旧分类不清空）
  let euLines = null;
  try {
    euLines = await buildEuLines(log);
    summary.euKept = euLines.kept; summary.euTotal = euLines.total;
  } catch (e) { log('欧美源获取失败，保留旧欧美音乐分类：' + (e.message || e)); summary.euKept = null; }

  // 2) 国内源（上游内容可疑时忽略）
  let cnText = null;
  try {
    const t = await ghFile(CN_REPO, 'radio.txt');
    if (countEntries(t.split(/\r?\n/)) < MIN_CN_ENTRIES) { log(`国内上游内容可疑（条目 < ${MIN_CN_ENTRIES}），保留本地`); summary.cn = '保留本地(上游可疑)'; }
    else { cnText = t; summary.cn = '已更新'; }
  } catch (e) { log('国内源上游获取失败，保留本地：' + (e.message || e)); summary.cn = '保留本地'; }

  // 3) 合并：国内 sections（欧美成功时替换旧欧美分类，失败时保留）+ 新欧美音乐
  const curText = fs.existsSync(RADIO) ? fs.readFileSync(RADIO, 'utf8') : '';
  const before = countEntries(curText.split(/\r?\n/));
  const base = splitSections(cnText || curText);
  const merged = [];
  for (const sec of base) {
    if (sec.cat === EU_CAT && euLines) continue; // 欧美成功重建时替换；失败时走下面保留
    merged.push(`${sec.cat},#genre#`, ...sec.lines);
  }
  if (euLines) merged.push(...euLines.lines);
  const after = countEntries(merged);

  // 4) 健全性检查 + 原子写盘（temp + rename，中途被杀不留半个文件）
  if (after < MIN_TOTAL) {
    log(`合并结果异常（仅 ${after} 台 < ${MIN_TOTAL} 下限），中止写盘，保留原文件`);
    summary.aborted = true; summary.total = before; summary.delta = 0;
    return summary;
  }
  if (fs.existsSync(RADIO)) fs.copyFileSync(RADIO, RADIO + '.bak');
  fs.writeFileSync(RADIO + '.tmp', merged.join('\r\n') + '\r\n', 'utf8');
  fs.renameSync(RADIO + '.tmp', RADIO);

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
