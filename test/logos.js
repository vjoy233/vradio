// logos.js 台标数据链确定性矩阵（P0b，docs/testing-strategy-2026-11.md §3 L1 logos 行）。
// 与 test/ui-phase.js 分工：那边管「渲染形状」（radio.txt 全分类 tone 扫描、外框/UI 形状、首字兜底字形）；
// 本文件管「数据链」——三级来源优先级、loadFile 解析与 URL 门禁、ensure 批量补全（去重/在飞去重/3 路并行/
// 落库与回调）、负缓存 7 天边界、resolve 蜻蜓/byurl 双路、save FIFO 封顶、跨实例缓存恢复；渲染链只从数据链
// 视角复述数据面不变式（esc 转义/img 属性完备/wrap 单层外框），不重复 ui-phase 的形状断言。
// 装载：logos.js 无 boot 块，vm 直装（sandbox + 可编程 fetch 桩 + FakeClock 不 tick——px 8s abort 定时永不触发；
// AbortController 为宿主全局非 ECMAScript 内置，vm 侧须注入桩）。mem 恢复走显式 Logos.load()（与 app boot 同步）。
// 分节 → 覆盖矩阵：
// [1] get 同步优先级（STARTER l > logos.txt file Map > localStorage mem 三层叠置）+ get/visual 全程零 fetch
// [2] loadFile 解析（CRLF/注释空行跳过/双侧 trim/台名含逗号按最后逗号切/非 http 拒收/引号空白尖括号拒收/
//     URL 含逗号切坏拒收/无逗号行/重复键后到覆盖/重载整体重置）
// [3] ensure 批量补全（l/file/mem 任一命中不请求/负缓存新鲜不请求/同台并发在飞去重/重复项去重/3 路并行峰值
//     恰 3/save+done 恰一次/成功落 {u,t} 失败落 {x:1,t}/busy finally 清理/空列表空台不回调）
// [4] 负缓存 7 天（NEG-1 仍新鲜零请求；恰 NEG 过期重新请求并转正缓存；正缓存条目永不判负）
// [5] resolve 蜻蜓路（u 任意位命中 qingting.fm/live/{id} → m.qtfm.cn/channels/{id}/；class="img" 封面提取；
//     ok() 校验不过恰重试一次；两败抛错且 ensure 落负缓存；提取含空白/尖括号拒收后接 byurl）
// [6] resolve byurl 路（de1.api.radio-browser.info byurl?url=s.u[0] 严格编码回显；favicon 合法性门（http(s)
//     且无引号空白尖括号）；缺失/空数组/非 http 一律 ''；https 接受；坏 JSON 拒收）
// [7] save FIFO cap 600（t 升序淘汰最旧、无 t 按 0 最先淘汰、超灌 602 断言边界；localStorage 形态 JSON 回读；
//     setItem 抛错静默吞不崩）
// [8] 渲染链数据面（tone 9 分类精确 token + 未知分类 neutral；phd 剥 [国别] 首字大写/hue 兼容字段存在但不进
//     渲染产物；esc 转义 &<>"；img 完整形态（外框+data-tone+转义 src/data-ch+lazy+onerror）；visual 无图同框
//     同 tone 首字兜底；img/visual 恰一层外框——AIbot PR#31 P1）
// [9] phf 坏图回退（createElement span.className='logo ph'/textContent=ch/aria-hidden/replaceWith 恰一次；
//     dataset.ch 缺失 ？ 兜底）
// [10] 跨实例缓存（同 FakeLS 重载新 Logos：load() 恢复 mem 正缓存命中零请求、负缓存跨实例仍新鲜过期即重试；
//      load() 坏 JSON/非对象/getItem 抛错一律归 {}）
// 未覆盖项与原因（黑盒不可观测/不属于本层，均不为测试改生产代码）：
// - px 8s abort 超时中断：fetch 桩不消费 AbortSignal，桩内无法产生真实中断（setTimeout→ac.abort() 路径随
//   FakeClock 装载、不 tick 不触发）；真超时归 L2 fixture 层。
// - 蜻蜓 SSR 桩页真实出现概率、频道页/接口改版：网络边界，桩按当前选择器取样（选择器漂移由本测快速暴露）。
// - 「提取结果含引号拒收」经蜻蜓路不可达：提取捕获组 [^"]+ 结构性排除引号（byurl 路 favicon 引号拒收已测）。
// - 「收藏 + 正在播才触发解析」的范围圈定：app.js 调用方纪律，logos.ensure 本身不做范围裁剪，归 app 域用例。
// - <img> 真实加载失败时序与浏览器 onerror 触发、file:// 直连显示：渲染面归 ui-phase（形状）与浏览器 smoke。
// - localStorage 真实配额语义：FakeLS 不模拟配额上限，仅以 setItem 抛错模拟写失败。
// 零依赖离线（fetch 全桩），Node 14 兼容，npm test 随跑。
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { sandbox, FakeLS } = require('./harness/fake-browser');
const { FakeClock } = require('./harness/fake-clock');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ✓', name); },
  e => { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); });

// —— 装置 ————————————————————————————————————————————————
const LOGOS_SRC = fs.readFileSync(path.join(__dirname, '..', 'logos.js'), 'utf8');
function FakeAC() { // px() 只在 8s 定时上调 abort；桩不消费 signal，Node 14 无该宿主全局也稳
  this.signal = { aborted: false, addEventListener() {} };
}
FakeAC.prototype.abort = function () { this.signal.aborted = true; };

// 可编程 fetch 桩：routes = 函数(代理URL)→{status,text,err} 或固定 spec 对象；缺省 200 空体。
// 记录调用序（/proxy?url=… 原文）与在飞峰值（同步段计数——微任务排空前断言即确定性峰值）。
function mkFetch(routes) {
  const calls = []; let cur = 0, peak = 0;
  const fetch = u => {
    calls.push(u); cur++; if (cur > peak) peak = cur;
    const spec = (typeof routes === 'function' ? routes(u) : routes) || {};
    return Promise.resolve().then(() => {
      cur--;
      if (spec.err) throw spec.err;
      return { ok: spec.status == null || spec.status === 200, status: spec.status || 200, text: () => Promise.resolve(spec.text == null ? '' : spec.text) };
    });
  };
  fetch.calls = calls; fetch.peak = () => peak;
  return fetch;
}

// 一页装置：独立 sandbox + FakeClock（默认 t=1000，mem 落库 t 恒可断言）+ 可编程 fetch；不做隐式 load()。
function mkLogos(over) {
  over = over || {};
  const clock = over.clock || new FakeClock(1000);
  const ls = over.ls || new FakeLS(over.lsSeed);
  const fetch = over.fetch || mkFetch({});
  const sb = sandbox({ ls: ls, clock: clock, fetch: fetch, document: over.document, globals: { AbortController: FakeAC } });
  vm.createContext(sb);
  vm.runInContext(LOGOS_SRC + '\nthis.Logos = Logos;', sb, { filename: 'logos.js' });
  return { Logos: sb.Logos, ls: ls, fetch: fetch, clock: clock };
}

const plain = v => JSON.parse(JSON.stringify(v)); // vm realm 对象 → 本 realm（deepStrictEqual 原型失配规避，同 ui-scope.js 法）
const target = u => decodeURIComponent(String(u).split('?url=')[1]); // '/proxy?url=…' → 目标站（encodeURIComponent 不产 ?/=，切分安全）
const st = (c, n, u, over) => Object.assign({ c: c, n: n, u: u }, over || {}); // 台对象（app 装配后形态）
const QT = id => 'http://lhttp.qingting.fm/live/' + id + '/64k.mp3'; // 蜻蜓直流样例（可命中 qingting.fm/live/{id}）
const layers = h => (String(h).match(/class="station-logo"/g) || []).length; // 外框层数（AIbot PR#31 P1）

(async () => {

console.log('[1] get 同步优先级 + 同步读取零请求');
await ok('三层叠置取最高层：STARTER l > logos.txt file > localStorage mem；全 miss/负缓存条目 → 空', () => {
  const f = mkFetch({ err: new Error('get/visual 不得发请求') });
  const { Logos } = mkLogos({ fetch: f, lsSeed: { 'radio.logos': JSON.stringify({
    '欧美音乐|三层': { u: 'http://mem/3.png', t: 1 },
    '欧美音乐|仅缓存': { u: 'http://mem/only.png', t: 1 },
    '欧美音乐|脏': { x: 1, t: 1 },
  }) } });
  Logos.load(); // mem 从 localStorage 恢复（boot 步，显式）
  Logos.loadFile('欧美音乐|三层,http://file/3.png\n欧美音乐|两层,http://file/2.png');
  assert.strictEqual(Logos.get(st('欧美音乐', '三层', ['http://s/3'], { l: 'http://starter/3.png' })), 'http://starter/3.png', 'STARTER 最高');
  assert.strictEqual(Logos.get(st('欧美音乐', '三层', ['http://s/3'])), 'http://file/3.png', '无 l → file 压过 mem');
  assert.strictEqual(Logos.get(st('欧美音乐', '两层', ['http://s/2'])), 'http://file/2.png');
  assert.strictEqual(Logos.get(st('欧美音乐', '仅缓存', ['http://s/1'])), 'http://mem/only.png', '只剩 mem');
  assert.strictEqual(Logos.get(st('欧美音乐', '无台标', ['http://s/0'])), '', '全 miss 空串');
  assert.strictEqual(Logos.get(st('欧美音乐', '脏', ['http://s/4'])), '', '负缓存条目不供 URL');
});
await ok('get/visual 全程零 fetch（同步读取不发请求是行为断言：有图/无图两分支各渲染一遍计数恒 0）', () => {
  const f = mkFetch({ err: new Error('get/visual 不得发请求') });
  const { Logos } = mkLogos({ fetch: f });
  Logos.loadFile('欧美音乐|文件台,http://file/f.png');
  Logos.get(st('欧美音乐', '文件台', ['http://1']));
  Logos.visual(st('欧美音乐', '文件台', ['http://1'])); // 有图分支
  Logos.visual(st('欧美音乐', '无台标', ['http://2'])); // 首字兜底分支
  assert.strictEqual(f.calls.length, 0);
});

console.log('[2] loadFile 解析（logos.txt 行协议：分类|台名,URL）');
await ok('合法行落表：CRLF/注释/空行跳过、键 URL 双侧 trim、台名含逗号按最后逗号切、重复键后到覆盖', () => {
  const { Logos } = mkLogos({});
  Logos.loadFile([
    '# 由 npm run sync 自动生成（头部注释）',
    '',
    '   ',
    '欧美音乐|BBC Radio 1,http://pic/1.png',
    '亚洲·港台|台, 名,http://pic/2.png',
    '欧美音乐|重复,http://pic/old.png',
    '欧美音乐|重复,http://pic/new.png',
    '  华语音乐|空白台  ,http://pic/8.png  ',
    '华语音乐|URL尾空白,http://pic/9.png   ',
  ].join('\r\n'));
  assert.strictEqual(Logos.file.get('欧美音乐|BBC Radio 1'), 'http://pic/1.png');
  assert.strictEqual(Logos.file.get('亚洲·港台|台, 名'), 'http://pic/2.png', '最后逗号才是分隔：台名保留逗号');
  assert.strictEqual(Logos.file.get('欧美音乐|重复'), 'http://pic/new.png', '重复键后到覆盖');
  assert.strictEqual(Logos.file.get('华语音乐|空白台'), 'http://pic/8.png', '键双侧 trim');
  assert.strictEqual(Logos.file.get('华语音乐|URL尾空白'), 'http://pic/9.png', 'URL trim');
  assert.strictEqual(Logos.file.size, 5, '注释/空行/白空行全部跳过');
});
await ok('URL 门禁：非 http(s)、引号/空白/尖括号（防属性逃逸）、URL 含逗号按最后逗号切坏、无逗号行——全部拒收', () => {
  const { Logos } = mkLogos({});
  Logos.loadFile([
    '欧美音乐|坏协议,ftp://pic/3.png',
    '欧美音乐|坏相对,/local/3.png',
    '欧美音乐|坏引号,http://pic/4.png?x=" onclick=',
    '欧美音乐|坏空白,http://pic/5.png?a=1&b= 2',
    '欧美音乐|坏尖括号,http://pic/<6>.png',
    '欧美音乐|逗号URL,http://pic/7.png?a=1,2', // 按最后逗号切 → 尾段 '2' 非 http → 整行拒收（上游 tvg-logo 无逗号前提）
    '无逗号行',
  ].join('\r\n'));
  assert.strictEqual(Logos.file.size, 0, '七类非法行全部拒收');
  for (const k of ['欧美音乐|坏协议', '欧美音乐|坏相对', '欧美音乐|坏引号', '欧美音乐|坏空白', '欧美音乐|坏尖括号', '欧美音乐|逗号URL', '无逗号行']) {
    assert.ok(!Logos.file.has(k), k + ' 不得落表');
  }
});
await ok('loadFile 幂等重置：再次载入整体替换 file Map，空串载入清空', () => {
  const { Logos } = mkLogos({});
  Logos.loadFile('欧美音乐|首载,http://a/1.png');
  assert.strictEqual(Logos.file.size, 1);
  Logos.loadFile('华语音乐|二载,http://b/2.png');
  assert.strictEqual(Logos.file.size, 1, '重载整体重置');
  assert.ok(!Logos.file.has('欧美音乐|首载'));
  Logos.loadFile('');
  assert.strictEqual(Logos.file.size, 0, '空串载入清空');
});

console.log('[3] ensure 批量补全（去重/在飞去重/3 路并行/落库回调）');
await ok('已有台标（l/file/mem 任一命中）不请求；todo 空不 save 不回调；空列表/null 台项不回调', async () => {
  const f = mkFetch(() => ({ text: '[{"favicon":"http://fb/x.png"}]' }));
  const { Logos } = mkLogos({ fetch: f, lsSeed: { 'radio.logos': JSON.stringify({ '华语音乐|缓存台': { u: 'http://mem/c.png', t: 1 } }) } });
  Logos.load();
  Logos.loadFile('华语音乐|文件台,http://file/f.png');
  let done = 0;
  await Logos.ensure([
    st('华语音乐', '缓存台', ['http://1']),
    st('华语音乐', '文件台', ['http://2']),
    st('华语音乐', '内置台', ['http://3'], { l: 'http://l/3.png' }),
  ], () => done++);
  assert.strictEqual(f.calls.length, 0, '三层任一命中都不请求');
  assert.strictEqual(done, 0, 'todo 空：无 save 无 done');
  await Logos.ensure([], () => { done++; });
  await Logos.ensure([null], () => { done++; }); // !s continue
  assert.strictEqual(done, 0, '空列表/空台项不回调');
});
await ok('负缓存新鲜（{x:1,t} 未过期）不请求不回调', async () => {
  const f = mkFetch(() => ({ text: '[{"favicon":"http://fb/nc.png"}]' }));
  const { Logos } = mkLogos({ fetch: f, lsSeed: { 'radio.logos': JSON.stringify({ '测试|负缓存': { x: 1, t: 1000 } }) } });
  Logos.load();
  const s = st('测试', '负缓存', ['http://n/1']);
  assert.strictEqual(Logos.freshNeg(s), true, 't0 同刻：0 < NEG 新鲜');
  let done = 0;
  await Logos.ensure([s], () => done++);
  assert.strictEqual(f.calls.length, 0);
  assert.strictEqual(done, 0);
});
await ok('在飞去重：同台并发两次 ensure 只发一路；先到者回调落库，后到者空手而归；busy finally 清零', async () => {
  const f = mkFetch(() => ({ text: '[{"favicon":"http://fb/dd.png"}]' }));
  const { Logos } = mkLogos({ fetch: f });
  let d1 = 0, d2 = 0;
  const s = st('欧美音乐', '并发台', ['http://main/1']);
  const p1 = Logos.ensure([s], () => d1++); // 同步段：busy 标记 + fetch#1 即发
  const p2 = Logos.ensure([s], () => d2++); // busy.has(k) → 剪枝
  await Promise.all([p1, p2]);
  assert.strictEqual(f.calls.length, 1, '同台只发一路');
  assert.strictEqual(d1, 1);
  assert.strictEqual(d2, 0, '空 todo 无回调');
  assert.strictEqual(Logos.busy.size, 0, 'finally 清理在飞集');
  assert.strictEqual(Logos.get(s), 'http://fb/dd.png', '落库成功');
});
await ok('重复项去重：stations 含同台重复项只发一路、回调一次', async () => {
  const f = mkFetch(() => ({ text: '[{"favicon":"http://fb/dup.png"}]' }));
  const { Logos } = mkLogos({ fetch: f });
  const s = st('欧美音乐', '重复台', ['http://main/1']);
  let done = 0;
  await Logos.ensure([s, s, s], () => done++); // seen Set 去重
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(done, 1);
  assert.strictEqual(Logos.get(s), 'http://fb/dup.png');
});
await ok('3 路并行：同步段峰值在飞恰 3（≤3 且 >1），5 台全落库、save 一次、done 恰一次', async () => {
  let ci = 0;
  const f = mkFetch(() => ({ text: '[{"favicon":"http://img/' + (++ci) + '.png"}]' }));
  const { Logos, ls } = mkLogos({ fetch: f });
  const sts = ['A', 'B', 'C', 'D', 'E'].map(n => st('欧美音乐', '并行' + n, ['http://m/' + n]));
  let done = 0;
  const p = Logos.ensure(sts, () => done++);
  assert.strictEqual(f.peak(), 3, '同步段 3 worker 各捡一站：确定性峰值恰 3');
  assert.strictEqual(f.calls.length, 3);
  await p;
  assert.strictEqual(f.calls.length, 5, '余下 2 台由空出 worker 接力');
  assert.strictEqual(f.peak(), 3, '全程不超 3');
  assert.strictEqual(done, 1, 'done 恰一次');
  assert.strictEqual(Object.keys(Logos.mem).length, 5);
  assert.strictEqual(Logos.mem['欧美音乐|并行A'].u, 'http://img/1.png', 'todo 序 = 捡取序（前 3 台确定性映射）');
  assert.strictEqual(Logos.mem['欧美音乐|并行B'].u, 'http://img/2.png');
  assert.strictEqual(Logos.mem['欧美音乐|并行C'].u, 'http://img/3.png');
  assert.ok(/^http:\/\/img\/[45]\.png$/.test(Logos.mem['欧美音乐|并行D'].u), '后 2 台落库即可（worker 接力序不约定）');
  const stored = JSON.parse(ls.getItem('radio.logos'));
  assert.strictEqual(Object.keys(stored).length, 5, 'save 落 localStorage');
  assert.ok(stored['欧美音乐|并行A'].u === 'http://img/1.png');
  assert.strictEqual(Logos.busy.size, 0);
});
await ok('落库形态：成功落 {u,t}、失败落负缓存 {x:1,t}；失败台 ok() 门两试全败计 2 跳', async () => {
  const f = mkFetch(u => {
    if (target(u).indexOf('okhost') > -1) return { text: '[{"favicon":"http://ok/1.png"}]' };
    return { text: 'not json' }; // byurl ok 门（startsWith '['）两试全败 → px 抛 → resolve 拒 → 负缓存
  });
  const { Logos } = mkLogos({ fetch: f });
  let done = 0;
  await Logos.ensure([st('欧美音乐', '成功台', ['http://okhost/1']), st('欧美音乐', '失败台', ['http://badhost/1'])], () => done++);
  assert.strictEqual(done, 1);
  assert.deepStrictEqual(plain(Logos.mem['欧美音乐|成功台']), { u: 'http://ok/1.png', t: 1000 }, '成功落 {u,t}');
  assert.deepStrictEqual(plain(Logos.mem['欧美音乐|失败台']), { x: 1, t: 1000 }, '失败落负缓存 {x:1,t}');
  assert.strictEqual(f.calls.length, 3, '成功 1 跳 + 失败 2 跳（ok 门重试一次）');
});

console.log('[4] 负缓存 7 天（NEG 边界）');
await ok('NEG-1ms 仍新鲜：freshNeg=true、ensure 零请求零回调', async () => {
  const rec = mkFetch(() => ({ text: '[{"favicon":"http://fb/re.png"}]' }));
  const p = mkLogos({ fetch: rec, lsSeed: { 'radio.logos': JSON.stringify({ '测试|负缓存': { x: 1, t: 1000 } }) } });
  p.Logos.load();
  assert.strictEqual(p.Logos.NEG, 604800000, 'NEG = 7*86400000 键漂移守门');
  const s = st('测试', '负缓存', ['http://n/1']);
  p.clock.t = 1000 + p.Logos.NEG - 1;
  assert.strictEqual(p.Logos.freshNeg(s), true, '第 7 天界内仍新鲜');
  let done = 0;
  await p.Logos.ensure([s], () => done++);
  assert.strictEqual(rec.calls.length, 0);
  assert.strictEqual(done, 0);
});
await ok('恰 NEG 过期：freshNeg=false、重新请求并转正缓存 {u,t}', async () => {
  const rec = mkFetch(() => ({ text: '[{"favicon":"http://fb/re.png"}]' }));
  const p = mkLogos({ fetch: rec, lsSeed: { 'radio.logos': JSON.stringify({ '测试|负缓存': { x: 1, t: 1000 } }) } });
  p.Logos.load();
  const s = st('测试', '负缓存', ['http://n/1']);
  p.clock.t = 1000 + p.Logos.NEG; // < NEG 不再成立：界上即过期
  assert.strictEqual(p.Logos.freshNeg(s), false);
  let done = 0;
  await p.Logos.ensure([s], () => done++);
  assert.strictEqual(rec.calls.length, 1);
  assert.strictEqual(done, 1);
  assert.deepStrictEqual(plain(p.Logos.mem['测试|负缓存']), { u: 'http://fb/re.png', t: 1000 + p.Logos.NEG });
  assert.strictEqual(p.Logos.freshNeg(s), false, '转正缓存后永不判负');
  assert.strictEqual(p.Logos.get(s), 'http://fb/re.png');
});
await ok('正缓存条目（{u,t} 形态）无论多旧永不判负，ensure 不再补', async () => {
  const rec = mkFetch(() => ({ text: '[{"favicon":"http://fb/x.png"}]' }));
  const p = mkLogos({ fetch: rec, lsSeed: { 'radio.logos': JSON.stringify({ '测试|老正缓存': { u: 'http://old/1.png', t: 1 } }) } });
  p.Logos.load();
  const s = st('测试', '老正缓存', ['http://o/1']);
  p.clock.t = 1e12;
  assert.strictEqual(p.Logos.freshNeg(s), false, '{u} 形态无 x 不判负');
  await p.Logos.ensure([s], () => {});
  assert.strictEqual(rec.calls.length, 0, 'get 命中不进 todo');
  assert.strictEqual(p.Logos.get(s), 'http://old/1.png');
});

console.log('[5] resolve 蜻蜓路（频道页封面）');
await ok('u 任意位命中 qingting.fm/live/{id} → 请求 m.qtfm.cn/channels/{id}/，class="img" 封面提取即止', async () => {
  const f = mkFetch(() => ({ text: '<html><img class="img" src="http://pic.qtfm.cn/cover/2089.jpg" alt="台名"></html>' }));
  const { Logos } = mkLogos({ fetch: f });
  const s = st('亚洲·港台', '蜻蜓台', ['http://other/x', QT(2089)]); // u[1] 命中
  assert.strictEqual(await Logos.resolve(s), 'http://pic.qtfm.cn/cover/2089.jpg');
  assert.strictEqual(f.calls.length, 1, '命中频道页即止，不走 byurl');
  assert.strictEqual(target(f.calls[0]), 'https://m.qtfm.cn/channels/2089/', 'id 与流 URL 同空间确定性映射');
});
await ok('ok() 校验不过恰重试一次（首响应 SSR 桩页、二次真页）', async () => {
  let n = 0;
  const f = mkFetch(() => ({ text: (++n === 1) ? '<html>SSR 桩页</html>' : '<html><img class="img" src="http://pic.qingting.com/p/2089.png" alt="台标"></html>' }));
  const { Logos } = mkLogos({ fetch: f });
  assert.strictEqual(await Logos.resolve(st('亚洲·港台', '重试台', [QT(2089)])), 'http://pic.qingting.com/p/2089.png');
  assert.strictEqual(f.calls.length, 2, 'px 内层 for 恰两试');
});
await ok('两试全败 → 抛错（stub page）；经 ensure 落负缓存 {x:1,t}', async () => {
  const f = mkFetch(() => ({ text: '<html>SSR 桩页</html>' }));
  const { Logos } = mkLogos({ fetch: f });
  const s = st('亚洲·港台', '桩页台', [QT(777)]);
  await assert.rejects(Logos.resolve(s), /stub page/, 'resolve 直接拒收');
  assert.strictEqual(f.calls.length, 2, '恰两试');
  let done = 0;
  await Logos.ensure([s], () => done++); // resolve().catch(() => '') → 负缓存
  assert.strictEqual(f.calls.length, 4);
  assert.deepStrictEqual(plain(Logos.mem['亚洲·港台|桩页台']), { x: 1, t: 1000 }, '两败负缓存落库');
  assert.strictEqual(done, 1);
});
await ok('提取结果含空白/尖括号拒收 → 接 byurl 路（s.u[0] 严格编码进参）', async () => {
  const f = mkFetch(u => {
    const t = target(u);
    if (t.indexOf('m.qtfm.cn/channels/') > -1) return { text: '<html><img class="img" src="http://pic.qtfm.cn/a b<img>.jpg" alt="x"></html>' };
    return { text: '[{"favicon":"http://fb/fall.png"}]' };
  });
  const { Logos } = mkLogos({ fetch: f });
  const s = st('亚洲·港台', '脏图台', [QT(888)]);
  assert.strictEqual(await Logos.resolve(s), 'http://fb/fall.png', '脏提取弃用，兜底 byurl');
  assert.strictEqual(f.calls.length, 2);
  assert.ok(target(f.calls[1]).indexOf('de1.api.radio-browser.info') > -1, '第二跳走 byurl');
  assert.ok(target(f.calls[1]).indexOf(encodeURIComponent(QT(888))) > -1, 'byurl 参数 = s.u[0]');
});

console.log('[6] resolve byurl 路（Radio Browser favicon）');
await ok('无蜻蜓源 → byurl?url=s.u[0] 严格编码回显；https favicon 合法接受', async () => {
  const f = mkFetch(() => ({ text: '[{"favicon":"https://fb/s.png"}]' }));
  const { Logos } = mkLogos({ fetch: f });
  const s = st('欧美音乐', 'byurl台', ['http://radio/stream?a=1&b=2']);
  assert.strictEqual(await Logos.resolve(s), 'https://fb/s.png');
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(target(f.calls[0]), 'https://de1.api.radio-browser.info/json/stations/byurl?url=' + encodeURIComponent('http://radio/stream?a=1&b=2'), '目标站+编码严格回显');
});
await ok('favicon 合法性门：缺失/空数组/非 http/引号/空白/尖括号一律空串（逐样例独立装置）', async () => {
  const CASES = [
    ['[{"name":"无 favicon 字段"}]', ''],
    ['[]', ''],
    ['[{}]', ''],
    ['[{"favicon":"ftp://x/y.png"}]', ''],
    ['[{"favicon":"http://x/a b.png"}]', ''],
    ['[{"favicon":"http://x/a<b>.png"}]', ''],
    ['[{"favicon":"http://x/a\\"b.png"}]', ''],
  ];
  for (const [text, want] of CASES) {
    const { Logos } = mkLogos({ fetch: mkFetch(() => ({ text: text })) });
    assert.strictEqual(await Logos.resolve(st('欧美音乐', '门禁台', ['http://r/1'])), want, '样例 ' + text + ' 应得 ' + JSON.stringify(want));
  }
});
await ok('坏 JSON（以 [ 开头骗过 ok 门但解析失败）→ resolve 拒收（ensure 侧落负缓存已由 [3] 覆盖）', async () => {
  const f = mkFetch(() => ({ text: '[broken' }));
  const { Logos } = mkLogos({ fetch: f });
  await assert.rejects(Logos.resolve(st('欧美音乐', '坏JSON台', ['http://r/2'])));
  assert.strictEqual(f.calls.length, 1, 'JSON.parse 抛在重试门之后：不再二试');
});

console.log('[7] save FIFO 封顶 600 + 持久化形态');
await ok('mem 超 600 按 t 升序淘汰最旧；无 t 条目按 0 最先淘汰（602+2 灌入断言边界）', () => {
  const { Logos, ls } = mkLogos({});
  for (let i = 1; i <= 602; i++) Logos.mem['k' + i] = { u: 'http://x/' + i, t: i };
  Logos.mem.noT1 = { u: 'http://x/n1' }; // 无 t → 按 0
  Logos.mem.noT2 = { x: 1, t: -1 };
  Logos.save();
  assert.strictEqual(Object.keys(Logos.mem).length, 600);
  for (const k of ['noT2', 'noT1', 'k1', 'k2']) assert.ok(!(k in Logos.mem), k + ' 最旧被淘汰');
  assert.ok('k3' in Logos.mem && 'k602' in Logos.mem, '最新边界保留');
  assert.strictEqual(Object.keys(JSON.parse(ls.getItem('radio.logos'))).length, 600, '淘汰后形态落盘');
});
await ok('localStorage 持久化形态可 JSON.parse 回读：键集合与 {u,t}/{x,t} 条目形状一致', () => {
  const { Logos, ls } = mkLogos({});
  Logos.mem['a|b'] = { u: 'http://x/1.png', t: 1000 };
  Logos.mem['c|d'] = { x: 1, t: 1001 };
  Logos.save();
  const stored = JSON.parse(ls.getItem('radio.logos'));
  assert.deepStrictEqual(Object.keys(stored).sort(), ['a|b', 'c|d']);
  assert.strictEqual(stored['a|b'].u, 'http://x/1.png');
  assert.strictEqual(stored['a|b'].t, 1000);
  assert.strictEqual(stored['c|d'].x, 1);
  assert.strictEqual(stored['c|d'].t, 1001);
});
await ok('setItem 抛错（模拟配额满）静默吞掉：save 不崩、mem 不动', () => {
  const ls = new FakeLS();
  const { Logos } = mkLogos({ ls: ls });
  ls.setItem = () => { throw new Error('QuotaExceeded'); };
  Logos.mem['a|b'] = { u: 'http://x/1.png', t: 1 };
  Logos.save(); // try/catch 吞错不抛
  assert.strictEqual(Logos.mem['a|b'].u, 'http://x/1.png', 'mem 不回滚不崩');
});

console.log('[8] 渲染链数据面（tone/phd/esc/img/visual/wrap）');
await ok('tone 分类查表：9 真实分类精确 token、未知/空分类中性兜底（表漂移即此处红）', () => {
  const { Logos } = mkLogos({});
  const CASES = [['华语音乐', 'green'], ['欧美音乐', 'blue'], ['亚洲·港台', 'teal'], ['新闻资讯', 'orange'],
    ['国际新闻·谈话', 'steel'], ['交通广播', 'amber'], ['文艺·生活', 'plum'], ['财经', 'gold'], ['综合·其他', 'neutral']];
  for (const [c, tk] of CASES) assert.strictEqual(Logos.tone({ c: c, n: 'x', u: ['http://a/1'] }), tk, '分类「' + c + '」token 漂移');
  assert.strictEqual(Logos.tone({ c: '自建分类', n: 'x', u: [] }), 'neutral');
  assert.strictEqual(Logos.tone({ c: '', n: 'x', u: [] }), 'neutral');
});
await ok('phd：剥 [国别] 尾缀取首字符大写；hue 为旧缓存兼容字段（存在、确定性、不进渲染产物）', () => {
  const { Logos } = mkLogos({});
  const d = Logos.phd({ c: '欧美音乐', n: 'jazz radio [US]', u: [] });
  assert.strictEqual(d.ch, 'J', '剥 [国别] 后首字符大写');
  assert.ok(Number.isInteger(d.hue) && d.hue >= 0 && d.hue < 360, 'hue 兼容字段仍在（0-359 整数）');
  assert.strictEqual(Logos.phd({ c: '欧美音乐', n: 'jazz radio [US]', u: [] }).hue, d.hue, '同输入同 hue（确定性）');
  const h = Logos.visual({ c: '欧美音乐', n: 'jazz radio [US]', l: 'http://img/x.png', u: [] });
  assert.ok(h.indexOf('hue') === -1 && h.indexOf('style=') === -1 && h.indexOf('background') === -1, 'hue 不参与上色：无 hue/inline style/background');
  assert.strictEqual(Logos.phd({ c: 'x', n: '[CN]', u: [] }).ch, '?', '剥完为空 → ？ 兜底');
});
await ok('esc 转义 &<>"（上游可控数据拼属性前的唯一防线）+ 非字符串先 String', () => {
  const { Logos } = mkLogos({});
  assert.strictEqual(Logos.esc('a&b<c>d"e'), 'a&amp;b&lt;c&gt;d&quot;e');
  assert.strictEqual(Logos.esc(123), '123');
});
await ok('img() 完整形态：外框+data-tone+src/ data-ch 双转义+loading=lazy+onerror=Logos.phf(this)，恰一层外框', () => {
  const { Logos } = mkLogos({});
  const h = Logos.img({ c: '华语音乐', n: '&台', l: 'http://img/a.png?x=1&y=2', u: ['http://s'] });
  assert.strictEqual(h, '<span class="station-logo" data-tone="green" aria-hidden="true">' +
    '<img class="logo" src="http://img/a.png?x=1&amp;y=2" alt="" loading="lazy" data-ch="&amp;" onerror="Logos.phf(this)"></span>',
    'URL 含 & / 台名首字 & 均转义，属性逃逸面为零');
  assert.strictEqual(layers(h), 1, 'img 产物恰一个 .station-logo 外框（AIbot PR#31 P1）');
});
await ok('visual() 无台标走首字兜底：同一外框同一 tone（有图/无图前缀逐字符一致）+ 恰一层', () => {
  const { Logos } = mkLogos({});
  const noImg = Logos.visual({ c: '财经', n: '无图台', u: ['http://s'] });
  assert.strictEqual(noImg, '<span class="station-logo" data-tone="gold" aria-hidden="true"><span class="logo ph">无</span></span>');
  const withImg = Logos.visual({ c: '财经', n: '有图台', l: 'http://img/i.png', u: ['http://s'] });
  const frame = '<span class="station-logo" data-tone="gold" aria-hidden="true">';
  assert.ok(withImg.indexOf(frame) === 0 && noImg.indexOf(frame) === 0, '同框同 tone');
  assert.strictEqual(layers(noImg), 1);
  assert.strictEqual(layers(withImg), 1);
});

console.log('[9] phf 坏图回退');
await ok('phf：createElement span.className="logo ph"、textContent=ch、aria-hidden、replaceWith 恰一次且换的就是新 span', () => {
  let created = null;
  const doc = { createElement(tag) { const el = { tag: tag, className: '', textContent: '', attrs: {}, setAttribute(k, v) { el.attrs[k] = v; } }; created = el; return el; } };
  const { Logos } = mkLogos({ document: doc });
  const replaced = [];
  Logos.phf({ dataset: { ch: 'B' }, replaceWith(sp) { replaced.push(sp); } });
  assert.strictEqual(replaced.length, 1);
  assert.strictEqual(created, replaced[0], 'replaceWith 收到的就是新建 span');
  assert.strictEqual(created.className, 'logo ph');
  assert.strictEqual(created.textContent, 'B');
  assert.strictEqual(created.attrs['aria-hidden'], 'true');
});
await ok('phf：dataset.ch 缺失 → ？ 兜底', () => {
  let created = null;
  const doc = { createElement(tag) { const el = { className: '', textContent: '', attrs: {}, setAttribute(k, v) { el.attrs[k] = v; } }; created = el; return el; } };
  const { Logos } = mkLogos({ document: doc });
  const replaced = [];
  Logos.phf({ dataset: {}, replaceWith(sp) { replaced.push(sp); } });
  assert.strictEqual(replaced.length, 1);
  assert.strictEqual(replaced[0].textContent, '?');
});

console.log('[10] 跨实例缓存与 load() 容错');
await ok('同 FakeLS 重载新 Logos：load() 恢复 mem → get 命中零请求、ensure 零回调', async () => {
  const clock = new FakeClock(1000);
  const ls = new FakeLS();
  const fa = mkFetch(() => ({ text: '[{"favicon":"http://fb/cross.png"}]' }));
  const a = mkLogos({ ls: ls, clock: clock, fetch: fa });
  assert.strictEqual(a.Logos.LS, 'radio.logos', '持久键漂移守门');
  await a.Logos.ensure([st('欧美音乐', '跨实例', ['http://x/1'])], () => {});
  assert.strictEqual(JSON.parse(ls.getItem('radio.logos'))['欧美音乐|跨实例'].u, 'http://fb/cross.png', 'A 侧落盘');
  const fb = mkFetch({ err: new Error('跨实例命中缓存不得再发请求') });
  const b = mkLogos({ ls: ls, clock: clock, fetch: fb }); // 新 sandbox：mem/file 从零开始
  const s = st('欧美音乐', '跨实例', ['http://x/1']);
  assert.strictEqual(b.Logos.get(s), '', '未 load 前 mem 为空');
  b.Logos.load();
  assert.strictEqual(b.Logos.get(s), 'http://fb/cross.png', 'load() 恢复 mem');
  let done = 0;
  await b.Logos.ensure([s], () => done++);
  assert.strictEqual(fb.calls.length, 0, '正缓存命中零请求');
  assert.strictEqual(done, 0);
});
await ok('负缓存跨实例：load() 恢复 {x,t} → 新鲜期内不重试，推过 7 天即重试', async () => {
  const clock = new FakeClock(1000);
  const ls = new FakeLS({ 'radio.logos': JSON.stringify({ '测试|负缓存跨': { x: 1, t: 1000 } }) });
  const fc = mkFetch(() => ({ text: '[{"favicon":"http://fb/nc.png"}]' }));
  const c = mkLogos({ ls: ls, clock: clock, fetch: fc });
  c.Logos.load();
  const s = st('测试', '负缓存跨', ['http://x/2']);
  assert.strictEqual(c.Logos.freshNeg(s), true, '负缓存跨实例仍新鲜');
  await c.Logos.ensure([s], () => {});
  assert.strictEqual(fc.calls.length, 0);
  clock.t = 1000 + c.Logos.NEG;
  assert.strictEqual(c.Logos.freshNeg(s), false, '过期即重试');
  await c.Logos.ensure([s], () => {});
  assert.strictEqual(fc.calls.length, 1);
  assert.deepStrictEqual(plain(c.Logos.mem['测试|负缓存跨']), { u: 'http://fb/nc.png', t: 1000 + c.Logos.NEG });
});
await ok('load() 容错：坏 JSON/非对象（数字）/getItem 抛错一律归 {}，不抛不崩', () => {
  const ls = new FakeLS();
  const { Logos } = mkLogos({ ls: ls });
  ls.setItem('radio.logos', '{oops');
  Logos.load();
  assert.strictEqual(Object.keys(Logos.mem).length, 0, '坏 JSON 归空');
  ls.setItem('radio.logos', '5');
  Logos.load();
  assert.strictEqual(Object.keys(Logos.mem).length, 0, '非对象归空');
  ls.getItem = () => { throw new Error('io'); };
  Logos.load();
  assert.strictEqual(Object.keys(Logos.mem).length, 0, 'getItem 抛错也吞');
  assert.strictEqual(Logos.get(st('欧美音乐', '任意', ['http://x'])), '');
});

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);

})().catch(e => { console.error('logos 测试异常：', e); process.exit(1); });
