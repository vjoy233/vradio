// 曲讯事件管线测试（B3-A，契约 contracts/metadata-event.json + fixtures/metadata-golden.json）：
// ① normalizeMetadata 黄金样本逐字段断言（冻结样本，双端一致）；② parseIcyTitle 连接号变体/拆分边界；
// ③ 管线状态机：同曲去重（连续同曲 + 30s 窗内重复入史）、旧世代事件丢弃、切台后迟到事件、空曲讯不覆盖、
// 换歌旧曲入史、切台/刷新 reset 清空。零依赖离线，npm test 随跑。
const assert = require('assert'), fs = require('fs'), path = require('path');
const Metadata = require(path.join(__dirname, '..', 'metadata.js'));

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); } };

/* ---------- ① 黄金样本（逐字段全等） ---------- */
ok('黄金样本：normalizeMetadata 全部 case 逐字段一致', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'fixtures', 'metadata-golden.json'), 'utf8'));
  assert.ok(Array.isArray(golden.cases) && golden.cases.length >= 6, '样本数量');
  for (const c of golden.cases) {
    const got = Metadata.normalizeMetadata(c.in.raw, c.in.ctx);
    assert.deepStrictEqual(got, c.out, `case「${c.name}」`);
  }
});

/* ---------- ② parseIcyTitle 细分口径 ---------- */
ok('连接号四形态（- － — –）前后带空格均拆分，title 保留原连接号', () => {
  for (const sep of ['-', '－', '—', '–']) {
    const p = Metadata.parseIcyTitle('A ' + sep + ' B');
    assert.deepStrictEqual({ artist: p.artist, track: p.track, title: p.title }, { artist: 'A', track: 'B', title: 'A ' + sep + ' B' }, '分隔符 ' + sep);
  }
});
ok('无空格连接号不拆（"Artist-Title" 整段为曲名，confidence=stream）', () => {
  const p = Metadata.parseIcyTitle('Artist-Title');
  assert.strictEqual(p.artist, ''); assert.strictEqual(p.track, 'Artist-Title');
});
ok('首次出现的前后带空格连接号生效（多个分隔取第一个）', () => {
  const p = Metadata.parseIcyTitle('A - B - C');
  assert.strictEqual(p.artist, 'A'); assert.strictEqual(p.track, 'B - C');
});
ok('单层「台名 - 歌名」不剥前缀（stationName 匹配但无重复）', () => {
  const p = Metadata.parseIcyTitle('动感101 - 歌名', '动感101');
  assert.strictEqual(p.artist, '动感101'); assert.strictEqual(p.track, '歌名'); assert.strictEqual(p.title, '动感101 - 歌名');
});
ok('normalizeMetadata 默认值：program 空、source 缺省 none、at 缺省现时', () => {
  const ev = Metadata.normalizeMetadata({ title: 'X - Y' }, { identityUrl: 'https://a/live' });
  assert.strictEqual(ev.program, ''); assert.strictEqual(ev.source, 'none'); assert.ok(Math.abs(ev.at - Date.now()) < 5000);
  assert.strictEqual(ev.confidence, 'parsed'); assert.strictEqual(ev.stationIdentityUrl, 'https://a/live');
});
ok('HLS 无曲讯不猜歌：空输入产出空形态（source=none、confidence=stream）', () => {
  const ev = Metadata.normalizeMetadata({ title: '', source: 'none' }, { identityUrl: 'https://a/live' });
  assert.strictEqual(ev.title, ''); assert.strictEqual(ev.artist, ''); assert.strictEqual(ev.track, '');
  assert.strictEqual(ev.confidence, 'stream');
});

/* ---------- ③ 管线状态机（固定顺序） ---------- */
const mkEv = (title, gen, key, at) => Object.assign(
  Metadata.normalizeMetadata({ title, source: title ? 'icy' : 'none', at }, { identityUrl: key }), { token: gen });

ok('换歌：旧曲入史 + 新曲生效；首曲（first）不产生入史', () => {
  const p = Metadata.mpCreate({ now: () => 1000 });
  Metadata.mpReset(p, 7, 'https://a/live');
  const d1 = Metadata.mpAccept(p, mkEv('Song A', 7, 'https://a/live', 1000));
  assert.strictEqual(d1.st, 'new'); assert.strictEqual(d1.first, true); assert.strictEqual(d1.hist, null);
  const d2 = Metadata.mpAccept(p, mkEv('Song B', 7, 'https://a/live', 61000));
  assert.strictEqual(d2.st, 'new'); assert.strictEqual(d2.first, false);
  assert.deepStrictEqual(d2.hist, { u: 'https://a/live', t: 'Song A', at: 1000 });
});
ok('同曲去重：连续同曲 noop（不重渲、不重复入史）', () => {
  const p = Metadata.mpCreate({ now: () => 1000 });
  Metadata.mpReset(p, 7, 'https://a/live');
  Metadata.mpAccept(p, mkEv('Song A', 7, 'https://a/live', 1000));
  assert.strictEqual(Metadata.mpAccept(p, mkEv('Song A', 7, 'https://a/live', 2000)).st, 'noop');
  assert.strictEqual(Metadata.mpAccept(p, mkEv('Song A', 7, 'https://a/live', 3000)).st, 'noop');
});
ok('同曲去重：30s 窗内重复曲名不重复入史（A-B-A 抖动只留一条 A）', () => {
  const p = Metadata.mpCreate({ now: () => 1000 });
  Metadata.mpReset(p, 7, 'https://a/live');
  Metadata.mpAccept(p, mkEv('A', 7, 'https://a/live', 1000));
  const dB = Metadata.mpAccept(p, mkEv('B', 7, 'https://a/live', 5000)); // A 入史
  assert.deepStrictEqual(dB.hist, { u: 'https://a/live', t: 'A', at: 1000 });
  const dA = Metadata.mpAccept(p, mkEv('A', 7, 'https://a/live', 8000)); // B 入史
  assert.deepStrictEqual(dA.hist, { u: 'https://a/live', t: 'B', at: 5000 });
  const dC = Metadata.mpAccept(p, mkEv('C', 7, 'https://a/live', 10000)); // A 又换出：30s 窗内已入史 → 不再入
  assert.strictEqual(dC.hist, null);
});
ok('旧世代事件丢弃：reset 换代后旧 token 事件 stale', () => {
  const p = Metadata.mpCreate({ now: () => 1000 });
  Metadata.mpReset(p, 7, 'https://a/live');
  Metadata.mpAccept(p, mkEv('A', 7, 'https://a/live', 1000));
  Metadata.mpReset(p, 8, 'https://b/live'); // 切台/刷新
  assert.strictEqual(Metadata.mpAccept(p, mkEv('A late', 7, 'https://a/live', 2000)).st, 'stale'); // 旧世代迟到事件
  const d = Metadata.mpAccept(p, mkEv('B', 8, 'https://b/live', 2100));
  assert.strictEqual(d.st, 'new'); assert.strictEqual(d.first, true); // 旧曲不串台：新世代首曲
});
ok('切台后迟到事件：异台身份 URL（即使 token 相同）也丢弃', () => {
  const p = Metadata.mpCreate({ now: () => 1000 });
  Metadata.mpReset(p, 9, 'https://a/live');
  assert.strictEqual(Metadata.mpAccept(p, mkEv('X', 9, 'https://other/live', 1500)).st, 'stale');
});
ok('空曲讯不覆盖有效曲名：gap 不产显示更新、不入史（现状语义）', () => {
  const p = Metadata.mpCreate({ now: () => 1000 });
  Metadata.mpReset(p, 7, 'https://a/live');
  Metadata.mpAccept(p, mkEv('A', 7, 'https://a/live', 1000));
  const d = Metadata.mpAccept(p, mkEv('', 7, 'https://a/live', 2000));
  assert.strictEqual(d.st, 'gap'); assert.ok(!d.hist); // 显示层保留旧曲（sink 不动作）、不入史
  const cur = Metadata.mpCurrent(p);
  assert.strictEqual(cur.title, ''); // 管线当前曲讯已清空（统计口径），空曲讯后续同曲不再 gap
  assert.strictEqual(Metadata.mpAccept(p, mkEv('', 7, 'https://a/live', 3000)).st, 'noop');
  const d2 = Metadata.mpAccept(p, mkEv('A', 7, 'https://a/live', 4000)); // 空后回同曲：不重复入史（had=false → 无 hist）
  assert.strictEqual(d2.st, 'new'); assert.strictEqual(d2.first, true); assert.strictEqual(d2.hist, null);
});
ok('reset 清空：当前曲讯归零，新世代从首曲开始', () => {
  const p = Metadata.mpCreate({ now: () => 1000 });
  Metadata.mpReset(p, 7, 'https://a/live');
  Metadata.mpAccept(p, mkEv('A', 7, 'https://a/live', 1000));
  Metadata.mpReset(p, 8, 'https://a/live'); // 同台刷新（token 递增）
  assert.strictEqual(Metadata.mpCurrent(p), null);
  assert.strictEqual(Metadata.mpAccept(p, mkEv('A', 7, 'https://a/live', 2000)).st, 'stale'); // 旧 token 死
});

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
