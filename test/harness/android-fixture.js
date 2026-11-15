// 安卓 instrumented smoke 固定流 fixture（P2，docs/testing-strategy-2026-11.md §3 L4 接入协议）。
// 与 Web 侧 harness/http-fixture.js（测试内嵌、127.0.0.1）的差异：独立 CLI + 监听 0.0.0.0（模拟器
// 经固定映射 10.0.2.2 可达）+ 面向 ExoPlayer 的真可解码音频（LAME 静音 MP3 帧；HLS 分片手工 MPEG-TS 打包）。
// 接入协议（冻结口径）：宿主 `node test/harness/android-fixture.js` 打印 FIXTURE_URL/FIXTURE_VERSION
// → workflow 把 127.0.0.1 换算 10.0.2.2 → gradle -Pandroid.testInstrumentationRunnerArguments.
// fixtureBaseUrl= 注入 instrumentation；未注入时安卓侧 Assume 跳过播放用例（骨架保持绿）。
// FIXTURE_VERSION 与 androidTest AndroidSmokeTest.FIXTURE_VERSION 两处同步改；路由增删经 --list 对账。
const http = require('http');

const FIXTURE_VERSION = 'v1';
const STREAM_TTL_MS = 10 * 60 * 1000; // keep-open 流生命周期兜底（防泄漏；smoke 用例远短于此）
const METAINT = 32;                   // ICY 元数据间隔取小值：换歌在毫秒级可见（web 侧 np-proxy fixture 同款口径）
const SEG_FRAMES = 38;                // HLS 分片帧数 ≈ 1s（26.06ms/帧）

// LAME 静音 MP3 单帧（本机 ffmpeg libmp3lame anullsrc mono 44.1kHz/128kbps 产出，去 ID3 取首帧 417 字节
// 内嵌 base64；重复成流 = 合法恒静音 MP3，ffprobe 实测 200 帧=5.2125s 可解）。直流/HLS/ICY 三场景共用——
// 假流/断流场景（不可解码形态）才用填充字节。
const MP3_FRAME = Buffer.from(
  '//uQxAADwAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV', 'base64');
const mp3Chunk = frames => Buffer.concat(Array(frames).fill(MP3_FRAME));

/* ---------- MPEG-TS 最小打包器（HLS 分片：MP3-in-TS，PAT/PMT/PES 手工构造，ffprobe 实测可解） ---------- */

const CRC_TBL = [];
for (let i = 0; i < 256; i++) { // MPEG-2 CRC32（poly 0x04C11DB7，MSB 先行）
  let c = i << 24;
  for (let j = 0; j < 8; j++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04C11DB7) : (c << 1);
  CRC_TBL.push(c >>> 0);
}
function crc32(buf) { // 覆盖 table_id 起至 CRC 前的全节
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = ((c << 8) >>> 0) ^ CRC_TBL[((c >>> 24) ^ buf[i]) & 0xFF];
  return c >>> 0;
}
const crcTail = body => {
  const c = crc32(body), b = Buffer.alloc(4);
  b[0] = c >>> 24; b[1] = (c >>> 16) & 0xFF; b[2] = (c >>> 8) & 0xFF; b[3] = c & 0xFF;
  return b;
};

const ccMap = {}; // 各 PID 连续计数器（跨分片全局递增，贴近真实编码器形态）
function nextCc(pid) { const c = ccMap[pid] == null ? 0 : (ccMap[pid] + 1) & 0x0F; ccMap[pid] = c; return c; }

// 单 TS 包构造：payload ≤ 184B；pcr 非 null 时 adaptation 头部塞 PCR；空位 0xFF stuffing（afl 计入 stuffing）
function tsPacket(pid, payload, pusi, pcr) {
  const hdr = Buffer.alloc(4);
  hdr[0] = 0x47; hdr[1] = (pusi ? 0x40 : 0) | (pid >> 8); hdr[2] = pid & 0xFF;
  let af = null;
  if (pcr != null || payload.length < 184) {
    const flags = Buffer.from([pcr != null ? 0x10 : 0x00]);
    let pcrBuf = Buffer.alloc(0);
    if (pcr != null) { // PCR = 33bit base（90kHz）+ 6bit 保留位（111111）+ 9bit ext（0）
      const base = BigInt(pcr) & 0x1FFFFFFFFn, p = Buffer.alloc(6);
      p[0] = Number((base >> 25n) & 0xFFn); p[1] = Number((base >> 17n) & 0xFFn);
      p[2] = Number((base >> 9n) & 0xFFn);  p[3] = Number((base >> 1n) & 0xFFn);
      p[4] = Number(base & 1n) * 128 + 0x7E; p[5] = 0;
      pcrBuf = p;
    }
    const body = Buffer.concat([flags, pcrBuf,
      Buffer.alloc(184 - payload.length - 1 - 1 - pcrBuf.length, 0xFF)]); // afl 1B + flags 1B
    af = Buffer.concat([Buffer.from([body.length]), body]);
  }
  hdr[3] = ((af ? 3 : 1) << 4) | nextCc(pid);
  return Buffer.concat([hdr, af || Buffer.alloc(0), payload]);
}

// PSI 单节单包（PAT/PMT 均 < 184B）：pointer_field=0 + section + 0xFF stuffing
function psiPacket(pid, section) {
  const payload = Buffer.alloc(184);
  payload[0] = 0;
  section.copy(payload, 1);
  for (let i = 1 + section.length; i < 184; i++) payload[i] = 0xFF;
  return tsPacket(pid, payload, true, null);
}

function patSection() { // PAT：program 1 → PMT PID 0x1000
  const body = Buffer.from([0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xF0, 0x00]);
  return Buffer.concat([body, crcTail(body)]);
}
function pmtSection() { // PMT：stream_type 0x03（MPEG-1 audio）→ ES PID 0x100，PCR 挂同 PID
  const body = Buffer.from([0x02, 0xB0, 0x12, 0x00, 0x01, 0xC1, 0x00, 0x00, 0xE1, 0x00, 0xF0, 0x00, 0x03, 0xE1, 0x00, 0xF0, 0x00]);
  return Buffer.concat([body, crcTail(body)]);
}

function pesPacket(payload, pts) { // MPEG audio PES（stream_id 0xC0，仅 PTS）
  const h = Buffer.alloc(14);
  h[0] = 0; h[1] = 0; h[2] = 1; // packet_start_code_prefix（alloc 全零，缺这组整段不被识别为 PES）
  h[3] = 0xC0; h[4] = (5 + payload.length) >> 8; h[5] = (5 + payload.length) & 0xFF;
  h[6] = 0x80; h[7] = 0x80; h[8] = 5;
  // PTS 33bit → 5 字节（'0010'+b32..b30+'1' / b29..b22 / b21..b15+'1' / b14..b7 / b6..b0+'1'；除法取位防 32bit 截断）
  h[9] = 0x20 | (Math.floor(pts / 0x40000000) % 8) * 2 + 1; // b32..b30（'0010' 前缀 + 尾标记位）
  h[10] = Math.floor(pts / 0x400000) & 0xFF;
  h[11] = (Math.floor(pts / 0x8000) & 0x7F) * 2 + 1;
  h[12] = Math.floor(pts / 0x80) & 0xFF;
  h[13] = (pts % 0x80) * 2 + 1;
  return Buffer.concat([h, payload]);
}

function pesToTs(pes, withPcr) { // 431B PES → 184/184/63 三包：首包可带 PCR（占 8B adaptation），尾包 stuffing 补齐
  const out = [];
  let off = 0, first = true;
  while (off < pes.length) {
    const room = 184 - (first && withPcr != null ? 8 : 0);
    const end = Math.min(off + room, pes.length);
    out.push(tsPacket(0x100, pes.slice(off, end), first, first && withPcr != null ? withPcr : null));
    off = end; first = false;
  }
  return out;
}

function tsSegment(idx) { // 第 idx 片：PAT+PMT + 38 帧音频（PTS 全局连续，无漂移）
  const parts = [psiPacket(0, patSection()), psiPacket(0x1000, pmtSection())];
  for (let f = 0; f < SEG_FRAMES; f++) {
    const pts = Math.round((idx * SEG_FRAMES + f) * 90000 * 1152 / 44100);
    parts.push(...pesToTs(pesPacket(MP3_FRAME, pts), f === 0 ? pts : null));
  }
  return Buffer.concat(parts);
}

/* ---------- ICY 帧（metaint=32 + StreamTitle 换歌两帧，web 侧 np-proxy fixture 同款格式） ---------- */

function icyBlock(title, frames) { // 一段音频按 32B 切片、每片后插 meta 块（1B 长度 + StreamTitle 补 \0 到 16 倍数）
  const meta = Buffer.from("StreamTitle='" + title + "';", 'utf8');
  const len = Math.ceil(meta.length / 16);
  const blk = Buffer.concat([Buffer.from([len]), meta, Buffer.alloc(len * 16 - meta.length, 0)]);
  const audio = mp3Chunk(frames), parts = [];
  for (let off = 0; off + METAINT <= audio.length; off += METAINT)
    parts.push(audio.slice(off, off + METAINT), blk);
  return Buffer.concat(parts);
}
const ICY_A = icyBlock('歌名A', 32); // 换歌前帧块
const ICY_B = icyBlock('歌名B', 32); // 换歌后帧块（600ms 后切换）

/* ---------- 场景路由（方案 §3 L2.2 + L4 固定清单；--list 与 /__health 同源对账） ---------- */

// keep-open 共用壳：首吐 + 250ms 周期续吐 + 断开/TTL 回收（直流/ICY/慢流共用）
function keepAlive(res, tick) {
  tick(true);
  const iv = setInterval(() => tick(false), 250);
  const ttl = setTimeout(() => { try { res.end(); } catch (_) {} }, STREAM_TTL_MS);
  res.on('close', () => { clearInterval(iv); clearTimeout(ttl); });
}
const audioHead = res => res.writeHead(200, { 'Content-Type': 'audio/mpeg' });

const ROUTES = [ // [路径, 说明] —— 固定枚举，安卓测试断言与 workflow 日志按清单对账
  ['/direct.mp3',    '直流 MP3 持续吐字节（真帧 keep-open，首吐 60 帧 + 16 帧/250ms）'],
  ['/direct-b.mp3',  '第二直流 MP3（切台用例目标台）'],
  ['/icy.mp3',       'ICY 直流：icy-metaint=32 + icy-br + StreamTitle 换歌两帧（歌名A→600ms→歌名B）'],
  ['/hls/master.m3u8', 'HLS master（相对引用 variant.m3u8）'],
  ['/hls/variant.m3u8', 'HLS 直播滑窗播放列表（1s×3 片无 ENDLIST，按墙钟滚动）'],
  ['/hls/seg<i>.ts', 'HLS 分片（MP3-in-TS，真帧可解）'],
  ['/slow.mp3',      '延迟建流 1.5s 后直流（建流慢源口径）'],
  ['/drop.mp3',      '断流：头部 + 8 字节后 150ms destroy'],
  ['/fake.mp3',      '336B 假流（200 OK audio/mpeg 但不可解码）'],
  ['/html.mp3',      'HTML 错误页（200 OK text/html，状态码/内容类型矛盾形态）'],
  ['/__health',      'fixture 自检 JSON（版本 + 路由清单；宿主 curl 验证用）'],
];

const HANDLERS = {
  '/direct.mp3': res => { audioHead(res); keepAlive(res, first => { if (first) res.write(mp3Chunk(60)); else res.write(mp3Chunk(16)); }); },
  '/direct-b.mp3': res => { audioHead(res); keepAlive(res, first => { if (first) res.write(mp3Chunk(60)); else res.write(mp3Chunk(16)); }); },
  '/icy.mp3': res => { // 首帧即达 + 600ms 换歌帧 + 周期续吐（icy-br 走响应头）
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-metaint': String(METAINT), 'icy-br': '128' });
    res.write(ICY_A);
    const t = setTimeout(() => { try { res.write(ICY_B); } catch (_) {} }, 600);
    keepAlive(res, first => { if (!first) res.write(ICY_B); });
    res.on('close', () => clearTimeout(t));
  },
  '/hls/master.m3u8': res => { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nvariant.m3u8\n'); },
  '/hls/variant.m3u8': res => { // 直播滑窗：1s 一片按墙钟滚动（永不 ENDLIST——直播不该 ended）
    const k = Math.floor((Date.now() - startedAt) / 1000);
    const first = Math.max(0, k - 2);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:' + first];
    for (let i = first; i <= k; i++) lines.push('#EXTINF:1.0,', 'seg' + i + '.ts');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(lines.join('\n') + '\n');
  },
  '/slow.mp3': res => { audioHead(res); setTimeout(() => keepAlive(res, first => { // 建流 1.5s 后才吐字节
    if (first) res.write(mp3Chunk(60)); else res.write(mp3Chunk(16)); }), 1500); },
  '/drop.mp3': res => { audioHead(res); res.write(Buffer.alloc(8, 0x07)); // 头部 + 几字节先出再断（destroy 过早会连头吞掉）
    setTimeout(() => { try { res.destroy(); } catch (_) {} }, 150); },
  '/fake.mp3': res => { audioHead(res); res.end(Buffer.alloc(336, 0x5A)); }, // 336B：可建连、不足一帧、不可解
  '/html.mp3': res => { res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>502 Bad Gateway</body></html>'); },
  '/__health': res => { res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: FIXTURE_VERSION, routes: ROUTES.map(r => r[0]) })); },
};

let startedAt = 0; // 滑窗播放列表的墙钟锚（start() 时刻）
let open = [];     // 活跃响应（close() 全量断开用）

function handler(req, res) {
  open.push(res);
  res.on('close', () => { const i = open.indexOf(res); if (i >= 0) open.splice(i, 1); });
  res.on('error', () => {}); // 客户端中途断开（模拟器回收）不许炸进程
  let path = req.url;
  const qi = path.indexOf('?');
  if (qi >= 0) path = path.slice(0, qi);
  console.log('[fixture] ' + req.method + ' ' + path);
  const seg = /^\/hls\/seg(\d+)\.ts$/.exec(path);
  if (seg) {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    return res.end(tsSegment(+seg[1]));
  }
  const h = HANDLERS[path];
  if (!h) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no route'); }
  return h(res);
}

/* ---------- 生命周期 ---------- */

function start() { // 程序化入口（测试编排 require）：0.0.0.0 随机端口 → { port, url, close, routes }
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (_) {} });
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      startedAt = Date.now();
      const port = server.address().port;
      resolve({
        port,
        url: 'http://127.0.0.1:' + port,
        routes: ROUTES.map(r => r[0]),
        close: () => new Promise(ok => {
          for (const c of open.slice()) { try { c.destroy(); } catch (_) {} }
          server.close(ok);
        }),
      });
    });
  });
}

module.exports = { FIXTURE_VERSION, ROUTES, start };

if (require.main === module) { // 独立 CLI：--list 打印路由清单；否则常驻并打印协议行（workflow 解析口径）
  if (process.argv.indexOf('--list') >= 0) {
    console.log('FIXTURE_VERSION=' + FIXTURE_VERSION);
    for (const r of ROUTES) console.log(r[0] + '\t' + r[1]);
  } else {
    start().then(fx => {
      console.log('FIXTURE_VERSION=' + FIXTURE_VERSION);
      console.log('FIXTURE_URL=http://127.0.0.1:' + fx.port);
      console.log('# 模拟器侧访问宿主回环固定映射：http://10.0.2.2:' + fx.port + '（宿主侧换算）');
      console.log('# 路由清单：node test/harness/android-fixture.js --list');
    }, e => { console.error('fixture 启动失败：' + (e && e.message || e)); process.exit(1); });
  }
}
