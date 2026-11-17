// station-api —— /api/mystation + /api/boot 真服务端到端矩阵（docs/testing-strategy-2026-11.md §3 L2「统一 API 矩阵」P1 批）。
// 真服务子进程（test/harness/api-client.js）+ 本地 http fixture（test/harness/http-fixture.js），全程离线（唯一网络 = 本机 fixture）。
// 隔离（review#39 P2-适配 #37 修订版 api-client）：isolated = 复制仓库骨架到独立临时应用根再起服——服务写盘
// （my-radio.txt、data/*.json、生成资产）全部落在临时根内，宿主用户数据与生成资产零接触；测试视角路径一律取
// boot 返回的 root（APPROOT 随每次 boot 重绑），不再对仓库根做任何快照/还原。
// 覆盖矩阵：
//   A /api/mystation（真服务 + VR_TEST_GUARD=1 注入缝：safeTarget 顶替为 http(s) 形态放行、lookup 固定回环 → 探活打到本地 fixture）
//     1 探活通过写入两态：新分类尾部开节 / 已有分类节内插入（含延迟建流 300ms——12s 探活窗口容忍）
//     2 假流 336B（SHORT_BODY）/ HTML 错误页 / 404 小体（直流不看状态码）/ 死端口 NETWORK → HTTP 200 但
//       {ok:false, detail:'探活失败：…'}（业务失败与 HTTP 状态区分），且文件零写入
//     3 台名/分类去 csv 分隔符（逗号/竖线/换行，分类额外去 #）+ 长度封顶 40/24 + URL 512
//     4 重复拒绝：同名同 URL「该电台已在个人列表中」/ 同 URL 换名「该流地址已存在（点名既有台名）」
//     5 500 行 / 64KB 封顶：{ok:false} 上限文案，旧文件字节不变
//     6 并发两 POST：myQ 串行队列——两台都落盘、无互相覆盖
//     7 协议面：跨源 Origin 403（smoke 未覆盖 mystation 跨源，本批补上）/ 非法 JSON 400 / 清洗后空名空分类 400 / 请求体 >2048 413
//   A' 无缝默认 boot（VR_TEST_GUARD 不为 1）：环回/私网/非 http URL → 403「流地址不合法」（SSRF 护栏回归；
//     与缝内同一 URL 形态 200 ok 形成对照），文件零写入
//   B /api/boot（makeRoot 建独立应用根 → 预写/操纵根内生成资产 → boot({root}) 起服 → 操纵 → boot({root}) 重启；
//     根需测试自管清理（close 不删非自有根）；每子测先 resetArts 复位到骨架原始代，宿主资产零接触）
//     8  全资产齐 + manifest 哈希匹配 → {ok:true, version, missing:[], restored:false}
//     9  缺 sync-manifest.json + 四资产齐 → bootstrap 写入（ok:true version:'bootstrap'，manifest 落盘且四资产不动）
//     10 缺 radio-meta.json + 无 manifest → ok:false missing:[radio-meta.json]（不静默混态、不写 bootstrap）
//     11 缺 radio-meta.json + prev 有效 → 自动恢复（ok:true restored:true，文件从 .tmp/sync-prev 找回；
//        源码口径：恢复成功按 prev manifest 版本上报、不回带 missing——missing 只出现在 ok:false 与 bootstrap-缺资响应）
//     12 manifest 哈希不匹配（篡改 radio.txt 一字节）+ prev → 恢复上一批（version=prev 携带的 A1，radio.txt 字节还原）
//     13 prev 损坏 → .tmp/sync-prev-old 兜底恢复（AIbot P1-3 代际轮换：任何时刻至少一代完整上一批）
//     14 哈希不匹配 + 无 prev → ok:false（恢复通道不可用，不静默混态）
// 未覆盖（另行安排）：
//   - 写失败注入（writeFile/rename EPERM）→ L5 故障演练（本批任务明确不含）
//   - /api/boot POST 405（test/smoke.js 已有）；boot 恢复「恢复中途再次失败」双故障与连续多代轮换 → L5
//   - 探活 12s 窗口超时边界（真实等待过久；失败通道已由死端口/假流覆盖）；HLS/ICY 探活分支（test/diagnostic.js 全覆盖）
//   - /api/myradio 全量替换（test/myradio-api.js 专文件高风险矩阵——review#39 第 3 条）
const assert = require('assert'), fs = require('fs'), path = require('path');
const { boot, freePort, makeRoot, addCleanup } = require('./harness/api-client');
const { fixture } = require('./harness/http-fixture');
const { publishSync, readManifestOf } = require('../update-sources');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });

let APPROOT = null, MY = null; // 当前 boot 的应用根（isolated：服务写盘全落这里，测试断言/操纵同视角）
const setRoot = r => { APPROOT = r; MY = path.join(r, 'my-radio.txt'); };
const myRaw = () => { try { return fs.readFileSync(MY); } catch (_) { return null; } };
const myLines = () => { const r = myRaw(); return r ? r.toString('utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean) : []; };
const postMy = (req, j) => req('POST', '/api/mystation', { 'Content-Type': 'application/json' }, JSON.stringify(j));
const jbody = r => JSON.parse(r.body);
const sameBuf = (a, b) => Buffer.compare(a, b) === 0;

// fixture 路由（验收口径 = update-sources.js checkDetail：直流持续吐 ≥8000B 且非 HTML；<8000B 先判 SHORT_BODY，
// HTML 判定要求 ≥8000B 才到得了——假流/错误页都是「拒绝」，分支不同而已）
const CHUNK = Buffer.alloc(4096, 7);
const stream = res => { // 真流：分块持续吐 12288B（≥阈值）后收尾——探活按「持续吐数据 ≥ 阈值字节」验收
  let n = 0;
  const w = () => { if (res.writableEnded || res.destroyed) return; res.write(CHUNK); n += CHUNK.length; if (n >= 12288) res.end(); else setTimeout(w, 10); };
  w();
};
const HTML_BIG = Buffer.from('<html>' + 'x'.repeat(9000) + '</html>');

(async () => {
  let srv = null, BROOT = null; // BROOT 在 try 内创建，finally 兜删用
  const fx = fixture({
    '/ok.mp3': { headers: { 'Content-Type': 'audio/mpeg' }, stream },
    '/slow.mp3': { delay: 300, headers: { 'Content-Type': 'audio/mpeg' }, stream }, // 延迟建流（蜻蜓系建流慢的缩小版，12s 窗口内照常入库）
    '/stub.mp3': { headers: { 'Content-Type': 'audio/mpeg' }, body: Buffer.alloc(336, 3) }, // xmcdn 假流形态：336B 即断
    '/page.html': { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: HTML_BIG }, // HTML 错误页但 200
    '/gone.mp3': { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'not found' }, // 404 小体 → SHORT_BODY（字节法不信状态码）
  });
  const fport = await fx.listen();
  const FIX = 'http://127.0.0.1:' + fport;
  const deadPort = await freePort(); // 建服后即关的端口：建连必拒（NETWORK 路径）

  try {
    console.log('[A] /api/mystation 真服务（VR_TEST_GUARD=1 → 探活打到本地 fixture）');
    srv = await boot({ isolated: true, env: { VR_TEST_GUARD: '1' } });
    setRoot(srv.root);
    const req = srv.req;

    await ok('跨源拒绝：POST 带 Origin → 403', async () =>
      assert.strictEqual((await req('POST', '/api/mystation', { Origin: 'http://evil.com', 'Content-Type': 'application/json' }, '{}')).status, 403));

    await ok('探活通过 → 200 {ok:true}；新分类尾部开节（空文件起步的节结构）', async () => {
      try { fs.unlinkSync(MY); } catch (_) {} // 临时根起步本就无 my-radio.txt（骨架复制排除用户数据）——语义钉死「空文件起步」
      const r = await postMy(req, { n: '台一', u: FIX + '/ok.mp3', c: '音乐' });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(jbody(r), { ok: true });
      assert.strictEqual(myRaw().toString('utf8'), '音乐,#genre#\r\n台一,' + FIX + '/ok.mp3\r\n');
    });

    await ok('探活通过（延迟建流 /slow.mp3 300ms）→ 已有分类节内插入（非尾部追加）', async () => {
      fs.writeFileSync(MY, '音乐,#genre#\r\n甲台,http://a/1\r\n新闻,#genre#\r\n乙台,http://b/2\r\n');
      const r = await postMy(req, { n: '丙台', u: FIX + '/slow.mp3', c: '音乐' });
      assert.deepStrictEqual(jbody(r), { ok: true });
      assert.deepStrictEqual(myLines(), ['音乐,#genre#', '丙台,' + FIX + '/slow.mp3', '甲台,http://a/1', '新闻,#genre#', '乙台,http://b/2']);
    });

    await ok('同名同 URL → {ok:false,error:「该电台已在个人列表中」}', async () => {
      const j = jbody(await postMy(req, { n: '丙台', u: FIX + '/slow.mp3', c: '另类' })); // 分类不同不绕开重复判定
      assert.strictEqual(j.ok, false);
      assert.strictEqual(j.error, '该电台已在个人列表中');
    });

    await ok('同 URL 换名 → 「该流地址已存在」并点名既有台名', async () => {
      const j = jbody(await postMy(req, { n: '丁台', u: FIX + '/slow.mp3', c: '另类' }));
      assert.strictEqual(j.ok, false);
      assert.ok(j.error.indexOf('该流地址已存在') === 0 && j.error.indexOf('丙台') > 0, j.error);
    });

    await ok('台名/分类去 csv 分隔符：逗号/竖线/换行（分类额外去 #）→ 空格（radio.txt 行格式硬约束）', async () => {
      const r = await postMy(req, { n: '台,名|两\n行', u: FIX + '/ok.mp3?c=clean', c: '#分,类|一' });
      assert.deepStrictEqual(jbody(r), { ok: true });
      const ls = myLines();
      assert.ok(ls.indexOf('分 类 一,#genre#') >= 0, '分类头：' + ls.join(' / '));
      assert.ok(ls.indexOf('台 名 两 行,' + FIX + '/ok.mp3?c=clean') >= 0, '台行：' + ls.join(' / '));
    });

    await ok('长度封顶：台名 40 / 分类 24（超出截断）', async () => {
      const r = await postMy(req, { n: 'N'.repeat(50), u: FIX + '/ok.mp3?c=cap', c: 'C'.repeat(30) });
      assert.deepStrictEqual(jbody(r), { ok: true });
      const ls = myLines();
      assert.ok(ls.indexOf('C'.repeat(24) + ',#genre#') >= 0, '分类 24 封顶：' + ls.join(' / '));
      assert.ok(ls.indexOf('N'.repeat(40) + ',' + FIX + '/ok.mp3?c=cap') >= 0, '台名 40 封顶：' + ls.join(' / '));
    });

    await ok('URL 512 封顶：超长 URL 截断后探活与落盘（截断串仍命中 fixture 路由）', async () => {
      const u = FIX + '/ok.mp3?pad=' + 'z'.repeat(600);
      const r = await postMy(req, { n: '台八', u: u, c: '容量' });
      assert.deepStrictEqual(jbody(r), { ok: true });
      const line = '台八,' + u.slice(0, 512);
      assert.ok(myLines().indexOf(line) >= 0, '落盘为 512 截断串');
      assert.strictEqual(u.slice(0, 512).length, 512);
    });

    await ok('假流 336B（SHORT_BODY）→ HTTP 200 但 {ok:false,detail:探活失败…}，文件零写入', async () => {
      const before = myRaw();
      const r = await postMy(req, { n: '假流台', u: FIX + '/stub.mp3', c: '音乐' });
      assert.strictEqual(r.status, 200); // 业务失败走 200——断言区分 HTTP 状态与业务 ok
      const j = jbody(r);
      assert.strictEqual(j.ok, false);
      assert.ok(j.detail.indexOf('探活失败：') === 0, j.detail);
      assert.ok(sameBuf(before, myRaw()), '探活失败不得写文件');
    });

    await ok('HTML 错误页（200 + text/html ≥8000B）→ 拒绝，文件零写入', async () => {
      const before = myRaw();
      const j = jbody(await postMy(req, { n: '网页台', u: FIX + '/page.html', c: '音乐' }));
      assert.strictEqual(j.ok, false);
      assert.ok(j.detail.indexOf('探活失败：') === 0, j.detail);
      assert.ok(sameBuf(before, myRaw()));
    });

    await ok('404 小体 → 拒绝（直流字节法不看状态码），文件零写入', async () => {
      const before = myRaw();
      const j = jbody(await postMy(req, { n: '死链台', u: FIX + '/gone.mp3', c: '音乐' }));
      assert.strictEqual(j.ok, false);
      assert.ok(j.detail.indexOf('探活失败：') === 0, j.detail);
      assert.ok(sameBuf(before, myRaw()));
    });

    await ok('死端口（建连必拒）→ NETWORK 拒绝，文件零写入', async () => {
      const before = myRaw();
      const j = jbody(await postMy(req, { n: '断连台', u: 'http://127.0.0.1:' + deadPort + '/x.mp3', c: '音乐' }));
      assert.strictEqual(j.ok, false);
      assert.ok(j.detail.indexOf('探活失败：') === 0, j.detail);
      assert.ok(sameBuf(before, myRaw()));
    });

    await ok('非法 JSON → 400 bad request', async () =>
      assert.strictEqual((await req('POST', '/api/mystation', { 'Content-Type': 'application/json' }, 'not json')).status, 400));

    await ok('清洗后空名/空分类 → 400（分隔符全清洗 = 拒绝，不出空行）', async () => {
      assert.strictEqual((await postMy(req, { n: ',,|', u: FIX + '/ok.mp3', c: '音乐' })).status, 400);
      assert.strictEqual((await postMy(req, { n: '台名', u: FIX + '/ok.mp3', c: ',,|' })).status, 400);
    });

    await ok('请求体 > 2048 → 413（先答后断连，Connection:close 独占短连）', async () => {
      const r = await req('POST', '/api/mystation', { 'Content-Type': 'application/json', Connection: 'close' },
        JSON.stringify({ n: 'x', u: FIX + '/ok.mp3', c: '音乐', pad: 'y'.repeat(3000) }));
      assert.strictEqual(r.status, 413);
    });

    await ok('500 行封顶：预置近满文件 POST → {ok:false} 上限文案，旧文件字节不变', async () => {
      fs.writeFileSync(MY, Array.from({ length: 500 }, (_, i) => '占位' + i + ',http://192.0.2.1/' + i).join('\r\n'));
      const before = myRaw();
      const j = jbody(await postMy(req, { n: '超限台', u: FIX + '/ok.mp3?c=linecap', c: '音乐' }));
      assert.strictEqual(j.ok, false);
      assert.ok(j.error.indexOf('已达上限') >= 0, j.error);
      assert.ok(sameBuf(before, myRaw()), '封顶拒绝不得写文件');
    });

    await ok('64KB 封顶（行数 <500）：同样拒绝且字节不变', async () => {
      fs.writeFileSync(MY, Array.from({ length: 100 }, (_, i) => '占' + i + ',' + 'u'.repeat(690)).join('\r\n'));
      assert.ok(myRaw().length >= 65536, '前置：预置文件已超 64KB');
      const before = myRaw();
      const j = jbody(await postMy(req, { n: '超限台', u: FIX + '/ok.mp3?c=bytecap', c: '音乐' }));
      assert.strictEqual(j.ok, false);
      assert.ok(sameBuf(before, myRaw()));
    });

    await ok('并发两 POST：myQ 串行化——两台都落盘、无互相覆盖（后写者读到前者结果）', async () => {
      try { fs.unlinkSync(MY); } catch (_) {}
      const both = await Promise.all([
        postMy(req, { n: '并甲', u: FIX + '/ok.mp3?c=cc1', c: '并发测试' }),
        postMy(req, { n: '并乙', u: FIX + '/ok.mp3?c=cc2', c: '并发测试' }),
      ]);
      assert.deepStrictEqual(jbody(both[0]), { ok: true });
      assert.deepStrictEqual(jbody(both[1]), { ok: true });
      const ls = myLines();
      assert.strictEqual(ls.length, 3, '节头 + 两台：' + ls.join(' / ')); // 无队列时两个空读互覆 → 只剩 1 台
      assert.strictEqual(ls[0], '并发测试,#genre#');
      assert.ok(ls.indexOf('并甲,' + FIX + '/ok.mp3?c=cc1') > 0 && ls.indexOf('并乙,' + FIX + '/ok.mp3?c=cc2') > 0);
    });

    await srv.close(); srv = null;

    console.log("[A'] 无缝默认 boot：SSRF 护栏回归（同一 URL 形态缝内 200 ok / 缝外 403）");
    srv = await boot({ isolated: true, env: { VR_TEST_GUARD: '' } }); // 显式清缝：宿主误导出也不假红
    setRoot(srv.root);
    await ok('环回/私网/非 http 目标 → 403「流地址不合法」，文件零写入', async () => {
      fs.writeFileSync(MY, '音乐,#genre#\r\n哨兵,http://s/1\r\n');
      const before = myRaw();
      for (const u of [FIX + '/ok.mp3', 'http://10.0.0.1/x.mp3', 'http://192.168.1.1/x.mp3', 'http://localhost/x.mp3', 'ftp://example.com/x.mp3']) {
        const r = await postMy(srv.req, { n: '护栏台', u: u, c: '音乐' });
        assert.strictEqual(r.status, 403, u);
        assert.strictEqual(jbody(r).error, '流地址不合法（仅公网 http(s)）', u);
      }
      assert.ok(sameBuf(before, myRaw()), '护栏拒绝不得写文件');
    });
    await srv.close(); srv = null;

    console.log('[B] /api/boot 真服务矩阵（独立应用根内操纵生成资产 + boot({root}) 复用重启；宿主资产零接触）');
    BROOT = makeRoot(); // 手动建根：预写/操纵资产后再起服（boot({root}) 不重新复制骨架，根由测试自管清理）
    addCleanup(() => { try { fs.rmSync(BROOT, { recursive: true, force: true }); } catch (_) {} });
    const ASSETS = ['radio.txt', 'radio-data.js', 'logos.txt', 'radio-meta.json', 'sync-manifest.json'];
    const orig = {}; // 骨架复制出的「原始代」资产（prev-old 兜底恢复的对照物；必须在任何 publishSync 前捕获）
    for (const k of ASSETS) { try { orig[k] = fs.readFileSync(path.join(BROOT, k)); } catch (_) {} }
    const resetArts = () => { // 根资产复位到原始代：删测试发布的 manifest/.tmp 代际，五文件字节还原（等价旧 restoreAssets(pristine) 语义）
      for (const k of ASSETS) {
        const fp = path.join(BROOT, k);
        if (orig[k]) fs.writeFileSync(fp, orig[k]);
        else { try { fs.unlinkSync(fp); } catch (_) {} }
      }
      try { fs.rmSync(path.join(BROOT, '.tmp'), { recursive: true, force: true }); } catch (_) {}
    };
    const makeArts = tag => { // 测试批次四资产（assetsComplete 可解析：radio.txt 有节 / data.js 含 RADIO_DATA / meta v1+stations）
      const txt = '音乐,#genre#\r\n台甲-' + tag + ',http://192.0.2.10/a.mp3\r\n台甲-' + tag + '备,http://192.0.2.11/a2.mp3\r\n新闻,#genre#\r\n台乙-' + tag + ',http://192.0.2.12/b.m3u8\r\n';
      const meta = { v: 1, generatedAt: 0, stations: {} };
      meta.stations['http://192.0.2.10/a.mp3'] = { name: '台甲-' + tag, category: '音乐',
        sources: [{ url: 'http://192.0.2.10/a.mp3', upstream: 'gao', upstreamId: '', kind: 'main', firstSeenAt: 0 }] };
      return {
        'radio.txt': txt,
        'radio-data.js': 'window.RADIO_DATA=' + JSON.stringify(txt) + ';\r\n',
        'logos.txt': '# 测试批次占位台标表\r\n',
        'radio-meta.json': JSON.stringify(meta),
      };
    };
    const writeArts = arts => { for (const k of Object.keys(arts)) fs.writeFileSync(path.join(BROOT, k), arts[k]); };
    const withBoot = async fn => { // boot({root}) 复用同一根重启（不重新复制骨架；close 只杀服不删根——根由外层清理）
      const s = await boot({ root: BROOT, env: { VR_TEST_GUARD: '' } });
      try { return await fn(s); } finally { await s.close(); }
    };
    const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

    await ok('全资产齐 + manifest 哈希匹配 → {ok:true, version, missing:[], restored:false}', async () => {
      resetArts();
      publishSync(BROOT, makeArts('a'), { version: 'A1', ts: 1000000 }); // 发布协议：root=批A+manifest A1，prev=原始代
      await withBoot(async s => {
        const j = jbody(await s.req('GET', '/api/boot'));
        assert.strictEqual(j.ok, true);
        assert.strictEqual(j.version, 'A1');
        assert.deepStrictEqual(j.missing, []);
        assert.strictEqual(j.restored, false);
      });
    });

    await ok('缺 sync-manifest.json + 四资产齐 → bootstrap 写入（version:bootstrap，manifest 落盘且四资产不动）', async () => {
      resetArts();
      const artsA = makeArts('a');
      writeArts(artsA);
      try { fs.unlinkSync(path.join(BROOT, 'sync-manifest.json')); } catch (_) {}
      await withBoot(async s => {
        const j = jbody(await s.req('GET', '/api/boot'));
        assert.strictEqual(j.ok, true);
        assert.strictEqual(j.version, 'bootstrap');
        assert.deepStrictEqual(j.missing, []);
        assert.strictEqual(j.restored, false);
        const m = readManifestOf(BROOT); // 四文件 bytes/sha256 全对才算有效 manifest
        assert.ok(m && m.version === 'bootstrap', 'bootstrap manifest 已落盘且可校验');
        for (const k of Object.keys(artsA))
          assert.strictEqual(fs.readFileSync(path.join(BROOT, k)).toString('utf8'), artsA[k], 'bootstrap 不动四资产：' + k);
      });
    });

    await ok('缺 radio-meta.json + 无 manifest → ok:false missing 命中（不静默混态、不写 bootstrap）', async () => {
      resetArts();
      writeArts(makeArts('a'));
      try { fs.unlinkSync(path.join(BROOT, 'sync-manifest.json')); } catch (_) {}
      fs.unlinkSync(path.join(BROOT, 'radio-meta.json'));
      await withBoot(async s => {
        const j = jbody(await s.req('GET', '/api/boot'));
        assert.strictEqual(j.ok, false);
        assert.deepStrictEqual(j.missing, ['radio-meta.json']);
        assert.strictEqual(j.restored, false);
        assert.ok(!fs.existsSync(path.join(BROOT, 'sync-manifest.json')), '资产不全不写 bootstrap manifest');
      });
    });

    await ok('缺 radio-meta.json + prev 有效 → 自动恢复（restored:true，文件从 sync-prev 找回）', async () => {
      resetArts();
      publishSync(BROOT, makeArts('a'), { version: 'A1', ts: 1000000 }); // prev = 原始代 + 其携带的 manifest
      const prevVer = readJson(path.join(BROOT, '.tmp', 'sync-prev', 'sync-manifest.json')).version;
      fs.unlinkSync(path.join(BROOT, 'radio-meta.json'));
      await withBoot(async s => {
        const j = jbody(await s.req('GET', '/api/boot'));
        assert.strictEqual(j.ok, true);
        assert.strictEqual(j.restored, true);
        assert.strictEqual(j.version, prevVer); // 源码口径：恢复成功按 prev manifest 版本上报
        assert.deepStrictEqual(j.missing, []);  // 恢复路径不回带 missing（missing 只在 ok:false / bootstrap-缺资响应出现）
        assert.strictEqual(fs.readFileSync(path.join(BROOT, 'radio-meta.json')).toString('utf8'),
          orig['radio-meta.json'].toString('utf8'), 'radio-meta.json 已从 prev 找回');
      });
    });

    await ok('manifest 哈希不匹配（篡改 radio.txt 一字节）+ prev → 恢复上一批（version=A1，radio.txt 字节还原）', async () => {
      resetArts();
      const artsA = makeArts('a'), artsB = makeArts('b');
      publishSync(BROOT, artsA, { version: 'A1', ts: 1000000 });
      publishSync(BROOT, artsB, { version: 'B1', ts: 2000000 }); // prev = 批A + A1 manifest（root manifest 有效时随行携带）
      fs.writeFileSync(path.join(BROOT, 'radio.txt'), artsB['radio.txt'] + 'x'); // 一字节篡改 → B1 校验必失败
      await withBoot(async s => {
        const j = jbody(await s.req('GET', '/api/boot'));
        assert.strictEqual(j.ok, true);
        assert.strictEqual(j.restored, true);
        assert.strictEqual(j.version, 'A1');
        assert.strictEqual(fs.readFileSync(path.join(BROOT, 'radio.txt')).toString('utf8'), artsA['radio.txt'], 'radio.txt 从 prev 还原');
        assert.strictEqual(readManifestOf(BROOT).version, 'A1', 'manifest 随行还原为 A1');
      });
    });

    await ok('prev 损坏 → .tmp/sync-prev-old 兜底恢复（代际轮换：任何时刻至少一代完整上一批）', async () => {
      resetArts();
      const artsA = makeArts('a'), artsB = makeArts('b');
      publishSync(BROOT, artsA, { version: 'A1', ts: 1000000 }); // 一代 prev = 原始代 + 其携带的 manifest
      publishSync(BROOT, artsB, { version: 'B1', ts: 2000000 }); // 二代：prev=批A+A1，prev-old=原始代
      fs.writeFileSync(path.join(BROOT, '.tmp', 'sync-prev', 'sync-manifest.json'), '{broken'); // 打掉 prev 校验
      fs.writeFileSync(path.join(BROOT, 'radio.txt'), artsB['radio.txt'] + 'x');
      const oldVer = readJson(path.join(BROOT, '.tmp', 'sync-prev-old', 'sync-manifest.json')).version;
      await withBoot(async s => {
        const j = jbody(await s.req('GET', '/api/boot'));
        assert.strictEqual(j.ok, true);
        assert.strictEqual(j.restored, true);
        assert.strictEqual(j.version, oldVer, '按 prev-old 的 manifest 版本上报');
        assert.strictEqual(fs.readFileSync(path.join(BROOT, 'radio.txt')).toString('utf8'),
          orig['radio.txt'].toString('utf8'), 'radio.txt 从 prev-old（原始代）还原，非被篡改值');
      });
    });

    await ok('哈希不匹配 + 无 prev → ok:false（恢复通道不可用，不静默混态）', async () => {
      resetArts();
      publishSync(BROOT, makeArts('a'), { version: 'A1', ts: 1000000 });
      fs.rmSync(path.join(BROOT, '.tmp'), { recursive: true, force: true }); // prev/prev-old 全无
      fs.appendFileSync(path.join(BROOT, 'radio.txt'), 'x');
      await withBoot(async s => {
        const j = jbody(await s.req('GET', '/api/boot'));
        assert.strictEqual(j.ok, false);
        assert.deepStrictEqual(j.missing, []);
        assert.strictEqual(j.restored, false);
      });
    });
  } finally {
    if (srv) { try { await srv.close(); } catch (_) {} }
    try { await fx.close(); } catch (_) {}
    // 临时根由各自 boot 自管清理（isolated close 删自有根）；BROOT 经 addCleanup 在 SIGINT 兜底，正常路径同样兜删
    if (BROOT) { try { fs.rmSync(BROOT, { recursive: true, force: true }); } catch (_) {} }
  }
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('station-api 测试异常：', e); process.exit(1); });
