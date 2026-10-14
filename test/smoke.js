// VRadio 烟雾测试（audit-2026-10-14 R1 落地）—— 零依赖：node 内置 assert + 子进程起真服务打真端口，离线秒级。
// 覆盖面：静态拦截矩阵（dotfile/.bak/data 段的大小写与尾点变形、方法校验、nosniff）、/proxy 与 /api/* 跨源
// 拒绝、Host 头白名单（rebinding 面）、safeTarget/guardLookup 双层护栏、classifyCn 幂等、
// /api/store 白名单 + rev 发号 round-trip + 重启续发号（AIbot P2-1 回归）+ 超限显式拒绝。
// 用户数据保护（AIbot P2-4）：已有 data/store.json 先备份为 .smokebak 落盘（硬中断可恢复，SIGINT 自动还原）、
// 只写 store.json 相关文件、跑完还原现场（原无 data/ 则整目录清掉）。跑法：npm test。全部离线。
const assert = require('assert'), http = require('http'), net = require('net'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const { safeTarget, guardLookup, classifyCn, splitSections, countEntries } = require('../update-sources');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });

// 空闲端口探测（AIbot P3-3：固定端口被占会整场假红，两轮会话各取新口避开 kill 后端口释放竞态）
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
let PORT = 0;
const req = (m, p, headers = {}, body = null) => new Promise((resolve, reject) => {
  if (body != null && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(body);
  const r = http.request({ host: '127.0.0.1', port: PORT, method: m, path: p, headers }, res => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  r.on('error', reject); r.end(body);
});
const UP = path.join(__dirname, '..');
const boot = () => new Promise(async (resolve, reject) => { // 起服 + 就绪轮询（替代裸 sleep）
  // HOST 显式钉死（AIbot P2-2）：宿主机若导出 HOST=0.0.0.0，子进程按自担风险档跳过白名单，用例假红
  const srv = spawn(process.execPath, [path.join(UP, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { // 最多 ~6s，慢机不假败
    await new Promise(r => setTimeout(r, 100));
    try { const r = await req('GET', '/'); if (r.status === 200) return resolve(srv); } catch (_) {}
    if (srv.exitCode !== null) return reject(new Error('server 启动即退出'));
  }
  srv.kill(); reject(new Error('server 6s 未就绪'));
});

(async () => {
  console.log('[1] 字符串级护栏 safeTarget');
  await ok('拒环回/私网/链路本地/.local/IPv6 私网字面量/十进制 IP/非 http', () => {
    for (const u of ['http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/',
      'http://172.31.255.1/', 'http://169.254.1.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[fd00::1]/',
      'http://[fc00::2]/', 'http://[fe80::1]/', 'http://x.local/', 'ftp://example.com/', 'http://2130706433/'])
      assert.strictEqual(safeTarget(u), null, u); // 100.64/10 CGNAT 属连接层 guardLookup 管辖，字符串层设计上不拦
  });
  await ok('放行公网 http(s)（含 172.32+/100.128 边界外）', () => {
    for (const u of ['http://example.com/', 'https://a.b/c?d=1', 'http://8.8.8.8/', 'http://172.32.0.1/', 'http://100.128.0.1/'])
      assert.ok(safeTarget(u), u);
  });

  console.log('[2] 连接级护栏 guardLookup');
  await ok('localhost 解析被拒（环回地址不许建连——TOCTOU 兜底层）', () => new Promise((resolve, reject) =>
    guardLookup('localhost', {}, err => err ? resolve() : reject(new Error('未拦截')))));

  console.log('[3] classifyCn 幂等（自身产物再喂入不变形）');
  const FIXTURE = ['华语音乐,#genre#', '动感101,http://a/1.mp3', '新闻资讯,#genre#', 'XX新闻台,http://b/2.m3u8',
    '世界,#genre#', 'CNA 938,http://c/3.mp3', 'JJ FM,http://d/4.mp3',
    '欧美音乐,#genre#', 'Foo Radio [英国],http://e/5.mp3', 'BBC Radio 2,http://f/6.mp3'].join('\r\n');
  await ok('两轮分类输出稳定（新式节原样保留 + 捞回/世界拆分不重放）', () => {
    const r1 = classifyCn(splitSections(FIXTURE));
    const text1 = [];
    // 按 CAT_ORDER 装配（欧美系两节喂捞回行——与 syncSources 主拼装同构）
    for (const c of ['华语音乐', '欧美音乐', '亚洲·港台', '国际新闻·谈话', '新闻资讯', '交通广播', '文艺·生活', '财经', '综合·其他']) {
      const body = c === '欧美音乐' || c === '国际新闻·谈话' ? r1.euExtra[c] : r1.out[c];
      if (body && body.length) text1.push(c + ',#genre#', ...body);
    }
    const r2 = classifyCn(splitSections(text1.join('\r\n')));
    assert.deepStrictEqual(r2.out, r1.out);
    assert.deepStrictEqual(r2.euExtra, r1.euExtra);
  });
  await ok('countEntries 计数跳过节头', () => assert.strictEqual(countEntries(FIXTURE.split(/\r?\n/)), 6));

  console.log('[4] 真服务端到端（子进程，空闲端口自动探测）');
  const DATA = path.join(UP, 'data'), STORE = path.join(DATA, 'store.json'), BAK = STORE + '.smokebak';
  const hadStore = fs.existsSync(STORE), hadDir = fs.existsSync(DATA);
  if (hadStore) { fs.copyFileSync(STORE, BAK); fs.unlinkSync(STORE); } // 备份落盘不进内存（AIbot P2-4 硬中断可恢复）+ 干净库起测（AIbot P2-1：「rev 从 1 发号」断言才有确定语义）
  process.on('SIGINT', () => { // 中断兜底：先还原用户数据再退
    try { if (fs.existsSync(BAK)) { fs.copyFileSync(BAK, STORE); fs.unlinkSync(BAK); } } catch (_) {}
    process.exit(130);
  });
  let srv = null, srv2 = null;
  try {
    PORT = await freePort();
    srv = await boot();
    await ok('GET / 200（含 nosniff，audit A6）', async () => {
      const r = await req('GET', '/');
      assert.strictEqual(r.status, 200); assert.ok(r.body.includes('VRadio'));
      assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    });
    await ok('GET /radio.txt 200', async () => assert.strictEqual((await req('GET', '/radio.txt')).status, 200));
    await ok('dotfile 403', async () => assert.strictEqual((await req('GET', '/.git/config')).status, 403));
    await ok('data 段 403（含大小写/尾点变形——Windows 绕过根治，audit A1）', async () => {
      for (const p of ['/data/store.json', '/DATA/store.json', '/Data/store.json', '/data./store.json'])
        assert.strictEqual((await req('GET', p)).status, 403, p);
    });
    await ok('.bak 403（含 .BAK/尾点变形）', async () => {
      for (const p of ['/radio.txt.bak', '/radio.txt.BAK', '/radio.txt.bak.'])
        assert.strictEqual((await req('GET', p)).status, 403, p);
    });
    await ok('静态方法校验：POST /index.html → 405（audit A4）', async () => assert.strictEqual((await req('POST', '/index.html')).status, 405));
    await ok('/proxy 方法校验：POST → 405（AIbot P3-4）', async () =>
      assert.strictEqual((await req('POST', '/proxy?url=' + encodeURIComponent('http://example.com/'))).status, 405));
    await ok('radio-data.js 一天缓存头', async () => {
      const r = await req('GET', '/radio-data.js');
      assert.ok(/max-age=86400/.test(r.headers['cache-control'] || ''), r.headers['cache-control']);
    });
    await ok('/proxy 拒跨站驱动（Sec-Fetch-Site: cross-site → 403，audit A2，仅 Chromium 闭环见 server 注释）', async () =>
      assert.strictEqual((await req('GET', '/proxy?url=' + encodeURIComponent('http://example.com/'), { 'Sec-Fetch-Site': 'cross-site' })).status, 403));
    await ok('/proxy 拒私网目标（字符串层）', async () =>
      assert.strictEqual((await req('GET', '/proxy?url=' + encodeURIComponent('http://127.0.0.1/'))).status, 403));
    await ok('Host 头校验：伪造 Host → 403（rebinding 面，audit A3）', async () =>
      assert.strictEqual((await req('GET', '/', { Host: 'evil.example' })).status, 403));
    await ok('正常 localhost Host 放行', async () =>
      assert.strictEqual((await req('GET', '/', { Host: 'localhost:' + PORT })).status, 200));
    await ok('/api/store 拒跨源 Origin', async () =>
      assert.strictEqual((await req('GET', '/api/store', { Origin: 'http://evil.com' })).status, 403));
    await ok('/api/check 拒私网目标', async () =>
      assert.strictEqual((await req('GET', '/api/check?url=' + encodeURIComponent('http://127.0.0.1/'))).status, 400));
    await ok('/api/sync 拒跨站 POST', async () =>
      assert.strictEqual((await req('POST', '/api/sync', { 'Sec-Fetch-Site': 'cross-site' })).status, 403));
    await ok('/api/nowplaying 对 .M3U8 大小写变形短路返回空（不建旁路连接）', async () => {
      const r = await req('GET', '/api/nowplaying?url=' + encodeURIComponent('http://example.com/live.M3U8'));
      assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(r.body).title, '');
    });
    await ok('/api/store 白名单 + rev 发号 round-trip（干净库从 1 起）', async () => {
      const p1 = JSON.stringify({ data: { 'radio.favs': '[]', 'radio.nope': 'x' } });
      const w1 = await req('POST', '/api/store', { 'Content-Type': 'application/json' }, p1);
      assert.strictEqual(JSON.parse(w1.body).rev, 1, 'rev 由服务端发号');
      const j = JSON.parse((await req('GET', '/api/store')).body);
      assert.strictEqual(j.rev, 1);
      assert.deepStrictEqual(Object.keys(j.data), ['radio.favs'], '白名单外键静默丢弃');
    });
    await ok('/api/store 拒超限键（413 显式可感知）', async () => {
      const big = JSON.stringify({ data: { 'radio.favs': 'x'.repeat(600 * 1024) } });
      assert.strictEqual((await req('POST', '/api/store', { 'Content-Type': 'application/json' }, big)).status, 413);
    });

    // 重启续发号回归（AIbot P2-1）：预置 rev=5，重启后首个请求直接 POST → 应发 6 而非从 1 重发。
    // 旧实现 storeWrite 不先读盘、rev 只在 GET 懒装载——重启后首 POST 覆写 rev=1，旧窗口高 rev 镜像被静默压掉
    PORT = await freePort();
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify({ rev: 5, data: { 'radio.vol': '50' } }));
    srv2 = await boot();
    await ok('重启后首 POST rev 续发（预置 rev=5 → 发 6，AIbot P2-1）', async () => {
      const w = await req('POST', '/api/store', { 'Content-Type': 'application/json' }, JSON.stringify({ data: { 'radio.favs': '[]' } }));
      assert.strictEqual(JSON.parse(w.body).rev, 6);
    });
  } finally {
    if (srv) srv.kill(); if (srv2) srv2.kill();
    // 现场还原（AIbot P2-4）：只动测试涉及的文件，原无 data/ 才整目录清掉
    try { fs.unlinkSync(STORE); fs.unlinkSync(STORE + '.tmp'); } catch (_) {}
    if (hadStore) { try { fs.copyFileSync(BAK, STORE); fs.unlinkSync(BAK); } catch (_) {} }
    if (!hadDir) { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) {} }
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('烟雾测试异常：', e); process.exit(1); });
