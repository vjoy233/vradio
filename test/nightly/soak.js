// test/nightly/soak.js —— 长时播放/连接回收演练（P3，docs/testing-strategy-2026-11.md §3 L5；时长可配）。
// 跑法：SOAK_SECONDS=1800 node test/nightly/soak.js（默认 60；编排入口 run.js --soak=N 转 env）。
// 公开参数下限：SOAK_SECONDS ≥ 10（跨台探测窗 = min(15s, 30% 时长)，10s 档 ≈3s 起探——探测按观察窗比例安排，
// 短时长不产生「断言自身没样本」的假红，review#41 任务 7）。
// 退出码语义（方案 §5 失败分类）：代码回归（串台/泄漏/5xx/写失败/rev 回退）= 非零；环境失败（端口/权限）= 报告标
// 「环境未执行」非零。报告：docs/test-reports/nightly/<run-id>/soak.json（每轮独立目录，逐断言入列，review#41 任务 6）。
// 覆盖矩阵：
//   [1] 页面行为仿真（VR_TEST_GUARD=1 + 回环 fixture + 真服务）：每 3s GET /api/nowplaying（icy 会话 keep-open，
//       页面 15s 轮询节奏的压缩版）+ 每 5s POST /api/quality 一条 + 每 10s POST /api/store 全量快照 +
//       每 30s GET /api/check?detail=1（首轮 5s 起探，短时 soak 也至少一条）
//   [2] 曲讯稳态：title 恒 ∈ fixture 已知集（不串台——跨台样本 /icy2.mp3 中段比对）+ icy-br 码率随头稳定 +
//       观察窗内旁路连接不堆积（fixture 侧 OPEN['/icy.mp3'] 恒 ≤1 = keep-open 会话复用）
//   [3] 收尾断言：全程零 5xx；quality/store rev 严格递增；**零失败预算**（review#41 任务 3：服务端写盘失败协议是
//       HTTP 200 {ok:false}，「零 5xx」发现不了持续丢写——无故障稳态 soak 本义即零失败：qualityFail/storeFail 必须
//       为 0、成功批数与发出批数一比一、结束前 GET /api/store 与 /api/quality 对账最终持久值（GET rev = 末次成功
//       写 rev、store 快照键回读一致），不做失败预算/重试收敛）；+10s 直流探活连接归零（probe 短连自收）；
//       icy 旁路会话空闲回收 ≤45s 归零（NP_IDLE=30s 全局回收器兜底，停轮询后连接不泄漏）；
//       RSS 增长 <80MB（仅 Linux /proc 可得；Windows 跳过并在报告注明——零依赖不解析 tasklist/wmic）
// 未覆盖项：
//   - RSS 判据的平台差：Windows 无 /proc，跳过不假报；Linux CI 夜间满时长生效
//   - 播放器内部时序（watchdog/自愈/睡眠定时）——player 层由 test/player.js fake audio 覆盖，本脚本只仿真页面 API 面；
//     Web Player 长时播放（真实浏览器 + 可解码音频数十分钟）属挂账项，见 docs/testing-strategy-2026-11.md §10 附录
//   - 30 分钟满时长仅 workflow 夜间跑（本地 --soak=N 缩样；时长只改变样本量，不改变断言语义——探测启动时刻按
//     min(15s, 30% 时长) 比例化后成立）
//   - 空闲回收的真实 30s 时钟不注入（黑盒轮询等待）；NP_RETRY 冷却后半边由 test/np-proxy.js 常量对齐钉死
const assert = require('assert'), fs = require('fs');
const { boot } = require('../harness/api-client');
const { fixture } = require('../harness/http-fixture');
const { openRun } = require('./report-dir');

let pass = 0, fail = 0;
const ctx = openRun(); // 每轮独立报告目录（env NIGHTLY_RUN_ID = 编排方已建目录；本地自算先清）
const asserts = [];
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); asserts.push({ name, pass: true, category: 'code-regression' }); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); asserts.push({ name, pass: false, category: 'code-regression', error: String(e && e.message || e).slice(0, 300) }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const METAINT = 32;
const frame = (title, fill) => { // ICY 帧：metaint 音频字节 + 1B 长度 + meta（补 \0 到 16 倍数），学 test/np-proxy.js
  const meta = Buffer.from("StreamTitle='" + title + "';", 'utf8');
  const len = Math.ceil(meta.length / 16);
  return Buffer.concat([Buffer.alloc(METAINT, fill), Buffer.from([len]), meta, Buffer.alloc(len * 16 - meta.length, 0)]);
};
const icyH = br => ({ 'Content-Type': 'audio/mpeg', 'icy-metaint': String(METAINT), 'icy-br': String(br) });
const readRss = pid => { // Linux CI：/proc/<pid>/status VmRSS（kB）；Windows 无 → null
  try { return fs.readFileSync('/proc/' + pid + '/status', 'utf8').match(/VmRSS:\s+(\d+)\s+kB/).slice(1).map(Number)[0]; } catch (_) { return null; }
};

(async () => {
  const t0 = Date.now();
  // SOAK_SECONDS：argv --soak=N > env > 默认 60；下限 10s 防退化（探测窗按 min(15s, 30% 时长) 比例化）
  const argSoak = (process.argv.find(a => /^--soak=\d+$/.test(a)) || '').slice(7);
  const S = Math.max(10, parseInt(argSoak || process.env.SOAK_SECONDS || '60', 10) || 60);
  // fixture 路由与记账（学 test/np-proxy.js track 口径）：HITS/OPEN = 请求数/活跃连接数
  const HITS = {}, OPEN = {};
  const track = (name, def) => { HITS[name] = 0; OPEN[name] = 0; return Object.assign({}, def, { stream: res => {
    HITS[name]++; OPEN[name]++;
    res.on('close', () => { OPEN[name]--; });
    def.stream(res);
  } }); };
  const R = {};
  const fx = fixture(R);
  const FPORT = await fx.listen();
  const FIX = 'http://127.0.0.1:' + FPORT;
  const TITLES = ['深夜情歌', '午夜点歌'];
  Object.assign(R, {
    '/icy.mp3': track('/icy.mp3', { headers: icyH(128), stream: res => { // 主曲讯台：首帧即达 + 每 1s 轮换曲名
      let i = 0; res.write(frame(TITLES[0], 0x61));
      const iv = setInterval(() => { if (res.destroyed) return clearInterval(iv); res.write(frame(TITLES[++i % 2], 0x62)); }, 1000);
    } }),
    '/icy2.mp3': track('/icy2.mp3', { headers: icyH(96), stream: res => res.write(frame('隔壁电台', 0x63)) }), // 跨台串音样本：单帧
    '/direct.mp3': track('/direct.mp3', { headers: { 'Content-Type': 'audio/mpeg' }, stream: res => { // 持续直流：探活对象
      const iv = setInterval(() => { if (res.destroyed) return clearInterval(iv); res.write(Buffer.alloc(2048, 0x7f)); }, 200);
    } }),
  });

  const counters = { nowplaying: 0, nowplayingTitle: 0, nowplayingBad: 0, quality: 0, qualityFail: 0, store: 0, storeFail: 0, check: 0, checkBad: 0, fiveXX: 0, connErr: 0 };
  let maxIcyOpen = 0, crossOk = false, crossAttempted = false;
  const qRevs = [], sRevs = [];
  let rssStart = null, rssEnd = null; // Linux /proc 可得；Windows 双 null = 跳过
  const srv = await boot({ isolated: true, env: { VR_TEST_GUARD: '1' } }); // isolated 临时应用根：写盘零接触宿主仓库
  const req = srv.req;
  const call = async (m, p, body) => { // 全程状态码记账：5xx/连接失败计数不炸循环
    try {
      const r = await req(m, p, body ? { 'Content-Type': 'application/json' } : null, body ? JSON.stringify(body) : null);
      if (r.status >= 500) counters.fiveXX++;
      return r;
    } catch (e) { counters.connErr++; return null; }
  };

  let gq = null, gs = null; // 收尾对账用：quality/store 最终持久态
  try {
    console.log(`[1] 页面行为仿真持续 ${S}s（nowplaying 3s / quality 5s / store 10s / check 30s / cross min(15s,30%时长)，首轮错峰错开）`);
    const start = Date.now();
    let nextNp = start + 1000, nextQ = start + 2000, nextS = start + 4000, nextC = start + 5000,
      nextCross = start + Math.min(15000, Math.round(S * 1000 * 0.3)); // 跨台探测窗比例化：短时长不至于轮不到样本
    let startRss = null;
    while (Date.now() - start < S * 1000) {
      const now = Date.now();
      if (startRss === null && now - start > 5000) startRss = readRss(srv.srv.pid); // 暖机后取 RSS 基线（仅 Linux 有值）
      if (now >= nextNp) {
        nextNp += 3000; counters.nowplaying++;
        const r = await call('GET', '/api/nowplaying?url=' + encodeURIComponent(FIX + '/icy.mp3'));
        const j = r && (() => { try { return JSON.parse(r.body); } catch (_) { return null; } })();
        if (j && j.title) {
          counters.nowplayingTitle++;
          if (!TITLES.includes(j.title)) counters.nowplayingBad++; // 串台/未知曲名
          if (j.br !== 128) counters.nowplayingBad++;              // icy-br 须随头稳定
        }
      }
      if (now >= nextCross) { // 跨台样本：另一 ICY 会话必须返回自己的曲名（不串台）——新会话首帧异步到达，短轮询等待
        crossAttempted = true; nextCross = Infinity;
        for (let i = 0; i < 5 && !crossOk; i++) {
          const r = await call('GET', '/api/nowplaying?url=' + encodeURIComponent(FIX + '/icy2.mp3'));
          const j = r && (() => { try { return JSON.parse(r.body); } catch (_) { return null; } })();
          if (j && j.title === '隔壁电台' && j.br === 96) crossOk = true;
          else await sleep(1000);
        }
      }
      if (now >= nextQ) {
        nextQ += 5000; counters.quality++;
        const r = await call('POST', '/api/quality', { ops: [{ id: 'soak-' + counters.quality, identityUrl: FIX + '/soak.mp3',
          sourceUrl: FIX + '/soak.mp3', kind: 'playback', trigger: 'play', ok: true, latencyMs: 10, bytes: 800, at: Date.now(), mode: 'direct' }] });
        const j = r && (() => { try { return JSON.parse(r.body); } catch (_) { return null; } })();
        if (j && j.ok) qRevs.push(j.rev); else counters.qualityFail++;
      }
      if (now >= nextS) {
        nextS += 10000; counters.store++;
        const r = await call('POST', '/api/store', { data: { 'radio.favs': '["' + FIX + '/icy.mp3"]',
          'radio.vol': (0.5 + counters.store / 100).toFixed(2), 'radio.view': counters.store % 2 ? 'list' : 'grid' } });
        const j = r && (() => { try { return JSON.parse(r.body); } catch (_) { return null; } })();
        if (j && j.ok) sRevs.push(j.rev); else counters.storeFail++;
      }
      if (now >= nextC) {
        nextC += 30000; counters.check++;
        const r = await call('GET', '/api/check?detail=1&url=' + encodeURIComponent(FIX + '/direct.mp3'));
        const j = r && (() => { try { return JSON.parse(r.body); } catch (_) { return null; } })();
        if (!(j && j.results && j.results[0] && j.results[0].code === 'OK')) counters.checkBad++;
      }
      maxIcyOpen = Math.max(maxIcyOpen, OPEN['/icy.mp3']);
      await sleep(200);
    }
    rssEnd = readRss(srv.srv.pid);
    rssStart = startRss;
    const rssSkipped = rssStart === null || rssEnd === null;
    // 收尾对账取证（review#41 任务 3）：GET 最终持久值，断言与内存记账一致（GET 本身也入 5xx/connErr 记账）
    gq = await call('GET', '/api/quality');
    gs = await call('GET', '/api/store');
    const gqJ = gq && (() => { try { return JSON.parse(gq.body); } catch (_) { return null; } })();
    const gsJ = gs && (() => { try { return JSON.parse(gs.body); } catch (_) { return null; } })();
    const lastStoreN = counters.store; // 末批序号 = 总发出批数（载荷函数用它算 vol/view）

    console.log('[2] 收尾断言');
    await ok('曲讯稳态：全程至少一次非空 title 且恒 ∈ 已知集、码率 128（串台/未知曲名 ' + counters.nowplayingBad + ' 次）', () => {
      assert.ok(counters.nowplayingTitle > 0, '整个 soak 未见非空曲名（nowplaying ' + counters.nowplaying + ' 次轮询）');
      assert.strictEqual(counters.nowplayingBad, 0);
    });
    await ok('跨台不串音：/icy2.mp3 返回自身曲名与码率（隔壁电台/96；探测窗 min(15s,30%时长) 已执行 ' + crossAttempted + '）', () => {
      assert.ok(crossAttempted, '跨台样本未执行（不应发生：探测窗 = min(15s, 30% 时长) 必落入观察窗）');
      assert.ok(crossOk, '跨台样本未命中');
    });
    await ok('旁路会话复用：观察窗内 fixture 侧 /icy.mp3 活跃连接恒 ≤1（无重建堆积，实测峰值 ' + maxIcyOpen + '）', () =>
      assert.ok(maxIcyOpen <= 1));
    await ok('全程零 5xx、零连接级失败（nowplaying ' + counters.nowplaying + ' / quality ' + counters.quality +
      ' / store ' + counters.store + ' / check ' + counters.check + ' + 收尾对账 GET）', () => {
      assert.strictEqual(counters.fiveXX, 0); assert.strictEqual(counters.connErr, 0);
    });
    await ok('quality rev 严格递增（每批新 id 必发新号；成功 ' + qRevs.length + '/' + counters.quality + ' 批）', () => {
      assert.ok(qRevs.length > 0, 'soak 内 quality 零成功批');
      assert.ok(qRevs.every((v, i) => i === 0 || v > qRevs[i - 1]), '序列：' + qRevs.join(','));
    });
    await ok('store rev 严格递增（成功 ' + sRevs.length + '/' + counters.store + ' 批）', () => {
      assert.ok(sRevs.length > 0, 'soak 内 store 零成功批');
      assert.ok(sRevs.every((v, i) => i === 0 || v > sRevs[i - 1]), '序列：' + sRevs.join(','));
    });
    await ok('零失败预算：quality 写失败 ' + counters.qualityFail + ' 批 / store 写失败 ' + counters.storeFail +
      ' 批（无故障稳态 soak 本义——写盘失败协议是 200 {ok:false}，「零 5xx」发现不了持续丢写，review#41 任务 3）', () => {
      assert.strictEqual(counters.qualityFail, 0, 'quality 写失败批数 ' + counters.qualityFail);
      assert.strictEqual(counters.storeFail, 0, 'store 写失败批数 ' + counters.storeFail);
    });
    await ok('成功批与发出批一比一：quality ' + qRevs.length + '/' + counters.quality + '、store ' + sRevs.length + '/' + counters.store, () => {
      assert.strictEqual(qRevs.length, counters.quality, 'quality 成功/发出不匹配');
      assert.strictEqual(sRevs.length, counters.store, 'store 成功/发出不匹配');
    });
    await ok('终态持久对账：GET rev = 末次成功写 rev（quality ' + (gqJ && gqJ.rev) + '、store ' + (gsJ && gsJ.rev) + '）', () => {
      assert.ok(gqJ && gsJ, '收尾 GET 失败（quality/gs 响应缺失）');
      assert.strictEqual(gqJ.rev, qRevs[qRevs.length - 1], 'quality GET rev 与末次成功写不一致');
      assert.strictEqual(gsJ.rev, sRevs[sRevs.length - 1], 'store GET rev 与末次成功写不一致');
    });
    await ok('终态持久对账：store 快照键回读一致（favs/vol/view = 末次全量写载荷）', () => {
      assert.deepStrictEqual(gsJ.data, { 'radio.favs': '["' + FIX + '/icy.mp3"]',
        'radio.vol': (0.5 + lastStoreN / 100).toFixed(2), 'radio.view': lastStoreN % 2 ? 'list' : 'grid' });
    });
    await ok('探活通道健康：detail=1 全部 code=OK（坏 ' + counters.checkBad + ' 次）', () => {
      assert.ok(counters.check > 0, 'soak 内未触发 check（不应发生：首轮 5s 起）');
      assert.strictEqual(counters.checkBad, 0);
    });
    await sleep(10000); // 稳态观察窗：停轮询后探活短连应已自收
    await ok('+10s 直流探活连接归零（probe 短连自收，不泄漏）：fixture 侧 /direct.mp3 活跃 = 0', () =>
      assert.strictEqual(OPEN['/direct.mp3'], 0));
    await ok('icy 旁路会话空闲回收：停轮询后 ≤45s 内归零（NP_IDLE=30s 全局回收器兜底，keep-open 不泄漏）', async () => {
      const w0 = Date.now();
      while (OPEN['/icy.mp3'] > 0 && Date.now() - w0 < 45000) await sleep(1000);
      assert.strictEqual(OPEN['/icy.mp3'], 0, '回收等待 ' + (Date.now() - w0) + 'ms 后仍挂连接');
    });
    await ok('RSS 增长 <80MB' + (rssSkipped ? '（平台无 /proc——跳过，报告注明）' : '（基线 ' + (rssStart / 1024).toFixed(1) + 'MB → 终态 ' + (rssEnd / 1024).toFixed(1) + 'MB）'), () => {
      if (rssSkipped) return; // Windows 跳过：判据在 Linux CI 生效（报告 rss.skipped=true 注明，非伪报通过）
      assert.ok(rssEnd - rssStart < 80 * 1024, 'RSS 增长 ' + ((rssEnd - rssStart) / 1024).toFixed(1) + 'MB 超阈');
    });
  } finally {
    try { await srv.close(); } catch (_) {}
    try { await fx.close(); } catch (_) {} // keep-open 长连接：杀服 + 销毁全部 fixture 连接，不留挂起句柄
  }

  const report = { script: 'soak', runId: ctx.runId, headSha: ctx.headSha, startedAt: ctx.startedAt,
    generatedAt: new Date().toISOString(), soakSeconds: S, durationMs: Date.now() - t0,
    executed: true, category: fail ? 'code-regression' : 'pass', pass, fail, assertions: asserts, counters,
    recycle: { directOpenAtPlus10s: OPEN['/direct.mp3'], icyOpenFinal: OPEN['/icy.mp3'] },
    rss: rssStart === null || rssEnd === null ? { skipped: true, note: '平台无 /proc（Windows），RSS 判据在 Linux CI 生效' }
      : { skipped: false, startKB: rssStart, endKB: rssEnd, growthKB: rssEnd - rssStart, thresholdKB: 80 * 1024 } };
  fs.writeFileSync(ctx.file('soak'), JSON.stringify(report, null, 2));
  console.log(`\n${pass} 通过，${fail} 失败（报告 docs/test-reports/nightly/${ctx.runId}/soak.json）`);
  process.exit(fail ? 1 : 0);
})().catch(e => { // 套件级异常 = 未执行：环境类（端口/权限/起服失败）标「环境未执行」，其余按代码回归处置
  const env = /EADDRINUSE|EACCES|EPERM|未就绪|启动即退出|listen /.test(String(e && e.message || e));
  console.error('soak 未执行（' + (env ? '环境失败' : '套件异常') + '）：', e && e.message || e);
  try {
    fs.writeFileSync(ctx.file('soak'), JSON.stringify({ script: 'soak', runId: ctx.runId, headSha: ctx.headSha, startedAt: ctx.startedAt,
      generatedAt: new Date().toISOString(), executed: false, category: env ? 'environment' : 'code-regression',
      reason: String(e && e.message || e).slice(0, 300), pass, fail, assertions: asserts }, null, 2));
  } catch (_) {}
  process.exit(1);
});
