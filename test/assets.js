// 生成资产/manifest 一致性校验（P1，docs/testing-strategy-2026-11.md §3 L0 检查项 + §6.2「生成数据校验」清单）：
// 对仓库根四个同步生成资产（radio.txt/radio-data.js/logos.txt/radio-meta.json）与 sync-manifest.json 做
// 只读 L0 对账；纯函数面（assetsComplete/bootManifest/writeBootstrapManifest/readManifestOf/manifestCheckDir/
// publishSync）走 test/harness/temp-root.js 临时目录，绝不写仓库根数据文件。
// 与 test/sources.js 分工：那边测「生成管线」（注入原料的质量门/发布事务/代际回滚，fixture 驱动）；本文件测
// 「生成产物」——落在仓库里的真实资产批次自身一致（L0 门禁视角），不重复其三侧键白名单（test/contracts.js）。
// 分节 → 覆盖矩阵（§6.2 清单逐条）：
// [1] sync-manifest.json 四资产存在 + 字节数/SHA-256 逐文件对账（失败点名 文件/维度/期望/实际）+ 发布协议同款
//     readManifestOf/manifestCheckDir 对真仓根判定通过
//     ⚠ 任务描述写 sha1，实际契约字段为 sha256（update-sources.js sha256Buf 发布协议），以契约为准
// [2] radio.txt 行协议：节头 `分类名,#genre#` / 台行 `台名,http(s)://…` 两形态；CRLF 形态；内部空行为零；
//     空分类名/缺逗号/坏 URL 为零；台名不含逗号；节顺序 = CAT_ORDER（源码常量未导出 → 按声明式提取对账，
//     EU_CAT/ASIA_CAT/INTL_CAT/CN_FALLBACK 占位符一并解析）+ splitSections 导出解析器对账；
//     重复主身份点名（同名分裂 run/组内重复 URL/同 URL 异名——软报告不拦截，见未覆盖项）
// [3] radio-data.js 与 radio.txt 内容等价：发布模板 `window.RADIO_DATA=` + JSON.stringify(全文) + `;\r\n`
//     逐字节相等；JSON 反解回 radio.txt 全文
// [4] radio-meta.json 绑定 radio.txt：meta 无独立哈希字段——绑定经同批 manifest（[1] 四资产同批哈希）+
//     buildRadioMeta（导出纯函数）同语义逐台重建对账（键 = 主身份首 URL，name/category/sources 逐字段；
//     slim 态 name/category 可缺省不比对）
// [5] logos.txt 行协议 `分类|台名,图片URL`：分类白名单 = EU_SYSTEM_CATS（源码提取对账）；URL 门禁与 logos.js
//     loadFile 同款（http(s) 且无 引号/空白/尖括号）；头注释在位；CRLF 形态；重复键软点名（loadFile 后到覆盖）
// [6] assetsComplete 分支矩阵（temp-root：四资产齐/逐个缺/空文件/只有节头无台行的 radio.txt/无标记
//     radio-data.js/坏 meta JSON/v≠1/stations 非对象）
// [7] writeBootstrapManifest ↔ readManifestOf round-trip（哈希可对回）；bootManifest 分支（无 manifest 四资产齐
//     → bootstrap、缺资产 → ok:false+missing 名单、坏 manifest → 同 bootstrap 兜底、哈希不匹配无前批 →
//     corrupt:true 且根资产字节不变）
// [8] 发布事务失败保旧批（纯函数层）：publishSync 生成物不全抛「生成物不全」→ 根四资产 + manifest 字节不变；
//     happy path 产物可校验 + .tmp/sync-prev 自描述；readManifestOf 容错矩阵（坏 JSON/缺 files/条数/未知路径/
//     字段型不对）/ manifestCheckDir（缺文件/哈希/字节不符）
// [9] 数量 sanity：总数 ≥ 1000（防意外清库哨兵，阈值放宽防上游正常波动）；分类 > 0；meta 台数 = 主身份重建数
// 未覆盖项与原因：
// - logos.txt 条目与 radio.txt 欧美系两节的名字级对应：资产批（bootstrap）与台标批非同批生成、上游重排合法
//   漂移（当前 95 条中 16 条名字已不在库，重跑 --logos 可收敛）——点名不拦截，硬断言会假红
// - 重复主身份硬拦截：当前库存在 9 组同名分裂 run、1 组组内重复 URL、18 组同 URL 异名（皆上游遗留，classifyCn
//   原样保留国内节、装配不合并）——[2] 点名输出；要收紧须先在 update-sources.js 装配处去重再翻硬断言
// - publishSync 回滚副本写校验失败分支（.tmp/sync-prev-new 校验拦截，AIbot P1-3）：需注入 fs 故障，
//   发布事务/代际轮换行为面归 test/sources.js（注入管线全矩阵）
// - manifest version='sync-*' 真实同步批次：本仓当前批由 --init-meta 产 bootstrap（version 语义 [7] 已测），
//   真同步批次归 L2/演练层（需真上游）
// 零依赖离线（仓库根数据文件只读），Node 14 兼容，npm test 随跑。
const assert = require('assert'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const U = require('../update-sources');
const { tempRoot } = require('./harness/temp-root');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); }
};

const ROOT = path.join(__dirname, '..');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

(async () => {
  /* ---------- 只读装载仓库根数据文件（绝不写） ---------- */
  const manifestTxt = fs.readFileSync(path.join(ROOT, 'sync-manifest.json'), 'utf8');
  const radioTxt = fs.readFileSync(path.join(ROOT, 'radio.txt'), 'utf8');
  const radioDataJs = fs.readFileSync(path.join(ROOT, 'radio-data.js'), 'utf8');
  const logosTxt = fs.readFileSync(path.join(ROOT, 'logos.txt'), 'utf8');
  const metaTxt = fs.readFileSync(path.join(ROOT, 'radio-meta.json'), 'utf8');

  /* ---------- [0] 常量对账：SYNC_ASSETS 导出 + CAT_ORDER/EU_SYSTEM_CATS 源码提取 ---------- */
  console.log('[0] 常量对账（update-sources.js 导出/声明）');
  ok('SYNC_ASSETS 导出 = 四生成资产名单', () => {
    assert.deepStrictEqual(U.SYNC_ASSETS, ['radio.txt', 'radio-data.js', 'logos.txt', 'radio-meta.json'],
      'SYNC_ASSETS 名单漂移（manifest 四资产口径随之漂移）');
  });
  const SRC = fs.readFileSync(path.join(ROOT, 'update-sources.js'), 'utf8');
  const catLit = {};
  for (const m of SRC.matchAll(/const (EU_CAT|ASIA_CAT|INTL_CAT|CN_FALLBACK) = '([^']*)';/g)) catLit[m[1]] = m[2];
  const resolveIds = arr => arr.map(s => { s = s.trim(); const q = s.match(/^'(.*)'$/); return q ? q[1] : catLit[s]; });
  const CAT_ORDER = resolveIds(((SRC.match(/const CAT_ORDER = \[([^\]]*)\];/) || [])[1] || '').split(','));
  const EU_SYSTEM_CATS = resolveIds(((SRC.match(/const EU_SYSTEM_CATS = \[([^\]]*)\];/) || [])[1] || '').split(','));
  ok('CAT_ORDER/EU_SYSTEM_CATS 源码声明可解析（占位符全部落为字面量、无重复）', () => {
    assert.ok(CAT_ORDER.length >= 8, 'CAT_ORDER 提取失败（节过少）：' + JSON.stringify(CAT_ORDER));
    assert.ok(CAT_ORDER.every(c => c && typeof c === 'string'), 'CAT_ORDER 含未解析占位符：' + JSON.stringify(CAT_ORDER));
    assert.strictEqual(new Set(CAT_ORDER).size, CAT_ORDER.length, 'CAT_ORDER 有重复分类');
    assert.strictEqual(EU_SYSTEM_CATS.length, 2, 'EU_SYSTEM_CATS 提取失败');
    assert.ok(EU_SYSTEM_CATS.every(c => c && CAT_ORDER.includes(c)), 'EU_SYSTEM_CATS 不在 CAT_ORDER 内');
  });

  /* ---------- [1] sync-manifest.json 四资产哈希/字节数（§6.2 第 6 条，L0） ---------- */
  console.log('[1] sync-manifest.json 四资产对账（仓库根 L0）');
  const manifest = JSON.parse(manifestTxt);
  ok('manifest 结构 = 四资产名单（条数/路径集合/version/generatedAt）', () => {
    assert.ok(Array.isArray(manifest.files), 'sync-manifest.json.files 非数组');
    assert.strictEqual(manifest.files.length, U.SYNC_ASSETS.length,
      `manifest 条数 ${manifest.files.length} ≠ SYNC_ASSETS ${U.SYNC_ASSETS.length}`);
    assert.deepStrictEqual(manifest.files.map(f => f.path).sort(), U.SYNC_ASSETS.slice().sort(),
      'manifest 覆盖路径集合与 SYNC_ASSETS 漂移');
    assert.strictEqual(typeof manifest.version, 'string', 'manifest.version 缺失');
    assert.ok(Number.isFinite(manifest.generatedAt), 'manifest.generatedAt 非有限数');
  });
  ok('逐文件 字节数+SHA-256 对账（失败点名 文件/维度/期望/实际）', () => {
    for (const f of manifest.files) {
      const p = path.join(ROOT, f.path);
      assert.ok(fs.existsSync(p), 'manifest 点名的资产缺失：' + f.path);
      const buf = fs.readFileSync(p);
      assert.strictEqual(buf.length, f.bytes, `${f.path} 字节数不符：期望 ${f.bytes} 实际 ${buf.length}`);
      const h = sha256(buf);
      assert.strictEqual(h, f.sha256, `${f.path} SHA-256 不符：期望 ${f.sha256} 实际 ${h}`);
    }
  });
  ok('发布协议同款校验对真仓根通过（readManifestOf + manifestCheckDir）', () => {
    const m = U.readManifestOf(ROOT);
    assert.ok(m, 'readManifestOf(ROOT) 归 null（manifest 结构不符发布协议：条数/路径/字段型）');
    assert.ok(U.manifestCheckDir(ROOT, m), 'manifestCheckDir(ROOT) 不通过（哈希/字节对不上）');
    assert.strictEqual(m.version, manifest.version, 'readManifestOf 与直读 manifest.version 不一致');
  });

  /* ---------- [2] radio.txt 行协议（§6.2 第 1 条） ---------- */
  console.log('[2] radio.txt 行协议（节头/台行/CRLF/CAT_ORDER 顺序/主身份点名）');
  const rawLines = radioTxt.split(/\r?\n/);
  const cats = [], stations = [], badLines = [];
  let cat = '', sawHeader = false, interiorEmpty = 0;
  rawLines.forEach((raw, idx) => {
    const l = raw.trim();
    if (!l) { if (idx < rawLines.length - 1) interiorEmpty++; return; } // 尾部收尾空行合法
    const hm = l.match(/^([^,]+),#genre#$/);
    if (hm) { cat = hm[1]; sawHeader = true; cats.push({ cat, at: idx + 1 }); return; }
    if (l.endsWith('#genre#')) { badLines.push(`第 ${idx + 1} 行节头形态不合法（空分类名/含逗号）：${l.slice(0, 40)}`); return; }
    const i = l.indexOf(',');
    if (!sawHeader) { badLines.push(`第 ${idx + 1} 行台行出现在首个节头之前`); return; }
    const name = i < 0 ? '' : l.slice(0, i), url = i < 0 ? '' : l.slice(i + 1);
    if (i < 0 || !name || name.includes(',') || !/^https?:\/\//i.test(url)) {
      badLines.push(`第 ${idx + 1} 行台行不合法（缺逗号/空台名/台名含逗号/URL 非 http(s)）：${l.slice(0, 60)}`); return;
    }
    stations.push({ cat, name, url, at: idx + 1 });
  });
  ok('CRLF 行尾形态（同步写 CRLF；无裸 LF/裸 CR）', () => {
    assert.ok(radioTxt.endsWith('\r\n'), 'radio.txt 不以 CRLF 收尾');
    assert.ok(!/(^|[^\r])\n/.test(radioTxt), 'radio.txt 存在裸 LF（非 CRLF 行尾）');
    assert.ok(!/\r(?!\n)/.test(radioTxt), 'radio.txt 存在裸 CR（非 CRLF 行尾）');
  });
  ok('结构合法：无内部空行、无空分类名节头、无节前/坏形态行', () => {
    assert.strictEqual(interiorEmpty, 0, `radio.txt 有 ${interiorEmpty} 个内部空行（节头后台行之间的空行）`);
    assert.ok(cats.length, 'radio.txt 无任何分类节头');
    for (const c of cats) assert.ok(c.cat, `radio.txt 第 ${c.at} 行节头空分类名`);
    assert.deepStrictEqual(badLines, [], 'radio.txt 行协议坏行：\n       ' + badLines.join('\n       '));
  });
  ok('分类装配顺序 = CAT_ORDER（源码声明对账；分类名全在表内且索引严格递增）', () => {
    let prev = -1;
    for (const c of cats) {
      const idx = CAT_ORDER.indexOf(c.cat);
      assert.ok(idx >= 0, `radio.txt 分类「${c.cat}」（第 ${c.at} 行）不在 CAT_ORDER：${JSON.stringify(CAT_ORDER)}`);
      assert.ok(idx > prev, `radio.txt 分类装配顺序偏离 CAT_ORDER：「${c.cat}」（第 ${c.at} 行，期望排在「${CAT_ORDER[prev] || '首'}」之后）`);
      prev = idx;
    }
  });
  ok('splitSections 导出解析器同视角（节序一致、无空节）', () => {
    assert.deepStrictEqual(U.splitSections(radioTxt).map(s => s.cat), cats.map(c => c.cat),
      'splitSections 视角与行走查节序不一致（空节/解析分叉）');
  });
  // 主身份走查（软点名：上游遗留态，装配管线不保证合并——硬断言会假红，见文件头未覆盖项）
  const runFirst = new Map(), groupUrls = new Map(), ownerByCatUrl = new Map();
  let lastKey = null;
  for (const st of stations) {
    const k = st.cat + '|' + st.name;
    if (k !== lastKey) { if (!runFirst.has(k)) runFirst.set(k, []); runFirst.get(k).push(st.url); lastKey = k; }
    if (!groupUrls.has(k)) groupUrls.set(k, []);
    groupUrls.get(k).push(st.url);
    const ou = st.cat + '|' + st.url;
    if (!ownerByCatUrl.has(ou)) ownerByCatUrl.set(ou, new Set());
    ownerByCatUrl.get(ou).add(st.name);
  }
  const splitRuns = [...runFirst.entries()].filter(([, a]) => new Set(a).size > 1);
  const inGroupDup = [...groupUrls.entries()].filter(([, a]) => new Set(a).size !== a.length);
  const multiNames = [...ownerByCatUrl.entries()].filter(([, s]) => s.size > 1);
  ok('重复主身份点名（软报告：分裂 run/组内重复 URL/同 URL 异名，数量如实打印）', () => {
    console.log(`    · 同名分裂 run（组首 URL 可能漂移）: ${splitRuns.length} 组` +
      (splitRuns.length ? `，首例 ${splitRuns[0][0]} → ${splitRuns[0][1].join(' / ')}` : ''));
    console.log(`    · 组内重复 URL: ${inGroupDup.length} 组` +
      (inGroupDup.length ? `，首例 ${inGroupDup[0][0]}` : ''));
    console.log(`    · 同分类同 URL 挂多台名: ${multiNames.length} 组` +
      (multiNames.length ? `，首例 ${multiNames[0][0]} → ${[...multiNames[0][1]].join(' / ')}` : ''));
    assert.ok(true);
  });

  /* ---------- [3] radio-data.js 与 radio.txt 内容等价（§6.2 第 3 条） ---------- */
  console.log('[3] radio-data.js 等价（发布模板逐字节 + JSON 反解）');
  ok('radio-data.js = 发布模板逐字节（window.RADIO_DATA= + JSON.stringify(全文) + ;\\r\\n）', () => {
    const expect = 'window.RADIO_DATA=' + JSON.stringify(radioTxt) + ';\r\n';
    assert.strictEqual(radioDataJs, expect,
      `radio-data.js 与发布模板逐字节不符：期望 ${expect.length}B 实际 ${radioDataJs.length}B（同步随行产出漂移）`);
  });
  ok('剥壳反解：JSON 字符串字面量 parse 后 === radio.txt 全文（含 CRLF）', () => {
    const m = radioDataJs.match(/^window\.RADIO_DATA=([\s\S]*);\r\n$/);
    assert.ok(m, 'radio-data.js 不符 window.RADIO_DATA="…"; 形态（剥壳失败）');
    assert.strictEqual(JSON.parse(m[1]), radioTxt, 'radio-data.js 内嵌字符串反解后与 radio.txt 全文不等');
  });

  /* ---------- [4] radio-meta.json 绑定 radio.txt（§6.2 第 4 条） ---------- */
  console.log('[4] radio-meta.json 绑定（同批 manifest + buildRadioMeta 逐台重建对账）');
  const meta = JSON.parse(metaTxt);
  ok('meta 结构：v=1 / generatedAt 有限 / stations 对象 / 每源 url+upstream+kind=main+firstSeenAt', () => {
    assert.strictEqual(meta.v, 1, 'radio-meta.json.v ≠ 1（消费端 RadioMeta.kt 口径）');
    assert.ok(Number.isFinite(meta.generatedAt), 'radio-meta.json.generatedAt 非有限数');
    assert.ok(meta.stations && typeof meta.stations === 'object' && !Array.isArray(meta.stations),
      'radio-meta.json.stations 非对象');
    for (const [k, st] of Object.entries(meta.stations)) {
      assert.ok(Array.isArray(st.sources) && st.sources.length, `stations[${k}].sources 空/非数组`);
      for (const s of st.sources) {
        assert.ok(s && typeof s.url === 'string' && s.url, `stations[${k}] 源缺 url`);
        assert.ok(typeof s.upstream === 'string', `stations[${k}] 源缺 upstream`);
        assert.strictEqual(s.kind, 'main', `stations[${k}] 源 kind ≠ main`);
        assert.ok(Number.isFinite(s.firstSeenAt), `stations[${k}] 源缺 firstSeenAt`);
      }
    }
  });
  ok('逐台重建对账：buildRadioMeta(radio.txt) 同语义 → meta 键/名/分类/源序全等（绑定经同批 manifest 双保险）', () => {
    const rebuilt = U.buildRadioMeta(U.splitSections(radioTxt).flatMap(s => [s.cat + ',#genre#', ...s.lines]),
      null, [], null, 0, '');
    const rk = Object.keys(rebuilt.stations), mk = Object.keys(meta.stations);
    assert.strictEqual(mk.length, rk.length,
      `radio-meta.json 台数 ${mk.length} ≠ radio.txt 主身份重建数 ${rk.length}（${mk.length - rk.length} 漂移）`);
    for (const k of mk) {
      const r = rebuilt.stations[k], st = meta.stations[k];
      assert.ok(r, `radio-meta.json 主身份键不在 radio.txt 重建结果（身份漂移）：${k}`);
      if ('name' in st) assert.strictEqual(st.name, r.name, `stations[${k}].name 与 radio.txt 不符：${st.name} vs ${r.name}`);
      if ('category' in st) assert.strictEqual(st.category, r.category, `stations[${k}].category 与 radio.txt 不符`);
      assert.deepStrictEqual(st.sources.map(s => s.url), r.sources.map(s => s.url),
        `stations[${k}].sources 与 radio.txt 组内 URL 序不符`);
    }
  });

  /* ---------- [5] logos.txt 行协议（§6.2 第 5 条） ---------- */
  console.log('[5] logos.txt 行协议（分类白名单/URL 门禁/头注释）');
  let logoCount = 0, logoDup = 0; // 台标条目数/重复键数（[9] 实况打印复用）
  ok('头注释在位 + CRLF 形态 + 分类白名单 = EU_SYSTEM_CATS + URL 门禁（logos.js loadFile 同款）', () => {
    const lines = logosTxt.split(/\r?\n/).filter(l => l.trim());
    assert.ok(lines.length && /^#/.test(lines[0].trim()), 'logos.txt 缺头注释行（首行须 # 开头）');
    assert.ok(logosTxt.endsWith('\r\n') && !/(^|[^\r])\n/.test(logosTxt), 'logos.txt 非 CRLF 形态');
    const perCat = {};
    let bad = 0; const seenSet = new Set(), badSample = [];
    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      const bar = line.indexOf('|'), i = line.lastIndexOf(',');
      const c = bar < 0 ? '' : line.slice(0, bar);
      const u = i < 0 ? '' : line.slice(i + 1).trim();
      const key = i < 0 ? '' : line.slice(0, i).trim();
      if (!EU_SYSTEM_CATS.includes(c) || !key.slice(c.length + 1) ||
        !/^https?:\/\//.test(u) || /[\s"'<>]/.test(u)) {
        bad++; if (badSample.length < 3) badSample.push(line.slice(0, 60)); continue;
      }
      if (seenSet.has(key)) logoDup++;
      seenSet.add(key);
      perCat[c] = (perCat[c] || 0) + 1;
    }
    logoCount = seenSet.size;
    assert.strictEqual(bad, 0, `logos.txt ${bad} 行不符「${EU_SYSTEM_CATS.join('/')}|台名,http(s)URL」或 URL 含引号/空白/尖括号：\n       ` + badSample.join('\n       '));
    assert.ok(Object.keys(perCat).length > 0, 'logos.txt 无任何台标条目');
    console.log(`    · 台标 ${logoCount} 条（${Object.entries(perCat).map(([c, n]) => `${c} ${n}`).join('，')}），重复键 ${logoDup}（loadFile 后到覆盖，软点名）`);
  });

  /* ---------- [6] assetsComplete 分支矩阵（§6.2/L0；temp-root） ---------- */
  console.log('[6] assetsComplete 分支矩阵（临时目录）');
  const seedAssets = root => {
    const txt = '华语音乐,#genre#\r\n台A,http://a/1.mp3\r\n台A,http://a/2.mp3\r\n';
    fs.writeFileSync(path.join(root, 'radio.txt'), txt);
    fs.writeFileSync(path.join(root, 'radio-data.js'), 'window.RADIO_DATA=' + JSON.stringify(txt) + ';\r\n');
    fs.writeFileSync(path.join(root, 'logos.txt'), '# 头注释\r\n欧美音乐|台A,http://logo/a.png\r\n');
    fs.writeFileSync(path.join(root, 'radio-meta.json'),
      JSON.stringify({ v: 1, generatedAt: 1, stations: { 'http://a/1.mp3': { name: '台A', category: '华语音乐',
        sources: [{ url: 'http://a/1.mp3', upstream: 'local', upstreamId: '', kind: 'main', firstSeenAt: 1 }] } } }));
  };
  ok('四资产齐全 → true；逐个缺失 → false（点名缺哪个）', () => {
    const tr = tempRoot('assets-complete'); try {
      seedAssets(tr.dir);
      assert.strictEqual(U.assetsComplete(tr.dir), true, '四资产齐全判定 false');
      for (const f of U.SYNC_ASSETS) {
        const tr2 = tempRoot('assets-missing-' + f.replace(/\W/g, '-'));
        try { seedAssets(tr2.dir); fs.unlinkSync(path.join(tr2.dir, f));
          assert.strictEqual(U.assetsComplete(tr2.dir), false, '缺 ' + f + ' 仍判 true');
        } finally { tr2.wipe(); }
      }
    } finally { tr.wipe(); }
  });
  ok('混态不静默：空 radio.txt / 只有节头无台行 / 无标记 radio-data.js / 坏 meta JSON / v≠1 / stations 非对象', () => {
    const cases = [
      ['radio.txt 空文件', { 'radio.txt': '' }],
      ['radio.txt 只有节头无台行（splitSections 归零）', { 'radio.txt': '华语音乐,#genre#\r\n' }],
      ['radio-data.js 无 RADIO_DATA 标记', { 'radio-data.js': 'x=1;\r\n' }],
      ['radio-meta.json 坏 JSON', { 'radio-meta.json': 'not json' }],
      ['radio-meta.json v=2', { 'radio-meta.json': JSON.stringify({ v: 2, generatedAt: 1, stations: {} }) }],
      ['radio-meta.json stations 非对象', { 'radio-meta.json': JSON.stringify({ v: 1, generatedAt: 1, stations: 'x' }) }],
    ];
    for (const [name, over] of cases) {
      const tr = tempRoot('assets-mixed'); try {
        seedAssets(tr.dir);
        for (const k of Object.keys(over)) fs.writeFileSync(path.join(tr.dir, k), over[k]);
        assert.strictEqual(U.assetsComplete(tr.dir), false, name + ' 仍判 true（静默混态）');
      } finally { tr.wipe(); }
    }
  });

  /* ---------- [7] writeBootstrapManifest ↔ readManifestOf round-trip + bootManifest 分支 ---------- */
  console.log('[7] bootstrap manifest round-trip + bootManifest 分支（临时目录）');
  ok('writeBootstrapManifest 产物可被 readManifestOf 读回且逐文件哈希对得上', () => {
    const tr = tempRoot('assets-bootstrap'); try {
      seedAssets(tr.dir);
      U.writeBootstrapManifest(tr.dir);
      const m = U.readManifestOf(tr.dir);
      assert.ok(m, 'bootstrap manifest 读回 null');
      assert.strictEqual(m.version, 'bootstrap', 'version ≠ bootstrap');
      assert.strictEqual(m.files.length, 4, 'files 条数 ≠ 4');
      for (const f of m.files) {
        const buf = fs.readFileSync(path.join(tr.dir, f.path));
        assert.strictEqual(buf.length, f.bytes, f.path + ' bytes');
        assert.strictEqual(sha256(buf), f.sha256, f.path + ' sha256');
      }
      assert.ok(U.manifestCheckDir(tr.dir, m), 'manifestCheckDir 对 bootstrap 产物不通过');
    } finally { tr.wipe(); }
  });
  ok('bootManifest：无 manifest + 四资产齐 → bootstrap 兜底继续；缺资产 → ok:false + missing 名单', () => {
    const tr = tempRoot('assets-boot1'); try {
      seedAssets(tr.dir);
      const st = U.bootManifest(tr.dir);
      assert.deepStrictEqual(st, { ok: true, version: 'bootstrap' }, '四资产齐未走 bootstrap：' + JSON.stringify(st));
      assert.ok(fs.existsSync(path.join(tr.dir, 'sync-manifest.json')), 'bootstrap 未落 manifest');
    } finally { tr.wipe(); }
    const tr2 = tempRoot('assets-boot2'); try {
      seedAssets(tr2.dir);
      fs.unlinkSync(path.join(tr2.dir, 'radio-meta.json'));
      const st = U.bootManifest(tr2.dir);
      assert.strictEqual(st.ok, false, '缺资产仍 ok');
      assert.deepStrictEqual(st.missing, ['radio-meta.json'], 'missing 名单不精确：' + JSON.stringify(st.missing));
    } finally { tr2.wipe(); }
  });
  ok('bootManifest：坏 manifest（非 JSON）→ 同 bootstrap 兜底重写可读回', () => {
    const tr = tempRoot('assets-boot3'); try {
      seedAssets(tr.dir);
      fs.writeFileSync(path.join(tr.dir, 'sync-manifest.json'), 'garbage{{{');
      const st = U.bootManifest(tr.dir);
      assert.strictEqual(st.ok, true, '坏 manifest 未走 bootstrap 兜底');
      assert.strictEqual(st.version, 'bootstrap', '坏 manifest 兜底 version 不对');
      assert.ok(U.readManifestOf(tr.dir), '兜底重写后 readManifestOf 仍 null');
    } finally { tr.wipe(); }
  });
  ok('bootManifest：manifest 有效但哈希不匹配 + 无前批 → corrupt:true 且根资产字节不变（不静默混态）', () => {
    const tr = tempRoot('assets-boot4'); try {
      seedAssets(tr.dir);
      U.writeBootstrapManifest(tr.dir);
      fs.appendFileSync(path.join(tr.dir, 'radio.txt'), '幽灵台,http://ghost/1.mp3\r\n'); // 资产漂移 → 哈希失配
      const before = {}; // 快照漂移后的现场：bootManifest 失败路径本身不得再动根资产
      for (const f of U.SYNC_ASSETS) before[f] = fs.readFileSync(path.join(tr.dir, f));
      const st = U.bootManifest(tr.dir);
      assert.strictEqual(st.ok, false, '哈希失配仍 ok');
      assert.strictEqual(st.corrupt, true, '哈希失配未标 corrupt');
      for (const f of U.SYNC_ASSETS)
        assert.ok(before[f].equals(fs.readFileSync(path.join(tr.dir, f))), '失败路径改写了根资产 ' + f);
    } finally { tr.wipe(); }
  });

  /* ---------- [8] 发布事务失败保旧批 + manifest 容错矩阵（§6.2 第 7 条；纯函数层） ---------- */
  console.log('[8] 发布事务（publishSync 失败保旧批）+ manifest 容错（临时目录）');
  ok('publishSync happy path：四资产替换 + manifest 同批可校验 + .tmp/sync-prev 自描述含旧批', () => {
    const tr = tempRoot('assets-pub1'); try {
      seedAssets(tr.dir);
      const oldTxt = fs.readFileSync(path.join(tr.dir, 'radio.txt'), 'utf8');
      const arts = {}; for (const f of U.SYNC_ASSETS) arts[f] = '新批:' + f + '\r\n' + fs.readFileSync(path.join(tr.dir, f), 'utf8');
      const mf = U.publishSync(tr.dir, arts, { version: 'sync-test-1' });
      assert.strictEqual(mf.version, 'sync-test-1', '返回 manifest version 不符');
      for (const f of U.SYNC_ASSETS)
        assert.strictEqual(fs.readFileSync(path.join(tr.dir, f), 'utf8'), arts[f], '新批未落盘：' + f);
      const m = U.readManifestOf(tr.dir);
      assert.ok(m && U.manifestCheckDir(tr.dir, m), '发布后 manifest 不可校验');
      const prev = path.join(tr.dir, '.tmp', 'sync-prev');
      assert.strictEqual(fs.readFileSync(path.join(prev, 'radio.txt'), 'utf8'), oldTxt, 'prev 未快照旧批');
      const pm = U.readManifestOf(prev);
      assert.ok(pm && U.manifestCheckDir(prev, pm), 'prev 副本不自描述/不可校验');
    } finally { tr.wipe(); }
  });
  ok('发布事务失败保旧批：publishSync 生成物不全抛「生成物不全」→ 根四资产 + manifest 字节不变', () => {
    const tr = tempRoot('assets-pub2'); try {
      seedAssets(tr.dir);
      U.writeBootstrapManifest(tr.dir); // 预置有效 manifest：失败时也须原样
      const before = {};
      for (const f of [...U.SYNC_ASSETS, 'sync-manifest.json']) before[f] = fs.readFileSync(path.join(tr.dir, f));
      const arts = {}; for (const f of U.SYNC_ASSETS) arts[f] = '新批:' + f + '\r\n';
      delete arts['logos.txt']; // 半批生成物
      assert.throws(() => U.publishSync(tr.dir, arts, { version: 'sync-bad' }), /生成物不全/,
        '半批生成物未抛「生成物不全」');
      for (const f of [...U.SYNC_ASSETS, 'sync-manifest.json'])
        assert.ok(before[f].equals(fs.readFileSync(path.join(tr.dir, f))), '失败路径改写了 ' + f);
    } finally { tr.wipe(); }
  });
  ok('readManifestOf 容错：坏 JSON/缺 files/条数不符/未知路径/字段型不对 → 一律 null（不抛）', () => {
    const tr = tempRoot('assets-rmo'); try {
      seedAssets(tr.dir);
      U.writeBootstrapManifest(tr.dir);
      const good = fs.readFileSync(path.join(tr.dir, 'sync-manifest.json'), 'utf8');
      assert.ok(U.readManifestOf(tr.dir), '基线 manifest 应可读');
      const variants = [
        ['坏 JSON', 'not json{{{'],
        ['缺 files', JSON.stringify({ version: 'x', generatedAt: 1 })],
        ['files 条数不符', JSON.stringify({ version: 'x', generatedAt: 1, files: [{ path: 'radio.txt', bytes: 1, sha256: 'a' }] })],
        ['未知路径', (() => { const m = JSON.parse(good); m.files[0].path = 'other.txt'; return JSON.stringify(m); })()],
        ['bytes 非有限数', (() => { const m = JSON.parse(good); m.files[0].bytes = 'x'; return JSON.stringify(m); })()],
        ['sha256 非字符串', (() => { const m = JSON.parse(good); m.files[0].sha256 = 123; return JSON.stringify(m); })()],
      ];
      for (const [name, txt] of variants) {
        fs.writeFileSync(path.join(tr.dir, 'sync-manifest.json'), txt);
        assert.strictEqual(U.readManifestOf(tr.dir), null, name + ' 未归 null');
      }
    } finally { tr.wipe(); }
  });
  ok('manifestCheckDir：全对 true；缺文件/哈希不符/字节不符 → false（读文件异常不抛）', () => {
    const tr = tempRoot('assets-mcd'); try {
      seedAssets(tr.dir);
      U.writeBootstrapManifest(tr.dir);
      const m = U.readManifestOf(tr.dir);
      assert.ok(U.manifestCheckDir(tr.dir, m), '基线应通过');
      fs.unlinkSync(path.join(tr.dir, 'radio-data.js'));
      assert.strictEqual(U.manifestCheckDir(tr.dir, m), false, '缺文件仍 true');
      seedAssets(tr.dir); // 恢复后哈希相同 → 再过；随后做哈希/字节双维篡改
      assert.ok(U.manifestCheckDir(tr.dir, m), '恢复后应通过');
      fs.appendFileSync(path.join(tr.dir, 'radio.txt'), 'x'); // 字节变 → sha 变
      assert.strictEqual(U.manifestCheckDir(tr.dir, m), false, '内容篡改仍 true');
      seedAssets(tr.dir);
      const m2 = JSON.parse(JSON.stringify(m)); m2.files[0].bytes += 1;
      assert.strictEqual(U.manifestCheckDir(tr.dir, m2), false, 'manifest 字节记录漂移仍 true');
      const m3 = JSON.parse(JSON.stringify(m)); m3.files[1].sha256 = '0'.repeat(64);
      assert.strictEqual(U.manifestCheckDir(tr.dir, m3), false, 'manifest 哈希记录漂移仍 true');
    } finally { tr.wipe(); }
  });

  /* ---------- [9] 数量 sanity（§6.2 第 2 条；防意外清库哨兵） ---------- */
  console.log('[9] 数量 sanity');
  ok('总数 ≥ 1000（当前库 1600+，阈值放宽防上游正常波动——意外清库即红）', () => {
    assert.ok(stations.length >= 1000, `radio.txt 总台数仅 ${stations.length}（< 1000，疑似清库/同步事故）`);
  });
  ok('分类计数 > 0，meta 台数 = 主身份重建数 > 0', () => {
    assert.ok(cats.length > 0, `radio.txt 分类数 ${cats.length}`);
    const metaN = Object.keys(meta.stations).length;
    assert.ok(metaN > 0, 'radio-meta.json.stations 为空');
    assert.strictEqual(metaN, Object.keys(U.buildRadioMeta(
      U.splitSections(radioTxt).flatMap(s => [s.cat + ',#genre#', ...s.lines]), null, [], null, 0, '').stations).length,
      'meta 台数与 radio.txt 主身份重建数不一致');
    console.log(`    · 实况：${stations.length} 台 / ${cats.length} 分类（${cats.map(c => c.cat).join('、')}）/ meta ${metaN} 台 / 台标 ${logoCount} 条`);
  });

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('资产校验异常：', e); process.exit(1); });
