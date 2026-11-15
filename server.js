// VRadio — 最简静态服务器 + 流媒体代理：node server.js（或 npm start）后访问 http://localhost:8137
// /proxy?url=...   同源转发远端音频流/HLS，绕开浏览器 CORS 限制（配合前端 hls.js 使用；同源无需 ACAO）
// /api/sync        一键同步最新源（update-sources.js 管线，进行中重复触发返回 409；被替换决策门拦截时
//                  返回 {ok:false, gated:true, report, reportHash} 不落盘；body 带 forceToken = 两步协议强制发布）
// /api/sync/force-token  两步协议第一步：{reportHash} → {token, expiresAt(5min), reportHash}（一次性、绑定报告指纹）
// /api/boot        启动资产状态（B2 manifest 校验/bootstrap/恢复结果；前端「数据资产不完整」toast 用）
// /api/check?url=  可用性探测（url 参数可重复=多源、任一活即 OK，最多 4 个；服务端检测无 CORS 限制）
// /api/mystation   添加自定义电台（POST JSON {n,u,c}：先探活拒绝假流/死链，再原子写入 my-radio.txt）
// /api/nowplaying?url=  曲讯（ICY StreamTitle）：对 mp3/AAC 直流旁路建会话持续读取；HLS 结构性无 ICY 直接返回空
// /api/store       前端持久层主源（GET 全量 / POST 覆盖写 data/store.json）：rev 服务端唯一发号（方案二/R4），
//                  localStorage 只作镜像；白名单键集合 STORE_KEYS 与 store.js 的 KEYS 同步扩（AGENTS.md 契约）
// /api/quality     质量聚合 sidecar（B0/B2）：GET ?rev= 条件获取 / POST {baseRev,ops,keep} 操作事件合并（op.id 幂等去重，
//                  rev 唯一发号，409 仅限 schema/批量超限/超 2MB，三类均带机器可读 code=schema|batch-limit|too-large
//                  供客户端 flush 分类处置；keep=trim 保护集 ≤64；契约 contracts/quality-summary.json）
// /api/myradio     my-radio.txt 全量替换（B0）：v2+ 备份恢复通道，行形态清洗 + 500 行/64KB 封顶 + tmp+rename
// 安全：默认仅监听 127.0.0.1；proxy/check 仅允许公网 http(s) 目标 —— safeTarget 字符串校验 + guardLookup
//       连接级 IP 校验（防 DNS rebinding/TOCTOU），重定向逐跳复查；/proxy 与全部 /api/* 校验
//       Origin/Sec-Fetch-Site（防跨源 CSRF/探活驱动/把本机当流中继——媒体元素加载无需 CORS，audit A2）；
//       回环监听模式下校验 Host 头（rebinding 页面 Origin==Host==攻击者域名，Origin 比对全失效，唯有
//       握手层 Host 无从伪造，audit A3）；静态服务拒绝目录穿越、dotfile、备份文件与 data/ 段——段名比较
//       先归一大小写与尾部点空格（Windows 大小写不敏感 + Win32 剥尾点曾实测绕过字面量比较，audit A1；
//       store.json 是全量个人数据，HOST=0.0.0.0 局域网模式下不可被直接 GET）。
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { runPipeline, publishResult, bootManifest, forceTokenIssue, forceTokenConsume, checkStream, checkDetail, safeTarget, guardLookup, tryUrl } = require('./update-sources');
const { qApplyOp, qTrim } = require('./quality-store'); // B2：质量聚合应用/裁剪纯函数（与客户端逐字节同语义）
const ROOT = __dirname, PORT = process.env.PORT || 8137, HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain; charset=utf-8' };
// Host 头白名单（audit A3，防 DNS rebinding）：回环监听（默认）下只认本机名——rebinding 攻击里页面
// Origin==Host==攻击者域名，所有 Origin 比对失效，从握手层直接拒绝；HOST=0.0.0.0 显式局域网档自担
// 风险不校验；HOST 指定具体地址时该地址随行放行（127.0.0.2 等其它环回变形会被拒，属可接受收紧）
const hostName = h => { try { return new URL('http://' + h).hostname; } catch (_) { return null; } };
const HOST_OK = HOST === '0.0.0.0' ? null : new Set(['localhost', '127.0.0.1', '[::1]', hostName(HOST)]);

// 跨源请求识别：Sec-Fetch-Site（现代浏览器全覆盖）+ Origin 与 Host 比对（兜底）
function crossOrigin(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return true;
  const o = req.headers.origin;
  if (!o) return false;
  try { return new URL(o).host !== (req.headers.host || ''); } catch (_) { return true; }
}

function proxy(target, req, res, depth = 0) {
  if (depth > 5) return res.writeHead(508).end('too many redirects');
  const mod = target.startsWith('https') ? https : http;
  const creq = mod.get(target, {
    timeout: 30000, lookup: guardLookup, // 超时（P2-3）+ 连接级 IP 校验：校验的就是本次连接实际使用的解析结果
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': '*/*' }
  }, r => {
    if ([301, 302, 303, 307].includes(r.statusCode) && r.headers.location) {
      r.resume();
      const next = safeTarget(tryUrl(r.headers.location, target)); // 重定向逐跳复查（P2-6）；畸形头经 tryUrl 归 null 按拒绝处理（audit-r2 P2-1：裸 new URL 抛 TypeError 即崩进程）
      if (!next) return res.writeHead(403).end('403 redirect target rejected');
      return proxy(next, req, res, depth + 1);
    }
    const h = { 'Content-Type': r.headers['content-type'] || 'application/octet-stream' }; // 同源代理，无需 ACAO（P2-4）
    if (r.headers['content-range']) h['Content-Range'] = r.headers['content-range'];
    res.writeHead(r.statusCode, h);
    r.on('error', () => res.destroy()); // 上游中途断流：终止响应，error 不逃逸（Node ≥14 防御性守卫）
    res.on('close', () => r.destroy()); // 浏览器侧断开（换源/暂停/关页）：销毁上游，直播流不再泄漏连接（P2-2）
    r.pipe(res);
  });
  creq.on('timeout', () => creq.destroy(new Error('upstream timeout'))); // 带错误对象 destroy：各版本 Node 都保证触发 error → 502
  creq.on('error', () => { if (res.headersSent) res.destroy(); else res.writeHead(502).end('upstream error'); });
}

// ---------- my-radio.txt 写入（A-2）：tmp+rename 原子替换 + 写段串行化（与前端 reloadMain/导入重并无半写竞争） ----------
const MY_FILE = path.join(ROOT, 'my-radio.txt'), MY_MAX_LINES = 500, MY_MAX_BYTES = 65536;
let myQ = Promise.resolve(); // 串行写队列：探活是异步的，两个并发添加不得互踩对方的读-改-写
function myStationWrite(n, u, c) {
  return myQ = myQ.then(() => new Promise(done => {
    let txt = '';
    try { txt = fs.readFileSync(MY_FILE, 'utf8'); } catch (_) {} // 不存在 = 首次创建
    const lines = txt ? txt.split(/\r?\n/) : [];
    if (lines.length >= MY_MAX_LINES || txt.length >= MY_MAX_BYTES) return done({ ok: false, error: `my-radio.txt 已达上限（${MY_MAX_LINES} 行），请清理后再添加` });
    if (lines.some(l => l.trim() === `${n},${u}`)) return done({ ok: false, error: '该电台已在个人列表中' });
    const dup = lines.find(l => l.trim().endsWith(',' + u)); // 同 URL 换名也不双开（AIbot P3-7：applySources 按 keyOf 合并，不同名会出两行）
    if (dup) return done({ ok: false, error: `该流地址已存在（「${dup.split(',')[0]}」），同一地址请直接使用现有电台` });
    const head = `${c},#genre#`, at = lines.findIndex(l => l.trim() === head);
    if (at >= 0) lines.splice(at + 1, 0, `${n},${u}`); // 已有该分类节：节内插入
    else lines.push('', head, `${n},${u}`); // 新分类：尾部开节
    const out = lines.join('\r\n').replace(/^\r\n/, '') + '\r\n';
    const tmp = MY_FILE + '.tmp';
    fs.writeFile(tmp, out, e => e ? done({ ok: false, error: '写入失败' })
      : fs.rename(tmp, MY_FILE, e2 => done(e2 ? { ok: false, error: '写入失败' } : { ok: true })));
  })).catch(() => ({ ok: false, error: '写入失败' }));
}

// ---------- my-radio.txt 全量替换（B0）：v2+ 备份恢复通道。与 myStationWrite 共用串行队列（追加与整替不互踩），
// tmp+rename 原子替换；行形态清洗在路由层完成（只收「分类,#genre#」与「台名,http(s)」两种合法行） ----------
function myRadioReplace(lines) {
  return myQ = myQ.then(() => new Promise(done => {
    const out = lines.length ? lines.join('\r\n') + '\r\n' : '';
    const tmp = MY_FILE + '.tmp';
    fs.writeFile(tmp, out, e => e ? done({ ok: false, error: '写入失败' })
      : fs.rename(tmp, MY_FILE, e2 => done(e2 ? { ok: false, error: '写入失败' } : { ok: true })));
  })).catch(() => ({ ok: false, error: '写入失败' }));
}

// ---------- data/store.json（方案二/R4 拍板）：前端持久层主源。仲裁 = 服务端唯一发号（rev 由 POST 成功才分配，
// 客户端永不自造）——跨浏览器/换机窗口不会「同 rev 不同数据」静默压掉一端改动，并发退化为显式 last-write-wins。
// 写入复用 my-radio 口径：tmp+rename 原子替换 + 串行队列；结构白名单只收已知键（值形状前端自管，键集合即边界） ----------
const DATA_DIR = path.join(ROOT, 'data'), STORE_FILE = path.join(DATA_DIR, 'store.json');
const STORE_KEYS = new Set(['radio.favs', 'radio.recents', 'radio.health', 'radio.cfg', 'radio.songs', 'radio.volperst', 'radio.srcmem2',
  'radio.vol', 'radio.view', 'radio.showdead', 'radio.theme', 'radio.baseline', 'radio.baselineProg']); // ⚠ 与 store.js KEYS 同步扩
const STORE_MAX = 2 * 1024 * 1024, KEY_MAX = 512 * 1024;
const KEY_MAXS = { 'radio.health': 1536 * 1024 }; // 分键上限（AIbot P2-3）：健康标记 FIFO 2000 条 × 多源 URL 快照最坏 ~0.9MB，512KB 会静默丢键——对账再把镜像一起抹掉，僵尸台问题换个形式回归
let storeRev = 0, storeCache = null, storeQ = Promise.resolve();
function storeRead() { // 懒加载：首访问读盘；坏文件视为空库（rev=0，前端镜像会重建推送）
  if (!storeCache) {
    try { storeCache = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (_) { storeCache = null; }
    if (!storeCache || typeof storeCache !== 'object' || typeof storeCache.data !== 'object' || !Number.isFinite(storeCache.rev)) storeCache = { rev: 0, data: {} };
    storeRev = storeCache.rev;
  }
  return storeCache;
}
function storeWrite(data) {
  return storeQ = storeQ.then(() => new Promise(done => {
    storeRead(); // 先装载磁盘态（AIbot P2-1）：rev 只在 GET 路径懒装载——重启后首请求若是 POST 会从 0 重发号，旧窗口高 rev 镜像被静默压掉，违反「rev 服务端唯一发号」公理
    const rev = storeRev + 1, out = JSON.stringify({ rev, data }), tmp = STORE_FILE + '.tmp';
    fs.mkdir(DATA_DIR, { recursive: true }, e => {
      if (e) return done({ ok: false, error: '写入失败' });
      fs.writeFile(tmp, out, e2 => e2 ? done({ ok: false, error: '写入失败' })
        : fs.rename(tmp, STORE_FILE, e3 => {
          if (e3) return done({ ok: false, error: '写入失败' });
          storeRev = rev; storeCache = { rev, data };
          done({ ok: true, rev });
        }));
    });
  })).catch(() => ({ ok: false, error: '写入失败' }));
}

// ---------- data/quality.json（B0 骨架 / B2 QualityStore 服务端底座）：质量聚合 sidecar。
// 仲裁模型 = 操作事件合并（非 last-write-wins，契约 contracts/quality-summary.json）：POST {baseRev, ops[, keep]} 逐条
// 应用，同一 op.id 已处理则跳过——网络重试/页面刷新/多标签重复提交不重复计数；去重日志 FIFO（512 条）淘汰时
// 推进 at 水位线 floorAt，旧于水位线的重试显式拒绝（响应 rejected 计数）而非静默重算，幂等边界可证明；baseRev 只是客户端观测版本，
// 不作整段覆盖条件、版本落后不拒绝合并；仅 schema 错误/单批超限/无法合并（含 2MB 硬上限）返回 409——
// 三类 409 均带机器可读 code（schema|batch-limit|too-large，AIbot PR#26 复核 P2）：客户端只丢不可恢复的
// schema 批、容量类保留 pending 重试（quality-store.js flush 分类处置）。
// rev 服务端唯一发号（成功应用 ≥1 条才 +1，纯去重命中不动号）。安全边界复用 store 口径：跨源拒绝、
// 请求体/单批操作数封顶、tmp+rename + 串行队列、坏文件按空库恢复。
// B2 落地：聚合应用走 quality-store.js 纯函数 qApplyOp（每台 {cf, sources:{源URL:{聚合值…}}} 内层形态与
// Android filesDir/quality.json 一致；本文件包装 = {v,rev,ops,data}、Android = {v,stations}，契约 files 节冻结）；
// keep = 客户端随批附带的收藏+最近保护集（≤64 条 http(s) URL），
// trim 时保留——B2 临场设计（契约 trimOrder 的保护集服务端落地）。trim 下钻序见 quality-store.js。 ----------
const QUALITY_FILE = path.join(DATA_DIR, 'quality.json');
const Q_MAX = 2 * 1024 * 1024, Q_OPS_MAX = 32, Q_BODY_MAX = 256 * 1024, Q_OPLOG = 512;
const Q_KINDS = new Set(['diagnostic', 'playback']), Q_TRIGGERS = new Set(['manual', 'boot', 'sync', 'play', 'watchdog', 'switch', 'error']), Q_MODES = new Set(['direct', 'hls', 'proxy']);
let qCache = null, qQ = Promise.resolve();
function qRead() { // 懒加载 + 坏文件按空库恢复（只清自身，绝不碰 radio.health / store.json）
  if (!qCache) {
    try { qCache = JSON.parse(fs.readFileSync(QUALITY_FILE, 'utf8')); } catch (_) { qCache = null; }
    if (!qCache || typeof qCache !== 'object' || !Array.isArray(qCache.ops) || typeof qCache.data !== 'object' || !Number.isFinite(qCache.rev)) qCache = { v: 1, rev: 0, ops: [], data: {} };
    if (!Array.isArray(qCache.ats) || qCache.ats.length !== qCache.ops.length) { qCache.ats = qCache.ops.map(() => 0); qCache.floorAt = 0; } // 幂等水位线兼容：旧文件/形态不齐按 0 对齐（不拒绝任何重试）
    if (!Number.isFinite(qCache.floorAt)) qCache.floorAt = 0;
  }
  return qCache;
}
function qValidOp(o) { // schema 校验（契约 opEvent）：不合即 409，不做静默修补
  return !!o && typeof o === 'object' && typeof o.id === 'string' && o.id.length > 0 && o.id.length <= 128
    && /^https?:\/\//.test(o.identityUrl || '') && (o.identityUrl || '').length <= 512
    && /^https?:\/\//.test(o.sourceUrl || '') && (o.sourceUrl || '').length <= 512
    && Q_KINDS.has(o.kind) && Q_TRIGGERS.has(o.trigger) && typeof o.ok === 'boolean'
    && Number.isFinite(+o.latencyMs) && Number.isFinite(+o.bytes) && Number.isFinite(+o.at) && Q_MODES.has(o.mode);
}
function qCommit(ops, keep) { // 串行：克隆当前态 → 应用（qApplyOp）→ trim（契约淘汰序，keep 保护集）→ 写盘
  return qQ = qQ.then(() => new Promise(done => {   // 成功才换内存与 rev（写失败不留半应用状态）
    const st = JSON.parse(JSON.stringify(qRead()));
    let applied = 0, rejected = 0;
    for (const op of ops) {
      if (st.ops.includes(op.id)) continue;          // 窗口内命中：幂等跳过
      if (+op.at <= st.floorAt) { rejected++; continue; } // 旧于淘汰水位线：显式拒绝（响应带 rejected 计数），绝不重复计数——容量裁剪可丢聚合样本，不得破坏幂等语义（AIbot B0-P1）
      // 设计边界（AIbot #20 复核 P2 设计清单留档）：floorAt 以事件时间为水位线——客户端时钟回拨/离线队列
      // 延迟可能令合法新事件被拒计入 rejected（误伤上限 = 淘汰窗口外的少量新样本，不破坏幂等语义）；
      // B2 后续完整实现的改进方向 = 持久哈希/分区去重索引（精确区分「已淘汰旧重试」与「迟到的合法新事件」），
      // 当前语义已由 test/quality.js「超过 512 条后：淘汰旧 op 重试被显式拒绝」测试钉死。
      qApplyOp(st.data, op);                        // B2 纯函数应用（与客户端/Android 同语义）
      st.ops.push(op.id);
      st.ats.push(+op.at || 0);
      applied++;
    }
    if (st.ops.length > Q_OPLOG) { // 去重日志 FIFO（与数据同受 2MB 约束）；淘汰推进幂等水位线 floorAt——已淘汰 op 的重试按 at<=floorAt 显式拒绝
      const cut = st.ops.length - Q_OPLOG, ev = st.ats.splice(0, cut);
      st.ops.splice(0, cut);
      st.floorAt = Math.max(st.floorAt || 0, ...ev);
    }
    if (!applied) return done({ ok: true, rev: st.rev, applied: 0, rejected });
    const rev = st.rev + 1;
    const serialize = () => JSON.stringify({ v: 1, rev, ops: st.ops, ats: st.ats, floorAt: st.floorAt, data: st.data }); // 水位线随盘持久
    qTrim(st.data, keep, () => Buffer.byteLength(serialize()), Q_MAX); // 2MB 逼近时按淘汰序裁（每 2 步复核防过冲）
    const out = serialize(), tmp = QUALITY_FILE + '.tmp';
    if (Buffer.byteLength(out) > Q_MAX) return done({ ok: false, error: 'quality sidecar 超过 2MB 硬上限', code: 'too-large' }); // 无法合并（含 2MB 硬上限）→ 409（路由按 code 映射；写失败仍 200 ok:false——临时错误非协议拒）
    fs.mkdir(DATA_DIR, { recursive: true }, e => {
      if (e) return done({ ok: false, error: '写入失败' });
      fs.writeFile(tmp, out, e2 => e2 ? done({ ok: false, error: '写入失败' })
        : fs.rename(tmp, QUALITY_FILE, e3 => {
          if (e3) return done({ ok: false, error: '写入失败' });
          qCache = st; qCache.rev = rev; done({ ok: true, rev, applied, rejected });
        }));
    });
  })).catch(() => ({ ok: false, error: '写入失败' }));
}

// ---------- 曲讯旁路会话（B-6）：ICY meta 只存在于 Icecast/Shoutcast 形态的 mp3/AAC 直流 ----------
// 模型：keep-open 持续读（ICY 帧随音频内联到达，换歌近实时，优于周期重连只能拿连接时刻曲名）；
// 会话按 url 缓存曲名，前端 15s 轮询只读缓存；空闲 30s 回收（切台后旧连接自动关）、并发旁路封顶 2
const npSess = new Map(); // url → {title, hit, req, noIcy, deadAt}
const NP_MAX = 2, NP_IDLE = 30000, NP_RETRY = 60000; // 并发上限 / 空闲回收 / 连接失败冷却重试
const NP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
function npEvictOldest() {
  let old = null;
  for (const [u, x] of npSess) if (!old || x.hit < old[1].hit) old = [u, x];
  if (old) { if (old[1].req) old[1].req.destroy(); npSess.delete(old[0]); }
}
function npStart(url) { // 建会话（或复用已有）；并发封顶时 LRU 淘汰最久未访问
  let s = npSess.get(url);
  if (s) { s.hit = Date.now(); return s; }
  for (const [u, x] of [...npSess]) if (Date.now() - x.hit > NP_IDLE) { if (x.req) x.req.destroy(); npSess.delete(u); } // 空闲回收
  if (npSess.size >= NP_MAX) npEvictOldest();
  s = { title: '', hit: Date.now(), req: null, noIcy: false, deadAt: 0, br: 0 };
  npSess.set(url, s);
  const go = (t, depth) => { // 重定向逐跳复查（旁路连接同样过 SSRF 护栏，不豁免）
    if (depth > 3) { s.deadAt = Date.now(); return; }
    const creq = (t.startsWith('https') ? https : http).get(t, { timeout: 15000, lookup: guardLookup, headers: { 'User-Agent': NP_UA, Accept: '*/*', 'Icy-MetaData': '1' } }, r => {
      if ([301, 302, 303, 307].includes(r.statusCode) && r.headers.location) {
        r.resume();
        const nx = safeTarget(tryUrl(r.headers.location, t)); // 畸形头经 tryUrl 归 null（audit-r2 P2-1）
        if (nx) go(nx, depth + 1); else s.deadAt = Date.now();
        return;
      }
      s.req = creq;
      const mi = parseInt(r.headers['icy-metaint'], 10);
      const br = parseInt(r.headers['icy-br'], 10); // 码率（③/grill 拍板）：ICY 响应头随曲讯一起返回，footer 曲名旁显示「· Nkbps」
      s.br = br > 0 ? br : 0;
      if (!(mi > 0)) { s.noIcy = true; r.destroy(); creq.destroy(); return; } // 协议无曲讯（普通文件流/部分服务器）：请求+响应双销毁防双倍带宽（resume 会把整条音频流在服务端放空下载——AIbot P1-1），Map 条目即负缓存
      // ICY 帧状态机：mi 个音频字节 → 1 字节长度(值×16) → meta 载荷，取 StreamTitle='…'（\' 转义）
      let pos = 'a', left = mi, mlen = 0, mbuf = [];
      r.on('data', d => {
        let i = 0;
        while (i < d.length) {
          if (pos === 'a') { const use = Math.min(left, d.length - i); i += use; left -= use; if (!left) pos = 'l'; }
          else if (pos === 'l') {
            mlen = d[i++] * 16;
            if (!mlen) { left = mi; pos = 'a'; } else { mbuf = []; pos = 'm'; }
          } else {
            const use = Math.min(mlen, d.length - i); mbuf.push(d.slice(i, i + use)); i += use; mlen -= use;
            if (!mlen) {
              const raw = Buffer.concat(mbuf);
              let txt = raw.toString('utf8'); // 多数欧美台 meta 是 UTF-8（AIbot P3-5）；含替换符再回退 latin1（老 Icecast 字节流）
              if (txt.includes('\uFFFD')) txt = raw.toString('latin1');
              const t2 = txt.match(/StreamTitle='((?:\\'|[^'])*)'/);
              if (t2) s.title = t2[1].replace(/\\'/g, "'").trim();
              left = mi; pos = 'a';
            }
          }
        }
      });
      r.on('end', () => { s.deadAt = Date.now(); });   // 上游断连：保留最后曲名，冷却期后下次访问重建
      r.on('error', () => { s.deadAt = Date.now(); });
    });
    creq.on('timeout', () => creq.destroy(new Error('upstream timeout')));
    creq.on('error', () => { s.deadAt = Date.now(); });
    if (!s.req) s.req = creq;
  };
  go(url, 0);
  return s;
}
// 全局回收器（AIbot P2-4）：空闲回收只在 npStart 入口触发不够——暂停/停止后无人再发请求，
// 挂着的旁路连接要靠这里 30s 一扫兜底销毁，否则最多 2 条 ICY 流在 upstream 永久下载
setInterval(() => {
  const now = Date.now();
  for (const [u, x] of [...npSess]) if (now - x.hit > NP_IDLE) { if (x.req) x.req.destroy(); npSess.delete(u); }
}, NP_IDLE);

let syncInFlight = null;
// 启动资产校验（§13.3）：manifest 缺失且四资产齐全 → 写 bootstrap 继续；校验失败 → 自动恢复上一批（.tmp/sync-prev）；
// 资产不完整 → ok:false（前端 toast「数据资产不完整」提示，服务照常起，不静默混态）
const bootState = bootManifest(ROOT, m => console.log('[sync]', m));
/* B2 强制同步两步协议（§6.4）：普通 /api/sync 被决策门拦截时不落盘，返回 {ok:false, gated:true, report,
   reportHash} 并把候选产物 stash 进内存单槽；POST /api/sync/force-token {reportHash} 换一次性 token（5 分钟、
   绑定报告指纹）；POST /api/sync {forceToken} 消费 token → 复用 stash 原料重跑强制发布（不重拉上游）。
   普通 /api/sync 不收 force 字段（400）；force 只绕数量/分类类决策门，安全护栏/格式过滤/生成失败照拦。 */
let syncStash = null; // {report, reportHash, inputs:{cn,eu}, tokens:{token:{expiresAt,reportHash}}}
const randHex = () => crypto.randomBytes(32).toString('hex');
http.createServer((req, res) => {
  if (HOST_OK && !HOST_OK.has(hostName(req.headers.host || '') || '')) return res.writeHead(403).end('403 unexpected Host'); // rebinding 面（audit A3）：Host 不在白名单一律拒
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const readJsonBody = (req, cap, onJson) => { // 小体量 JSON 读取（sync/force-token 用；空体 = {}，解析失败 = null）
    let body = '', big = false;
    req.on('data', c => { body += c; if (body.length > cap) { big = true; json(413, { error: '请求体过大' }); req.destroy(); } });
    req.on('end', () => {
      if (big) return;
      if (!body.trim()) return onJson({});
      let j; try { j = JSON.parse(body); } catch (_) { return onJson(null); }
      onJson(j);
    });
  };

  if (req.url.split('?')[0] === '/api/sync/force-token') { // 两步协议第一步：换一次性 token（只收 POST）
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' });
    return readJsonBody(req, 4096, j => {
      if (j === null) return json(400, { error: 'bad request' });
      const r = forceTokenIssue(syncStash, j, Date.now(), randHex);
      json(r.status, r.status === 200 ? r.body : { error: r.error });
    });
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/sync') {
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' }); // 防 CSRF（P2-5）
    if (syncInFlight) return json(409, { error: '同步已在进行中，请稍候' });
    return readJsonBody(req, 4096, j => {
      if (j === null) return json(400, { error: 'bad request' });
      if ('force' in j) return json(400, { error: '不接受 force 字段——强制同步走 /api/sync/force-token 两步协议' });
      const forceToken = typeof j.forceToken === 'string' ? j.forceToken : '';
      const run = (async () => {
        if (forceToken) { // 两步协议第二步：消费 token（单次、绑定指纹复查）→ 复用 stash 原料强制发布
          const c = forceTokenConsume(syncStash, forceToken, Date.now());
          if (c.status !== 200) return { __http: c.status, __err: c.error };
          const r2 = await runPipeline(m => console.log('[sync]', m), { inputs: syncStash.inputs, force: true, entry: 'web' });
          if (r2.hardAbort) return r2.summary; // 复跑撞硬门槛（理论不可达：门检查同一批原料）——保留旧库
          return publishResult(ROOT, r2, { entry: 'web', forced: true });
        }
        const r = await runPipeline(m => console.log('[sync]', m), { entry: 'web' });
        if (r.hardAbort) return r.summary;                                   // 既有 aborted 语义（消费方兼容）
        if (r.gated) {                                                       // 决策门：不落盘，stash 供强制复用
          syncStash = { report: r.report, reportHash: r.reportHash, inputs: r.artInputs, tokens: {} };
          return { ok: false, gated: true, report: r.report, reportHash: r.reportHash };
        }
        syncStash = null; // 门通过正常发布：旧 stash 作废（其 token 随之失效）
        return publishResult(ROOT, r, { entry: 'web' });
      })();
      syncInFlight = run;
      run.then(s => s && s.__http ? json(s.__http, { error: s.__err }) : json(200, s))
        .catch(e => json(500, { error: String(e.message || e) }))
        .finally(() => { syncInFlight = null; });
    });
  }
  if (req.url.split('?')[0] === '/api/boot') { // B2 启动资产状态（§13.3）：manifest 校验/bootstrap/恢复结果（前端 toast 用）
    if (req.method !== 'GET') return json(405, { ok: false, error: 'method not allowed' });
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' });
    return json(200, { ok: bootState.ok, version: bootState.version, missing: bootState.missing || [], restored: !!bootState.restored });
  }
  if (req.url.startsWith('/api/check?')) {
    if (req.method !== 'GET') return json(405, { ok: false, detail: 'method not allowed' }); // 探活只该被 GET 驱动（audit-r2 P3-1，与 /proxy、静态同口径）
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' }); // 带副作用的 GET 同样防跨源驱动（P2-9）
    let urls, sp;
    try { sp = new URL(req.url, `http://${req.headers.host || 'localhost'}`); urls = [...sp.searchParams.getAll('url')]; }
    catch (_) { return json(400, { ok: false, detail: 'bad request' }); }
    if (urls.length > 4) return json(400, { ok: false, detail: '最多 4 个源' }); // 放大面封顶（P2-9）
    const targets = [...new Set(urls.map(safeTarget).filter(Boolean))];
    if (!targets.length) return json(400, { ok: false, detail: '仅允许公网 http(s) 地址' });
    // 探活窗口可调（AIbot P1-1）：批量体检不传 → checkStream 默认 4.5s（ETA 按最坏校准，不能放慢）；
    // 追加备选源传 t=12000 —— 蜻蜓系救援源建流 5-10s 属正常，与 /api/mystation 同口径。钳到 [1s, 30s] 防滥用
    const tms = Math.min(Math.max(parseInt(sp.searchParams.get('t'), 10) || 0, 0), 30000);
    const opt = tms >= 1000 ? { timeout: tms } : {};
    (async () => {
      if (sp.searchParams.get('detail') === '1') { // 结构化详情（B1，契约 contracts/source-diagnostic.json）：逐源完整结果、
        // 绝不返回响应体；安全边界与旧口径一致（≤4 URL/双护栏/逐跳复查/跨源拒/时间窗口不放宽——单 URL 窗口同 t 钳制）
        const results = await Promise.all(targets.map(t => checkDetail(t, 0, opt)));
        return json(200, { ok: results.some(r => r.ok), results });
      }
      for (const t of targets) { const r = await checkStream(t, 0, opt); if (r.ok) return json(200, { ok: true, detail: r.detail }); }
      json(200, { ok: false, detail: `${targets.length} 个源均不可用` });
    })();
    return;
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/mystation') { // 添加自定义电台（A-2）：探活通过才写 my-radio.txt
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' }); // 写文件接口，防 CSRF 与 check/sync 同口径
    let body = '', big = false;
    req.on('data', c => { body += c; if (body.length > 2048) { big = true; json(413, { error: '请求体过大' }); req.destroy(); } }); // 超限先写响应再断连（destroy 后无 end，socket 已毁时补写会静默失败——AIbot P3-8）
    req.on('end', () => {
      if (big) return;
      let j; try { j = JSON.parse(body); } catch (_) { return json(400, { error: 'bad request' }); }
      // 内容护栏：台名/分类去 csv 分隔符与换行（radio.txt 格式硬约束），长度封顶；地址须公网 http(s)
      const n = String(j.n || '').replace(/[,\r\n|]/g, ' ').trim().slice(0, 40);
      const c = String(j.c || '').replace(/[,\r\n|#]/g, ' ').trim().slice(0, 24);
      const u0 = String(j.u || '').trim().slice(0, 512);
      if (!n || !c) return json(400, { error: '电台名/分类不能为空' });
      const target = safeTarget(u0);
      if (!target) return json(403, { error: '流地址不合法（仅公网 http(s)）' });
      checkStream(target, 0, { timeout: 12000 }).then(async r => { // 探活先行：假流（xmcdn 336B 类）与死链一律拒绝入库；窗口放宽到 12s——蜻蜓系建流 5-10s 属正常（AIbot P1-2），单 URL 手动添加不涉 /api/check 的放大面
        if (!r.ok) return json(200, { ok: false, detail: '探活失败：' + r.detail });
        json(200, await myStationWrite(n, target, c));
      }).catch(e => json(500, { error: String(e && e.message || e) }));
    });
    return;
  }
  if (req.url.split('?')[0] === '/api/quality') { // 质量 sidecar（B0 契约）：GET 条件获取（rev 命中只回 notModified）/ POST ops 合并
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' });
    if (req.method === 'GET') {
      const s = qRead();
      let rv = NaN;
      try { rv = parseInt(new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('rev') || '', 10); } catch (_) {}
      if (rv === s.rev) return json(200, { rev: s.rev, notModified: true });
      return json(200, { rev: s.rev, data: s.data });
    }
    if (req.method === 'POST') {
      let body = '', big = false;
      req.on('data', c => { body += c; if (body.length > Q_BODY_MAX) { big = true; json(409, { ok: false, error: '请求体过大', code: 'too-large' }); req.destroy(); } }); // 超限先写响应再断连（与 store 同口径）；字节超限 → code=too-large
      req.on('end', () => {
        if (big) return;
        let j; try { j = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: 'bad request' }); }
        const ops = j && j.ops;
        // 三类 409 各带机器可读 code（AIbot PR#26 复核 P2）：schema=op 事件校验失败（不可恢复，客户端丢批）；
        // batch-limit=单批 32 条超限（可恢复，客户端减半分批）；契约口径不变——仅 schema/批量超限/无法合并 → 409
        if (!Array.isArray(ops) || !ops.length) return json(409, { ok: false, error: '操作事件列表不合法', code: 'schema' });
        if (ops.length > Q_OPS_MAX) return json(409, { ok: false, error: '单批操作事件超过上限（32 条）', code: 'batch-limit' });
        if (!ops.every(qValidOp)) return json(409, { ok: false, error: '操作事件 schema 校验失败', code: 'schema' }); // baseRev 落后不拒
        // keep = 收藏+最近保护集（B2 临场设计：客户端每次 POST 附带 ≤64 条 http(s) URL，服务端 trim 时保留）
        const keep = Array.isArray(j.keep) ? [...new Set(j.keep.filter(u => typeof u === 'string' && u.length <= 512 && /^https?:\/\//.test(u)))].slice(0, 64) : [];
        qCommit(ops, keep).then(r => json(r && r.code ? 409 : 200, r)); // qCommit 唯一带 code 的失败 = 2MB 无法合并（too-large）；写失败 200 ok:false
      });
      return;
    }
    return json(405, { ok: false, error: 'method not allowed' });
  }
  if (req.url.split('?')[0] === '/api/myradio') { // my-radio.txt 全量替换（B0）：v2+ 备份恢复通道；行形态清洗 + 行数/字节封顶
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' });
    if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
    let body = '', big = false;
    req.on('data', c => { body += c; if (body.length > 128 * 1024) { big = true; json(413, { ok: false, error: '请求体过大' }); req.destroy(); } });
    req.on('end', () => {
      if (big) return;
      let j; try { j = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: 'bad request' }); }
      const lines = j && j.lines;
      if (!Array.isArray(lines)) return json(400, { ok: false, error: 'bad request' });
      const clean = []; // 只收「分类,#genre#」与「台名,http(s) 地址」；台名去 csv 分隔符（与 mystation 同口径）
      for (const l of lines) {
        if (typeof l !== 'string') continue;
        const t = l.trim().slice(0, 600).replace(/[\r\n]/g, '');
        if (!t) continue;
        if (t.endsWith('#genre#')) {
          const c = t.slice(0, -8).replace(/,\s*$/, '').replace(/[,\r\n|]/g, ' ').trim().slice(0, 24);
          if (c) clean.push(c + ',#genre#');
          continue;
        }
        const i = t.lastIndexOf(',');
        if (i < 0) continue;
        const n = t.slice(0, i).replace(/[,\r\n|]/g, ' ').trim().slice(0, 40), u = t.slice(i + 1).trim();
        if (n && /^https?:\/\//.test(u)) clean.push(n + ',' + u);
      }
      if (clean.length > MY_MAX_LINES || clean.join('\r\n').length > MY_MAX_BYTES) return json(413, { ok: false, error: `个人电台列表超上限（${MY_MAX_LINES} 行/64KB）` });
      myRadioReplace(clean).then(r => json(200, r));
    });
    return;
  }
  if (req.url.split('?')[0] === '/api/store') { // 前端持久层主源（方案二）：GET 全量 / POST 覆盖写；同 mystation 防跨源
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' });
    if (req.method === 'GET') { const s = storeRead(); return json(200, { rev: s.rev, data: s.data }); }
    if (req.method === 'POST') {
      let body = '', big = false;
      req.on('data', c => { body += c; if (body.length > STORE_MAX) { big = true; json(413, { ok: false, error: '请求体过大' }); req.destroy(); } }); // 超限先写响应再断连（与 mystation 同口径）
      req.on('end', () => {
        if (big) return;
        let j; try { j = JSON.parse(body); } catch (_) { return json(400, { ok: false, error: 'bad request' }); }
        const d = j && j.data;
        if (!d || typeof d !== 'object' || Array.isArray(d)) return json(400, { ok: false, error: 'bad request' });
        const clean = {};
        for (const k of Object.keys(d)) {
          if (!STORE_KEYS.has(k)) continue; // 白名单外的键静默丢弃（前端全量快照，漏扩键的改动不落盘但不炸）
          const v = d[k], max = KEY_MAXS[k] || KEY_MAX;
          if (typeof v !== 'string' || v.length > max) return json(413, { ok: false, error: `数据键 ${k} 超限（>${Math.round(max / 1024)}KB），写入被拒绝` }); // AIbot P2-3：白名单键超限显式拒绝——客户端收非 ok 置 dirty 保镜像；静默丢键会让对账把镜像一起抹掉
          clean[k] = v;
        }
        storeWrite(clean).then(r => json(200, r)); // rev 在写成功后发（响应携带新号）
      });
      return;
    }
    return json(405, { ok: false, error: 'method not allowed' });
  }

  if (req.url.startsWith('/api/nowplaying?')) { // 曲讯（B-6）：带副作用 GET（驱动服务端上行连接），与 check 同口径防跨源驱动
    if (req.method !== 'GET') return json(405, { title: '' }); // 旁路只该被 GET 驱动（audit-r2 P3-1，同 /api/check）
    if (crossOrigin(req)) return json(403, { error: '跨源请求被拒绝' });
    let u;
    try { u = [...new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.getAll('url')][0]; }
    catch (_) { return json(400, { title: '' }); }
    const target = u && safeTarget(u);
    if (!target) return json(400, { title: '' }); // 仅公网 http(s)
    if (/\.m3u8(\?|$)/i.test(target)) return json(200, { title: '' }); // HLS 结构性无 ICY，不建旁路不耗探活（i：.M3U8 变形同判）
    const old = npSess.get(target);
    if (old && old.deadAt && Date.now() - old.deadAt > NP_RETRY) { if (old.req) old.req.destroy(); npSess.delete(target); } // 失败冷却后允许重建
    const s = npSess.get(target) || npStart(target);
    return json(200, { title: s.title || '', br: s.br || 0 });
  }
  if (req.url.startsWith('/proxy?url=')) {
    if (req.method !== 'GET') return res.writeHead(405).end('405'); // 与静态同口径（AIbot P3-4）：媒体/hls 请求全是 GET
    if (crossOrigin(req)) return res.writeHead(403).end('403 cross-origin rejected'); // audit A2：任意网页可用 <audio>/媒体元素驱动本机代理当公开中继（加载无需 CORS）；同源页面 SFS=same-origin、地址栏直开 SFS=none 均不受影响。
    // ⚠ 覆盖边界（AIbot P2-3，owner 拍板只标注不加固）：Sec-Fetch-Site 仅 Chromium 系必发——Firefox/Safari
    // 的跨站 <audio> 不带 SFS/Origin，此校验对最弱浏览器不闭环（Referer 校验可被 referrerpolicy=no-referrer
    // 绕过、且空 Referer 与地址栏直开不可区分，不采纳）；localhost 威胁模型下残余危害 = 带宽中继
    let target;
    try { target = safeTarget(decodeURIComponent(req.url.slice('/proxy?url='.length))); }
    catch (_) { return res.writeHead(400).end('400 bad url'); }
    if (!target) return res.writeHead(403).end('403 公网 http(s) only');
    return proxy(target, req, res);
  }

  // 静态文件（仅 GET/HEAD——audit A4；拒绝目录穿越 + dotfile/备份文件/data 段——.git/.DS_Store/radio.txt.bak
  // 不可读，P2-8；data/ 含 store.json 全量个人数据（收藏/歌史/健康标记），HOST=0.0.0.0 局域网模式下不可被
  // 直接 GET——外部 review P0-1。段名比较先归一：Windows 文件系统对 DATA/radio.txt.BAK/data. 等
  // 大小写与尾点变形照读不误，字面量比较被实测击穿过——audit-2026-10-14 A1）
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end('405');
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); } catch (_) { return res.writeHead(400).end('400'); }
  const norm = s => s.toLowerCase().replace(/[.\s]+$/, '');
  if (rel.split('/').some(seg => seg.startsWith('.') || norm(seg).endsWith('.bak') || norm(seg) === 'data')) return res.writeHead(403).end('403');
  const p = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) return res.writeHead(403).end('403');
  fs.readFile(p, (e, buf) => {
    if (e) return res.writeHead(404).end('404');
    const h = { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }; // audit A6：本地文件类型可信堵嗅探；/proxy 转发上游类型不可信（错标 octet-stream 的流靠嗅探才能播），不加
    // radio-data.js 是同步才变的生成物（~200KB），http 模式每次刷新都会白拉一遍（列表实际走 radio.txt）——
    // 定向给一天缓存（AIbot P3-5）；file:// 读本地文件不经 HTTP 缓存，不受影响。其余文件不缓存：开发改动即刷即生效
    if (p === path.join(ROOT, 'radio-data.js')) h['Cache-Control'] = 'public, max-age=86400';
    res.writeHead(200, h).end(buf);
  });
}).listen(PORT, HOST, () => console.log(`VRadio: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}（仅本机监听；局域网需 HOST=0.0.0.0 自行承担风险）`));
