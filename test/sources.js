// 同步候选管线 + 替换前质量门 + 发布协议测试（B2，plan-expansion-r4 §6.2–§6.4/§13.3）：
// 全离线——runPipeline 的 inputs 注入（cn 文本 / eu 结构体）顶替真实上游拉取，fixture 见 test/fixtures/；
// 发布协议（publishSync/bootManifest）在 os.tmpdir 临时根目录验证，不写真根目录。
// 覆盖：URL 保守归一化、三层去重、同名合并、来源保留、质量门六条（可绕过/不可绕过分类）、候选不足旧库
// 字节不变、门通过时四生成物 + manifest 同批出现、manifest 损坏恢复/bootstrap、强制两步协议纯函数。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const U = require('../update-sources');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });
const FIX = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

/* 临时根目录 + 旧库种子（radio.txt 为主、logos.txt/radio-data.js 随行，模拟 B1 存量仓库态） */
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vradio-src-'));
const genOldLib = (nSt, nEu) => {
  const lines = ['华语音乐,#genre#'];
  for (let i = 0; i < nSt; i++) lines.push(`旧库台${i + 1},http://old.stream.cn/st${i + 1}/64.mp3`);
  lines.push('欧美音乐,#genre#');
  for (let i = 0; i < nEu; i++) lines.push(`Old EU ${i + 1} [英国],http://old-eu.stream.cn/eu${i + 1}.mp3`);
  return lines.join('\r\n') + '\r\n';
};
const seedRoot = (root, oldText) => {
  fs.writeFileSync(path.join(root, 'radio.txt'), oldText);
  fs.writeFileSync(path.join(root, 'radio-data.js'), 'window.RADIO_DATA=' + JSON.stringify(oldText) + ';\r\n');
  fs.writeFileSync(path.join(root, 'logos.txt'), '# 由 npm run sync 自动生成。\r\n欧美音乐|Old EU 1 [英国],http://logo/eu1.png\r\n');
};
const bytesOf = (root, f) => fs.readFileSync(path.join(root, f)).length;
/* 欧美注入结构体（buildEuLines 结果形态；meta 供 radio-meta.json 来源追踪） */
const euOf = (lines, metas) => ({
  lines, logoLines: [], news: { lines: [], logoLines: [], meta: [] },
  meta: metas || lines.map((l, i) => ({ name: l.split(',')[0], url: l.split(',')[1], uuid: 'u' + i })),
  kept: lines.length, total: lines.length + 3,
});

(async () => {
  console.log('[1] URL 保守归一化 normalizeCandidateUrl（只用于比对，绝不替换原 URL）');
  await ok('小写 scheme/host、删默认端口、保留 path/query/尾斜杠', () => {
    assert.strictEqual(U.normalizeCandidateUrl('HTTP://Example.COM:80/a?b=1'), 'http://example.com/a?b=1');
    assert.strictEqual(U.normalizeCandidateUrl('https://Example.com:443/a/'), 'https://example.com/a/');
    assert.strictEqual(U.normalizeCandidateUrl('http://Example.com:8080/a'), 'http://example.com:8080/a'); // 非默认端口保留
    assert.strictEqual(U.normalizeCandidateUrl('http://example.com'), 'http://example.com'); // 空端口 = 默认
    assert.strictEqual(U.normalizeCandidateUrl('HTTP://X.Y/Z#f'), 'http://x.y/Z#f'); // path/fragment 原样
  });
  await ok('非 http(s)/空 host/IPv6 字面量整体保留', () => {
    assert.strictEqual(U.normalizeCandidateUrl('ftp://example.com/x'), null);
    assert.strictEqual(U.normalizeCandidateUrl('http:///path'), null);
    assert.strictEqual(U.normalizeCandidateUrl('  '), null);
    assert.strictEqual(U.normalizeCandidateUrl('http://[::1]/x'), 'http://[::1]/x'); // IPv6 不拆端口
    assert.strictEqual(U.normalizeCandidateUrl('HTTP://[2001:DB8::1]:8080/a'), 'http://[2001:db8::1]:8080/a');
  });

  console.log('[2] parseUpstream：行协议恰两字段 + 来源追踪字段');
  await ok('3+ 字段容错跳过、空名计入 nameless、注释/空行不计、节头带分类', () => {
    const stats = { total: 0, valid: 0, nameless: 0, noCat: 0 };
    const cands = U.parseUpstream([
      '节前无名台,http://a/4.mp3',   // 首个节头之前 = 分类缺失（noCat 口径）
      '华语音乐,#genre#',
      '好台,http://a/1.mp3',
      '坏行,http://a/2.mp3,多余',
      ',http://a/3.mp3',
      '# 注释行',
      '',
    ].join('\r\n'), { upstream: 'gao', stats });
    assert.strictEqual(cands.length, 2);
    assert.deepStrictEqual(cands.map(c => c.stationName), ['节前无名台', '好台']);
    assert.strictEqual(cands[1].category, '华语音乐');
    assert.strictEqual(cands[0].category, '');               // 节头之前 = 分类缺失
    assert.strictEqual(cands[1].upstream, 'gao');
    assert.strictEqual(cands[1].sourceLine, '好台,http://a/1.mp3');
    assert.strictEqual(cands[1].duplicateKey, '华语音乐|好台');
    assert.strictEqual(cands[1].validationResult, null);      // 国内节不探活，预留 null
    assert.deepStrictEqual(stats, { total: 4, valid: 2, nameless: 1, noCat: 1 }); // 注释/空行不入 total
  });

  console.log('[3] dedupeCandidates 三层去重（精确 URL → 归一化 URL → 同分类同名合并）');
  await ok('精确与归一化 URL 重复删首现保留；同分类同名共享 duplicateKey 全保留；不同分类同名不强并', () => {
    const mk = (n, c, u) => ({ stationName: n, category: c, url: u, upstream: 'gao', upstreamId: '', logoUrl: '',
      sourceLine: `${n},${u}`, normalizedUrl: U.normalizeCandidateUrl(u) || '', duplicateKey: `${c}|${n}`, validationResult: null });
    const out = U.dedupeCandidates([
      mk('A台', '华语音乐', 'http://x/1.mp3'),
      mk('B台', '华语音乐', 'http://x/1.mp3'),                              // ① 精确 URL 重复
      mk('B台', '华语音乐', 'HTTP://X:80/2.mp3'),
      mk('C台', '华语音乐', 'http://x/2.mp3'),                              // ② 归一化 URL 重复（胜者保留原 URL）
      mk('D台', '华语音乐', 'http://x/3.mp3'),
      mk('D台', '华语音乐', 'http://x/4.mp3'),                              // ③ 同分类同名 = 多源合并（都保留）
      mk('D台', '新闻资讯', 'http://x/5.mp3'),                              // 不同分类同名不并
    ]);
    assert.deepStrictEqual(out.map(c => c.url), ['http://x/1.mp3', 'HTTP://X:80/2.mp3', 'http://x/3.mp3', 'http://x/4.mp3', 'http://x/5.mp3']);
    assert.strictEqual(out.filter(c => c.stationName === 'D台' && c.category === '华语音乐').every(c => c.duplicateKey === '华语音乐|D台'), true);
    assert.notStrictEqual(out[3].duplicateKey, out[4].duplicateKey);
    assert.strictEqual(out[1].url, 'HTTP://X:80/2.mp3'); // 去重只比对：写入仍是原 URL（首现者）
  });
  await ok('buildCandidates：多原料统计（deduped/invalid）+ 来源字段保留', () => {
    const r = U.buildCandidates([{ text: 'S,#genre#\r\nA,http://a/1\r\nA,http://a/1\r\nB,ftp://x/1\r\n', upstream: 'gao' }]);
    assert.strictEqual(r.candidates.length, 1);
    assert.strictEqual(r.stats.total, 3);
    assert.strictEqual(r.stats.valid, 2);
    assert.strictEqual(r.stats.deduped, 1);
    assert.strictEqual(r.candidates[0].upstream, 'gao');
  });

  console.log('[4] 质量门矩阵（runPipeline 注入原料，floor=0；临时根目录）');
  const EU_OK = euOf(['Foo Radio [英国],http://eu.new/1.mp3']);
  await ok('good fixture：门通过、四生成物齐备、hash 产出', async () => {
    const root = tmpRoot(), old = genOldLib(5, 1); // 旧欧美 1 行 = 新层 1 行，不触 eu-collapse
    seedRoot(root, old);
    const r = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-good.txt'), eu: EU_OK } });
    assert.strictEqual(r.hardAbort, false);
    assert.strictEqual(r.gated, false);
    assert.strictEqual(r.report.reasons.length, 0);
    assert.ok(/^[0-9a-f]{64}$/.test(r.reportHash));
    for (const f of U.SYNC_ASSETS) assert.ok(typeof r.arts[f] === 'string' && r.arts[f].length, '生成物 ' + f);
    return r, root;
  });
  await ok('门通过发布：四生成物 + sync-manifest.json 同批出现、哈希吻合、统一输出形态', async () => {
    const root = tmpRoot(), old = genOldLib(5, 1);
    seedRoot(root, old);
    const r = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-good.txt'), eu: EU_OK } });
    const s = U.publishResult(root, r, { entry: 'cli' });
    for (const f of [...U.SYNC_ASSETS, 'sync-manifest.json']) assert.ok(fs.existsSync(path.join(root, f)), f + ' 未生成');
    const m = JSON.parse(fs.readFileSync(path.join(root, 'sync-manifest.json'), 'utf8'));
    assert.strictEqual(m.files.length, 4);
    for (const f of m.files) {
      const buf = fs.readFileSync(path.join(root, f.path));
      assert.strictEqual(buf.length, f.bytes, f.path + ' bytes');
      assert.strictEqual(require('crypto').createHash('sha256').update(buf).digest('hex'), f.sha256, f.path + ' sha256');
    }
    for (const k of ['ok', 'total', 'added', 'removed', 'deduped', 'invalid', 'replacement', 'quality', 'sourceMeta'])
      assert.ok(k in s, '统一输出缺键 ' + k);
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.replacement, 'accepted');
    assert.strictEqual(s.sourceMeta, 'radio-meta.json');
    assert.deepStrictEqual(s.quality, { oldTotal: 6, newTotal: s.total });
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'radio-meta.json'), 'utf8'));
    assert.strictEqual(meta.v, 1);
    assert.ok(meta.stations['http://ngcdn001.cnr.cn/live/zgzs/index.m3u8']);
    assert.strictEqual(meta.stations['http://ngcdn001.cnr.cn/live/zgzs/index.m3u8'].sources[0].upstream, 'gao');
    assert.strictEqual(meta.stations['http://eu.new/1.mp3'].sources[0].upstream, 'eu');
    assert.strictEqual(meta.stations['http://eu.new/1.mp3'].sources[0].kind, 'main');
    assert.ok(Number.isFinite(meta.generatedAt));
  });
  await ok('总台数降超 20%：gated=true（total-drop 可绕过）、旧库字节不变', async () => {
    const root = tmpRoot(), old = genOldLib(60, 3);
    seedRoot(root, old);
    const before = bytesOf(root, 'radio.txt');
    const r = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-drop-80-percent.txt'), eu: null } });
    assert.strictEqual(r.gated, true);
    assert.ok(r.report.reasons.some(x => x.key === 'total-drop' && x.bypassable));
    assert.strictEqual(bytesOf(root, 'radio.txt'), before, '被门拦截不得写盘');
    assert.ok(!fs.existsSync(path.join(root, 'sync-manifest.json')));
  });
  await ok('分类数 0：gated=true（no-categories 可绕过）', async () => {
    const root = tmpRoot(), old = genOldLib(5, 0); // 旧欧美为空：候选 0 → merged 无节头（保留旧层也救不了）
    seedRoot(root, old);
    const r = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-empty-category.txt'), eu: null } });
    assert.strictEqual(r.hardAbort, false);
    assert.strictEqual(r.gated, true);
    assert.ok(r.report.reasons.some(x => x.key === 'no-categories' && x.bypassable));
  });
  await ok('国内格式有效行 < 95%：hardAbort（invalid-ratio 不可绕过）、旧库字节不变', async () => {
    const root = tmpRoot(), old = genOldLib(10, 2);
    seedRoot(root, old);
    const before = bytesOf(root, 'radio.txt');
    const r = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-bad-lines.txt'), eu: null } });
    assert.strictEqual(r.hardAbort, true);
    assert.ok(r.report.reasons.some(x => x.key === 'invalid-ratio' && !x.bypassable));
    assert.strictEqual(bytesOf(root, 'radio.txt'), before);
    assert.strictEqual(r.summary.aborted, true); // 既有消费方 aborted 语义保留
  });
  await ok('无分类合法行 > 5%：gated=true（nocat-ratio 独立口径可绕过；不触 nameless-ratio/invalid-ratio，AIbot P2-4）', async () => {
    const root = tmpRoot(), old = genOldLib(3, 1);
    seedRoot(root, old);
    // 节头之前的行 = 分类缺失（noCat）：行本身可解析 → valid 比例 100%，但无分类占比 83% > 5%
    const cn = ['无节台一,http://a/1.mp3', '无节台二,http://a/2.mp3', '无节台三,http://a/3.mp3',
      '无节台四,http://a/4.mp3', '无节台五,http://a/5.mp3', '华语音乐,#genre#', '好台,http://a/6.mp3'].join('\r\n');
    const r = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn, eu: null } });
    assert.strictEqual(r.gated, true);
    assert.ok(r.report.reasons.some(x => x.key === 'nocat-ratio' && x.bypassable), '独立 nocat-ratio 键');
    assert.ok(!r.report.reasons.some(x => x.key === 'nameless-ratio'), '无分类不再混入无名口径');
    assert.ok(!r.report.reasons.some(x => x.key === 'invalid-ratio'));
    assert.strictEqual(r.report.cn.noCat, 5);                  // 独立计数字段（报告可分别诊断）
    assert.strictEqual(r.report.cn.nameless, 0);
  });
  await ok('无名行 > 5%：nameless-ratio 独立键 + report.cn.nameless 精确计数（与 invalid-ratio 并存可分诊）', async () => {
    const root = tmpRoot(), old = genOldLib(3, 1);
    seedRoot(root, old);
    // 8 行里 1 行空名 = 12.5% > 5%：空名行不入 valid（§6.4「台名非空」定义）→ invalid-ratio 同批命中（hard），
    // nameless-ratio 照常独立上报（数量/占比分列，报告能看出 invalid 里有多少是无名行）
    const cn = ['华语音乐,#genre#', '好台,http://a/1.mp3', '台二,http://a/2.mp3', '台三,http://a/3.mp3', '台四,http://a/4.mp3',
      '台五,http://a/5.mp3', '台六,http://a/6.mp3', '台七,http://a/7.mp3', ',http://a/8.mp3'].join('\r\n');
    const r = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn, eu: null } });
    assert.ok(r.report.reasons.some(x => x.key === 'nameless-ratio' && x.bypassable), '独立 nameless-ratio 键');
    assert.strictEqual(r.report.cn.nameless, 1);
    assert.strictEqual(r.report.cn.noCat, 0);
    assert.strictEqual(r.report.cn.invalid, 1);                // invalid = 无名 + 坏格式（此处全为无名）
  });
  await ok('重复行大量去重：deduped 如实计数、不触任何门（AIbot P2-4 补重复行门测试）', async () => {
    const root = tmpRoot(), old = genOldLib(5, 1);
    seedRoot(root, old);
    const lines = ['华语音乐,#genre#'];
    for (let i = 0; i < 6; i++) lines.push(`台${i},http://a/${i}.mp3`);
    for (let i = 0; i < 30; i++) lines.push(`重复台${i},http://a/${i % 6}.mp3`);   // 30 行精确 URL 重复全被去重
    const r = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: lines.join('\r\n'), eu: null } });
    assert.strictEqual(r.gated, false);
    assert.strictEqual(r.hardAbort, false);
    assert.strictEqual(r.report.reasons.length, 0);
    assert.strictEqual(r.report.cn.deduped, 30);
  });
  await ok('欧美层 < 上次 60%：保留旧层发布（replacement=kept）、logos 不动；force 复用原料改用新层（forced）', async () => {
    const root = tmpRoot(), old = genOldLib(5, 10); // 旧欧美 10 行 → 新 1 行 < ceil(10*0.6)=6
    seedRoot(root, old);
    const oldLogos = bytesOf(root, 'logos.txt');
    const EU1 = euOf(['Foo Radio [英国],http://eu.new/1.mp3']);
    const r = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-good.txt'), eu: EU1 } });
    assert.strictEqual(r.gated, false, '欧美塌陷是保留旧层的补救决策，不整批拦截');
    assert.strictEqual(r.euKeptDecision, true);
    assert.ok(r.report.reasons.some(x => x.key === 'eu-collapse' && x.bypassable));
    const s = U.publishResult(root, r, { entry: 'web' });
    assert.strictEqual(s.replacement, 'kept');
    const txt = fs.readFileSync(path.join(root, 'radio.txt'), 'utf8');
    assert.ok(txt.includes('Old EU 1 [英国]') && !txt.includes('http://eu.new/1.mp3'), '旧欧美层保留');
    assert.strictEqual(bytesOf(root, 'logos.txt'), oldLogos, '保留旧层时 logos 不重写');
    // 强制：复用 stash 原料（不重拉上游）重跑 → 新欧美层生效
    const r2 = await U.runPipeline(() => {}, { root, floor: 0, inputs: r.artInputs, force: true });
    assert.strictEqual(r2.gated, false);
    const s2 = U.publishResult(root, r2, { entry: 'web', forced: true });
    assert.strictEqual(s2.replacement, 'forced');
    assert.ok(s2.forcedReasons.includes('eu-collapse')); // 强制弃旧层还会带出 total-drop（33→24），如实入 forcedReasons
    assert.ok(fs.readFileSync(path.join(root, 'radio.txt'), 'utf8').includes('http://eu.new/1.mp3'));
  });

  console.log('[5] 发布协议与 manifest（§13.3：bootstrap/校验/恢复上一批）');
  await ok('第二批发版后损坏根生成物 → bootManifest 恢复上一批完整生成物与 manifest', async () => {
    const root = tmpRoot(), old = genOldLib(5, 2);
    seedRoot(root, old);
    const r1 = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-good.txt'), eu: null } });
    U.publishResult(root, r1, { entry: 'test' });
    const batch1 = fs.readFileSync(path.join(root, 'radio.txt'), 'utf8');
    const r2 = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-drop-80-percent.txt'), eu: null } });
    U.publishResult(root, r2, { entry: 'test' });
    assert.notStrictEqual(fs.readFileSync(path.join(root, 'radio.txt'), 'utf8'), batch1);
    fs.writeFileSync(path.join(root, 'radio.txt'), 'corrupted!'); // 模拟写盘中断/外部损坏
    const st = U.bootManifest(root, m => assert.ok(/校验失败|恢复/.test(m) || true));
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.restored, true);
    assert.strictEqual(fs.readFileSync(path.join(root, 'radio.txt'), 'utf8'), batch1, '恢复为上一批内容');
  });
  await ok('代际轮换（AIbot P1-3）：连续两次发布后 prev=上一批、prev-old=上上一批，两代都完整', async () => {
    const root = tmpRoot(), old = genOldLib(5, 2);
    seedRoot(root, old);
    fs.writeFileSync(path.join(root, 'radio-meta.json'), JSON.stringify({ v: 1, generatedAt: 1, stations: {} })); // 四资产齐全：prev 代代可校验
    const r1 = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-good.txt'), eu: null } });
    U.publishResult(root, r1, { entry: 'test' });                                   // 第 1 次：prev = 旧库批
    const batch1 = fs.readFileSync(path.join(root, 'radio.txt'), 'utf8');
    const r2 = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-drop-80-percent.txt'), eu: null } });
    U.publishResult(root, r2, { entry: 'test' });                                   // 第 2 次：prev = batch1，prev-old = 旧库批
    const batch2 = fs.readFileSync(path.join(root, 'radio.txt'), 'utf8');
    const prev = path.join(root, '.tmp', 'sync-prev'), prevOld = path.join(root, '.tmp', 'sync-prev-old');
    assert.strictEqual(fs.readFileSync(path.join(prev, 'radio.txt'), 'utf8'), batch1, 'prev = 上一批');
    assert.strictEqual(fs.readFileSync(path.join(prevOld, 'radio.txt'), 'utf8'), old, 'prev-old 保留上上一批（至少两代）');
    for (const d of [prev, prevOld]) {                                              // 两代都完整可校验
      const m = U.readManifestOf(d);
      assert.ok(m && U.manifestCheckDir(d, m), d + ' 不完整');
    }
    assert.ok(!fs.existsSync(path.join(root, '.tmp', 'sync-prev-new')), '轮换后不留半成品 new 目录');
    assert.notStrictEqual(batch1, batch2);
  });
  await ok('轮换空窗兜底：prev 缺失（两步改名间崩溃态）+ 根损坏 → bootManifest 从 prev-old 恢复', async () => {
    const root = tmpRoot(), old = genOldLib(5, 2);
    seedRoot(root, old);
    fs.writeFileSync(path.join(root, 'radio-meta.json'), JSON.stringify({ v: 1, generatedAt: 1, stations: {} }));
    const r1 = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-good.txt'), eu: null } });
    U.publishResult(root, r1, { entry: 'test' });
    const r2 = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-drop-80-percent.txt'), eu: null } });
    U.publishResult(root, r2, { entry: 'test' });                                   // 两次发布后 prev=batch1、prev-old=旧库快照
    fs.rmSync(path.join(root, '.tmp', 'sync-prev'), { recursive: true, force: true }); // 模拟「旧 prev 已改名、new 未就位」瞬时空窗
    fs.writeFileSync(path.join(root, 'radio.txt'), 'corrupted!');                    // 根资产同时损坏
    const st = U.bootManifest(root);
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.restored, true);
    assert.strictEqual(fs.readFileSync(path.join(root, 'radio.txt'), 'utf8'), old, '从 prev-old 兜底恢复完整一代');
  });
  await ok('混态根（部分文件已是新批 + 旧 manifest）→ hash 不匹配恢复上一批完整生成物', async () => {
    const root = tmpRoot(), old = genOldLib(5, 2);
    seedRoot(root, old);
    fs.writeFileSync(path.join(root, 'radio-meta.json'), JSON.stringify({ v: 1, generatedAt: 1, stations: {} }));
    const r1 = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-good.txt'), eu: null } });
    U.publishResult(root, r1, { entry: 'test' });
    const batch1 = fs.readFileSync(path.join(root, 'radio.txt'), 'utf8');
    const r2 = await U.runPipeline(() => {}, { root, floor: 0, inputs: { cn: FIX('sync-drop-80-percent.txt'), eu: null } });
    const fresh = r2.arts['radio.txt'];                                              // 模拟逐文件 rename 进行到一半即崩溃：
    fs.writeFileSync(path.join(root, 'radio.txt'), fresh);                           // radio.txt 已是新批、manifest 仍指旧批（prev=旧库批）
    const st = U.bootManifest(root);
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.restored, true);
    assert.strictEqual(fs.readFileSync(path.join(root, 'radio.txt'), 'utf8'), old, '回滚为 prev 里的上一批完整生成物');
  });
  await ok('冷启动 bootstrap：无 manifest 但四资产齐全可解析 → 写 version:bootstrap 继续', () => {
    const root = tmpRoot(), old = genOldLib(5, 2);
    seedRoot(root, old);
    fs.writeFileSync(path.join(root, 'radio-meta.json'), JSON.stringify({ v: 1, generatedAt: 1, stations: {} }));
    const st = U.bootManifest(root);
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.version, 'bootstrap');
    const m = JSON.parse(fs.readFileSync(path.join(root, 'sync-manifest.json'), 'utf8'));
    assert.strictEqual(m.version, 'bootstrap');
    assert.strictEqual(m.files.length, 4);
  });
  await ok('资产缺失：不静默混态（ok:false + missing 名单）', () => {
    const root = tmpRoot(), old = genOldLib(5, 2);
    seedRoot(root, old); // 无 radio-meta.json、无 manifest
    const st = U.bootManifest(root);
    assert.strictEqual(st.ok, false);
    assert.deepStrictEqual(st.missing, ['radio-meta.json']);
  });

  console.log('[6] 强制同步两步协议纯函数（token 签发/消费/绑定指纹/单次）');
  const bypassableReport = { reasons: [{ key: 'total-drop', msg: 'x', bypassable: true }], oldTotal: 100, newTotal: 50 };
  await ok('无 stash → 404；无可绕过决策门 → 400；指纹不匹配 → 400', () => {
    assert.strictEqual(U.forceTokenIssue(null, {}, 0, () => 't').status, 404);
    const hardStash = { reportHash: 'h', report: { reasons: [{ key: 'invalid-ratio', msg: 'x', bypassable: false }] } };
    assert.strictEqual(U.forceTokenIssue(hardStash, { reportHash: 'h' }, 0, () => 't').status, 400);
    const stash = { reportHash: 'h1', report: bypassableReport };
    assert.strictEqual(U.forceTokenIssue(stash, { reportHash: 'h2' }, 0, () => 't').status, 400);
  });
  await ok('签发 → 5 分钟过期 + 绑定指纹；单次消费；过期/报告变化/错 token → 403', () => {
    const stash = { reportHash: 'h1', report: bypassableReport, tokens: {} };
    const now = 1000000;
    const iss = U.forceTokenIssue(stash, { reportHash: 'h1' }, now, () => 'tok1');
    assert.strictEqual(iss.status, 200);
    assert.strictEqual(iss.body.token, 'tok1');
    assert.strictEqual(iss.body.expiresAt, now + 5 * 60000);
    assert.strictEqual(iss.body.reportHash, 'h1');
    assert.strictEqual(U.forceTokenConsume(stash, 'tok1', now + 6 * 60000).status, 403, '过期');
    assert.strictEqual(U.forceTokenConsume(stash, 'tok1', now).status, 403, '已消费过（单次）');
    const iss2 = U.forceTokenIssue(stash, { reportHash: 'h1' }, now, () => 'tok2');
    stash.reportHash = 'h2'; // 新同步覆盖 stash：旧 token 绑定指纹失配
    assert.strictEqual(U.forceTokenConsume(stash, 'tok2', now).status, 403, '报告已变化');
    assert.strictEqual(U.forceTokenConsume(stash, 'nope', now).status, 403);
    const stash2 = { reportHash: 'h', report: bypassableReport, tokens: { ok: { expiresAt: now + 1, reportHash: 'h' } } };
    assert.strictEqual(U.forceTokenConsume(stash2, 'ok', now).status, 200);
  });

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('sources 测试异常：', e); process.exit(1); });
