// 质量客户端纯函数测试（B2，契约 contracts/quality-summary.json；口径对齐 Android QualityStore.kt 冻结语义，
// android/CONTRACTS.md B2 节四拍板：30 天窗近似/台级 cf/metadata 派生/trim 下钻式）：
// 覆盖 qApplyOp 聚合应用（含每台 6 源封顶）、qStability 四档判定次序、qSummary 聚合形态与派生字段、
// qTrim 下钻淘汰序 + keep 保护集、QualityStore 本地 op 构建/rebase 重放（ops 重试不重复计数）。
// Node 直跑：quality-store.js 双兼容（经典 script + CommonJS），浏览器 API 全在函数体内守卫。
const assert = require('assert');
const { QualityStore, QCAPS, qNormMode, qApplyOp, qTrim, qSummary, qStability } = require('../quality-store');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });

const op = (o) => Object.assign({ id: 't:' + (opSeq++), identityUrl: ID, sourceUrl: ID, kind: 'diagnostic',
  trigger: 'manual', ok: true, latencyMs: 0, bytes: 0, mode: 'direct', at: NOW }, o);
let opSeq = 0;
const ID = 'https://main.example/live', NOW = 1800000000000;
const st = () => ({});
const newStations = () => ({});

(async () => {
  console.log('[1] qApplyOp：聚合应用（口径②台级 cf / disconnects / lastDiag·lastPlayFail / 6 源封顶）');
  await ok('ok 样本清 cf、fail 累 cf；延迟>0 才进均值；playback 落 lastPlaybackAt', () => {
    const s = {};
    qApplyOp(s, op({ ok: false, at: 100 }));
    assert.strictEqual(s[ID].cf, 1);
    qApplyOp(s, op({ ok: true, latencyMs: 300, at: 200 }));
    assert.strictEqual(s[ID].cf, 0);                       // 任一源 ok 清台级 cf
    const src = s[ID].sources[ID];
    assert.deepStrictEqual([src.okCount, src.failCount, src.lastOkAt, src.lastFailAt, src.latSum, src.latN], [1, 1, 200, 100, 300, 1]);
    qApplyOp(s, op({ kind: 'playback', trigger: 'play', ok: true, at: 300 }));
    qApplyOp(s, op({ kind: 'playback', trigger: 'play', ok: false, latencyMs: 0, at: 400, sourceUrl: 'https://main.example/alt' }));
    assert.strictEqual(src.lastPlaybackAt, 300);           // playback 才落 lastPlaybackAt（diagnostic 不落）
    assert.strictEqual(s[ID].sources['https://main.example/alt'].lastPlaybackAt, 400);
    assert.strictEqual(s[ID].sources['https://main.example/alt'].lastPlayFail.t, 'play'); // 播放失败留最近一条（QEvent 形态 {t,ok,at,lat}）
  });
  await ok('断流 disconnects 只计 playback 的 error/watchdog（诊断失败与 switch 不计）', () => {
    const s = {};
    qApplyOp(s, op({ kind: 'playback', trigger: 'error', ok: false, at: 1 }));
    qApplyOp(s, op({ kind: 'playback', trigger: 'watchdog', ok: false, at: 2 }));
    qApplyOp(s, op({ kind: 'playback', trigger: 'switch', ok: false, at: 3 }));   // 级联换源失败（未到断流口径）
    qApplyOp(s, op({ trigger: 'manual', ok: false, at: 4 }));                     // 诊断失败
    assert.strictEqual(s[ID].sources[ID].disconnects, 2);
  });
  await ok('diagnostic 留最近一次 lastDiag；modes 去重累计', () => {
    const s = {};
    qApplyOp(s, op({ ok: true, latencyMs: 100, at: 5 }));
    qApplyOp(s, op({ ok: false, at: 6, mode: 'hls', sourceUrl: 'https://main.example/hls' }));
    assert.deepStrictEqual(s[ID].sources[ID].lastDiag, { t: 'manual', ok: true, at: 5, lat: 100 });
    assert.deepStrictEqual(s[ID].sources[ID].modes, ['direct']);
    assert.deepStrictEqual(s[ID].sources['https://main.example/hls'].modes, ['hls']);
  });
  await ok('每台 6 源封顶（caps.sourcesPerStation）：第 7 个新源丢样本', () => {
    const s = {};
    for (let i = 0; i < 8; i++) qApplyOp(s, op({ sourceUrl: 'https://x.example/s' + i, at: i }));
    assert.strictEqual(Object.keys(s[ID].sources).length, 6);
    assert.strictEqual(s[ID].sources['https://x.example/s6'], undefined);
  });

  console.log('[2] qStability 四档（判定次序 unknown→poor→good→fair；30 天窗近似 = 口径①）');
  await ok('unknown：样本 < 3', () => assert.strictEqual(qStability(2, 0, 0, 0, 0, NOW, NOW), 'unknown'));
  await ok('unknown：lastObservedAt 超 30 天窗（即使全成功）', () =>
    assert.strictEqual(qStability(100, 0, 0, 0, 0, NOW - QCAPS.windowMs - 1, NOW), 'unknown'));
  await ok('poor：成功率 < 0.5 一票否决', () => assert.strictEqual(qStability(1, 2, 0, 0, 0, NOW, NOW), 'poor'));
  await ok('poor：cf ≥ 3 一票否决（成功率再高也压不住）', () => assert.strictEqual(qStability(100, 1, 0, 0, 3, NOW, NOW), 'poor'));
  await ok('good：成功率 ≥0.8 且均延迟 <2500ms 且 cf<3', () =>
    assert.strictEqual(qStability(8, 2, 20000, 10, 2, NOW, NOW), 'good'));
  await ok('good：无延迟样本不拦（latN=0）', () => assert.strictEqual(qStability(10, 0, 0, 0, 0, NOW, NOW), 'good'));
  await ok('fair：成功率 ≥0.5 但 <0.8', () => assert.strictEqual(qStability(5, 5, 0, 0, 0, NOW, NOW), 'fair'));
  await ok('fair：成功率 ≥0.8 但均延迟 ≥2500ms', () =>
    assert.strictEqual(qStability(10, 0, 25000, 10, 0, NOW, NOW), 'fair'));
  await ok('判定次序：样本 <3 优先于 poor（cf≥3 也不越级）', () => assert.strictEqual(qStability(0, 2, 0, 0, 3, NOW, NOW), 'unknown'));

  console.log('[3] qSummary：契约聚合形态 + lastObservedAt 派生 + metadata（口径③）');
  await ok('无记录 → null；跨源聚合计数；lastObservedAt = max(lastOkAt,lastFailAt,lastPlaybackAt)', () => {
    const s = {};
    qApplyOp(s, op({ ok: true, latencyMs: 100, at: 100 }));
    qApplyOp(s, op({ ok: true, latencyMs: 300, at: 600, sourceUrl: ID + '/alt' }));
    qApplyOp(s, op({ ok: false, at: 300 }));
    qApplyOp(s, op({ kind: 'playback', trigger: 'play', ok: true, at: 500 }));
    const qa = qSummary(s, ID, null, NOW);
    assert.notStrictEqual(qa, null);
    assert.deepStrictEqual([qa.okCount, qa.failCount, qa.disconnects], [3, 1, 0]);
    assert.strictEqual(qa.lastObservedAt, 600);            // max(600, 300, 500)
    assert.strictEqual(qa.avgLatencyMs, 200);              // (100+300)/2 向下取整
    assert.strictEqual(qa.metadata, 'icy');                // 纯 direct → icy
    assert.strictEqual(qa.sourceCount, 2);                 // 无 sources 入参 → 按已观测源
    assert.strictEqual(qa.directCount, 2);
    assert.strictEqual(qSummary(s, 'https://none.example/x', null, NOW), null);
  });
  await ok('metadata：纯 hls → none；direct+hls → mixed；sources 入参覆盖 sourceCount/directCount', () => {
    const s = {};
    qApplyOp(s, op({ ok: true, mode: 'hls', at: 1 }));
    assert.strictEqual(qSummary(s, ID, null, NOW).metadata, 'none');
    qApplyOp(s, op({ ok: true, mode: 'direct', at: 2, sourceUrl: ID + '/d' }));
    assert.strictEqual(qSummary(s, ID, null, NOW).metadata, 'mixed');
    const qa = qSummary(s, ID, ['http://a/1.mp3', 'http://b/1.m3u8', 'http://c/1.m3u8'], NOW);
    assert.strictEqual(qa.sourceCount, 3);                 // 发现/详情页口径：按台源表算
    assert.strictEqual(qa.directCount, 1);                 // m3u8 形态判定
  });

  console.log('[4] qTrim 下钻淘汰序（口径④：非保护集 → 最久未访问 → 最旧诊断对 → 最大历史源 → 台空才整台丢；每 2 步字节复核）');
  const sizeUnit = stations => { // 可控测度：10/台 + 5/源 + 3/诊断对（cap 精确驱动下钻步；复核每 2 步一批）
    let n = 0;
    for (const q of Object.values(stations)) {
      n += 10;
      for (const s of Object.values(q.sources)) n += 5 + (s.lastDiag ? 3 : 0) + (s.lastPlayFail ? 3 : 0);
    }
    return n;
  };
  const srcOf = (ok, at, diag, pfail) => ({ okCount: ok, failCount: 0, lastOkAt: at, lastFailAt: 0, lastPlaybackAt: 0,
    latSum: 0, latN: 0, disconnects: 0, modes: ['direct'], lastDiag: diag || null, lastPlayFail: pfail || null });
  await ok('受害台=非保护集优先；诊断对先清于源历史（一组 2 步内：lastDiag at5 → lastPlayFail at9，旧者先）', () => {
    const s = { 'http://b/': { cf: 0, sources: {
      'http://b/s1': srcOf(8, 100, { t: 'manual', ok: true, at: 5, lat: 0 }, { t: 'error', ok: false, at: 9, lat: 0 }),
      'http://b/s2': srcOf(1, 90) } },
      'http://a/': { cf: 0, sources: { 'http://a/s1': srcOf(9, 500) } } };  // size = 10+(5+3+3)+5 +10+5 = 41
    qTrim(s, ['http://a/'], () => sizeUnit(s), 41 - 6);   // 恰清两条诊断对（2 步一组后复核即达标）
    const b1 = s['http://b/'].sources['http://b/s1'];
    assert.strictEqual(b1.lastDiag, null, '最旧诊断对先清');
    assert.strictEqual(b1.lastPlayFail, null, '再清较新播放失败');
    assert.ok(b1 && s['http://b/'].sources['http://b/s2'], '诊断对清完前不丢源历史');
    assert.ok(s['http://a/'].sources['http://a/s1'], '保护集不动');
  });
  await ok('诊断对清完 → 丢最大历史源（hist 大者先，平局按源 URL 字典序）', () => {
    const s = { 'http://b/': { cf: 0, sources: {
      'http://b/s1': srcOf(10, 100), 'http://b/s2': srcOf(3, 90), 'http://b/s3': srcOf(1, 80) } },
      'http://a/': { cf: 0, sources: { 'http://a/s1': srcOf(9, 500) } } }; // size = 10+15 +10+5 = 40
    qTrim(s, ['http://a/'], () => sizeUnit(s), 40 - 10);  // 2 步 = 丢 s1(hist10) 与 s2(hist3)
    assert.strictEqual(s['http://b/'].sources['http://b/s1'], undefined, '最大历史源先丢');
    assert.strictEqual(s['http://b/'].sources['http://b/s2'], undefined);
    assert.ok(s['http://b/'].sources['http://b/s3'], 'hist 最小的源存活');
  });
  await ok('台空才整台丢；保护台最后才被动（2 步过冲只伤及诊断对，源与台保留）', () => {
    const s = { 'http://b/': { cf: 0, sources: { 'http://b/s1': srcOf(5, 100) } },
      'http://a/': { cf: 0, sources: { 'http://a/s1': srcOf(9, 500, { t: 'manual', ok: true, at: 7, lat: 0 }) } } }; // size = 10+5 +10+5+3 = 33
    qTrim(s, ['http://a/'], () => sizeUnit(s), 33 - 5 - 3); // 2 步 = 丢 b 的唯一源（台随空整丢）+ a 诊断对被过冲步清掉
    assert.strictEqual(s['http://b/'], undefined, '源尽台空 → 整台移除');
    assert.ok(s['http://a/'] && s['http://a/'].sources['http://a/s1'], '保护台的源保留');
    assert.strictEqual(s['http://a/'].sources['http://a/s1'].lastDiag, null, '过冲步只清诊断对（2 步复核防过冲语义）');
  });
  await ok('保护集不是免死金牌：全部超限时保护台最后才被下钻（契约 caps：硬上限最终约束）', () => {
    const s = { 'http://a/': { cf: 0, sources: { 'http://a/s1': srcOf(1, 1, { t: 'manual', ok: true, at: 1, lat: 0 }) } } };
    qTrim(s, ['http://a/'], () => sizeUnit(s), 0);         // cap=0：清到空
    assert.deepStrictEqual(s, {});
  });

  console.log('[5] 客户端 op 构建 / rebase 重放（ops 重试幂等的客户端面：重拉后 pend 只重放一次）');
  await ok('recordDiagnostic/recordPlayback 构建 op（id 形态 随机sid:时间戳:序号；at 用 checkedAt）', () => {
    const Q = Object.create(QualityStore);
    Q.mode = 'local'; Q.stations = {}; Q.pend = []; Q.keepHint = []; Q.seq = 0; Q.sid = 'tabx';
    Q.recordDiagnostic(ID, { url: ID, ok: true, code: 'OK', latencyMs: 320, bytes: 12000, mode: 'direct', checkedAt: 12345 }, 'manual');
    Q.recordPlayback(ID, { sourceUrl: ID, ok: false, latencyMs: 0, mode: 'direct', trigger: 'watchdog' });
    assert.strictEqual(Q.pend.length, 2);
    assert.ok(/^tabx:\d+:1$/.test(Q.pend[0].id));
    assert.strictEqual(Q.pend[0].at, 12345);
    assert.strictEqual(Q.pend[0].kind, 'diagnostic');
    assert.strictEqual(Q.pend[1].kind, 'playback');
    assert.strictEqual(Q.summary(ID).failCount, 1);        // 本地视图即时可见
  });
  await ok('rebase：重拉服务端态后重放 pend（base+pend 各一次，不重复计数）', () => {
    const Q = Object.create(QualityStore);
    Q.mode = 'local'; Q.stations = {}; Q.pend = []; Q.keepHint = []; Q.seq = 0; Q.sid = 'taby';
    const base = {};
    qApplyOp(base, op({ ok: true, at: 1 }));               // 服务端已有 1 条 ok
    Q.recordPlayback(ID, { sourceUrl: ID, ok: true, trigger: 'play', mode: 'direct' });
    Q.recordPlayback(ID, { sourceUrl: ID, ok: true, trigger: 'play', mode: 'direct' });
    const merged = Q.rebase(base);                         // pull 后本地视图 = base + pend 重放一次
    assert.strictEqual(merged[ID].sources[ID].okCount, 3);
    assert.strictEqual(Q.pend.length, 2);                  // 未确认 ops 保留（重试由服务端 op.id 幂等兜底）
  });

  console.log('[6] mode 归一（AIbot P1-1：契约 opEvent.mode 必填枚举，入口永不为空防 /api/quality 409 整批丢样本）');
  const newQ = () => { const Q = Object.create(QualityStore); Q.mode = 'local'; Q.stations = {}; Q.pend = []; Q.keepHint = []; Q.seq = 0; Q.sid = 'tabz'; return Q; };
  await ok('qNormMode：合法枚举原样；缺失/非法按 variant URL 形态兜底（m3u8→hls、其余→direct）；无 URL 归不出', () => {
    assert.strictEqual(qNormMode('direct', ''), 'direct');
    assert.strictEqual(qNormMode('proxy', 'http://x/1.m3u8'), 'proxy');
    assert.strictEqual(qNormMode('', 'http://x/1.m3u8'), 'hls');
    assert.strictEqual(qNormMode('', 'http://x/1.mp3'), 'direct');
    assert.strictEqual(qNormMode('weird', 'http://x/live'), 'direct');
    assert.strictEqual(qNormMode('', ''), '', '连 URL 都没有 → 空串（调用方丢弃事件，不造假 unknown）');
  });
  await ok('recordPlayback 耗尽路径形态（mode 空、trigger=error、ok=false）→ op.mode 非空', () => {
    const Q = newQ();
    Q.recordPlayback('https://ex.example/live', { sourceUrl: 'https://ex.example/live/64.mp3', ok: false, latencyMs: 0, mode: '', trigger: 'error' });
    assert.strictEqual(Q.pend.length, 1);
    assert.strictEqual(Q.pend[0].mode, 'direct');            // 实际尝试过的 variant 形态兜底
    assert.strictEqual(Q.pend[0].kind, 'playback');
  });
  await ok('recordPlayback 断流（m3u8 源 + Media3/旧状态空 mode）→ 归一 hls；非法串同样归一', () => {
    const Q = newQ();
    Q.recordPlayback('https://ex.example/h', { sourceUrl: 'https://ex.example/h/index.m3u8', ok: false, mode: '', trigger: 'watchdog' });
    Q.recordPlayback('https://ex.example/h', { sourceUrl: 'https://ex.example/h/index.m3u8', ok: true, mode: 'unknown', trigger: 'switch' });
    assert.deepStrictEqual(Q.pend.map(o => o.mode), ['hls', 'hls']);
  });
  await ok('recordDiagnostic 诊断结果缺 mode → 按源 URL 形态归一；无 URL 事件丢弃', () => {
    const Q = newQ();
    Q.recordDiagnostic('https://ex.example/d', { url: 'https://ex.example/d/a.m3u8', ok: true, latencyMs: 100, checkedAt: 1 }, 'boot');
    Q.recordDiagnostic('https://ex.example/d', { url: '', ok: true }, 'boot');
    assert.strictEqual(Q.pend.length, 1);
    assert.strictEqual(Q.pend[0].mode, 'hls');
    assert.strictEqual(Q.pend[0].trigger, 'boot');
  });
  await ok('归一后所有 op 的 mode 都在服务端枚举内（Q_MODES 严格校验的直接前置）', () => {
    const Q = newQ();
    Q.recordDiagnostic('https://a.example/x', { url: 'https://a.example/x.mp3', ok: true, mode: '', checkedAt: 2 }, 'manual');
    Q.recordPlayback('https://a.example/x', { sourceUrl: 'https://a.example/x.mp3', ok: false, mode: undefined, trigger: 'error' });
    Q.recordPlayback('https://a.example/x', { sourceUrl: 'https://a.example/y.m3u8?t=1', ok: true, mode: null, trigger: 'play' });
    for (const o of Q.pend) assert.ok(['direct', 'hls', 'proxy'].includes(o.mode), 'mode 非枚举值：' + o.mode);
  });

  console.log('[7] 双端聚合黄金样本 round-trip（AIbot P1-2：contracts/fixtures/quality-aggregate.json，Android ContractTest 同源消费）');
  await ok('fixture 事件序列驱动 qApplyOp → qSummary 逐字段等于 expected（包装层各异、内层一致）', () => {
    const fx = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'contracts', 'fixtures', 'quality-aggregate.json'), 'utf8'));
    const stations = {};
    for (const e of fx.events)
      qApplyOp(stations, { id: 'fx:' + e.at, identityUrl: fx.identityUrl, sourceUrl: e.sourceUrl, kind: e.kind,
        trigger: e.trigger, ok: e.ok, latencyMs: e.latencyMs, bytes: e.bytes, mode: e.mode, at: e.at });
    const qa = qSummary(stations, fx.identityUrl, null, fx.expected.lastObservedAt);
    assert.notStrictEqual(qa, null);
    assert.deepStrictEqual(qa, fx.expected);
  });

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('quality-store 测试异常：', e); process.exit(1); });
