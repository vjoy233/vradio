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
const dns = require('dns'), crypto = require('crypto'), net = require('net');
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
/* ---------- B2 同步质量管线常量（plan-expansion-r4 §6.3/§6.4/§13.3） ---------- */
const SYNC_ASSETS = ['radio.txt', 'radio-data.js', 'logos.txt', 'radio-meta.json']; // 同批发布资产（manifest 最后提交）
const META_TARGET = 1024 * 1024;   // radio-meta.json 体积目标（超只告警：先删 name/category 冗余）
const META_HARD = 2 * 1024 * 1024; // radio-meta.json 硬上限（超阻止发布）
const GATE_CN_VALID = 0.95;        // 质量门：国内格式有效行比例下限
const GATE_NAMELESS = 0.05;        // 质量门：无名/无分类项比例上限
const GATE_DROP = 0.8;             // 质量门：总台数下降超 20%（new < old×0.8）阻止
const GATE_EU_FLOOR = 0.6;         // 质量门：欧美层有效数低于上次 60% 保留旧层

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
  let s = String(a);
  if (net.isIP(s) === 6) {
    // Node 接受带 zone ID 的 IPv6，WHATWG URL 不接受；拒绝而非抛异常。
    if (s.includes('%')) return true;
    // WHATWG 规范化展开形式与 dotted mapped，统一识别整个 ::ffff:0:0/96。
    s = new URL('http://[' + s + ']/').hostname.slice(1, -1);
    const m = s.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/);
    if (m) {
      const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
      return isPrivateIp([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    }
    return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || /^(fe8|fe9|fea|feb)/.test(s);
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
  if (net.isIP(h) === 4 && isPrivateIp(h)) return null;
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
      const chunks = []; let n = 0, kept = 0, settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(deadline); resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', bytes: n, latencyMs: lat, body: Buffer.concat(chunks) }); };
      // 直播流攒够即返回；body 保留流头——跨上限的单块按剩余截断（不再整块丢弃），前缀完整供 checkDetail 的
      // 直流 HTML 内容嗅探用（单块 >maxBytes 的响应原先 body 为空，review P2 顺手堵住）
      res.on('data', c => {
        n += c.length;
        if (kept < maxBytes) { const room = maxBytes - kept; chunks.push(room >= c.length ? c : c.slice(0, room)); kept += Math.min(room, c.length); }
        if (n >= maxBytes) { req.destroy(); finish(); }
      });
      res.on('end', finish);
      res.on('error', () => { if (!settled) { settled = true; clearTimeout(deadline); reject(new Error('stream error')); } });
    });
    // 绝对截止：socket timeout 只覆盖静默期，慢速活流必须靠硬上限兜底（否则同步会悬挂）
    const deadline = setTimeout(() => { req.destroy(); reject(new Error('deadline ' + url.slice(0, 50))); }, timeout + 1500);
    req.on('timeout', () => { clearTimeout(deadline); req.destroy(); reject(new Error('timeout ' + url.slice(0, 50))); });
    req.on('error', e => { clearTimeout(deadline); reject(e); });
  });
}

/* HTML 错误页判定（review P2，与 Android CheckStream 双端同款）：CT 头 text/html **或** 正文前缀嗅探（BOM/空白后
   以 <!doctype html / <html 开头）二合一。判序冻结不动（SHORT_BODY→HTML→OK）：字节达标后仍执行内容判定——
   ≥8000B 的 HTML 错误页即使服务器谎报 Content-Type（octet-stream/空）也判 HTML 不判 OK（AGENTS 已知坑：不能信 CT）；
   音频/TS 流首字节是 ID3/0xFF/0x47 等帧头，前缀嗅探不会误伤 */
const htmlLike = (ct, body) => /text\/html/i.test(ct || '')
  || /^\s*(?:<!doctype\s+html|<html[\s>])/i.test((body || Buffer.alloc(0)).slice(0, 256).toString('utf8'));

/* 结构化探活（B1，契约 contracts/source-diagnostic.json）：ok 语义与旧 checkStream 完全一致，code 固定枚举是
   程序分支唯一依据——UI 不得根据 why 文案反推状态。所有分支（正常/失败/重定向/HLS 分片/字节阈值）都返回完整结构。
   判序（直流，字节法）：SHORT_BODY（低于 8000B，336B 假流类——与黄金样本同型，先于 HTML 判）→ HTML（htmlLike：
   CT 头或正文前缀）→ OK；
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
    if (htmlLike(r.ct, r.body)) return fail('HTML', `HTML 错误页（${r.ct || '内容判定'} ${r.bytes}B）`, f); // 字节达标后仍执行 HTML 判定（review P2）
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
  await mapLimit(cand, 18, async s => { const r = await checkDetail(s.url); s.ok = r.ok; s.verification = r; });
  const ok = cand.filter(s => s.ok);
  // 按国家分组排序（组大在前、组内按名），名字挂中文国名；台标随行带走（logos.txt 用，按 URL 严格对应）
  const build = list => {
    const byC = {}; list.forEach(s => (byC[s.country] = byC[s.country] || []).push(s));
    const lines = [], logos = [], meta = []; // meta：radio-meta.json 来源追踪（url→72FM UUID 关联键，B2）
    Object.keys(byC).sort((a, b) => byC[b].length - byC[a].length).forEach(c => {
      byC[c].sort((a, b) => a.name.localeCompare(b.name)).forEach(s => {
        const name = `${s.name.replace(/,/g, ' ')} [${EU_COUNTRIES[s.country]}]`;
        lines.push(`${name},${s.url}`);
        if (s.logo) logos.push(name + ',' + s.logo);
        meta.push({ name, url: s.url, uuid: s.uuid || '', verification: s.verification });
      });
    });
    return { lines, logos, meta };
  };
  const music = build(ok.filter(s => !s.talk));
  const news = build(ok.filter(s => s.talk));
  log(`欧美实测通过 ${ok.length}/${cand.length}：音乐 ${music.lines.length} + 国际新闻·谈话 ${news.lines.length}，台标 ${music.logos.length + news.logos.length} 个`);
  return {
    lines: music.lines, logoLines: music.logos,        // 欧美音乐（logos 前缀由调用方补）
    news: { lines: news.lines, logoLines: news.logos }, // 国际新闻·谈话
    meta: [...music.meta, ...news.meta],               // B2：来源追踪（upstream='eu'，upstreamId=UUID）
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

/* ---------- 同步候选管线（B2，plan-expansion-r4 §6.2；Android sync/Candidates.kt 镜像语义，双端一致） ---------- */
/* URL 保守归一化（**只用于比对，写入仍是原 URL**）：去空白、scheme/host 小写、删默认端口（:80/:443 含空端口形态）、
   path/query/尾斜杠原样保留（不补也不删）、不盲删 query；userinfo 保留；非 http(s)/无 host → null。 */
function normalizeCandidateUrl(raw) {
  const u = String(raw == null ? '' : raw).trim();
  const m = u.match(/^(https?):\/\/([^/?#]*)(.*)$/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  let authority = m[2];
  const rest = m[3];
  const at = authority.lastIndexOf('@');
  const userinfo = at >= 0 ? authority.slice(0, at) : '';
  if (at >= 0) authority = authority.slice(at + 1);
  let host = authority, port = '';
  if (!host.startsWith('[')) {          // IPv6 字面量整体保留（比对场景不拆端口）
    const c = host.lastIndexOf(':');
    if (c >= 0) { port = host.slice(c + 1); host = host.slice(0, c); }
  }
  if (!host) return null;
  host = host.toLowerCase();
  const def = (scheme === 'http' && (port === '80' || port === '')) || (scheme === 'https' && (port === '443' || port === ''));
  if (def) port = '';
  return `${scheme}://${userinfo ? userinfo + '@' : ''}${host}${port ? ':' + port : ''}${rest}`;
}
/* 上游文本 → 候选数组（SyncCandidate：stationName/category/url 是数据，upstream/upstreamId/logoUrl 是来源
   追踪，sourceLine=「名,URL」行，normalizedUrl/duplicateKey 供去重，validationResult 预留 null=未实测）。
   行协议与 Android fromLine 一致：恰两字段（3+ 容错跳过）、台名非空、URL 须 http(s)；opt.stats 累计质量门口径。 */
function parseUpstream(text, opt = {}) {
  const stats = opt.stats || (opt.stats = { total: 0, valid: 0, nameless: 0, noCat: 0 });
  const out = [];
  let cat = ''; // 节头之前 = 分类缺失（noCat 口径；下游 classifyCn 按台名重分类兜底，不会写出空分类节）
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.endsWith('#genre#')) { cat = line.replace(/,#genre#$/, '').trim(); continue; }
    if (line.startsWith('#')) continue;
    stats.total++;
    const f = line.split(',');
    if (f.length !== 2) continue;
    const name = f[0].trim(), url = f[1].trim();
    if (!name) { stats.nameless++; continue; }
    if (!/^https?:\/\//i.test(url)) continue;
    stats.valid++;
    if (!cat) stats.noCat++;
    out.push({ stationName: name, category: cat, url, upstream: opt.upstream || '', upstreamId: opt.upstreamId || '',
      logoUrl: opt.logoUrl || '', sourceLine: name + ',' + url, normalizedUrl: normalizeCandidateUrl(url) || '',
      duplicateKey: cat + '|' + name, validationResult: null });
  }
  return out;
}
/* 三层去重（顺序固定）：① 精确 URL（首现保留）→ ② 归一化 URL（首现保留）→ ③ 同分类同名多源合并 =
   共享 duplicateKey「分类|台名」（全部保留，下游按同名行并源）；不同分类同名键不同不强并。
   胜者的来源字段（upstream/upstreamId/logoUrl）原样保留。 */
function dedupeCandidates(cands) {
  const seenExact = new Set(), seenNorm = new Set(), out = [];
  for (const c of cands) {
    if (seenExact.has(c.url)) continue;
    seenExact.add(c.url);
    if (c.normalizedUrl && seenNorm.has(c.normalizedUrl)) continue;
    seenNorm.add(c.normalizedUrl);
    if (!c.duplicateKey) c.duplicateKey = c.category + '|' + c.stationName;
    out.push(c);
  }
  return out;
}
/* 多上游原料 → 去重候选 + 统计（rawInputs = [{text, upstream, upstreamId?, logoUrl?}]） */
function buildCandidates(rawInputs, ctx) {
  const stats = { total: 0, valid: 0, nameless: 0, noCat: 0 };
  let parsed = [];
  for (const ri of rawInputs || []) parsed = parsed.concat(parseUpstream(ri.text, { upstream: ri.upstream, upstreamId: ri.upstreamId, logoUrl: ri.logoUrl, stats }));
  const cands = dedupeCandidates(parsed);
  stats.deduped = parsed.length - cands.length;
  return { candidates: cands, stats };
}

/* ---------- radio-meta.json 来源追踪旁车（§6.3，Android RadioMeta.kt 消费端；Web 生成） ---------- */
function readMetaFile(p) {
  try { const m = JSON.parse(fs.readFileSync(p, 'utf8')); return m && m.v === 1 && typeof m.stations === 'object' ? m : null; } catch (_) { return null; }
}
/* merged（行数组）→ meta。台分组 = 同节同名（首行源 = 身份键，与 app.parse 的 u[0] 口径一致）；
   firstSeenAt 按源 URL 继承上一份（新增才写当前时间）；来源优先级 国内候选 > 欧美实测 > 上一份 > upstreamDefault */
function buildRadioMeta(merged, prevMeta, cnCands, euLines, now, upstreamDefault = '') {
  const cnMap = new Map((cnCands || []).map(c => [c.url, c]));
  const euMap = new Map(((euLines && euLines.meta) || []).map(x => [x.url, x]));
  const prevUrl = new Map();
  for (const st of Object.values((prevMeta && prevMeta.stations) || {}))
    for (const s of (st.sources || [])) if (!prevUrl.has(s.url)) prevUrl.set(s.url, s);
  const groups = new Map();
  let cat = '';
  for (const l of merged) {
    if (l.endsWith('#genre#')) { cat = l.slice(0, -',#genre#'.length); continue; }
    const i = l.indexOf(','); if (i < 0) continue;
    const name = l.slice(0, i).trim(), url = l.slice(i + 1).trim();
    if (!name || !/^https?:\/\//.test(url)) continue;
    const k = cat + '|' + name;
    if (!groups.has(k)) groups.set(k, { name, category: cat, urls: [] });
    const g = groups.get(k);
    if (!g.urls.includes(url)) g.urls.push(url);
  }
  const stations = {};
  for (const g of groups.values())
    stations[g.urls[0]] = { name: g.name, category: g.category, sources: g.urls.map(url => {
      const c = cnMap.get(url), e = euMap.get(url), p = prevUrl.get(url);
      const evidence = e && e.verification;
      const verified = evidence && evidence.ok === true && evidence.url === url && Number.isFinite(evidence.checkedAt) && evidence.checkedAt > 0;
      const previousVerified = p && p.verification === 'sync' && Number.isFinite(p.lastVerifiedAt) && p.lastVerifiedAt > 0;
      const upstream = (c && c.upstream) || (e ? 'eu' : '') || (p && p.upstream) || upstreamDefault || 'unknown';
      // ID 与来源成对选取：只继承同一上游的旧 ID，不能混用另一个候选的 ID。
      const currentId = c && c.upstream ? c.upstreamId : e ? e.uuid : '';
      const upstreamId = currentId || (p && p.upstream === upstream && p.upstreamId) || '';
      return { url, upstream, upstreamId, kind: 'main',
        firstSeenAt: (p && p.firstSeenAt) || now, lastSeenAt: now,
        lastVerifiedAt: verified ? Math.max(evidence.checkedAt, previousVerified ? p.lastVerifiedAt : 0) : previousVerified ? p.lastVerifiedAt : 0,
        verification: verified || previousVerified ? 'sync' : 'unknown' };
    }) };
  return { v: 1, generatedAt: now, stations };
}

/* ---------- 发布协议（§13.3 逐字）：临时目录生成全资产 + SHA-256 → 备份上一批 → 替换根生成物 →
   manifest 最后提交。多文件 rename 在 Windows 非事务，靠 manifest 提交标记 + 启动校验回退兜底。
   回滚副本代际轮换（AIbot P1-3）：新副本先整写整验到 .tmp/sync-prev-new，再两步改名切换
   （旧 prev → sync-prev-old、new → prev）——任何时刻至少存在一代完整上一批（两步改名间的瞬时空窗由
   prev-old 兜底，bootManifest 回退顺序 prev → prev-old）；prev-old 保留到下一次轮换才被替换 ---------- */
const sha256Buf = buf => crypto.createHash('sha256').update(buf).digest('hex');
function publishSync(root, arts, opt = {}) {
  for (const name of SYNC_ASSETS) if (typeof arts[name] !== 'string') throw new Error('生成物不全：' + name); // 质量门最后一条：全成才替换
  const ts = opt.ts || Date.now(), tmpBase = path.join(root, '.tmp'), tmpDir = path.join(tmpBase, 'sync-' + ts);
  fs.mkdirSync(tmpDir, { recursive: true });
  const files = SYNC_ASSETS.map(name => {
    const buf = Buffer.from(arts[name], 'utf8');
    fs.writeFileSync(path.join(tmpDir, name), buf);
    return { path: name, bytes: buf.length, sha256: sha256Buf(buf) };
  });
  const manifest = { version: opt.version || String(ts), generatedAt: ts, files };
  if (opt.freshness) manifest.freshness = { refreshedAt: ts, provenance: 'pipeline-full' };
  fs.writeFileSync(path.join(tmpDir, 'sync-manifest.json'), JSON.stringify(manifest, null, 2));
  // 上一批回滚副本：先写临时代并整体验证（不碰现行 prev）。副本 manifest：root manifest 有效则原样携带
  //（描述的就是这批资产）；否则（首发布/存量仓库无 manifest）按副本资产现算一份，保证副本自描述可恢复
  const prevDir = path.join(tmpBase, 'sync-prev'), prevNew = path.join(tmpBase, 'sync-prev-new'), prevOld = path.join(tmpBase, 'sync-prev-old');
  try { fs.rmSync(prevNew, { recursive: true, force: true }); } catch (_) {} // 上次崩溃残留的半成品先清（现行 prev 不受影响）
  fs.mkdirSync(prevNew, { recursive: true });
  for (const name of SYNC_ASSETS)
    if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(prevNew, name));
  const rootM = readManifestOf(root), carryM = rootM && manifestCheckDir(root, rootM);
  const prevFiles = SYNC_ASSETS.filter(n => fs.existsSync(path.join(prevNew, n)))
    .map(n => { const buf = fs.readFileSync(path.join(prevNew, n)); return { path: n, bytes: buf.length, sha256: sha256Buf(buf) }; });
  fs.writeFileSync(path.join(prevNew, 'sync-manifest.json'),
    JSON.stringify(carryM ? rootM : { version: 'prev-' + ts, generatedAt: ts, files: prevFiles }, null, 2));
  const nm = readManifestOf(prevNew);
  if (SYNC_ASSETS.every(n => fs.existsSync(path.join(root, n))) && (!nm || !manifestCheckDir(prevNew, nm)))
    throw new Error('回滚副本写校验失败，中止发布（现行上一批副本未动）'); // 资产齐全的仓库副本必须可校验；过渡态（缺资产）尽力快照不强拦
  try { fs.rmSync(prevOld, { recursive: true, force: true }); } catch (_) {} // 清上次轮换的旧代（此刻起以 prev-new 为最新完整代）
  if (fs.existsSync(prevDir)) fs.renameSync(prevDir, prevOld); // Windows rename 目标须不存在：先旧→old，再 new→prev
  fs.renameSync(prevNew, prevDir);
  for (const name of SYNC_ASSETS) fs.renameSync(path.join(tmpDir, name), path.join(root, name)); // tmp 与根同卷，逐文件 rename
  fs.writeFileSync(path.join(root, 'sync-manifest.json.tmp'), JSON.stringify(manifest, null, 2));
  fs.renameSync(path.join(root, 'sync-manifest.json.tmp'), path.join(root, 'sync-manifest.json')); // manifest 最后提交
  for (const d of fs.readdirSync(tmpBase).filter(x => /^sync-\d/.test(x) && x !== path.basename(tmpDir)))
    try { fs.rmSync(path.join(tmpBase, d), { recursive: true, force: true }); } catch (_) {} // 清理过老临时目录（prev/prev-old 不匹配 /^sync-\d/，不受影响）
  return manifest;
}
function readManifestOf(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'sync-manifest.json'), 'utf8'));
    if (m && Array.isArray(m.files) && m.files.length === SYNC_ASSETS.length &&
      new Set(m.files.map(f => f && f.path)).size === SYNC_ASSETS.length &&
      m.files.every(f => f && SYNC_ASSETS.includes(f.path) && Number.isFinite(f.bytes) && typeof f.sha256 === 'string')) return m;
  } catch (_) {}
  return null;
}
function manifestCheckDir(dir, m) { // manifest 覆盖的四资产在 dir 下齐全且 bytes/sha256 全对
  try {
    for (const f of m.files) {
      const buf = fs.readFileSync(path.join(dir, f.path));
      if (buf.length !== f.bytes || sha256Buf(buf) !== f.sha256) return false;
    }
    return true;
  } catch (_) { return false; }
}
function freshnessFact(root) {
  const m = readManifestOf(root), f = m && m.freshness;
  if (!m || !manifestCheckDir(root, m) || !f || f.provenance !== 'pipeline-full' ||
      !Number.isSafeInteger(f.refreshedAt) || f.refreshedAt <= 0) return null;
  return { version: m.version, refreshedAt: f.refreshedAt, provenance: f.provenance };
}
function writeBootstrapManifest(root) { // 冷启动：四资产齐全可解析 → 按当前文件算哈希写 version:"bootstrap"
  const files = SYNC_ASSETS.map(name => { const buf = fs.readFileSync(path.join(root, name)); return { path: name, bytes: buf.length, sha256: sha256Buf(buf) }; });
  fs.writeFileSync(path.join(root, 'sync-manifest.json.tmp'), JSON.stringify({ version: 'bootstrap', generatedAt: Date.now(), files }, null, 2));
  fs.renameSync(path.join(root, 'sync-manifest.json.tmp'), path.join(root, 'sync-manifest.json'));
}
function assetsComplete(root) { // 四资产齐全且可解析（bootstrap 门槛；不静默混态）
  for (const f of SYNC_ASSETS) { try { if (!fs.statSync(path.join(root, f)).isFile() || fs.statSync(path.join(root, f)).size === 0) return false; } catch (_) { return false; } }
  try { if (!splitSections(fs.readFileSync(path.join(root, 'radio.txt'), 'utf8')).length) return false; } catch (_) { return false; }
  try { if (!fs.readFileSync(path.join(root, 'radio-data.js'), 'utf8').includes('window.RADIO_DATA')) return false; } catch (_) { return false; }
  try { const m = JSON.parse(fs.readFileSync(path.join(root, 'radio-meta.json'), 'utf8')); if (m.v !== 1 || typeof m.stations !== 'object') return false; } catch (_) { return false; }
  return true;
}
/* 启动校验（server.js 调用）：无 manifest 且四资产齐全 → bootstrap 继续；缺资产 → 不静默混态（ok:false 供前端 toast）；
   manifest 校验失败 → 恢复上一批完整生成物与 manifest（回退顺序 .tmp/sync-prev → .tmp/sync-prev-old——
   代际轮换两步改名间的瞬时空窗/恢复中途再次失败都有完整一代可兜底，AIbot P1-3） */
function bootManifest(root, log = () => {}) {
  const missing = SYNC_ASSETS.filter(f => !fs.existsSync(path.join(root, f)));
  const m = readManifestOf(root);
  if (!m) {
    if (!missing.length && assetsComplete(root)) { writeBootstrapManifest(root); log('无 sync-manifest.json：按当前资产写 bootstrap manifest'); return { ok: true, version: 'bootstrap' }; }
    return { ok: false, missing };
  }
  if (manifestCheckDir(root, m)) return { ok: true, version: m.version };
  log('sync-manifest.json 校验失败（缺文件/哈希不匹配），尝试恢复上一批生成物');
  for (const prevName of ['sync-prev', 'sync-prev-old']) {
    const prevDir = path.join(root, '.tmp', prevName);
    const pm = readManifestOf(prevDir);
    if (!(pm && manifestCheckDir(prevDir, pm))) continue;
    try {
      for (const f of pm.files) fs.copyFileSync(path.join(prevDir, f.path), path.join(root, f.path));
      fs.copyFileSync(path.join(prevDir, 'sync-manifest.json'), path.join(root, 'sync-manifest.json'));
      const m2 = readManifestOf(root);
      if (m2 && manifestCheckDir(root, m2)) { log(`已从 ${prevName} 恢复上一批完整生成物与 manifest`); return { ok: true, version: m2.version, restored: true }; }
    } catch (e) { log('恢复失败：' + (e.message || e)); }
  }
  return { ok: false, missing, corrupt: true };
}

/* ---------- 强制同步两步协议纯函数（§6.4；server.js 调用，端点级测试只测形态不真跑管线） ----------
   stash = {report, reportHash, inputs, tokens}（服务端内存单槽）；token 绑定报告 SHA-256 指纹、5 分钟、单次消费。 */
const reportHashOf = report => crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
function forceTokenIssue(stash, body, now, randHex) {
  if (!stash || !stash.reportHash) return { status: 404, error: '无可强制的同步报告（请先执行同步）' };
  if (!stash.report || !(stash.report.reasons || []).some(r => r.bypassable))
    return { status: 400, error: '无决策门可绕过（格式/安全类门槛不可强制）' };
  if (!body || typeof body !== 'object' || body.reportHash !== stash.reportHash)
    return { status: 400, error: '报告指纹不匹配（同步报告已更新，请重新查看）' };
  const token = randHex();
  stash.tokens = stash.tokens || {};
  stash.tokens[token] = { expiresAt: now + 5 * 60000, reportHash: stash.reportHash };
  return { status: 200, body: { ok: true, token, expiresAt: stash.tokens[token].expiresAt, reportHash: stash.reportHash } };
}
function forceTokenConsume(stash, token, now) { // 单次消费 + 绑定指纹复查（报告变化即 403）
  if (!stash || !stash.tokens || typeof token !== 'string' || !stash.tokens[token]) return { status: 403, error: '强制令牌无效' };
  const t = stash.tokens[token];
  delete stash.tokens[token];
  if (now > t.expiresAt) return { status: 403, error: '强制令牌已过期（5 分钟）' };
  if (!stash.reportHash || t.reportHash !== stash.reportHash) return { status: 403, error: '同步报告已变化，令牌失效' };
  return { status: 200 };
}

/* ---------- 主流程（B2 分阶段：runPipeline 只算不写；publishResult 落盘；决策门未 force 不落盘） ---------- */
async function runPipeline(log = () => {}, opt = {}) {
  const inject = opt.inputs || (opt.inputs = {});
  const root = opt.root || ROOT;
  const P = name => path.join(root, name);
  const report = { generatedAt: Date.now(), reasons: [], entry: opt.entry || null };
  const reason = (key, msg, bypassable, remedial) => report.reasons.push({ key, msg, bypassable: !!bypassable, remedial: !!remedial });
  const sum = {};
  const res = { report, reportHash: '', gated: false, hardAbort: false, arts: null, artInputs: null,
    euKeptDecision: false, oldTotal: 0, summary: sum, root };

  // 1) 欧美音乐（实测重建；失败时保留旧分类不清空——既有降级语义）。inputs.eu 注入 = 测试/强制复用（不重拉上游）
  let euLines = null;
  if ('eu' in inject) euLines = inject.eu;
  else { try { euLines = await buildEuLines(log); } catch (e) { log('欧美源获取失败，保留旧欧美音乐分类：' + (e.message || e)); euLines = null; } }
  if (euLines) { sum.euKept = euLines.kept; sum.euTotal = euLines.total; sum.euNews = euLines.news.lines.length; }
  else sum.euKept = null;

  // 2) 国内源（上游内容可疑时忽略——既有护栏）。inputs.cn 注入同上；null = 保留本地
  let cnText = null;
  if ('cn' in inject) { cnText = inject.cn; if (!sum.cn) sum.cn = cnText ? '已更新(注入)' : '保留本地(注入)'; }
  else {
    try {
      const t = await ghFile(CN_REPO, 'radio.txt');
      if (countEntries(t.split(/\r?\n/)) < MIN_CN_ENTRIES) { log(`国内上游内容可疑（条目 < ${MIN_CN_ENTRIES}），保留本地`); sum.cn = '保留本地(上游可疑)'; }
      else { cnText = t; sum.cn = '已更新'; }
    } catch (e) { log('国内源上游获取失败，保留本地：' + (e.message || e)); sum.cn = '保留本地'; }
  }
  res.artInputs = { cn: cnText, eu: euLines }; // stash 候选原料：强制发布复用，绝不重拉上游

  // 3) 国内节走候选管线（B2：恰两字段行协议 + 三层去重/跨节全局 URL 去重 + 来源追踪），
  //    classifyCn/CAT_ORDER/欧美重建既有分类装配逻辑不动——重组节喂入
  const curText = fs.existsSync(P('radio.txt')) ? fs.readFileSync(P('radio.txt'), 'utf8') : '';
  const before = countEntries(curText.split(/\r?\n/));
  res.oldTotal = before;
  const oldSecs = splitSections(curText);
  const { candidates: cands, stats } = buildCandidates([{ text: cnText || curText, upstream: 'gao' }]);
  sum.deduped = stats.deduped || 0;
  sum.invalid = Math.max(0, stats.total - stats.valid);
  const byCat = new Map();
  for (const c of cands) { if (!byCat.has(c.category)) byCat.set(c.category, []); byCat.get(c.category).push(c.sourceLine); }
  const { out, euExtra } = classifyCn([...byCat].map(([cat, lines]) => ({ cat, lines })));
  const oldOf = cat => { const s = oldSecs.find(x => x.cat === cat); return s ? s.lines : []; };
  // 欧美层塌陷门（决策门，可强制）：新欧美核心行数 < 上次 60% → 保留旧层（force = 用新层）
  const newEuCore = euLines ? euLines.lines.length + euLines.news.lines.length : 0;
  const oldEuCore = oldOf(EU_CAT).length + oldOf(INTL_CAT).length;
  let euSrc = euLines;
  if (euLines && oldEuCore > 0 && newEuCore < Math.ceil(oldEuCore * GATE_EU_FLOOR)) {
    if (opt.force) reason('eu-collapse', `欧美层 ${newEuCore} < 上次 ${oldEuCore} 的 60%：强制使用新欧美层`, true);
    else { euSrc = null; res.euKeptDecision = true; reason('eu-collapse', `欧美层有效数 ${newEuCore} 低于上次 ${oldEuCore} 的 60%，保留旧欧美层`, true, true); } // remedial：补救已套用（保留旧层），不参与整批拦截
  }
  // 欧美系拼装按 URL 去重（P1-3）：降级路径里旧节捞回行与新鲜 euExtra 会重复；本体在前，
  // 捞回在后——同 URL 时保留本体（带中文国名后缀的规范行），顺带堵「同物异名双份」窗口
  const dedupUrl = arr => { const seen = new Set(); return arr.filter(l => { const i = l.lastIndexOf(','); const u = i >= 0 ? l.slice(i + 1).trim() : l; if (seen.has(u)) return false; seen.add(u); return true; }); };
  const euBody = dedupUrl([...(euSrc ? euSrc.lines : oldOf(EU_CAT)), ...euExtra[EU_CAT]]);
  const intlBody = dedupUrl([...(euSrc ? euSrc.news.lines : oldOf(INTL_CAT)), ...euExtra[INTL_CAT]]);
  const merged = [];
  for (const cat of CAT_ORDER) {
    const body = cat === EU_CAT ? euBody : cat === INTL_CAT ? intlBody : out[cat];
    if (body.length) merged.push(`${cat},#genre#`, ...body);
  }
  const after = countEntries(merged);
  report.cn = { total: stats.total, valid: stats.valid, invalid: sum.invalid, nameless: stats.nameless, noCat: stats.noCat, deduped: sum.deduped, keptLocal: cnText == null }; // nameless/noCat 独立字段（AIbot P2-4 分别诊断）
  report.eu = { oldCore: oldEuCore, newCore: newEuCore, kept: !!res.euKeptDecision || !euLines };

  // 4) 替换前质量门（§6.4 六条）。格式/安全类（invalid-ratio/min-total/meta-too-large）不可强制；
  //    数量下降/分类缩水类决策门（total-drop/no-categories/nameless-ratio/nocat-ratio/eu-collapse）可强制绕过。
  //    无名/无分类拆两条独立口径（AIbot P2-4）：无名行不入 valid（计入 invalid 分母，§6.4「台名非空」定义），
  //    无分类行本身合法（valid++）只归 nocat-ratio——报告可分别诊断，不再合并一个键
  if (stats.total && stats.valid / stats.total < GATE_CN_VALID)
    reason('invalid-ratio', `国内格式有效行 ${(100 * stats.valid / stats.total).toFixed(1)}% 低于 95%`, false);
  if (stats.total && stats.nameless / stats.total > GATE_NAMELESS)
    reason('nameless-ratio', `无名项 ${stats.nameless} 行，占 ${(100 * stats.nameless / stats.total).toFixed(1)}% 超过 5%`, true);
  if (stats.total && stats.noCat / stats.total > GATE_NAMELESS)
    reason('nocat-ratio', `无分类项 ${stats.noCat} 行（节头之前的合法行），占 ${(100 * stats.noCat / stats.total).toFixed(1)}% 超过 5%`, true);
  if (!merged.some(l => l.endsWith('#genre#'))) reason('no-categories', '候选分类数为 0', true);
  if (before > 0 && after < Math.floor(before * GATE_DROP))
    reason('total-drop', `总台数 ${before} → ${after}（降超 20%）`, true);
  if (after < (opt.floor != null ? opt.floor : MIN_TOTAL)) { // opt.floor 仅测试注入（小 fixture 不触真实下限）
    const floor = opt.floor != null ? opt.floor : MIN_TOTAL;
    log(`合并结果异常（仅 ${after} 台 < ${floor} 下限），中止写盘，保留原文件`);
    reason('min-total', `合并结果 ${after} 台低于下限 ${floor}`, false);
    sum.aborted = true; sum.total = before; sum.delta = 0;
    res.hardAbort = true;
    return res;
  }
  if (report.reasons.some(r => !r.bypassable)) { // 格式/安全门槛命中：不可强制，保留旧库（字节不变）
    log('质量门拦截（不可强制），保留原数据：' + report.reasons.filter(r => !r.bypassable).map(r => r.msg).join('；'));
    sum.aborted = true; sum.total = before; sum.delta = 0;
    res.hardAbort = true;
    return res;
  }
  res.gated = report.reasons.some(r => r.bypassable && !r.remedial) && !opt.force; // 决策门：未 force → 不落盘（remedial 门已套用补救，不拦整批）

  // 5) 生成物装配（全成才替换）：radio.txt / radio-data.js / logos.txt（欧美层用新结果时重写，
  //    保留旧层/获取失败时沿用现文件——资产批次的当前态照常入 manifest）/ radio-meta.json
  const outText = merged.join('\r\n') + '\r\n';
  const arts = { 'radio.txt': outText, 'radio-data.js': 'window.RADIO_DATA=' + JSON.stringify(outText) + ';\r\n' };
  if (euSrc) {
    const lg = [LOGOS_HEADER,
      ...euSrc.logoLines.map(l => `${EU_CAT}|${l}`),
      ...euSrc.news.logoLines.map(l => `${INTL_CAT}|${l}`)];
    arts['logos.txt'] = lg.join('\r\n') + '\r\n';
    sum.logos = lg.length - 1; sum.logosNews = euSrc.news.logoLines.length;
  } else arts['logos.txt'] = fs.existsSync(P('logos.txt')) ? fs.readFileSync(P('logos.txt'), 'utf8') : LOGOS_HEADER + '\r\n';
  const meta = buildRadioMeta(merged, readMetaFile(P('radio-meta.json')), cnText ? cands : [], euLines, Date.now());
  let metaTxt = JSON.stringify(meta);
  report.metaOverTarget = Buffer.byteLength(metaTxt) > META_TARGET;
  if (report.metaOverTarget) { // 超目标：先删 name/category 冗余（可由 radio.txt 反解，不削弱来源追踪字段）
    const slim = JSON.parse(metaTxt);
    for (const st of Object.values(slim.stations)) { delete st.name; delete st.category; }
    metaTxt = JSON.stringify(slim);
  }
  const metaBytes = Buffer.byteLength(metaTxt);
  if (metaBytes > META_HARD) { // 超硬上限：阻止发布（不可强制）
    reason('meta-too-large', `radio-meta.json ${metaBytes}B 超硬上限 2MB`, false);
    log('radio-meta.json 超硬上限，中止写盘，保留原文件');
    sum.aborted = true; sum.total = before; sum.delta = 0;
    res.hardAbort = true;
    return res;
  }
  const sizes = Object.values(meta.stations).map(st => JSON.stringify(st).length);
  const nSrc = Object.values(meta.stations).reduce((n, st) => n + st.sources.length, 0);
  report.meta = { bytes: metaBytes, stations: Object.keys(meta.stations).length, sources: nSrc,
    avg: sizes.length ? Math.round(metaBytes / sizes.length) : 0, max: sizes.length ? Math.max(...sizes) : 0 };
  arts['radio-meta.json'] = metaTxt;
  res.arts = arts;

  // 6) 同步 diff 摘要（N4/r2 ⑥）：按台名集合对比旧文件与新列表——分类变化不算（重分类是本项目常规操作），
  //    改名 = 消失+新增如实呈现；名单封顶 50 防爆（前端收藏点名同样只看得到这 50 个，已知缺口，AIbot P3-2）
  const entryNames = lines => new Set((Array.isArray(lines) ? lines : splitSections(lines).flatMap(s => s.lines))
    .filter(l => !l.endsWith('#genre#')).map(l => l.split(',')[0].trim()).filter(Boolean));
  const oldNames = entryNames(curText), neuNames = entryNames(merged);
  const removedNames = [...oldNames].filter(n => !neuNames.has(n));
  const addedNames = [...neuNames].filter(n => !oldNames.has(n));
  sum.added = addedNames.length; sum.removed = removedNames.length;
  if (addedNames.length) sum.addedNames = addedNames.slice(0, 50);
  if (removedNames.length) sum.removedNames = removedNames.slice(0, 50);
  // 体检测名单（D4/R4 拍板）：新增台里的国内台（欧美两节同步期已逐个实测，跳过）——供前端同步后增量体检；
  // 极端 500 封顶防滥用。⚠ merged 是行数组（节头 + 台行交替），不能喂 splitSections（PR #12 实测教训）
  const addedSet = new Set(addedNames), cnAdded = [];
  let secCat = '';
  for (const l of merged) {
    if (l.endsWith('#genre#')) { secCat = l.slice(0, -',#genre#'.length); continue; }
    if (secCat === EU_CAT || secCat === INTL_CAT) continue;
    const nm = l.split(',')[0].trim();
    if (nm && addedSet.has(nm) && !cnAdded.includes(nm)) cnAdded.push(nm);
  }
  if (cnAdded.length) sum.addedCheck = cnAdded.slice(0, 500);
  // 消失台的 URL 集合（AIbot P3-1）：收藏点名按身份比对的第二通道（身份公理）；只收名单封顶内的台
  const oldUrlOf = new Map();
  for (const l of splitSections(curText).flatMap(s => s.lines)) {
    const i = l.indexOf(','); if (i < 0) continue;
    const nm = l.slice(0, i).trim();
    if (!oldUrlOf.has(nm)) oldUrlOf.set(nm, []);
    oldUrlOf.get(nm).push(l.slice(i + 1).trim());
  }
  const removedUrls = [...new Set(removedNames.slice(0, 50).flatMap(n => oldUrlOf.get(n) || []))].slice(0, 150);
  if (removedUrls.length) sum.removedUrls = removedUrls;

  sum.total = after; sum.delta = after - before;
  report.oldTotal = before; report.newTotal = after;
  res.reportHash = reportHashOf(report);
  log(`完成：共 ${after} 台（${sum.delta >= 0 ? '+' : ''}${sum.delta}${(addedNames.length || removedNames.length) ? `；新增 ${addedNames.length}、消失 ${removedNames.length}` : ''}${res.euKeptDecision ? '；欧美层保留旧数据' : ''}）`);
  return res;
}

/* 落盘发布（runPipeline 通过后）：发布协议事务 + 统一输出（§6.4：ok/total/added/removed/deduped/invalid/
   replacement/quality/addedCheck/removedNames/sourceMeta——既有消费方键名全兼容）+ 运行时报告（可丢失不入 manifest） */
function publishResult(root, res, opt = {}) {
  const manifest = publishSync(root, res.arts, { version: opt.version || 'sync-' + res.report.generatedAt,
    freshness: !!(res.report.cn && !res.report.cn.keptLocal && res.report.eu && !res.report.eu.kept) });
  const s = res.summary;
  s.ok = true;
  s.replacement = opt.forced ? 'forced' : (res.euKeptDecision ? 'kept' : 'accepted');
  if (s.replacement !== 'accepted') s.replacementReasons = res.report.reasons.filter(r => r.bypassable).map(r => r.key);
  if (opt.forced) { s.forcedReasons = s.replacementReasons; s.reportHash = res.reportHash; s.entry = opt.entry || 'cli'; }
  s.quality = { oldTotal: res.oldTotal, newTotal: s.total };
  s.sourceMeta = 'radio-meta.json';
  s.manifestVersion = manifest.version;
  try {
    const dir = path.join(root, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'last-sync-report.json.tmp'), JSON.stringify({ ...res.report, replacement: s.replacement, summary: s }, null, 2));
    fs.renameSync(path.join(dir, 'last-sync-report.json.tmp'), path.join(dir, 'last-sync-report.json'));
  } catch (_) {} // 运行时报告可丢失，不入 manifest
  return s;
}
function writeSyncReport(root, obj) { // --report 专用：只写运行时报告不发布
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'last-sync-report.json'), JSON.stringify(obj, null, 2));
  return path.join(dir, 'last-sync-report.json');
}

/* 既有入口（CLI 默认/兼容）：跑管线 → 门/中止处理 → 发布 */
async function syncSources(log = () => {}, opt = {}) {
  const res = await runPipeline(log, opt);
  if (res.hardAbort) return res.summary;
  if (res.gated) {
    log('同步被质量门拦截：' + res.report.reasons.map(r => r.msg).join('；'));
    log('确认要强制替换时用 node update-sources.js --force（交互确认后绕过决策门）');
    return { ok: false, gated: true, report: res.report, reportHash: res.reportHash };
  }
  return publishResult(opt.root || ROOT, res, { entry: opt.entry || 'cli', forced: !!opt.force });
}

/* ---------- 一次性资产补齐（--init-meta）：为既有 radio.txt 离线生成 radio-meta.json（无上游信息，
   upstream='local'），经同一发布协议原子入批（manifest 随行更新）——B1 存量仓库过渡到 B2 四资产态 ---------- */
function initMeta(root = ROOT, log = m => console.log('[vradio]', m)) {
  const P = n => path.join(root, n);
  const txt = fs.readFileSync(P('radio.txt'), 'utf8');
  const merged = splitSections(txt).flatMap(s => [s.cat + ',#genre#', ...s.lines]);
  const meta = buildRadioMeta(merged, readMetaFile(P('radio-meta.json')), [], null, Date.now(), 'local');
  const arts = { 'radio.txt': txt, 'radio-data.js': fs.readFileSync(P('radio-data.js'), 'utf8'),
    'logos.txt': fs.readFileSync(P('logos.txt'), 'utf8'), 'radio-meta.json': JSON.stringify(meta) };
  const m = publishSync(root, arts, { version: 'bootstrap' });
  log(`radio-meta.json 已生成（${Object.keys(meta.stations).length} 台），发布 manifest ${m.version}`);
  return m;
}

/* ---------- 入口（CLI）：--logos 只重建台标 / --init-meta 资产补齐 / --check-only 只出报告不写盘 /
   --report 写运行时报告不发布 / --force 交互确认强制（只绕决策门）/ 默认全量同步 ---------- */
if (require.main === module) {
  const argv = process.argv;
  const ask = q => new Promise(done => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q + '（y/N）', a => { rl.close(); done(/^(y|yes)$/i.test(a.trim())); });
  });
  if (argv.includes('--logos')) { // 只重建台标数据：node update-sources.js --logos
    buildLogoFile().then(({ text, count }) => { writeLogos(text); console.log(`[vradio] logos.txt：${count} 个台标`); })
      .catch(e => { console.error('台标生成失败:', e); process.exit(1); });
  } else if (argv.includes('--init-meta')) {
    try { initMeta(); } catch (e) { console.error('资产补齐失败:', e); process.exit(1); }
  } else if (argv.includes('--check-only')) { // 只生成候选质量报告，不覆盖正式数据——联网报告入口（AIbot P2-5）：
    // 会拉取 GitHub 上游并对欧美台逐个真实探活（与全量同步同一 runPipeline），非离线校验；
    // 离线纯函数/门路径测试走 test/sources.js 的 opt.inputs 注入，不经本入口
    console.log('[vradio] --check-only：联网报告入口（依赖 GitHub 上游 + 欧美台逐个真实探活，非离线校验；离线测试见 npm test 的 test/sources.js 注入路径）');
    runPipeline(m => console.log('[vradio]', m)).then(r => {
      console.log(JSON.stringify(r.report, null, 2));
      if (r.hardAbort || r.gated) process.exitCode = 1;
    }).catch(e => { console.error('同步失败:', e); process.exit(1); });
  } else if (argv.includes('--report')) { // 写 data/last-sync-report.json（可丢失运行时报告），不发布——同 --check-only 为联网入口
    console.log('[vradio] --report：联网报告入口（依赖 GitHub 上游 + 欧美台逐个真实探活，非离线校验）');
    runPipeline(m => console.log('[vradio]', m)).then(r => {
      const p = writeSyncReport(ROOT, r.report);
      console.log('[vradio] 报告已写入 ' + p);
      console.log(JSON.stringify(r.report, null, 2));
    }).catch(e => { console.error('同步失败:', e); process.exit(1); });
  } else if (argv.includes('--force')) { // 强制路径：stdin 交互确认 y/N；只绕决策门，不绕安全护栏/格式过滤/生成失败
    (async () => {
      const log = m => console.log('[vradio]', m);
      const r = await runPipeline(log);
      if (r.hardAbort) { console.error('质量门拦截（不可强制），已保留原数据'); process.exit(1); }
      if (!r.gated) { console.log(JSON.stringify(publishResult(ROOT, r, { entry: 'cli' }), null, 2)); return; }
      console.log('以下决策门将被绕过：');
      for (const x of r.report.reasons.filter(v => v.bypassable)) console.log('  - ' + x.msg);
      if (!await ask('确认强制同步替换？')) { console.log('已取消，未做任何改动'); return; }
      const r2 = await runPipeline(log, { inputs: r.artInputs, force: true, entry: 'cli' }); // 复用候选原料，不重拉上游
      console.log(JSON.stringify(publishResult(ROOT, r2, { entry: 'cli', forced: true }), null, 2));
    })().catch(e => { console.error('同步失败:', e); process.exit(1); });
  } else {
    syncSources(m => console.log('[vradio]', m)).then(s => { console.log(JSON.stringify(s, null, 2)); })
      .catch(e => { console.error('同步失败:', e); process.exit(1); });
  }
}
module.exports = { freshnessFact, syncSources, runPipeline, publishResult, publishSync, bootManifest, assetsComplete, readManifestOf, manifestCheckDir, writeBootstrapManifest, writeSyncReport, initMeta, buildRadioMeta, buildCandidates, parseUpstream, dedupeCandidates, normalizeCandidateUrl, forceTokenIssue, forceTokenConsume, reportHashOf, SYNC_ASSETS, checkStream, checkDetail, safeTarget, guardLookup, tryUrl, buildLogoFile, classifyCn, splitSections, countEntries }; // splitSections/countEntries 供 test/smoke.js 复用（R1）；tryUrl 供 server.js/测试复用（audit-r2 P2-1）；checkDetail 结构化探活（B1）；B2 管线/门/发布/manifest/强制协议（test/sources.js 复用）
