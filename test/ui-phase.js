// UI 播放阶段/台标外框测试（ui-redesign P3 §4.2/§6.10）：零依赖离线，npm test 随跑。
// ① logos.js 经 vm 沙箱直测（classic script 无模块出口，读源码取 Logos）：tone() 分类固定色板覆盖 radio.txt
//    全部真实分类、未知分类中性兜底、data-tone 只出安全 token；visual() 统一外框结构（有图/无图同框同 token）、
//    坏图回退 phf 只换内层节点不再带 inline 底色（色全由外框 CSS 给，同框同色）。
// ② app.js 剥尾部 boot 块后取顶层纯函数 uiPhaseRunning（唱片旋转判定三态：真实 playing × 页面可见 × 未减动效）。
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.error('  ✗', name, '\n     ', String(e && e.message || e).split('\n')[0]); } };

const UP = path.join(__dirname, '..');

// —— logos.js：整文件 vm 执行（顶层仅 const Logos = {...}；document 只有 phf 用到，给最小桩）——
const sandboxL = { document: { createElement: () => { const a = {}; return { setAttribute: (k, v) => { a[k] = v; }, getAttribute: k => a[k], style: {} }; } } };
vm.createContext(sandboxL);
vm.runInContext(fs.readFileSync(path.join(UP, 'logos.js'), 'utf8') + '\nthis.Logos = Logos;', sandboxL);
const Logos = sandboxL.Logos;

console.log('[P3 tone] 分类固定色板（§6.10：按当前分类查表，不做全色相 hash）');
ok('radio.txt 全部真实分类都有映射（逐一取证，重命名漏表即中性兜底无第三态）', () => {
  const cats = new Set();
  for (const line of fs.readFileSync(path.join(UP, 'radio.txt'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(.+),#genre#$/); if (m) cats.add(m[1].trim());
  }
  assert.ok(cats.size >= 5, 'radio.txt 应有真实分类节');
  for (const c of cats) assert.strictEqual(typeof Logos.tone({ c, n: 'x', u: ['http://a/1'] }), 'string', `分类「${c}」tone 非字符串`);
});
ok('未知/自建分类中性灰兜底（neutral，不猜色相）', () => {
  assert.strictEqual(Logos.tone({ c: '我的私藏台', n: 'x', u: ['http://a/1'] }), 'neutral');
  assert.strictEqual(Logos.tone({ c: '', n: 'x', u: ['http://a/1'] }), 'neutral');
});
ok('data-tone 只出安全 token（固定枚举小写词，绝非分类名本身——属性注入面为零）', () => {
  for (const c of ['华语音乐', '欧美音乐', '亚洲·港台', '新闻资讯', '国际新闻·谈话', '交通广播', '文艺·生活', '财经', '综合·其他', '不存在的分类"><img src=x onerror=alert(1)>']) {
    const t = Logos.tone({ c, n: 'x', u: ['http://a/1'] });
    assert.match(t, /^[a-z]+$/, `tone「${t}」越出固定枚举`);
  }
});

console.log('[P3 外框] station-logo 统一外框（§4.2/§6.10：双布局同构，坏图/无图同框同色）');
ok('visual() 恒包 .station-logo[data-tone] 外框 + aria-hidden（有图/无图同一结构）', () => {
  const noImg = Logos.visual({ c: '华语音乐', n: '动感 101', u: ['http://a/1'] });
  assert.match(noImg, /^<span class="station-logo" data-tone="green" aria-hidden="true">/);
  assert.ok(noImg.includes('<span class="logo ph">动</span>'), '首字兜底缺失（剥 [国别] 后首字符大写）');
  const withImg = Logos.visual({ c: '欧美音乐', n: 'BBC Radio', l: 'http://img/a.png', u: ['http://a/2'] });
  assert.match(withImg, /^<span class="station-logo" data-tone="blue" aria-hidden="true">/);
  assert.ok(withImg.includes('<img class="logo" src="http://img/a.png" alt="" loading="lazy"'), 'img 形态变化');
  assert.ok(withImg.includes('onerror="Logos.phf(this)"'), '坏图回退链保持');
});
ok('img() 同款外框（Logos.img 直用点不脱框）', () => {
  const h = Logos.img({ c: '财经', n: '第一财经', l: 'http://img/b.png', u: ['http://a/3'] });
  assert.match(h, /^<span class="station-logo" data-tone="gold" aria-hidden="true"><img class="logo"/);
  assert.strictEqual(Logos.img({ c: '财经', n: '无图台', u: ['http://a/4'] }), ''); // 无 URL 仍回空串（visual 负责兜底）
});
ok('phf() 坏图只换内层节点：不再带 inline 底色（改由外框 data-tone CSS 上色，同框同色）', () => {
  let replaced = null;
  const fake = { dataset: { ch: 'B' }, replaceWith(sp) { replaced = sp; } };
  Logos.phf(fake);
  assert.strictEqual(replaced.className, 'logo ph');
  assert.strictEqual(replaced.textContent, 'B');
  assert.ok(!replaced.style.background, '兜底 span 不得再带 inline 背景（旧 hash 色相残留会压过 tone）');
  assert.strictEqual(replaced.getAttribute('aria-hidden'), 'true');
});
ok('首字兜底：首个 Unicode 字符大写、剥 [国别] 后缀、空名 ？ 兜底', () => {
  assert.ok(Logos.visual({ c: '新闻资讯', n: '环球资讯广播 [CN]', u: ['http://a/5'] }).includes('环</span>'), '剥 [国别] 后首字');
  assert.ok(Logos.visual({ c: '欧美音乐', n: 'jazz radio', u: ['http://a/6'] }).includes('J</span>'), '首字符大写');
  assert.ok(Logos.visual({ c: '综合·其他', n: '', u: ['http://a/7'] }).includes('?</span>'), '空名 ？ 兜底');
});

// —— app.js：剥尾部 boot 块取顶层纯函数（test/ui-scope.js 同法）——
const { sandbox, uiPhaseRunning } = (() => {
  const src = fs.readFileSync(path.join(UP, 'app.js'), 'utf8');
  const m = src.match(/\nif \(typeof document !== 'undefined'\) App\.boot\(\);[\s\S]*$/);
  assert(m, 'app.js 尾部 boot 块可剥离');
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(src.slice(0, m.index) + '\nthis.uiPhaseRunning = uiPhaseRunning;', sandbox);
  return { sandbox, uiPhaseRunning: sandbox.uiPhaseRunning };
})();

console.log('[P3 phase] 唱片旋转判定 uiPhaseRunning（§6.10：仅真实 playing×可见×未减动效）');
ok('playing + 可见 + 未减动效 → 转；其余四相一律静止', () => {
  assert.strictEqual(uiPhaseRunning('playing', false, false), true);
  assert.strictEqual(uiPhaseRunning('connecting', false, false), false);
  assert.strictEqual(uiPhaseRunning('buffering', false, false), false); // 缓冲≠实际出声
  assert.strictEqual(uiPhaseRunning('paused', false, false), false);
  assert.strictEqual(uiPhaseRunning('idle', false, false), false);
  assert.strictEqual(uiPhaseRunning('', false, false), false); // 初始/未知相位不转
});
ok('页面后台 / 系统减动效：即便真实 playing 也静止（§4.4）', () => {
  assert.strictEqual(uiPhaseRunning('playing', true, false), false);
  assert.strictEqual(uiPhaseRunning('playing', false, true), false);
  assert.strictEqual(uiPhaseRunning('playing', true, true), false);
});

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
