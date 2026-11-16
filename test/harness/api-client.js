// 真服务子进程引导（P0a 最小版，从 test/smoke.js 口径提炼）：空闲端口 + 就绪轮询 + isolated 隔离。
// review#37 P1-1 修订：isolated 从「快照-清场-还原宿主文件」改为「复制仓库骨架到独立临时应用根再起服」——
// 旧方案四宗罪：①清场窗口与常驻 dev 服务/并行测试写盘竞争，结束恢复会确定性抹掉新数据；②进程 kill -9/
//   异常退出无法保证还原；③close 先 kill 立即还原、不等子进程退出，旧进程仍可能回写刚还原的文件；
//   ④data 目录整扫删 .tmp 会误删其他实例的临时文件。随机端口只是网络隔离，从来不是存储隔离。
// 新语义：宿主用户数据（data/*.json、my-radio.txt）与生成资产零接触；close = 杀服 → 等待退出 → 删自有临时根。
// boot({root}) 复用既有临时根重启服务（「操纵资产 → 重启」矩阵用，第二轮不重新复制）。
// 隔离默认化（review#39-r2 P2-③）：boot() 未传 isolated 也未传 root 时默认 isolated（临时应用根）——未来新增
// 写盘 API 测试漏传 opts 不再污染宿主工作树；显式 isolated:false 或 root:ROOT 才落宿主工作树（当前无调用方）。
// P1 扩展：boot({env}) 注入 VR_TEST_* 测试缝环境变量（PORT/HOST 在 env 之后钉死——测试缝不得改端口/监听地址）。
const http = require('http'), net = require('net'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// 有默认超时的请求器：服务「接受连接但不响应」时必须 reject（有报告的测试失败），不是让 CI 等全局超时
const reqFn = (port, timeoutMs) => (m, p, headers, body) => new Promise((resolve, reject) => { // JSON/文本两用 → {status, headers, body}
  headers = headers || {}; body = body == null ? null : body;
  if (body != null && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(body);
  const r = http.request({ host: '127.0.0.1', port, method: m, path: p, headers }, res => {
    const cs = []; res.on('data', c => cs.push(c));
    res.on('end', () => { clearTimeout(t); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(cs).toString('utf8') }); });
    res.on('error', e => { clearTimeout(t); reject(e); });
  });
  const t = setTimeout(() => { r.destroy(); reject(new Error('req 超时(' + (timeoutMs || 10000) + 'ms): ' + m + ' ' + p)); }, timeoutMs || 10000);
  r.on('error', e => { clearTimeout(t); reject(e); });
  r.end(body);
});

// ---------- 临时应用根：复制仓库骨架（排除用户数据/生成物/开发目录），服务从该根起、写盘全部落在其中 ----------
const SKIP_DIRS = { '.git': 1, node_modules: 1, '.ci': 1, 'ui-demo': 1, test: 1, docs: 1, android: 1, data: 1, '.tmp': 1, '.zcode': 1, '.github': 1, stash: 1 };
const SKIP_FILES = { 'my-radio.txt': 1, 'radio.cfg': 1, 'radio.txt.bak': 1, 'package-lock.json': 1, 'local.properties': 1 };
function copyTree(src, dst) { // Node 14 无 fs.cpSync——手写递归复制（骨架仅数百 KB～几 MB，同步复制即可）
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.isDirectory()) continue;
    if (e.isDirectory()) { if (!SKIP_DIRS[e.name]) copyTree(path.join(src, e.name), path.join(dst, e.name)); }
    else if (e.isFile() && !e.name.startsWith('.') && !SKIP_FILES[e.name] && !/\.bak$|\.tmp/.test(e.name)) {
      fs.writeFileSync(path.join(dst, e.name), fs.readFileSync(path.join(src, e.name)));
    }
  }
}
let rootSeq = 0;
function makeRoot() {
  const dir = path.join(os.tmpdir(), 'vradio-boot-' + process.pid + '-' + (++rootSeq) + '-' + Math.random().toString(36).slice(2, 8));
  copyTree(ROOT, dir);
  return dir;
}
function rmRoot(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error('临时根清理失败（记录不吞）:', dir, (e && e.code) || e); } }

// ---------- 仓库根快照/还原（显式操作 ROOT 用：assets 一致性校验等直读直写场景；isolated boot 不再使用） ----------
// 宿主用户数据清单（server.js 全部写路径；snapshot/restore 字节级对称）
const HOST_FILES = ['my-radio.txt', 'data/store.json', 'data/quality.json', 'data/listen-stats.json'];
// 仓库根生成资产清单（update-sources.js SYNC_ASSETS 四资产 + 发布 manifest）
const ASSET_FILES = ['radio.txt', 'radio-data.js', 'logos.txt', 'radio-meta.json', 'sync-manifest.json'];

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
  if (!snap.dirExisted) { try { fs.rmdirSync(path.join(ROOT, 'data')); } catch (_) {} }
}

// 生成资产快照：根文件逐个 Buffer + .tmp 整目录递归（发布协议的 sync-prev/prev-old/临时目录都在其中）
function snapshotAssets() {
  const tmpDir = path.join(ROOT, '.tmp');
  const snap = { files: {}, tmp: {}, tmpExisted: fs.existsSync(tmpDir) };
  for (const f of ASSET_FILES) { const fp = path.join(ROOT, f); if (fs.existsSync(fp)) snap.files[f] = fs.readFileSync(fp); }
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) snap.tmp[r] = fs.readFileSync(path.join(dir, e.name));
    }
  };
  if (snap.tmpExisted) walk(tmpDir, '');
  return snap;
}
function restoreAssets(snap) { // 字节级对称：快照没有的一律删除（含 .tmp 整目录与 manifest 写入的固定名临时残留）
  for (const f of ASSET_FILES) {
    const fp = path.join(ROOT, f);
    if (snap.files[f]) fs.writeFileSync(fp, snap.files[f]);
    else if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) {} }
  }
  try { fs.unlinkSync(path.join(ROOT, 'sync-manifest.json.tmp')); } catch (_) {} // writeBootstrapManifest 固定名临时文件
  try { fs.rmSync(path.join(ROOT, '.tmp'), { recursive: true, force: true }); } catch (_) {}
  if (snap.tmpExisted) {
    fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
    for (const rel of Object.keys(snap.tmp)) {
      const fp = path.join(ROOT, '.tmp', rel.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, snap.tmp[rel]);
    }
  }
}

// SIGINT 兜底（单监听器注册表）：boot 自管清理与测试自管快照统一入册，中断时全部尽力执行再退 130
const cleanups = [];
process.on('SIGINT', () => { for (const f of cleanups.splice(0)) { try { f(); } catch (_) {} } process.exit(130); });
const addCleanup = fn => { cleanups.push(fn); };

async function boot(opts) {
  opts = opts || {};
  if (opts.assets) throw new Error('boot({assets}) 已废弃：isolated 服务写生成资产落在临时根内，宿主零接触，无需仓库根快照（直读直写 ROOT 的场景用 snapshotAssets/restoreAssets）');
  const port = await freePort();
  let root = opts.root || null, ownsRoot = false;
  if (!root && opts.isolated !== false) { root = makeRoot(); ownsRoot = true; } // 隔离默认化（review#39-r2 ③）：无显式 root 一律临时应用根；isolated:false 才显式落宿主根
  // env 注入在前、PORT/HOST 钉死在后：测试缝（VR_TEST_*）不得改端口/监听地址
  const srv = spawn(process.execPath, [path.join(root || ROOT, 'server.js')], { env: Object.assign({}, process.env, opts.env || {}, { PORT: String(port), HOST: '127.0.0.1' }), cwd: root || ROOT, stdio: 'ignore' });
  const req = reqFn(port);
  let closed = null;
  const cleanup = () => { try { srv.kill(); } catch (_) {} if (ownsRoot) rmRoot(root); }; // SIGINT 同步兜底：尽力杀服 + 删根
  cleanups.push(cleanup);
  function close() { // 幂等：先杀服 → 等待子进程退出（旧进程不得回写）→ 删自有临时根；清理失败记录不吞
    if (!closed) closed = (async () => {
      try { srv.kill(); } catch (_) {}
      const i = cleanups.indexOf(cleanup); if (i >= 0) cleanups.splice(i, 1);
      await new Promise(ok => {
        if (srv.exitCode !== null) return ok();
        const hard = setTimeout(() => { try { srv.kill('SIGKILL'); } catch (_) {} setTimeout(ok, 300); }, 1500);
        srv.once('exit', () => { clearTimeout(hard); ok(); });
      });
      if (ownsRoot) rmRoot(root);
    })();
    return closed;
  }
  const probe = reqFn(port, 2000); // 就绪轮询单轮 2s 上限：挂死服务按「启动失败」报告，不无限等
  for (let i = 0; i < 60; i++) { // 就绪轮询 ~6s 上限（慢机不假败）
    await new Promise(r => setTimeout(r, 100));
    try { const r = await probe('GET', '/'); if (r.status === 200) return { srv, port, req, close, root: root || ROOT }; } catch (_) {}
    if (srv.exitCode !== null) { await close(); throw new Error('server 启动即退出'); }
  }
  await close(); throw new Error('server 6s 未就绪');
}

module.exports = { boot, freePort, reqFn, makeRoot, snapshotHost, restoreHost, snapshotAssets, restoreAssets, addCleanup, HOST_FILES, ASSET_FILES, ROOT };
