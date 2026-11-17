// /api/nowplaying + /proxy 真服务端到端矩阵（P1 统一 API 矩阵，docs/testing-strategy-2026-11.md §3 L2 覆盖总表两行）：
// 本地回环 fixture（harness/http-fixture.js）+ server.js 测试注入缝 VR_TEST_GUARD=1（safe 放行 http(s) 形态、
// lookup 钉死 127.0.0.1——流地址写 127.0.0.1:<fixture端口> 直达本地 fixture，生产零影响，缝见 server.js 顶部注释）。
// 与 harness/api-client.js 的差异：其 boot 暂无 env 注入参数（P1a 批在扩）——本文件自带 boot（quality.js 同款
// spawn + env），仅复用 harness 的 freePort/reqFn；P1 归拢后迁回 boot({env})。
// 覆盖矩阵（任务稿 A1-A8/B9-B13）：
//   [1] 常量对齐：NP_MAX/NP_IDLE/NP_RETRY 源码字面量（30s/60s 时钟黑盒不可注入，防静默漂移；A7）
//   [2] nowplaying：ICY 基线 title+br（A1）/ 换歌近实时且不重连（A2）/ 无 icy-metaint 负缓存不重建（A3）/
//       404 同走负缓存 / .m3u8 大小写短路 fixture 零请求（A4）/ 上游断连 deadAt 冷却：窗口内不重建+保留最后
//       曲名（A5）/ 中途断流失效 / 畸形重定向 deadAt / 重定向私网会话死亡（A8 安全回归）/ 跨源 403（补钉）
//   [3] proxy：302 逐跳跟跳内容来自目标（B9）/ 畸形 Location 403（B10）/ Content-Range 透传（B11）/
//       上游中途断流响应终止不挂死（B12）/ 客户端断开回收上游（P2-2 防直播流泄漏，覆盖总表补齐项）
//   [4] 并发封顶：NP_MAX=2 第三会话挤掉最旧（fixture 断开事件）+ 活跃连接 ≤2（A6，fresh server 淘汰序确定）
//   [5] 无缝默认 boot：私网/环回 → 400 {title:""} 且零旁路请求（A8 SSRF 回归）
// 未覆盖项：
//   - NP_IDLE=30s 空闲回收的真实触发（npStart 入口清扫 + 全局回收器）与 NP_RETRY=60s 冷却结束后的「重建成功」
//     半边——不真等 30s/60s，仅 [1] 常量对齐；窗口内拒绝已由 [2] 钉死
//   - 任务稿「404 → deadAt」按实现不成立：状态码不分支，无 icy 头一律落 noIcy 负缓存（[2] 以实现为准断言）
//   - proxy 私网 403 / nowplaying·proxy 方法校验 405——smoke.js 已覆盖不重复（B13 就略）
//   - https 上游、重定向深度上限（depth>3）——diagnostic.js 已覆盖同型护栏路径
const assert = require('assert'), http = require('http'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const { freePort, reqFn } = require('./harness/api-client');
const { fixture } = require('./harness/http-fixture');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms, step) => { // 轮询到断言成立（旁路会话异步建立、ICY 帧异步到达——首次 GET 常为空）
  const t0 = Date.now(); step = step || 100;
  for (;;) {
    const v = await fn(); if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('轮询超时（' + ms + 'ms）');
    await sleep(step);
  }
};

// 自带 boot（env 注入；quality.js 口径）：空闲端口 + 就绪轮询 + kill 等退出（幂等，可重复调）
const boot = env => new Promise(async (resolve, reject) => {
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')],
    { env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1' }, env || {}), stdio: 'ignore' });
  const req = reqFn(port);
  const kill = () => new Promise(done => {
    try { srv.kill(); } catch (_) {}
    if (srv.exitCode !== null) return done();
    srv.on('exit', done); setTimeout(done, 1000);
  });
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try { if ((await req('GET', '/')).status === 200) return resolve({ srv, port, req, kill }); } catch (_) {}
    if (srv.exitCode !== null) return reject(new Error('server 启动即退出'));
  }
  await kill(); reject(new Error('server 6s 未就绪'));
});

// ICY 帧构造：metaint 个音频字节 + 1 字节长度（值×16）+ meta 载荷（StreamTitle，补 \0 到 16 倍数）——
// 小 metaint 让换歌/断连在毫秒级可见
const METAINT = 32;
const frame = (title, fill) => {
  const meta = Buffer.from("StreamTitle='" + title + "';", 'utf8');
  const len = Math.ceil(meta.length / 16);
  return Buffer.concat([Buffer.alloc(METAINT, fill), Buffer.from([len]), meta, Buffer.alloc(len * 16 - meta.length, 0)]);
};
const icyH = br => ({ 'Content-Type': 'audio/mpeg', 'icy-metaint': String(METAINT), 'icy-br': String(br) });

(async () => {
  // fixture 路由与记账：HITS = 各路径累计请求数（负缓存/冷却「不重建」断言面）、OPEN = 活跃连接数（封顶/回收断言面）
  const HITS = {}, OPEN = {};
  const track = (name, def) => { HITS[name] = 0; OPEN[name] = 0; return Object.assign({}, def, { stream: res => {
    HITS[name]++; OPEN[name]++;
    res.on('close', () => { OPEN[name]--; });
    def.stream(res);
  } }); };
  const R = {};
  const fx = fixture(R);
  const FPORT = await fx.listen();
  const B = 'http://127.0.0.1:' + FPORT;
  const CPORT = await freePort(); // 占后即关：私网重定向指向它 = 确定性必拒端口
  Object.assign(R, {
    '/icy.mp3': track('/icy.mp3', { headers: icyH(128), stream: res => { // A1/A2：首帧即达，500ms 后吐换歌帧，keep-open 不 end
      res.write(frame('歌名A', 0x61));
      setTimeout(() => { if (!res.destroyed) res.write(frame('歌名B', 0x62)); }, 500);
    } }),
    '/noicy.mp3': track('/noicy.mp3', { headers: { 'Content-Type': 'audio/mpeg' }, stream: res => res.end(Buffer.alloc(64, 0x08)) }), // 无 icy 头 → noIcy 负缓存（A3）
    '/404.mp3': track('/404.mp3', { status: 404, headers: { 'Content-Type': 'text/plain' }, stream: res => res.end('not found') }), // 状态码不分支：同落负缓存
    '/dead.mp3': track('/dead.mp3', { headers: icyH(96), stream: res => res.end(frame('冷却曲', 0x64)) }), // A5：吐一帧后干净 end → 上游断连 deadAt
    '/drop.mp3': track('/drop.mp3', { headers: icyH(64), stream: res => { res.write(Buffer.alloc(8, 0x07)); setTimeout(() => res.destroy(), 150); } }), // A5/B12：头部+几字节先出再断 = 中途断流（destroy 过早会连头部一起吞掉，客户端只见 ECONNRESET）
    '/302.mp3': track('/302.mp3', { status: 302, headers: { Location: B + '/icyshort.mp3' }, stream: res => res.end() }), // B9
    '/bad302.mp3': track('/bad302.mp3', { status: 302, headers: { Location: 'http://[' }, stream: res => res.end() }), // B10：畸形 Location（audit-r2 P2-1 同型）
    '/redirpriv.mp3': track('/redirpriv.mp3', { status: 302, headers: { Location: 'http://10.0.0.1:' + CPORT + '/x.mp3' }, stream: res => res.end() }), // A8：私网重定向
    '/icyshort.mp3': track('/icyshort.mp3', { headers: icyH(128), stream: res => res.end(frame('代理曲', 0x63)) }), // B9 跟跳目标：单帧即 end
    '/range.mp3': track('/range.mp3', { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 100-199/5000' }, stream: res => res.end(Buffer.alloc(100, 0x09)) }), // B11
    '/hold.mp3': track('/hold.mp3', { headers: { 'Content-Type': 'audio/mpeg' }, stream: res => { res.write(Buffer.alloc(16, 0x0a)); } }), // 持续流：客户端断开回收用
    '/c1.mp3': track('/c1.mp3', { headers: icyH(64), stream: res => res.write(frame('并发一', 0x51)) }), // A6：三条 keep-open 旁路流
    '/c2.mp3': track('/c2.mp3', { headers: icyH(64), stream: res => res.write(frame('并发二', 0x52)) }),
    '/c3.mp3': track('/c3.mp3', { headers: icyH(64), stream: res => res.write(frame('并发三', 0x53)) }),
  });

  let cur = null;
  process.on('SIGINT', () => { try { if (cur) cur.kill(); fx.close(); } catch (_) {} process.exit(130); }); // 硬中断兜底：先杀服再退
  const npGet = u => cur.req('GET', '/api/nowplaying?url=' + encodeURIComponent(u)).then(r => {
    if (r.status !== 200) throw new Error('nowplaying HTTP ' + r.status + ' ' + String(r.body).slice(0, 80));
    return JSON.parse(r.body);
  });
  const npTitle = (u, t) => until(() => npGet(B + u).then(x => x.title === t ? x : null), 5000);

  try {
    console.log('[1] 常量对齐（黑盒时钟行为的源码锚点）');
    await ok('NP_MAX=2 / NP_IDLE=30000 / NP_RETRY=60000（A7：不真等 30s/60s，字面量防静默漂移）', () => {
      const m = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').match(/const NP_MAX = (\d+), NP_IDLE = (\d+), NP_RETRY = (\d+);/);
      assert.ok(m, 'server.js NP 常量声明形态漂移');
      assert.strictEqual(+m[1], 2); assert.strictEqual(+m[2], 30000); assert.strictEqual(+m[3], 60000);
    });

    console.log('[2] /api/nowplaying 真服务（VR_TEST_GUARD=1 + 回环 fixture）');
    cur = await boot({ VR_TEST_GUARD: '1' });
    await ok('A1 ICY 基线：旁路会话建流 → title=歌名A 且 br=128（icy-br 随头同帧返回）', async () => {
      assert.strictEqual((await npTitle('/icy.mp3', '歌名A')).br, 128);
    });
    await ok('A2 换歌近实时：fixture 吐第二帧 → 下次 GET 返回新曲名（keep-open 不重连）', async () => {
      assert.strictEqual((await npTitle('/icy.mp3', '歌名B')).br, 128);
      assert.strictEqual(HITS['/icy.mp3'], 1, '换歌不得重连——仍是最初那条会话');
    });
    await ok('A3 无 icy-metaint → noIcy 负缓存：二次 GET 仍空且不重建（fixture 请求数不涨）', async () => {
      const j1 = await npGet(B + '/noicy.mp3');
      assert.strictEqual(j1.title, ''); assert.strictEqual(j1.br, 0);
      await until(() => HITS['/noicy.mp3'] === 1, 3000); // 首建连接已到达 fixture
      await sleep(200);
      assert.strictEqual((await npGet(B + '/noicy.mp3')).title, '');
      assert.strictEqual(HITS['/noicy.mp3'], 1, '负缓存命中：未重建连接');
    });
    await ok('上游 404 同走负缓存：状态码不分支（无 icy 头即 noIcy），二次 GET 不重建', async () => {
      await npGet(B + '/404.mp3');
      await until(() => HITS['/404.mp3'] === 1, 3000);
      await npGet(B + '/404.mp3');
      assert.strictEqual(HITS['/404.mp3'], 1);
    });
    await ok('A4 HLS 结构性无 ICY：.m3u8/.M3U8 立即空 title 且不建旁路（fixture 零请求）', async () => {
      const before = fx.conns.length;
      assert.strictEqual((await npGet(B + '/live.m3u8')).title, '');
      assert.strictEqual((await npGet(B + '/live.M3U8')).title, '');
      assert.strictEqual(fx.conns.length, before, '不建旁路连接');
    });
    await ok('A5 失败冷却（干净断连）：deadAt 置位 → 窗口内二次 GET 保留最后曲名且不重建', async () => {
      const j1 = await npTitle('/dead.mp3', '冷却曲');
      assert.strictEqual(j1.br, 96);
      await sleep(300); // end → deadAt 落定
      const j2 = await npGet(B + '/dead.mp3');
      assert.strictEqual(j2.title, '冷却曲', '冷却期保留最后曲名（server.js 口径）');
      assert.strictEqual(j2.br, 96);
      assert.strictEqual(HITS['/dead.mp3'], 1, 'NP_RETRY 60s 窗口内不重建');
    });
    await ok('A5 上游中途断流 → 会话失效：title 空、br 已随头、冷却内不重建', async () => {
      await npGet(B + '/drop.mp3');
      await until(() => HITS['/drop.mp3'] === 1, 3000);
      await sleep(500); // 断流 error → deadAt 落定
      const j2 = await npGet(B + '/drop.mp3');
      assert.strictEqual(j2.title, ''); assert.strictEqual(j2.br, 64);
      assert.strictEqual(HITS['/drop.mp3'], 1);
    });
    await ok('畸形重定向（Location: http://[）→ 会话死亡：title 空、冷却内不重建（tryUrl 归 null 不抛）', async () => {
      await npGet(B + '/bad302.mp3');
      await until(() => HITS['/bad302.mp3'] === 1, 3000);
      await sleep(300); // 重定向拒绝 → deadAt 落定
      assert.strictEqual((await npGet(B + '/bad302.mp3')).title, '');
      assert.strictEqual(HITS['/bad302.mp3'], 1);
    });
    await ok('A8 重定向到私网（10.0.0.1 + 必拒端口）→ 会话死亡终态：title 空、冷却内不重建', async () => {
      await npGet(B + '/redirpriv.mp3');
      await until(() => HITS['/redirpriv.mp3'] === 1, 3000);
      await sleep(500); // 私网跳连接被拒 → deadAt 落定（guard 下 lookup 钉回环 + 端口必拒；生产 safeTarget 直接拒，同落 deadAt）
      assert.strictEqual((await npGet(B + '/redirpriv.mp3')).title, '');
      assert.strictEqual(HITS['/redirpriv.mp3'], 1);
    });
    await ok('跨源驱动拒绝：Origin: evil → 403（带副作用 GET 与 /api/check 同口径）', async () =>
      assert.strictEqual((await cur.req('GET', '/api/nowplaying?url=' + encodeURIComponent(B + '/icy.mp3'), { Origin: 'http://evil.com' })).status, 403));

    console.log('[3] /proxy 真服务（同一 guard 服务 + fixture）');
    await ok('B9 302 逐跳跟跳 → 200 audio/mpeg，内容来自重定向目标（跟跳后真流字节）', async () => {
      const r = await cur.req('GET', '/proxy?url=' + encodeURIComponent(B + '/302.mp3'));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers['content-type'], 'audio/mpeg');
      assert.strictEqual(r.body.slice(0, METAINT), 'c'.repeat(METAINT), '载荷应为 /icyshort.mp3 的音频帧');
      assert.ok(r.body.includes("StreamTitle='代理曲';"), '应为跟跳目标的 ICY 帧');
      assert.strictEqual(Buffer.byteLength(r.body), METAINT + 1 + METAINT, '整帧字节布局');
      assert.strictEqual(HITS['/302.mp3'], 1); assert.strictEqual(HITS['/icyshort.mp3'], 1); // 恰好一跳
    });
    await ok('B10 畸形 Location → 403（tryUrl 归 null 按拒绝处理，不跟跳不抛）', async () => {
      const h0 = HITS['/bad302.mp3'];
      const r = await cur.req('GET', '/proxy?url=' + encodeURIComponent(B + '/bad302.mp3'));
      assert.strictEqual(r.status, 403);
      assert.strictEqual(HITS['/bad302.mp3'], h0 + 1, '只落第一跳');
    });
    await ok('B11 Content-Range 透传：206 与原始头原样到达客户端', async () => {
      const r = await cur.req('GET', '/proxy?url=' + encodeURIComponent(B + '/range.mp3'));
      assert.strictEqual(r.status, 206);
      assert.strictEqual(r.headers['content-range'], 'bytes 100-199/5000');
      assert.strictEqual(r.body.length, 100);
    });
    await ok('B12 上游中途断流 → 响应被终止不挂死（完整 end 判失败；error/aborted/close 均算终止）', () => new Promise((resolve, reject) => {
      const tm = setTimeout(() => reject(new Error('响应 10s 未终止（挂死）')), 10000);
      const rq = http.request({ host: '127.0.0.1', port: cur.port, path: '/proxy?url=' + encodeURIComponent(B + '/drop.mp3') }, res => {
        let done = false;
        const fin = why => { if (done) return; done = true; clearTimeout(tm); why ? reject(new Error(why)) : resolve(); };
        res.on('data', () => {});
        res.on('end', () => fin('上游断流却收到完整 end——响应应被终止'));
        res.on('aborted', () => fin()); res.on('close', () => fin()); res.on('error', () => fin());
      });
      rq.on('error', () => { clearTimeout(tm); resolve(); }); // 连接级终止同属「没挂死」
      rq.end();
    }));
    await ok('客户端断开 → 上游连接被回收（P2-2：直播流不泄漏，fixture 侧断开事件）', async () => {
      const rq = http.request({ host: '127.0.0.1', port: cur.port, path: '/proxy?url=' + encodeURIComponent(B + '/hold.mp3') }, res => {
        res.on('data', () => {}); res.on('error', () => {});
      });
      rq.on('error', () => {});
      rq.end();
      await until(() => OPEN['/hold.mp3'] === 1, 3000); // 上游已连
      await sleep(200); // pipe 已建立、res.on('close') 已挂
      rq.destroy(); // 客户端断开（换台/暂停的真实形态）
      await until(() => OPEN['/hold.mp3'] === 0, 3000, 50); // fixture 侧上游被销毁
    });

    console.log('[4] 并发封顶（fresh server：npSess 从空开始，LRU 淘汰序确定）');
    await cur.kill(); cur = await boot({ VR_TEST_GUARD: '1' });
    await ok('A6 NP_MAX=2：第三会话建立时最旧被回收（fixture 断开事件）且活跃旁路连接 ≤2', async () => {
      await npTitle('/c1.mp3', '并发一'); // 会话建立 + 帧到达（req 已挂，挤出才能真销毁连接）
      await npTitle('/c2.mp3', '并发二'); // c1 最后触碰早于 c2 → LRU 最旧 = c1
      assert.strictEqual((await cur.req('GET', '/api/nowplaying?url=' + encodeURIComponent(B + '/c3.mp3'))).status, 200);
      await until(() => OPEN['/c1.mp3'] === 0, 3000, 50); // 最旧被回收：上游连接销毁
      await npTitle('/c3.mp3', '并发三'); // 第三会话已建流供曲（连接建立先于断言）
      assert.strictEqual(OPEN['/c2.mp3'], 1); assert.strictEqual(OPEN['/c3.mp3'], 1);
      assert.strictEqual(HITS['/c1.mp3'], 1, '轮询期间会话复用零重连');
    });

    console.log('[5] 无缝默认 boot（无 VR_TEST_GUARD）——SSRF 回归');
    await cur.kill(); cur = await boot();
    await ok('A8 私网/环回目标 → 400 {title:""}（safeTarget 拒绝：不建会话、零旁路请求）', async () => {
      const before = fx.conns.length;
      for (const u of ['http://10.0.0.1/x.mp3', 'http://127.0.0.1:' + FPORT + '/icy.mp3']) {
        const r = await cur.req('GET', '/api/nowplaying?url=' + encodeURIComponent(u));
        assert.strictEqual(r.status, 400, u);
        assert.strictEqual(JSON.parse(r.body).title, '', u);
      }
      assert.strictEqual(fx.conns.length, before, '私网目标不得触达任何旁路连接');
    });
  } finally {
    if (cur) { try { await cur.kill(); } catch (_) {} }
    try { await fx.close(); } catch (_) {} // 会话是 keep-open 长连接：杀服 + 销毁全部 fixture 连接，不留挂起句柄
  }
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('np-proxy 测试异常：', e); process.exit(1); });
