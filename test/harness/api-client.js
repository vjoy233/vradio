// 真服务子进程引导（P0a 最小版，从 test/smoke.js 口径提炼）：空闲端口 + 就绪轮询 + isolated 快照/还原宿主用户数据。
// isolated=true 时 data/*.json + my-radio.txt 先快照后清场，close()（含 SIGINT 兜底）还原——测试绝不留宿主痕迹。
// P1 归拢时 smoke.js 迁移到本接口；扩 stdio 捕获与原始流读取（nowplaying 旁路用）。
const http = require('http'), net = require('net'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const reqFn = port => (m, p, headers, body) => new Promise((resolve, reject) => { // JSON/文本两用 → {status, headers, body}
  headers = headers || {}; body = body == null ? null : body;
  if (body != null && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(body);
  const r = http.request({ host: '127.0.0.1', port, method: m, path: p, headers }, res => {
    const cs = []; res.on('data', c => cs.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(cs).toString('utf8') }));
  });
  r.on('error', reject); r.end(body);
});

// 宿主用户数据清单（server.js 全部写路径；snapshot/restore 字节级对称）
const HOST_FILES = ['my-radio.txt', 'data/store.json', 'data/quality.json', 'data/listen-stats.json'];

function snapshotHost() {
  const snap = { files: {}, dirExisted: fs.existsSync(path.join(ROOT, 'data')) };
  for (const f of HOST_FILES) { const fp = path.join(ROOT, f); if (fs.existsSync(fp)) snap.files[f] = fs.readFileSync(fp); }
  return snap;
}
function restoreHost(snap) {
  for (const f of HOST_FILES) {
    const fp = path.join(ROOT, f);
    if (snap.files[f]) { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, snap.files[f]); }
    else if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  for (const f of fs.existsSync(path.join(ROOT, 'data')) ? fs.readdirSync(path.join(ROOT, 'data')) : []) // tmp+rename 半途残留清理（server.js tmpOf 唯一名含 .tmp 前缀即命中）
    if (/\.tmp/.test(f)) { try { fs.unlinkSync(path.join(ROOT, 'data', f)); } catch (_) {} }
  if (!snap.dirExisted) { try { fs.rmdirSync(path.join(ROOT, 'data')); } catch (_) {} }
}

async function boot(opts) {
  opts = opts || {};
  const port = await freePort();
  const snap = opts.isolated ? snapshotHost() : null;
  if (snap) {
    for (const f of HOST_FILES) { const fp = path.join(ROOT, f); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
    process.on('SIGINT', () => { try { restoreHost(snap); } catch (_) {} process.exit(130); }); // 硬中断兜底（smoke.js 同款）
  }
  // HOST 显式钉死（smoke.js AIbot P2-2 同款）：宿主若导出 HOST=0.0.0.0 会改变白名单行为导致用例假红
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' }), stdio: 'ignore' });
  const req = reqFn(port);
  function close() { // 杀服 + 还原宿主数据（幂等：服务已退/数据已还原都不炸）
    try { srv.kill(); } catch (_) {}
    if (snap) { try { restoreHost(snap); } catch (_) {} }
    return new Promise(ok => { if (srv.exitCode !== null) return ok(); srv.on('exit', ok); setTimeout(ok, 1000); });
  }
  for (let i = 0; i < 60; i++) { // 就绪轮询 ~6s 上限（慢机不假败）
    await new Promise(r => setTimeout(r, 100));
    try { const r = await req('GET', '/'); if (r.status === 200) return { srv, port, req, close, snap }; } catch (_) {}
    if (srv.exitCode !== null) { if (snap) restoreHost(snap); throw new Error('server 启动即退出'); }
  }
  await close(); throw new Error('server 6s 未就绪');
}

module.exports = { boot, freePort, reqFn, snapshotHost, restoreHost, HOST_FILES, ROOT };
