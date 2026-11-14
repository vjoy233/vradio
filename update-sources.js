// VRadio 源同步引擎 —— 电台源是这个项目的重中之重，本文件负责：
//   1. 国内源：同步上游社区维护的 gaotianliuyun/gao radio.txt（内容可疑时保留本地），
//      按台名关键词重分类（无视上游分类头）：华语音乐/新闻资讯/交通广播/文艺·生活/财经/综合·其他；
//      旧「世界」拆成 亚洲·港台 + 国际新闻·谈话，藏在国内外表里的英文国际台（BBC Radio 系/NPR/CGTN…）一并捞回
//   2. 欧美台：拉取 Radio Browser 数据镜像(AlonDrilich/radio-playlists) top-500，
//      过滤欧美国家后按类型榜(news/talk/sports/religious)拆成 欧美音乐 + 国际新闻·谈话，
//      逐个实测可用性，只保留能持续吐数据的流（自动感知下线源）
//   3. 合并写入 radio.txt（temp+rename 原子替换，旧文件备份为 radio.txt.bak），分类顺序 = CAT_ORDER；
//      欧美获取失败时保留旧分类；合并结果低于下限时中止写盘；
//      随行产出 radio-data.js（radio.txt 全文包成 window.RADIO_DATA 经典 script，file:// 降级直读全库，N1/r2 ③）
// 用法：node update-sources.js  或 页面上点「同步源」(POST /api/sync)
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const dns = require('dns');
const { execFile } = require('child_process');

const ROOT = __dirname;
const RADIO = path.join(ROOT, 'radio.txt');
const RADIODATA = path.join(ROOT, 'radio-data.js'); // radio.txt 的经典 script 包装（N1/r2 ③）：file:// 下 fetch 必被拦、script 加载不会（hls.min.js 先例）
const LOGOS = path.join(ROOT, 'logos.txt');
const LOGOS_HEADER = '# 由 npm run sync 自动生成：欧美系台标（欧美音乐/国际新闻·谈话，源：Radio Browser 镜像 m3u 的 tvg-logo，按流 URL 匹配）。手工编辑会被覆盖。';
const CN_REPO = 'gaotianliuyun/gao';                 // 国内直播源上游
const EU_REPO = 'AlonDrilich/radio-playlists';       // Radio Browser 镜像
const EU_FILE = 'top/top-500.m3u';                   // 全球票数前500 = 最稳定
const EU_GENRE_FILES = ['news', 'talk', 'sports', 'religious']; // 镜像 genres/ 类型榜：非音乐排除集
// 类型榜（每类封顶300、按票数）榜外漏网的非音乐品牌兜底：同台不同码率/不同条目 UUID 对不上时按台名再拦一道
const EU_TALK_NAMES = /^(LBC|CNN|NPR|Fox News|NBC News|BBC (World Service|News|Radio [45])|Infowars|News Radio|Talk Radio|Deutschlandfunk|WDR 5|France (Info|Inter|Culture)|Europe 1|RMC|Sud Radio|Cadena SER|esRadio|Radio Marca|TOK FM|NPO Radio [12]|ABC News|VOA |Al Jazeera|CNA|Channel News)\b/i;
const EU_COUNTRIES = { 'United States': '美国', 'United Kingdom': '英国', 'Ireland': '爱尔兰', 'Canada': '加拿大', 'Australia': '澳大利亚', 'New Zealand': '新西兰', 'Germany': '德国', 'France': '法国', 'Netherlands': '荷兰', 'Belgium': '比利时', 'Switzerland': '瑞士', 'Austria': '奥地利', 'Italy': '意大利', 'Spain': '西班牙', 'Portugal': '葡萄牙', 'Sweden': '瑞典', 'Norway': '挪威', 'Denmark': '丹麦', 'Finland': '芬兰', 'Poland': '波兰' };
const EU_CAT = '欧美音乐';
const INTL_CAT = '国际新闻·谈话';  // 欧美拉取排除出的非音乐台 + 国内外表里捞出的英文新闻台
const ASIA_CAT = '亚洲·港台';      // 旧「世界」的非新闻部分（新马港台日 + 海外华语台）
const MIN_TOTAL = 800;      // 合并结果条目数下限，低于视为异常中止写盘
const MIN_CN_ENTRIES = 500; // 国内上游内容条目数下限，低于视为上游异常

/* ---------- 国内重分类（类型优先，粗分 5 类）：无视上游分类头、纯按台名规则归类，对上游改版免疫。
   规则顺序 = 优先级（音乐最前，汽车音乐台按内容归音乐）；兜底 = 综合·其他（城市综合台/人民台本就是"啥都播"）。 ---------- */
// 国际台捞回（藏在国内外表里的英文台）与 BBC 音乐网捞回——除进 CN_RULES 外，
// 欧美系旧节的捞回扫描（classifyCn 幂等路径）也复用这两条，勿重复定义
const CN_RESCUE_INTL = /^(NPR|CNN|Al ?Jazeera|BBC (News|World Service|Radio 4|Radio 5)|LBC News|News Radio UK|NBC News|Fox News|VOA|CNBC|Bloomberg|Sky News)\b|^(DW|ABC News|CBS|NHK World|France 24)\b|^(CGTN|CRI NEWS)/i;
const CN_RESCUE_MUSIC = /^BBC Radio [1236]/;
const CN_RULES = [
  [INTL_CAT, CN_RESCUE_INTL],
  [EU_CAT, CN_RESCUE_MUSIC],
  ['华语音乐', /音乐|动感\d|动听|经典947|经典FM|摩登|金曲|旋律|音悦|摇滚|古典|国乐|天籁|华语经典|好声音|Hit FM|轻松调频|怀旧|Love Radio|MY FM|Asia FM|Hot FM/i],
  ['交通广播', /交通|汽车|车载|私家车|的士|高速|交警/],
  ['财经', /经济|财经|第一财经|股市|金融|商贸|Money FM/i],
  ['文艺·生活', /文艺|戏曲|曲艺|戏剧|京剧|豫剧|越剧|黄梅|评书|相声|小品|书场|小说|故事|评弹|大鼓|娱乐|有声|文摘|都市|生活|城市|旅游|美食|健康|女性|亲子|文化|青春|高校|休闲|体育|运动|球迷|少儿|儿童|教育|校园|成长|阅读|老年/],
  ['新闻资讯', /新闻|资讯|NewsRadio|世界华声|中国之声|中华之声|神州之声|华夏之声|香港之声|湾区之声|乡村之声|南海之声|环球资讯|中文环球/],
];
const CN_FALLBACK = '综合·其他';
// 旧「世界」拆分：新闻向 → 国际新闻·谈话，其余整体进亚洲·港台
const WORLD_NEWS = /CNA|938|NHK|News|Channel News|百家|知识|Money/i;
// radio.txt 分类装配顺序 = 界面分类条默认顺序（华语音乐/欧美音乐由 app.js 置顶）
const CAT_ORDER = ['华语音乐', EU_CAT, ASIA_CAT, INTL_CAT, '新闻资讯', '交通广播', '文艺·生活', '财经', CN_FALLBACK];
// 欧美系分类（本文件独占重建；国内重分类时遇到要跳过，防止旧文件行被误按国内规则分走）
const EU_SYSTEM_CATS = [EU_CAT, INTL_CAT];
// EU 重建行的行尾国名后缀（buildEuLines 的 `${名} [${国名}]` 模板）：区分欧美系旧节里的
// 「重建本体」（带后缀）与「国内捞回/世界拆分」行（无后缀）——降级路径的世界系新闻台回收靠它
const EU_TAG_RE = new RegExp(' \\[(' + Object.values(EU_COUNTRIES).join('|') + ')\\]$');

/* ---------- 网络安全护栏（server.js 与本文件共用，导出供 require） ---------- */
// 私网/环回/链路本地判定：IPv4 段 + IPv6（::1、fc00::/7、fe80::/10、IPv4-mapped、未指定地址）
function isPrivateIp(a) {
  const s = String(a);
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) return isPrivateIp(m[1]);
  if (s.includes(':')) {
    const v6 = s.toLowerCase();
    return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || /^(fe8|fe9|fea|feb)/.test(v6);
  }
  const o = s.split('.').map(Number);
  return o[0] === 0 || o[0] === 10 || o[0] === 127 || (o[0] === 169 && o[1] === 254)
    || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
    || (o[0] === 100 && o[1] >= 64 && o[1] <= 127); // 100.64.0.0/10 CGNAT：运营商大内网，0.0.0.0 场景同样不可触达
}
// 目标字符串校验：仅 http(s) 且 hostname 非内网字面量（WHATWG URL 会把十进制 IP 规范化为点分，变形已堵）
function safeTarget(raw) {
  let u; try { u = new URL(raw); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]' || h.endsWith('.local')) return null;
  if (h.startsWith('[') && h.endsWith(']') && isPrivateIp(h.slice(1, -1))) return null; // IPv6 字面量 fail-fast（audit A5）：[fc/fd/fe8~b::…] 字符串层直拒——连接级 guardLookup 本就兜底，这里省一次建连、让两层校验名实相符
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return null;
  return u.href;
}
// 重定向头安全解析（audit-r2 P2-1）：畸形 Location（未闭合 IPv6 括号/非法端口/含空格 host）会让
// new URL 抛 TypeError——响应回调里裸解析即进程级 uncaughtException，整服务当场死。统一经此口：解析失败 = null，
// 调用方按「重定向目标拒绝」处理（proxy 403 / 同步 reject / 旁路 deadAt）
function tryUrl(u, base) { try { return new URL(u, base).href; } catch (_) { return null; } }
// 连接级校验（TOCTOU 安全，P2-7 修法）：包成自定义 lookup 传给 http(s).get，
// 校验的就是实际用于建立连接的那次 DNS 解析；rebinding 换 IP 也逃不过
function guardLookup(host, opts, cb) {
  dns.lookup(host, opts, (err, ...rest) => {
    if (err) return cb(err);
    const bad = (opts && opts.all) ? rest[0].some(x => isPrivateIp(x.address)) : isPrivateIp(rest[0]);
    if (bad) return cb(new Error('目标解析到内网/环回地址: ' + host));
    cb(null, ...rest);
  });
}

/* ---------- 基础网络 ---------- */
// hook 仅测试用（test/diagnostic.js 的 testHook 顶替 safeTarget/guardLookup 判定，放行回环 fixture）；生产路径绝不传
function request(url, { timeout = 10000, headers = {}, maxBytes = 1 << 20, maxRedirect = 5 } = {}, depth = 0, hook) {
  return new Promise((resolve, reject) => {
    if (depth > maxRedirect) return reject(new Error('too many redirects ' + url.slice(0, 50))); // P3-7：重定向深度上限
    const safe = (hook && hook.safe) || safeTarget, lookup = (hook && hook.lookup) || guardLookup;
    const t0 = Date.now();
    if (!safe(url)) return reject(new Error('目标非公网 http(s): ' + url.slice(0, 50)));    // P2-6：目标逐次校验
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout, lookup, headers: { 'User-Agent': 'vradio/0.1 (+local radio player)', ...headers } }, res => {
      const lat = Date.now() - t0; // 首响应延迟（B1 结构化探活；重定向跨跳自起始累计）
      if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = safe(tryUrl(res.headers.location, url)); // 重定向逐跳复查（P2-6）；畸形头经 tryUrl 归 null 一并拒绝（audit-r2 P2-1）
        if (!next) return reject(new Error('重定向目标非公网'));
        return request(next, { timeout, headers, maxBytes, maxRedirect }, depth + 1, hook).then(resolve, reject);
      }
      const chunks = []; let n = 0, settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(deadline); resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', bytes: n, latencyMs: lat, body: Buffer.concat(chunks) }); };
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

/* 结构化探活（B1，契约 contracts/source-diagnostic.json）：ok 语义与旧 checkStream 完全一致，code 固定枚举是
   程序分支唯一依据——UI 不得根据 why 文案反推状态。所有分支（正常/失败/重定向/HLS 分片/字节阈值）都返回完整结构。
   判序（直流，字节法）：SHORT_BODY（低于 8000B，336B 假流类——与黄金样本同型，先于 HTML 判）→ HTML → OK；
   **直流不看状态码**（AGENTS 已知坑明文：流地址漂移年代不能信状态码/Content-Type，按持续吐数据 ≥ 阈值字节验收；
   非 2xx 的 httpStatus 照常上报供诊断展示，但不参与 ok 判定——与 Android CheckStream 双端冻结口径）。
   判序（HLS）：清单非 200 → HTTP → EMPTY_PLAYLIST → 分片拉不到/不吐字节（NO_SEGMENT，分片阶段字段）→ OK（分片 ≥6000B）。
   bytes = 最末观察阶段的窗内字节数（直流=本体、HLS=清单或分片；分片未建连时回落清单阶段）；latencyMs 无响应时为整次尝试耗时。
   opt.testHook = { safe, lookup } 仅测试用：顶替 safeTarget/guardLookup 判定（打回环 fixture），生产路径绝不传 */
async function checkDetail(url, depth = 0, opts = {}) {
  const T = opts.timeout || 4500; // 探活窗口：默认 4.5s；调用方可放宽（server.js /api/mystation 传 12s——蜻蜓系建流 5-10s 属正常，见 AGENTS.md 已知坑）
  const isHls = /\.m3u8?(\?|$)/i.test(url);
  const base = over => Object.assign({ url, ok: false, code: 'NETWORK', hls: isHls, mode: isHls ? 'hls' : 'direct',
    httpStatus: 0, contentType: '', bytes: 0, latencyMs: 0, why: '', checkedAt: Date.now() }, over);
  const t0 = Date.now();
  const fin = r => { if (!r.latencyMs) r.latencyMs = Date.now() - t0; r.checkedAt = Date.now(); return r; };
  const fail = (code, why, over) => fin(base(Object.assign({ code, why }, over)));
  const catchCode = m => m.includes('重定向目标非公网') || m.includes('too many redirects') ? 'REDIRECT_REJECTED'
    : m.includes('目标非公网 http(s)') ? 'INVALID_URL' : 'NETWORK'; // guardLookup 拒绝（内网解析）/超时/断连归 NETWORK（契约）
  const safe = (opts.testHook && opts.testHook.safe) || safeTarget;
  if (!safe(url)) return fin(base({ code: 'INVALID_URL', why: '地址不合法（仅公网 http(s)）' }));
  if (!isHls) {
    let r;
    try { r = await request(url, { timeout: T, maxBytes: 24000 }, 0, opts.testHook); }
    catch (e) { return fail(catchCode(String(e.message || e)), String(e.message || e).slice(0, 60)); }
    const f = { httpStatus: r.status, contentType: r.ct, bytes: r.bytes, latencyMs: r.latencyMs };
    if (r.bytes < 8000) return fail('SHORT_BODY', `窗内仅 ${r.bytes}B（低于阈值，假流常见）`, f);
    if (/text\/html/i.test(r.ct)) return fail('HTML', `HTML 错误页（${r.ct} ${r.bytes}B）`, f);
    return fin(base(Object.assign({ ok: true, code: 'OK', why: `${r.ct || '未知类型'} ${r.bytes}B` }, f)));
  }
  // HLS：先取清单再验分片（master playlist 递归解一层，参数透传；i：.M3U8 变形同判）
  let pl;
  try { pl = await request(url, { timeout: T, maxBytes: 8000 }, 0, opts.testHook); }
  catch (e) { return fail(catchCode(String(e.message || e)), String(e.message || e).slice(0, 60)); }
  const pf = { httpStatus: pl.status, contentType: pl.ct, bytes: pl.bytes, latencyMs: pl.latencyMs };
  if (pl.status !== 200) return fail('HTTP', `清单 HTTP ${pl.status}`, pf);
  const seg = pl.body.toString('utf8').split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'));
  if (!seg) return fail('EMPTY_PLAYLIST', 'm3u8 无分片条目', pf);
  let segUrl; // 分片地址解析失败（畸形相对/绝对 URL 会让 new URL 抛 TypeError）归 NO_SEGMENT，报清单侧观察值（双端冻结口径）
  try { segUrl = new URL(seg, url).href; } catch (_) { return fail('NO_SEGMENT', `分片地址不可解析（${seg.slice(0, 40)}）`, pf); }
  if (/\.m3u8?(\?|$)/i.test(segUrl) && depth < 2) { const sub = await checkDetail(segUrl, depth + 1, opts); sub.url = url; return sub; }
  let r2;
  try { r2 = await request(segUrl, { timeout: T, maxBytes: 16000 }, 0, opts.testHook); }
  catch (e) { return fail('NO_SEGMENT', `分片不可达（${String(e.message || e).slice(0, 40)}）`, pf); }
  const sf = { httpStatus: r2.status, contentType: r2.ct, bytes: r2.bytes, latencyMs: r2.latencyMs };
  if (r2.bytes >= 6000 && !/text\/html/i.test(r2.ct)) return fin(base(Object.assign({ ok: true, code: 'OK', why: `hls分片 ${r2.bytes}B` }, sf)));
  return fail('NO_SEGMENT', r2.bytes < 6000 ? `分片仅 ${r2.bytes}B（不吐字节）` : `分片返回 HTML（${r2.ct}）`, sf);
}

// 流可用性探测（旧签名消费口：server.js /api/check、/api/mystation、buildEuLines）：ok/detail 语义不变，内部走 checkDetail
async function checkStream(url, depth = 0, opts = {}) {
  const d = await checkDetail(url, depth, opts);
  return { ok: d.ok, detail: d.why };
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
  let noGroup = 0, uuid = '';
  for (let i = 0; i < lines.length; i++) {
    // 每条 EXTINF 前的 72FM 注释行带电台 UUID —— 类型榜关联的稳定键（比 URL 可靠：同台不同码率变体常见）
    const um = lines[i].match(/^# 72FM: https:\/\/72fm\.com\/station\/([0-9a-f-]{36})/);
    if (um) { uuid = um[1]; continue; }
    const m = lines[i].match(/^#EXTINF:.*group-title="([^"]*)"[^,]*,(.+)$/);
    if (m && lines[i + 1] && /^https?:/.test(lines[i + 1].trim())) {
      const lg = lines[i].match(/tvg-logo="([^"]*)"/); // 台标属性可缺省
      out.push({ country: m[1].trim(), name: m[2].trim(), url: lines[i + 1].trim(), logo: lg ? lg[1].trim() : '', uuid });
      uuid = ''; // 用掉即清，防止下一条误绑
    } else if (/^#EXTINF:/.test(lines[i])) noGroup++;
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
  // 非音乐排除集（news/talk/sports/religious 类型榜）：UUID 优先、台名小写兜底双键关联；
  // 单个类型榜拉取失败只记警告不中断（排除集不全 → 少拆几台，不致整体降级）
  const badUuid = new Set(), badName = new Set();
  await Promise.all(EU_GENRE_FILES.map(async g => {
    try {
      for (const s of parseM3u(await ghFile(EU_REPO, `genres/${g}.m3u`), () => {})) {
        if (s.uuid) badUuid.add(s.uuid);
        badName.add(s.name.trim().toLowerCase());
      }
    } catch (e) { log(`类型榜 ${g} 获取失败（国际新闻排除集不全）：` + (e.message || e)); }
  }));
  const cand = [];
  const seenUrl = new Set();
  for (const s of all) {
    if (!EU_COUNTRIES[s.country] || seenUrl.has(s.url)) continue;
    s.talk = badUuid.has(s.uuid) || badName.has(s.name.trim().toLowerCase()) || EU_TALK_NAMES.test(s.name.trim());
    seenUrl.add(s.url); cand.push(s);
  }
  const nTalk = cand.filter(s => s.talk).length;
  log(`欧美候选 ${cand.length} 个（非音乐 ${nTalk} 待拆出），开始实测（约40s）…`);
  await mapLimit(cand, 18, async s => { const r = await checkStream(s.url); s.ok = r.ok; });
  const ok = cand.filter(s => s.ok);
  // 按国家分组排序（组大在前、组内按名），名字挂中文国名；台标随行带走（logos.txt 用，按 URL 严格对应）
  const build = list => {
    const byC = {}; list.forEach(s => (byC[s.country] = byC[s.country] || []).push(s));
    const lines = [], logos = [];
    Object.keys(byC).sort((a, b) => byC[b].length - byC[a].length).forEach(c => {
      byC[c].sort((a, b) => a.name.localeCompare(b.name)).forEach(s => {
        const name = `${s.name.replace(/,/g, ' ')} [${EU_COUNTRIES[s.country]}]`;
        lines.push(`${name},${s.url}`);
        if (s.logo) logos.push(name + ',' + s.logo);
      });
    });
    return { lines, logos };
  };
  const music = build(ok.filter(s => !s.talk));
  const news = build(ok.filter(s => s.talk));
  log(`欧美实测通过 ${ok.length}/${cand.length}：音乐 ${music.lines.length} + 国际新闻·谈话 ${news.lines.length}，台标 ${music.logos.length + news.logos.length} 个`);
  return {
    lines: music.lines, logoLines: music.logos,        // 欧美音乐（logos 前缀由调用方补）
    news: { lines: news.lines, logoLines: news.logos }, // 国际新闻·谈话
    kept: ok.length, total: cand.length,
  };
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

/* ---------- 国内重分类：把上游 sections（或同步失败时的本地旧文件）整编进 CAT_ORDER 目标分类。
   幂等性（P1）：输入既可能是上游旧式节，也可能是上轮同步的自身产物（新式节名 ∈ CAT_ORDER）——
   ① 新式节整节原样保留（上游旧文件没有这些节名，主路径不受影响；否则降级同步时「亚洲·港台」等会被台名规则重新打散）；
   ② 欧美系两新式节例外：本体由欧美拉取独占重建（或降级保留），其行只做捞回扫描且只扫无国名后缀行
     （CN 失败 + EU 成功时，困在旧节里的 BBC/CGTN 捞回行与世界系新闻台由此回收；带后缀的重建本体生死
     全由欧美结果决定，与旧节本体重复由装配处按 URL 去重）；
   ③ 旧「世界」按 WORLD_NEWS 拆走新闻台。
   返回 { out: 分类→行[], euExtra: 欧美系两分类的捞回行（BBC 音乐网/英文新闻台/世界系新闻台，追加到欧美同步结果之后） } ---------- */
function classifyCn(sections) {
  const out = {}; CAT_ORDER.forEach(c => out[c] = []);
  const euExtra = { [EU_CAT]: [], [INTL_CAT]: [] };
  for (const sec of sections) {
    if (EU_SYSTEM_CATS.includes(sec.cat)) {
      for (const line of sec.lines) {
        const nm = line.split(',')[0];
        // 带国名后缀 = EU 重建本体：生死由本轮欧美拉取全权决定，捞回扫描一律跳过——
        // 实测淘汰的旧台（如 LBC News [英国]）不得借品牌正则复活，欧美重建语义不破（PR#8 review P2）
        if (EU_TAG_RE.test(nm)) continue;
        // 无后缀行 = 国内捞回/世界拆分产物，三条规则只在其中捞：
        if (CN_RESCUE_MUSIC.test(nm)) euExtra[EU_CAT].push(line);
        else if (CN_RESCUE_INTL.test(nm)) euExtra[INTL_CAT].push(line);
        // 当年按 WORLD_NEWS 从旧「世界」拆入的世界系新闻台（CNA 938/百家知識…）不匹配上面两条品牌正则，
        // CN 失败 + EU 成功时会随旧节丢弃——补测 WORLD_NEWS 捞回（PR#5 二轮 review 残留）
        else if (WORLD_NEWS.test(nm)) euExtra[INTL_CAT].push(line);
      }
      continue;
    }
    if (CAT_ORDER.includes(sec.cat)) { out[sec.cat].push(...sec.lines); continue; } // 上轮产物：原样保留
    for (const line of sec.lines) {
      if (sec.cat === '世界') { (WORLD_NEWS.test(line.split(',')[0]) ? euExtra[INTL_CAT] : out[ASIA_CAT]).push(line); continue; }
      let cat = CN_FALLBACK;
      for (const [c, re] of CN_RULES) if (re.test(line.split(',')[0])) { cat = c; break; }
      (euExtra[cat] || out[cat]).push(line); // euExtra 只有两个欧美系键，命中国际捞回规则时走它
    }
  }
  return { out, euExtra };
}
const countEntries = lines => lines.filter(l => l && !l.endsWith('#genre#')).length;

/* ---------- 台标独立生成（node update-sources.js --logos）：只取镜像 m3u 的 tvg-logo 按当前
   radio.txt 的欧美系两分类（欧美音乐/国际新闻·谈话）URL 匹配写 logos.txt，不做实测、不改 radio.txt
   —— 免费台标，随时可重跑 ---------- */
async function buildLogoFile() {
  if (!fs.existsSync(RADIO)) throw new Error('radio.txt 缺失：--logos 按其欧美台 URL 匹配，请先完整同步（npm run sync）'); // 缺失时宁可报错退出，不能把 logos.txt 清成只剩表头
  const all = parseM3u(await ghFile(EU_REPO, EU_FILE), () => {});
  const byUrl = new Map(all.filter(s => s.logo).map(s => [s.url, s.logo]));
  const secs = splitSections(fs.readFileSync(RADIO, 'utf8'));
  const out = [LOGOS_HEADER]; let n = 0;
  for (const cat of EU_SYSTEM_CATS) {
    const sec = secs.find(s => s.cat === cat);
    for (const l of (sec ? sec.lines : [])) {
      const i = l.lastIndexOf(','); if (i < 0) continue;
      const logo = byUrl.get(l.slice(i + 1).trim());
      if (logo) { out.push(`${cat}|${l.slice(0, i).trim()},${logo}`); n++; }
    }
  }
  return { text: out.join('\r\n') + '\r\n', count: n };
}
function writeLogos(text) { // temp + rename 原子替换
  fs.writeFileSync(LOGOS + '.tmp', text, 'utf8');
  fs.renameSync(LOGOS + '.tmp', LOGOS);
}

/* ---------- 主流程 ---------- */
async function syncSources(log = () => {}) {
  const summary = {};

  // 1) 欧美音乐（实测重建；失败时保留旧分类不清空）
  let euLines = null;
  try {
    euLines = await buildEuLines(log);
    summary.euKept = euLines.kept; summary.euTotal = euLines.total; summary.euNews = euLines.news.lines.length;
  } catch (e) { log('欧美源获取失败，保留旧欧美音乐分类：' + (e.message || e)); summary.euKept = null; }

  // 2) 国内源（上游内容可疑时忽略）
  let cnText = null;
  try {
    const t = await ghFile(CN_REPO, 'radio.txt');
    if (countEntries(t.split(/\r?\n/)) < MIN_CN_ENTRIES) { log(`国内上游内容可疑（条目 < ${MIN_CN_ENTRIES}），保留本地`); summary.cn = '保留本地(上游可疑)'; }
    else { cnText = t; summary.cn = '已更新'; }
  } catch (e) { log('国内源上游获取失败，保留本地：' + (e.message || e)); summary.cn = '保留本地'; }

  // 3) 合并：国内整体重分类进新体系；欧美成功 → 新结果 + 国内捞回行，失败 → 保留本地旧节（降级语义不变）
  const curText = fs.existsSync(RADIO) ? fs.readFileSync(RADIO, 'utf8') : '';
  const before = countEntries(curText.split(/\r?\n/));
  const oldSecs = splitSections(curText);
  const { out, euExtra } = classifyCn(splitSections(cnText || curText));
  const oldOf = cat => { const s = oldSecs.find(x => x.cat === cat); return s ? s.lines : []; };
  // 欧美系拼装按 URL 去重（P1-3）：降级路径里旧节捞回行与新鲜 euExtra 会重复；本体在前，
  // 捞回在后——同 URL 时保留本体（带中文国名后缀的规范行），顺带堵「同物异名双份」窗口
  const dedupUrl = arr => { const seen = new Set(); return arr.filter(l => { const i = l.lastIndexOf(','); const u = i >= 0 ? l.slice(i + 1).trim() : l; if (seen.has(u)) return false; seen.add(u); return true; }); };
  const euBody = dedupUrl([...(euLines ? euLines.lines : oldOf(EU_CAT)), ...euExtra[EU_CAT]]);
  const intlBody = dedupUrl([...(euLines ? euLines.news.lines : oldOf(INTL_CAT)), ...euExtra[INTL_CAT]]);
  const merged = [];
  for (const cat of CAT_ORDER) {
    const body = cat === EU_CAT ? euBody : cat === INTL_CAT ? intlBody : out[cat];
    if (body.length) merged.push(`${cat},#genre#`, ...body);
  }
  const after = countEntries(merged);

  // 4) 健全性检查 + 原子写盘（temp + rename，中途被杀不留半个文件）
  if (after < MIN_TOTAL) {
    log(`合并结果异常（仅 ${after} 台 < ${MIN_TOTAL} 下限），中止写盘，保留原文件`);
    summary.aborted = true; summary.total = before; summary.delta = 0;
    return summary;
  }
  if (fs.existsSync(RADIO)) fs.copyFileSync(RADIO, RADIO + '.bak');
  const outText = merged.join('\r\n') + '\r\n';
  fs.writeFileSync(RADIO + '.tmp', outText, 'utf8');
  fs.renameSync(RADIO + '.tmp', RADIO);
  // radio-data.js（N1/r2 ③）：JSON.stringify 产物即合法 JS 字符串字面量（ES2019 起 U+2028/2029 亦安全），
  // </script> 序列只威胁内联脚本、外链 .js 无此面；与 radio.txt 同为 git 跟踪的生成物（clone 即用）。失败不影响主流程
  try {
    const js = 'window.RADIO_DATA=' + JSON.stringify(outText) + ';\r\n';
    fs.writeFileSync(RADIODATA + '.tmp', js, 'utf8');
    fs.renameSync(RADIODATA + '.tmp', RADIODATA);
  } catch (e) { log('radio-data.js 写入失败（不影响电台列表）：' + (e.message || e)); }

  // 4.5) 同步 diff 摘要（N4/r2 ⑥）：按台名集合对比旧文件与新列表——分类变化不算（重分类是本项目常规操作），
  //      改名 = 消失+新增如实呈现；aborted 早退不产出（保留旧列表口径一致）。名单封顶 50 防爆——前端收藏
  //      点名同样只看得到这 50 个，超出部分的消失收藏台不进点名（已知缺口，AIbot P3-2）
  const entryNames = lines => new Set((Array.isArray(lines) ? lines : splitSections(lines).flatMap(s => s.lines))
    .filter(l => !l.endsWith('#genre#')).map(l => l.split(',')[0].trim()).filter(Boolean));
  const oldNames = entryNames(curText), neuNames = entryNames(merged);
  const removedNames = [...oldNames].filter(n => !neuNames.has(n));
  const addedNames = [...neuNames].filter(n => !oldNames.has(n));
  summary.added = addedNames.length; summary.removed = removedNames.length;
  if (addedNames.length) summary.addedNames = addedNames.slice(0, 50);
  if (removedNames.length) summary.removedNames = removedNames.slice(0, 50);
  // 体检测名单（D4/R4 拍板）：新增台里的国内台（欧美两节同步期已逐个实测，跳过）——供前端同步后增量体检。
  // 不封顶口径（解「不设上限 vs 封顶 50」自相矛盾，外部 review P0-3），极端 500 封顶防滥用；UI 摘要仍是上面的 50。
  // ⚠ merged 是行数组（节头 + 台行交替），不是文本——不能喂 splitSections（其期望 string，数组无 .split，
  // PR #12 上线后首次全量同步即在此抛 TypeError，owner 实测报告；数据已落盘只是摘要段 500）
  const addedSet = new Set(addedNames), cnAdded = [];
  let secCat = '';
  for (const l of merged) {
    if (l.endsWith('#genre#')) { secCat = l.slice(0, -',#genre#'.length); continue; }
    if (secCat === EU_CAT || secCat === INTL_CAT) continue;
    const nm = l.split(',')[0].trim();
    if (nm && addedSet.has(nm) && !cnAdded.includes(nm)) cnAdded.push(nm);
  }
  if (cnAdded.length) summary.addedCheck = cnAdded.slice(0, 500);
  // 消失台的 URL 集合（AIbot P3-1）：收藏点名按身份比对的第二通道——经维护面板本地改名的收藏台键名已换、
  // 按名比对会漏，URL 快照仍对得上（身份公理）。台名内无逗号（同步硬约束），首个逗号即分隔；只收名单封顶内的台
  const oldUrlOf = new Map();
  for (const l of splitSections(curText).flatMap(s => s.lines)) {
    const i = l.indexOf(','); if (i < 0) continue;
    const nm = l.slice(0, i).trim();
    if (!oldUrlOf.has(nm)) oldUrlOf.set(nm, []);
    oldUrlOf.get(nm).push(l.slice(i + 1).trim());
  }
  const removedUrls = [...new Set(removedNames.slice(0, 50).flatMap(n => oldUrlOf.get(n) || []))].slice(0, 150);
  if (removedUrls.length) summary.removedUrls = removedUrls;

  // 5) 台标（欧美成功重建时随行重写 logos.txt，双分类前缀；失败时保留旧文件不动）
  if (euLines) {
    try {
      const lg = [LOGOS_HEADER,
        ...euLines.logoLines.map(l => `${EU_CAT}|${l}`),
        ...euLines.news.logoLines.map(l => `${INTL_CAT}|${l}`)];
      writeLogos(lg.join('\r\n') + '\r\n');
      summary.logos = lg.length - 1; summary.logosNews = euLines.news.logoLines.length;
    } catch (e) { log('logos.txt 写入失败（不影响电台列表）：' + (e.message || e)); }
  }

  summary.total = after; summary.delta = after - before;
  log(`完成：共 ${after} 台（${summary.delta >= 0 ? '+' : ''}${summary.delta}${(addedNames.length || removedNames.length) ? `；新增 ${addedNames.length}、消失 ${removedNames.length}` : ''}）`);
  return summary;
}

/* ---------- 入口 ---------- */
if (require.main === module) {
  if (process.argv.includes('--logos')) { // 只重建台标数据：node update-sources.js --logos
    buildLogoFile().then(({ text, count }) => { writeLogos(text); console.log(`[vradio] logos.txt：${count} 个台标`); })
      .catch(e => { console.error('台标生成失败:', e); process.exit(1); });
  } else {
    syncSources(m => console.log('[vradio]', m)).then(s => { console.log(JSON.stringify(s, null, 2)); })
      .catch(e => { console.error('同步失败:', e); process.exit(1); });
  }
}
module.exports = { syncSources, checkStream, checkDetail, safeTarget, guardLookup, tryUrl, buildLogoFile, classifyCn, splitSections, countEntries }; // splitSections/countEntries 供 test/smoke.js 复用（R1）；tryUrl 供 server.js/测试复用（audit-r2 P2-1）；checkDetail 结构化探活（B1）
