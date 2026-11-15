// test/nightly/real-sources.js —— 真实源抽样（P3，docs/testing-strategy-2026-11.md §3 L5；需要公网）。
// 跑法：node test/nightly/real-sources.js（编排入口 run.js --real）。报告：docs/test-reports/nightly/real-sources.json。
// 退出码语义（方案 §5 失败分类）：数据健康类（真实源探测失败）只进报告不阻塞 = exit 0；
// 环境失败（本机不通公网）= 报告标「环境未执行」exit 1——用「先探稳定公网端点（baidu generate_204 /
// registry.npmjs.org 双探）判连通性」区分网络环境 vs 源漂移。
// 抽样面（方案 §3 L5 固定代表样本）：**从仓库 radio.txt 实时抽取**（按分类名 + 序号固定，不硬编码 URL——
// URL 会漂移）：国内 m3u8 央广系 ×2（cnr.cn 域 m3u8）+ 蜻蜓 mp3 ×2（qingting.fm 64k.mp3 直流）+
// 欧美 m3u8 ×2（欧美音乐节）+ 国际新闻·谈话 ×1 + 已知漂移台（喜马拉雅 xmcdn 形态）×1 = 8 样本。
// 每样本走 update-sources.checkDetail（结构化 code，真实网络不带 testHook；12s 窗口容忍蜻蜓系 5-10s 建流），
// 记录 {name, url, code, httpStatus, contentType, bytes, latencyMs} 全字段入报告。
// 覆盖矩阵：
//   [1] 抽样装配：8 样本齐（分类缺节/样本不足 = 数据形态回归 → 非零退出——radio.txt 是随行生成物）
//   [2] 结构化结果契约：逐样本字段齐全、code ⊆ contracts/source-diagnostic.json 枚举、code ⇔ ok 一致
//   [3] 数据健康记账：code 分布入报告 summary（OK/漂移码各有其位），探测失败不阻塞退出码
//   [4] 连通性预探：双公网端点皆黑 → 环境失败（executed:false + reason）exit 1
// 未覆盖项：
//   - 样本代表性回归测试（样本 URL 的历史可用率趋势——属数据看板，非测试职责）
//   - 探测并发（串行更温和且报告稳定；夜间层不追求秒级）
//   - 播放级验证（解码/持续无卡顿）——本脚本只到 checkDetail 字节验收层
const assert = require('assert'), fs = require('fs'), https = require('https'), path = require('path');
const { checkDetail, splitSections } = require('../../update-sources');

const ROOT = path.join(__dirname, '..', '..');
const REPORTS = path.join(ROOT, 'docs', 'test-reports', 'nightly');
const enumCodes = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'source-diagnostic.json'), 'utf8')).codes;
const probe = u => new Promise(res => { // 连通性预探：任何响应（含 204/403）都算「有公网」
  const rq = https.get(u, { timeout: 6000 }, r => { r.resume(); res(true); });
  rq.on('timeout', () => { rq.destroy(); res(false); });
  rq.on('error', () => res(false));
});
// 抽样器：行 → {name, url}（名字逗号在同步期已被替换，首个逗号即分隔符；URL 漂移由实时读取吸收）
const splitLine = l => { const i = l.indexOf(','); return i < 0 ? null : { name: l.slice(0, i).trim(), url: l.slice(i + 1).trim() }; };

(async () => {
  const t0 = Date.now();
  const samples = [];
  const txt = fs.readFileSync(path.join(ROOT, 'radio.txt'), 'utf8');
  const secs = splitSections(txt);
  const flat = secs.flatMap(s => s.lines.filter(Boolean).map(l => Object.assign({ cat: s.cat }, splitLine(l))).filter(Boolean));
  const pick = (list, tag) => list.slice(0, 2).map((x, i) => samples.push({ tag: tag + '#' + i, name: x.name, category: x.cat, url: x.url }));
  pick(flat.filter(x => /cnr\.cn/.test(x.url) && /\.m3u8/i.test(x.url)), 'cn-m3u8-cnr');            // 国内央广系 m3u8 ×2
  pick(flat.filter(x => /qingting\.fm\/live\//.test(x.url) && /64k\.mp3/.test(x.url)), 'cn-qt-mp3'); // 蜻蜓 mp3 直流 ×2
  pick(flat.filter(x => x.cat === '欧美音乐' && /\.m3u8/i.test(x.url)), 'eu-m3u8');                  // 欧美 m3u8 ×2
  const intl = flat.filter(x => x.cat === '国际新闻·谈话').slice(0, 1)
    .forEach(x => samples.push({ tag: 'intl-talk#0', name: x.name, category: x.cat, url: x.url }));   // 国际新闻·谈话 ×1
  const xm = flat.filter(x => /live\.xmcdn\.com/.test(x.url)).slice(0, 1)
    .forEach(x => samples.push({ tag: 'drift-xmcdn#0', name: x.name, category: x.cat, url: x.url })); // 已知漂移台 ×1

  let pass = 0, fail = 0;
  const asserts = [];
  const ok = (name, fn) => Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ✓', name); asserts.push({ name, pass: true, category: 'code-regression' }); },
    e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); asserts.push({ name, pass: false, category: 'code-regression', error: String(e && e.message || e).slice(0, 300) }); });

  await ok('抽样装配：8 样本齐（分类缺节/不足 2 条 = radio.txt 形态回归）', () => {
    assert.strictEqual(samples.length, 8, '实得 ' + samples.length + '：' + samples.map(s => s.tag).join('/'));
    assert.ok(samples.every(s => /^https?:\/\//.test(s.url) && s.name), '样本行解析完整');
  });

  const online = await probe('https://www.baidu.com/generate_204') || await probe('https://registry.npmjs.org/');
  if (!online) { // 环境失败：明确标「环境未执行」非零退出（不伪报通过、不冒充数据健康）
    console.error('real-sources 未执行（环境失败）：公网不可达（baidu generate_204 + registry.npmjs.org 双探皆失败）');
    fs.mkdirSync(REPORTS, { recursive: true });
    fs.writeFileSync(path.join(REPORTS, 'real-sources.json'), JSON.stringify({ script: 'real-sources',
      generatedAt: new Date().toISOString(), executed: false, category: 'environment',
      reason: '公网不可达（连通性双探皆失败）', durationMs: Date.now() - t0, pass, fail, assertions: asserts }, null, 2));
    process.exit(1);
  }
  console.log('连通性预探通过（公网可达），开始 8 样本结构化探测（12s 窗口/样本，串行）\n');

  const results = [];
  for (const s of samples) {
    process.stdout.write('  · [' + s.tag + '] ' + s.name + ' … ');
    let d;
    try { d = await checkDetail(s.url, 0, { timeout: 12000 }); } // 真实网络：不带 testHook，生产口径
    catch (e) { d = { url: s.url, ok: false, code: 'NETWORK', hls: /\.m3u8/i.test(s.url), mode: /\.m3u8/i.test(s.url) ? 'hls' : 'direct', httpStatus: 0, contentType: '', bytes: 0, latencyMs: 0, why: String(e && e.message || e).slice(0, 60), checkedAt: Date.now() }; }
    process.stdout.write(d.code + '（' + d.bytes + 'B / ' + d.latencyMs + 'ms）\n');
    results.push(Object.assign({ tag: s.tag, name: s.name, category: s.category },
      { url: d.url, ok: d.ok, code: d.code, httpStatus: d.httpStatus, contentType: d.contentType, bytes: d.bytes, latencyMs: d.latencyMs, why: d.why, checkedAt: d.checkedAt }));
  }

  const codes = {};
  for (const r of results) codes[r.code] = (codes[r.code] || 0) + 1;
  await ok('结构化结果契约：逐样本字段齐全、code ⊆ 契约枚举、code ⇔ ok 一致', () => {
    for (const r of results) {
      for (const k of ['url', 'ok', 'code', 'httpStatus', 'contentType', 'bytes', 'latencyMs']) assert.ok(k in r && r[k] !== undefined, r.tag + ' 缺 ' + k);
      assert.ok(enumCodes.includes(r.code), r.tag + ' 枚举外 code ' + r.code);
      assert.strictEqual(r.ok, r.code === 'OK', r.tag + ' code ⇔ ok 不一致');
    }
  });

  const report = { script: 'real-sources', generatedAt: new Date().toISOString(), durationMs: Date.now() - t0,
    executed: true, category: 'data-health', network: 'online', pass, fail,
    summary: { total: results.length, okCount: codes.OK || 0, codes }, // 数据健康记账：探测失败只进报告不阻塞
    samples: results, assertions: asserts };
  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(path.join(REPORTS, 'real-sources.json'), JSON.stringify(report, null, 2));
  console.log(`\n${pass} 通过，${fail} 失败；code 分布：` + Object.entries(codes).map(([k, v]) => k + '=' + v).join(' / ')
    + '（数据健康类——失败只进报告，exit 0）');
  process.exit(fail ? 1 : 0); // 仅契约形态断言（代码回归）驱动退出码
})().catch(e => {
  console.error('real-sources 未执行（套件异常）：', e && e.message || e);
  try {
    fs.mkdirSync(REPORTS, { recursive: true });
    fs.writeFileSync(path.join(REPORTS, 'real-sources.json'), JSON.stringify({ script: 'real-sources',
      generatedAt: new Date().toISOString(), executed: false, category: 'code-regression',
      reason: String(e && e.message || e).slice(0, 300), pass: 0, fail: 1, assertions: [] }, null, 2));
  } catch (_) {}
  process.exit(1);
});
