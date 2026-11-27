'use strict';
// 离线合成字节；本文件不是 v2 解析器。不得用 JSON 重编码消费 rawBase64。
const crypto = require('crypto');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const enc = x => Buffer.from(JSON.stringify(x), 'utf8');
const A = 'a'.repeat(40), B = 'b'.repeat(40), source = 'recommended-radio-streams';
const item = (url, name = '示例', genre = '') => ({name, url, genre, upstream: source, commit: A});
const side = items => ({v: 2, source, license: 'CC0-1.0', commit: A, generatedAt: '2026-11-26T01:02:03.123Z', items});
const validItem = item('https://example.invalid/live');
const good = side([validItem]);
const raw = x => Buffer.isBuffer(x) ? x : enc(x);
const entry = (id, x, accept, output) => { const b = raw(x); return {id, rawBase64:b.toString('base64'), bytes:b.length, sha256:hash(b), accept, ...(accept ? {output} : {})}; };
const cases = [];
function add(id, x, accept) { cases.push(entry(id, x, accept, x)); }
add('empty', side([]), true); add('item', good, true);
add('300-items', side(Array.from({length:300}, (_, i) => item('https://example.invalid/'+i))), true);
add('301-items', side(Array.from({length:301}, (_, i) => item('https://example.invalid/'+i))), false);
add('name-200-bytes', side([item('http://example.invalid', '中'.repeat(66)+'ab')]), true);
add('name-201-bytes', side([item('http://example.invalid', '中'.repeat(67))]), false);
add('genre-120-bytes', side([item('http://example.invalid', 'n', '中'.repeat(40))]), true);
add('genre-123-bytes', side([item('http://example.invalid', 'n', '中'.repeat(41))]), false);
add('duplicate-url', side([validItem, validItem]), false);
add('wrong-item-commit', side([{...validItem,commit:B}]), false);
add('version-string', {...good,v:'2'}, false); add('unknown-key', {...good,extra:true}, false);
add('invalid-date', {...good,generatedAt:'2026-02-30T01:02:03.123Z'}, false);
add('unpaired-surrogate', side([item('http://example.invalid','\ud800')]), false);
const goodBytes = enc(good);
add('duplicate-key', Buffer.from(goodBytes.toString().replace('{"v":2,','{"v":2,"v":2,')), false);
add('invalid-utf8', Buffer.concat([goodBytes.subarray(0,1),Buffer.from([0xc0,0xaf]),goodBytes.subarray(1)]), false);
add('bom', Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),goodBytes]), false);
add('trailing', Buffer.concat([goodBytes,Buffer.from(' true')]), false);
const urlCases = [
 ['ipv4','http://127.0.0.1/live',true],['short-ip','http://127.1/live',false],['octal','http://0177.0.0.1/live',false],['hex-tail','http://example.0X7F/live',false],['numeric-tail','http://example.3com/live',false],['numeric-prefix','http://3com.example/live',true],['upper-host','http://EXAMPLE.COM/live',true],['upper-scheme','HTTP://example.com/live',false],['trailing-dot','http://example.com./live',false],['userinfo','http://user@example.com/live',false],['bad-percent','http://example.com/%XZ',false],['fragment','http://example.com/#x',false],['port-zero','http://example.com:0/',false],['ipv6','http://[::1]/',false]
];
urlCases.forEach(([id,u,ok]) => add('url-'+id, side([item(u)]), ok));
// 以尾随 JSON 空格构造准确边界：不更改解析结果。
const base = enc(side([]));
add('sidecar-exact-limit', Buffer.concat([base,Buffer.alloc(524288-base.length,0x20)]), true);
cases[cases.length-1].output = side([]);
add('sidecar-over-limit', Buffer.concat([base,Buffer.alloc(524289-base.length,0x20)]), false);
const gen = x => {const b=enc(x); return {sidecarBase64:b.toString('base64'),manifestBase64:enc({v:2,sha256:hash(b),bytes:b.length}).toString('base64'),id:hash(b),commit:x.commit};};
const current=gen(good), previous=gen(side([]));
const broken = {...current, manifestBase64:enc({v:2,sha256:current.id,bytes:1}).toString('base64')};
const otherCommit = gen({...side([]),commit:B});
function scenario(id, c, p, expect, opt={}) {
 const ptr=enc({v:2,current:c.id,previous:p ? p.id : null});
 return {id,pointerBase64:ptr.toString('base64'),generations:{[c.id]:c,...(p?{[p.id]:p}:{})},expected:expect,...opt};
}
const pointers=[scenario('first',current,null,{selection:'current',degraded:false,output:good}),scenario('both',current,previous,{selection:'current',degraded:false,output:good}),scenario('fallback',broken,previous,{selection:'previous',output:side([])}),scenario('empty-current',previous,current,{selection:'current',degraded:false,output:side([])}),scenario('cross-commit',broken,otherCommit,{selection:'unavailable'}, {binding:{currentCommit:A,previousCommit:B}})];
const missing=scenario('missing-previous',current,previous,{selection:'current',degraded:true,output:good}); delete missing.generations[previous.id]; pointers.push(missing);
const mismatch=scenario('pointer-id-mismatch',current,null,{selection:'unavailable'}); const fake='f'.repeat(64); mismatch.pointerBase64=enc({v:2,current:fake,previous:null}).toString('base64'); mismatch.generations={[fake]:current}; pointers.push(mismatch);
const badPrevious=scenario('invalid-previous',current,previous,{selection:'current',degraded:true,output:good});
// 破坏 previous manifest，但保留不相同的代 id。
badPrevious.pointerBase64=enc({v:2,current:current.id,previous:previous.id}).toString('base64'); badPrevious.generations[previous.id]={...previous,manifestBase64:enc({v:2,sha256:previous.id,bytes:1}).toString('base64')}; pointers.push(badPrevious);
const invalid=scenario('invalid-pointer',current,previous,{selection:'unavailable'}); invalid.pointerBase64=enc({v:2,current:current.id,previous:current.id}).toString('base64'); pointers.push(invalid);
const result={format:'c3-v2-shared-fixtures-1',note:'离线合成；原始字节仅 base64 解码，sha256 为真实字节哈希；不是解析器、许可或联网证明。output 是完整解析结果。',undefinedBehavior:['受控 commit 绑定及其传递方式未定义；跨 commit 用显式外部 binding 标识。','previous 回退时的降级标记和错误分类未定义，故不予断言。','规范未定义解析 API 返回值形状；output 是协议 JSON 值，不规定实现接口。'],sidecar:cases,pointer:pointers};
process.stdout.write(JSON.stringify(result,null,2)+'\n');
