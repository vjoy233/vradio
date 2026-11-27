'use strict';
// 实验性提案；不得将判断解释为原 v2 提案已冻结的行为。
const crypto = require('crypto');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const b = s => Buffer.from(s, 'utf8');
const enc = x => b(JSON.stringify(x));
const commit = 'a'.repeat(40), source = 'recommended-radio-streams';
const item = url => ({name:'示例',url,genre:'',upstream:source,commit});
const side = items => ({v:2,source,license:'CC0-1.0',commit,generatedAt:'2026-11-26T01:02:03.123Z',items});
const good = side([item('https://example.invalid/live')]);
const normal = enc(good);
function test(id, kind, bytes, proposed, rationale) {
 return {id,kind,rawBase64:bytes.toString('base64'),bytes:bytes.length,sha256:hash(bytes),proposed,rationale};
}
const entries = [];
function s(id, bytes, proposed, rationale) { entries.push(test(id,'sidecar',bytes,proposed,rationale)); }
s('version-int',normal,'accept','整数词法对照');
s('version-decimal',b(normal.toString().replace('"v":2,','"v":2.0,')),'reject','实验建议整数使用整数词法；原提案未明确定义数字词法');
s('version-exponent',b(normal.toString().replace('"v":2,','"v":2e0,')),'reject','实验建议整数使用整数词法；原提案未明确定义数字词法');
for (const [id,url] of [['path-brackets','https://example.invalid/a[b]'],['query-brackets','https://example.invalid/?a[b]=c'],['encoded-brackets','https://example.invalid/a%5Bb%5D?x=%5B%5D']])
 s(id,enc(side([item(url)])),id==='encoded-brackets'?'accept':'reject','实验建议路径/查询中裸方括号拒绝、百分号转义保留；原提案引用保留字符但未明确组件语法');
s('depth-3',normal,'accept','根对象→items 数组→item 对象，容器深度 3');
const d4=normal.toString().replace('"genre":""','"genre":{"nested":true}');
s('depth-4',b(d4),'reject','深度 4 的 genre 为对象，违反字符串类型；不引入独立深度上限');
const deep=normal.toString().replace('"genre":""','"genre":'+'['.repeat(4096)+'0'+']'.repeat(4096));
s('depth-4099',b(deep),'reject','根对象→items→item→4096 层数组，类型不符；无规定失败优先级');
const sid=hash(normal), manifest=enc({v:2,sha256:sid,bytes:normal.length});
for (const [id,bytes,proposed] of [
 ['manifest-bytes-int',manifest,'accept'],
 ['manifest-bytes-decimal',b(manifest.toString().replace('"bytes":'+normal.length,'"bytes":'+normal.length+'.0')),'reject'],
 ['manifest-bytes-exponent',b(manifest.toString().replace('"bytes":'+normal.length,'"bytes":'+normal.length+'e0')),'reject']
]) entries.push({...test(id,'manifest',bytes,proposed,'实验建议整数使用整数词法；原提案未明确定义数字词法'),sidecarId:sid,sidecarBase64:normal.toString('base64'),pointerBase64:enc({v:2,current:sid,previous:null}).toString('base64')});
const result={format:'c3-v2-adversarial-1',note:'实验建议而非原 v2 规范既定结论；proposed 不代表解析器已通过；仅解码 rawBase64 消费字节。',entries};
process.stdout.write(JSON.stringify(result,null,2)+'\n');
