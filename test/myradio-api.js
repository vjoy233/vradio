// /api/myradio 高风险矩阵（P2，AIbot review#39 第 3 条：test/quality.js 既有覆盖只有行清洗/方法拒绝/正常落盘，
// 方案 §1.3/L2 总表点名的全量替换语义缺口在此补齐）——my-radio.txt 全量替换端到端（B0 v2+ 备份恢复通道的服务端面）：
//   ① 合法全量替换 → 文件恰为提交内容（CRLF + 尾换行）；封顶边界对照（恰 500 行放行）
//   ② >500 行 → 413 拒绝且旧文件字节不变；③ >64KB（行数<500，字节上限独立生效）→ 同拒
//   ④ replace 与 mystation 追加共用 myQ 写队列并发串行：无混合/半写，追加先落盘后 replace → 终态恰为
//      replace 完整内容（后入队者完整内容，追加台不残留）；replace 先入队、追加后入队 → 节内插入合法终态
//   ⑤ 写失败（rename 目标被目录占位）→ 200 {ok:false,error:'写入失败'}，旧态保持、服务不崩
//   ⑥ 空列表全量替换 → 合法清空（0 字节）；⑦ 备份恢复联动：旧快照经同一 replace 通道无损回写（v2+ 恢复通道即全量替换）
//   ⑧ 方法校验 405 / 非法 JSON 400 / lines 非数组 400
// 隔离：boot({isolated:true}) 临时应用根——my-radio.txt 写盘全在根内（宿主零接触，无需备份还原）；
// mystation 探活经 VR_TEST_GUARD=1 + 本地 fixture（test/station-api.js 同款），全程离线。
const assert = require('assert'), fs = require('fs'), path = require('path');
const { boot } = require('./harness/api-client');
const { fixture } = require('./harness/http-fixture');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });
const jbody = r => JSON.parse(r.body);
const sameBuf = (a, b) => Buffer.compare(a, b) === 0;

// fixture 真流（探活验收口径 = 持续吐 ≥8000B 且非 HTML； mystation 追加路径专用，replace 不探活）
const CHUNK = Buffer.alloc(4096, 7);
const stream = res => {
  let n = 0;
  const w = () => { if (res.writableEnded || res.destroyed) return; res.write(CHUNK); n += CHUNK.length; if (n >= 12288) res.end(); else setTimeout(w, 10); };
  w();
};

(async () => {
  let srv = null;
  const fx = fixture({
    '/ok.mp3': { headers: { 'Content-Type': 'audio/mpeg' }, stream },
    '/slow.mp3': { delay: 500, headers: { 'Content-Type': 'audio/mpeg' }, stream }, // 延迟建流：④ 用它把「追加入队」压到 replace 之后（确定性串行）
  });
  const fport = await fx.listen();
  const FIX = 'http://127.0.0.1:' + fport;
  let MY = null; // 当前根的 my-radio.txt（isolated：服务写盘全在临时根）
  const myRaw = () => { try { return fs.readFileSync(MY); } catch (_) { return null; } };
  const myText = () => { const r = myRaw(); return r ? r.toString('utf8') : null; };
  const postReplace = (req, lines) => req('POST', '/api/myradio', { 'Content-Type': 'application/json' }, JSON.stringify({ lines }));
  const postMy = (req, j) => req('POST', '/api/mystation', { 'Content-Type': 'application/json' }, JSON.stringify(j));

  try {
    srv = await boot({ isolated: true, env: { VR_TEST_GUARD: '1' } });
    MY = path.join(srv.root, 'my-radio.txt');
    const req = srv.req;

    await ok('⑧ 方法校验：GET /api/myradio → 405（只收 POST）', async () =>
      assert.strictEqual((await req('GET', '/api/myradio')).status, 405));

    await ok('⑧ 协议面：非法 JSON / lines 非数组 → 400', async () => {
      assert.strictEqual((await req('POST', '/api/myradio', { 'Content-Type': 'application/json' }, 'not json')).status, 400);
      assert.strictEqual((await postReplace(req, 'nope')).status, 400);
    });

    await ok('① 合法全量替换：200 {ok:true}，文件恰为提交内容（CRLF + 尾换行）', async () => {
      const lines = ['音乐,#genre#', '我的台甲,' + FIX + '/ok.mp3', '我的台乙,https://b.example/live.m3u8'];
      const r = await postReplace(req, lines);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(jbody(r), { ok: true });
      assert.strictEqual(myText(), lines.join('\r\n') + '\r\n');
    });

    await ok('①b 封顶边界对照：恰 500 条合法行 → 放行（off-by-one 钉死）', async () => {
      const lines = ['音乐,#genre#'];
      for (let i = 0; i < 499; i++) lines.push('占位' + i + ',https://192.0.2.1/' + i + '.mp3'); // 1 + 499 = 500
      const r = await postReplace(req, lines);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(jbody(r), { ok: true });
      assert.strictEqual(myText().split(/\r\n/).filter(Boolean).length, 500);
    });

    await ok('② >500 行（501 条合法行）→ 413 拒绝，旧文件字节不变', async () => {
      const before = myRaw();
      const lines = ['音乐,#genre#'];
      for (let i = 0; i < 500; i++) lines.push('占位' + i + ',https://192.0.2.1/' + i + '.mp3'); // 501 条
      const r = await postReplace(req, lines);
      assert.strictEqual(r.status, 413);
      assert.strictEqual(jbody(r).ok, false);
      assert.ok(sameBuf(before, myRaw()), '封顶拒绝不得写文件');
    });

    await ok('③ >64KB（120 行 × 600 字符，行数 <500）→ 413 字节上限独立生效，旧文件不变', async () => {
      const before = myRaw();
      const lines = [];
      for (let i = 0; i < 120; i++) lines.push('长行' + i + ',https://x.example/' + 'u'.repeat(580)); // 行清洗截 600 字符/行
      assert.ok(lines.join('\r\n').length > 65536, '前置：提交内容已超 64KB');
      const r = await postReplace(req, lines);
      assert.strictEqual(r.status, 413);
      assert.strictEqual(jbody(r).ok, false);
      assert.ok(sameBuf(before, myRaw()));
    });

    await ok('④a replace 与 mystation 追加并发 → myQ 串行无混合：replace 先入队（无探活）、追加后入队（探活 500ms 延迟），终态 = replace 内容节内插入追加台', async () => {
      try { fs.unlinkSync(MY); } catch (_) {}
      // 追加请求先发出、探活延迟 500ms 才入队；replace 无探活、毫秒级入队——入队序确定性（fixture 延迟 >> HTTP 往返）
      const pApp = postMy(req, { n: '并台', u: FIX + '/slow.mp3', c: '音乐' });
      const pRep = postReplace(req, ['音乐,#genre#', '整替台,https://r.example/a.mp3']);
      assert.deepStrictEqual(jbody(await pRep), { ok: true });
      assert.deepStrictEqual(jbody(await pApp), { ok: true });
      const ls = myText().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      assert.deepStrictEqual(ls, ['音乐,#genre#', '并台,' + FIX + '/slow.mp3', '整替台,https://r.example/a.mp3'],
        '串行终态：追加读到 replace 落盘结果、节内插入，无半写/互覆');
    });

    await ok('④b 追加先落盘、replace 后入队 → 终态恰为 replace 完整内容（整替语义：追加台不残留）', async () => {
      // URL 加查询串避开 ④a 的重复判定（同 URL 换名会被拒），fixture 按.pathname 路由 → 仍走 500ms 延迟流
      const app = await postMy(req, { n: '先台', u: FIX + '/slow.mp3?b=4b', c: '新闻' }); // 先入队并落盘
      assert.deepStrictEqual(jbody(app), { ok: true });
      assert.ok(myText().includes('先台,'), '前置：追加台已在盘上');
      const r = await postReplace(req, ['新闻,#genre#', '整替乙,https://r.example/b.mp3']); // 后入队
      assert.deepStrictEqual(jbody(r), { ok: true });
      assert.strictEqual(myText(), '新闻,#genre#\r\n整替乙,https://r.example/b.mp3\r\n', 'replace 终态恰为后入队者完整内容');
    });

    await ok('⑤ 写失败（rename 目标被目录占位）→ 200 {ok:false,error:写入失败}，旧态保持、服务不崩', async () => {
      try { fs.unlinkSync(MY); } catch (_) {}
      fs.mkdirSync(MY); // 目录占位：tmp 文件写成功、rename(file→dir) 平台必败（Windows EPERM / POSIX EISDIR）
      const r = await postReplace(req, ['音乐,#genre#', '写失败台,https://w.example/x.mp3']);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(jbody(r), { ok: false, error: '写入失败' });
      assert.ok(fs.statSync(MY).isDirectory(), '旧态（目录占位）未被破坏');
      assert.strictEqual((await req('GET', '/')).status, 200, '服务存活不崩');
      fs.rmdirSync(MY); // 撤占位，后续用例恢复正常写盘
    });

    await ok('⑥ 空列表全量替换 → 200 {ok:true}，合法清空（0 字节）', async () => {
      fs.writeFileSync(MY, '音乐,#genre#\r\n待清台,https://c.example/x.mp3\r\n');
      const r = await postReplace(req, []);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(jbody(r), { ok: true });
      assert.notStrictEqual(myRaw(), null, '清空后文件存在');
      assert.strictEqual(myRaw().length, 0, '清空 = 空文件');
    });

    await ok('⑦ 备份恢复联动（v2+ 恢复通道 = 全量替换）：旧备份快照回写 → 终态恰为旧快照内容', async () => {
      const r1 = await postReplace(req, ['占位,#genre#', '现态台,https://now.example/z.mp3']); // 先造不同现态
      assert.deepStrictEqual(jbody(r1), { ok: true });
      const backup = ['华语音乐,#genre#', '备份台甲,' + FIX + '/ok.mp3', '备份台乙,https://bak.example/y.mp3'];
      const r2 = await postReplace(req, backup); // 恢复 = 旧快照整替回写
      assert.deepStrictEqual(jbody(r2), { ok: true });
      assert.strictEqual(myText(), backup.join('\r\n') + '\r\n', '旧快照无损回写');
    });

    await srv.close(); srv = null;
  } finally {
    if (srv) { try { await srv.close(); } catch (_) {} }
    try { await fx.close(); } catch (_) {}
  }
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('myradio-api 测试异常：', e); process.exit(1); });
