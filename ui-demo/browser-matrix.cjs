#!/usr/bin/env node
/* VRadio 响应式/无障碍/缩放浏览器矩阵（P2，docs/testing-strategy-2026-11.md §3 L3 响应式 + 无障碍两节）。
   pr-smoke.cjs 姊妹篇：自举隔离（git worktree 临时检出 HEAD → 被测实例 spawn 82xx 随机端口、cwd=临时检出、
   就绪探活）/ Z2 宿主两文件哈希终检 / Z3 browser/server/worktree 全回收清理门 / 提交态门（产物目录豁免）/
   资源噪音分流（合法 404 只记不判）/ 失败现场截图，全部同款骨架。
   矩阵落点（§3 L3）：
   · 视口十档 320/375/390/414/768/1023/1024/1280/1440/1920（p6 口径）——每档断言无横向溢出（scrollWidth ≤
     视口宽）、列表可见、header 高度合理（390 档 ≤130 两行，p6 A6 口径）；≤640 themeWrap 收进 lowfreq、
     >640 不收；1023/1024 桌面壳侧栏翻转断言；320/768/1024 三档留截图证据（其余不截图省产物）。
   · 200% 缩放两口径：viewport 1280 + deviceScaleFactor 2（任务口径，渲染倍率）+ 语义 200%（1280 窗口缩放
     200% ≡ CSS 布局视口减半至 640 × dsf2 渲染，Chromium 缩放语义）——无横向溢出 + 核心按钮可点。
   · forced-colors: active（Chromium headless 有模拟支持）——页面不白屏（body 背景/文字非 transparent 且
     相异）、主按钮文本可见；窄高窗口 300×700 无横向溢出。
   · 键盘完整路径：/ 聚焦搜索 → 输入 AND 过滤 → Enter 无副作用不崩 → Esc 清空 → ↓ 进列表首行 → 行 Enter
     点播 → ? 快捷键浮层开合 + 焦点回归（按实际行为断言：? 从 body 打开，kOpener=body，关后焦点停 body——
     无焦点丢进隐藏元素，p6 G5 口径）→ ←/→ 收藏间切台。
   · aria：themeBtn aria-label 三态（跟随系统/浅色/深色）+ aria-expanded 开合；维护面板 dialog 语义
     （role=dialog/aria-modal/aria-label 存在性，index.html 实测属性不虚构）；#keys role=dialog。
   产物：docs/test-reports/browser-matrix/validation.json（+ 指定视口截图）。
   Playwright 为外部工具（VRADIO_PLAYWRIGHT 指向安装路径），非仓库依赖。
   跑法：VRADIO_PLAYWRIGHT=".../playwright" node ui-demo/browser-matrix.cjs */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const output = path.resolve(__dirname, '../docs/test-reports/browser-matrix');
const ROOT = path.resolve(__dirname, '..');
fs.mkdirSync(output, { recursive: true });
const git = a => execSync('git ' + a, { cwd: ROOT, stdio: 'pipe' }).toString();
const sha1 = f => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch (_) { return 'absent'; } };
const hostSnap = () => ['data/store.json', 'my-radio.txt'].map(p => sha1(path.join(ROOT, p))).join('|'); // Z2 终检：宿主持久面
const httpGet = u => new Promise((resolve, reject) => { const r = http.get(u, res => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); r.setTimeout(2000, () => { r.destroy(); reject(new Error('timeout')); }); });
const pickPort = base => new Promise((resolve, reject) => { // base=82xx 应用实例 / 83xx 伪流（同 pr-smoke 口径）
  let p = base + Math.floor(Math.random() * 80), tried = 0;
  const tryOne = () => { if (++tried > 100) return reject(new Error(base + ' 端口段全忙')); const s = net.createServer();
    s.once('error', () => tryOne(p >= base + 79 ? (p = base) : ++p)); s.listen(p, '127.0.0.1', () => s.close(() => resolve(p))); };
  tryOne();
});
// 本地静音 WAV 流（8000Hz 单声道 16bit × 240s，定长 Content-Length）：键盘路径点播走它真实到 playing，
// 不打真实公网流（无头网络不可保证，且 hls.js 对真实源的 CORS 拒绝会以非资源 console error 污染 Z1）——
// 同 multi-tab.cjs 已验证手法；URL .mp3 走直流 variant
function wavBuf() { const rate = 8000, secs = 240, pcm = Buffer.alloc(rate * 2 * secs); const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); }
(async () => {
  let chromium = null; // Playwright 加载收口：缺工具也写 FAIL 报告 + 非零退出（环境失败分类，不伪报通过）
  try { chromium = require(process.env.VRADIO_PLAYWRIGHT || 'playwright').chromium; }
  catch (e) {
    const report = { capturedAt: new Date().toISOString(), result: 'FAIL', failure: '环境失败——Playwright 加载失败（VRADIO_PLAYWRIGHT 指向安装路径；CI 走 .ci/browser/）: ' + e.message, assertions: [], errors: [], resourceErrors: [], notes: [] };
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
    console.error('FAIL（环境失败）: Playwright 加载失败——', e.message); process.exitCode = 1; return;
  }
  const dirty = git('status --porcelain').split('\n').map(l => { const m = l.trim().match(/^(..)\s+(.+)$/); return m ? m[2].replace(/\"/g, '') : ''; })
    .filter(p => p && !p.startsWith('docs/test-reports/browser-matrix/')); // 提交态门：证据只采自提交态（本脚本产物目录豁免）
  if (dirty.length) { console.error('存在未提交改动（证据只采自提交态）：\n' + dirty.join('\n')); process.exitCode = 1; return; }
  const before = hostSnap();
  let browser = null, zbrowser = null, srv = null, sstream = null, wt = null, wtAlive = false, page = null;
  const pages = []; const report = { capturedAt: new Date().toISOString(), url: '', assertions: [], screenshots: [], errors: [], resourceErrors: [], notes: [], matrix: {} };
  const check = (name, ok) => { assert(ok, name); report.assertions.push(name); console.log('  ✓', name); };
  const note = t => report.notes.push(t);
  const failShot = async (p, name) => { try { if (p) { await p.screenshot({ path: path.join(output, name) }); note('失败现场截图: ' + name); } } catch (_) {} };
  try {
    const port = await pickPort(8200);
    const base = `http://127.0.0.1:${port}/`; report.url = base;
    wt = fs.mkdtempSync(path.join(os.tmpdir(), 'vradio-matrix-'));
    git(`worktree add --detach "${wt}" HEAD`); wtAlive = true;
    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1' };
    delete env.VR_TEST_Q_MAX;
    srv = spawn(process.execPath, ['server.js'], { cwd: wt, env, stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) { await new Promise(r => setTimeout(r, 100)); if (srv.exitCode !== null) break; try { ready = (await httpGet(base)) === 200; } catch (_) {} }
    if (!ready) throw new Error(`自举隔离服务未就绪（${base}）——端口冲突/服务启动异常`);
    const sport = await pickPort(8300);
    const fake = `http://127.0.0.1:${sport}/live.mp3`;
    const wav = wavBuf();
    sstream = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length), 'Access-Control-Allow-Origin': '*' }); res.end(wav); });
    await new Promise(r => sstream.listen(sport, '127.0.0.1', r));
    console.log(`自举隔离实例 ${base}（cwd=临时 worktree：data/my-radio 全落临时检出，宿主零接触）+ 本地静音流 ${fake}`);

    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' });
    page = await ctx.newPage(); pages.push(page);
    zbrowser = browser; // 同一 browser 实例开第二个 context（独立 storage，等效独立会话）
    const zctx = await zbrowser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark' }); // 200% 渲染口径
    const zpage = await zctx.newPage(); pages.push(zpage);
    for (const p of pages) {
      p.on('pageerror', e => report.errors.push('pageerror:' + e.message));
      p.on('console', m => { if (m.type() === 'error') { const t = m.text() || ''; (/^Failed to load resource/.test(t) ? report.resourceErrors : report.errors).push('console:' + t); } }); // 资源噪音分流（自举实例合法缺 my-radio.txt 404 只记不判，同 pr-smoke/p6 Z1 口径）
    }
    const waitBoot = p => p.waitForFunction(() => typeof App !== 'undefined' && App.state.stations.length > 50, null, { timeout: 20000 });
    const vis = sel => page.locator(sel).evaluate(el => !!el.offsetParent);
    const shot = async name => { await page.mouse.move(2, 2); await page.screenshot({ path: path.join(output, name) }); report.screenshots.push(name); };

    // —— [S] 启动（1280 桌面档）——
    console.log('[S] 启动（1280×800 桌面壳）');
    await page.goto(base); await page.reload(); await waitBoot(page); await page.waitForTimeout(400);
    check('S1 全库装配 >50 台', await page.evaluate(() => App.state.stations.length > 50));
    check('S2 桌面壳生效（uiRefresh ≥1024 侧栏可见）', await vis('.desktop-sidebar'));
    check('S3 启动零 pageerror', report.errors.length === 0);
    await zpage.goto(base); await zpage.reload(); await waitBoot(zpage); await zpage.waitForTimeout(400);

    // —— [V] 视口十档矩阵（横向溢出/列表可见/header 高度/断点语义）——
    console.log('[V] 视口矩阵 320/375/390/414/768/1023/1024/1280/1440/1920');
    const widths = [320, 375, 390, 414, 768, 1023, 1024, 1280, 1440, 1920];
    report.matrix.viewports = {};
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(450); // 断点 CSS/懒渲染 settle
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth,
        hh: Math.round(document.querySelector('header').getBoundingClientRect().height),
        visN: App.visible().length, rows: document.querySelectorAll('#list [data-fn]').length,
        low: document.getElementById('lowfreq').contains(document.getElementById('themeWrap')),
        side: !!document.querySelector('.desktop-sidebar') && !!document.querySelector('.desktop-sidebar').offsetParent }));
      report.matrix.viewports[w] = m;
      check(`V${w} 无横向溢出（scrollWidth ${m.sw} ≤ ${w}）`, m.sw <= w);
      check(`V${w} 列表可见（范围内 ${m.visN} 台 / 已渲染 ${m.rows} 行）`, m.visN > 0 && m.rows > 0);
      check(`V${w} header 高度合理（${m.hh}px，界 ${w <= 414 ? 200 : 160}）`, m.hh >= 24 && m.hh <= (w <= 414 ? 200 : 160));
      if (w === 390) check(`V390 header 两行口径 ≤130px（p6 A6；实测 ${m.hh}px）`, m.hh <= 130);
      if (w <= 640) check(`V${w} themeWrap 收进 lowfreq（≤640，p6 A8 口径）`, m.low);
      if (w > 640 && w < 1024) check(`V${w} themeWrap 不在 lowfreq（>640）`, !m.low);
      if (w === 1023) check('V1023 紧凑布局（桌面壳侧栏隐藏）', !m.side);
      if (w === 1024) check('V1024 桌面壳生效（侧栏可见——断点翻转）', m.side);
      if (w === 320 || w === 768 || w === 1024) await shot(`${w}.png`);
    }
    const hs = widths.map(w => w + ':' + report.matrix.viewports[w].hh).join(' ');
    note(`各档 header 实测高度：${hs}`);

    // —— [Z] 200% 缩放（渲染倍率 + 语义两口径，独立 dsf2 context）——
    console.log('[Z] 200% 缩放（dsf2@1280 + 语义 640 布视口）');
    await zpage.setViewportSize({ width: 1280, height: 800 });
    await zpage.waitForTimeout(400);
    const z1 = await zpage.evaluate(() => ({ sw: document.documentElement.scrollWidth, dpr: devicePixelRatio }));
    check(`Z1 dsf2@1280 无横向溢出（scrollWidth ${z1.sw} ≤ 1280，DPR ${z1.dpr}）`, z1.sw <= 1280 && z1.dpr === 2);
    await zpage.click('#themeBtn');
    check('Z2 200% 渲染下主题按钮可点（三选菜单弹出）', await zpage.locator('#themeMenu [data-theme-v]').count() === 3 && await zpage.evaluate(() => !document.getElementById('themeMenu').hidden));
    await zpage.keyboard.press('Escape');
    await zpage.click('#listBtn');
    check('Z3 200% 渲染下视图切换可点（aria-pressed 翻转）', await zpage.evaluate(() => document.getElementById('listBtn').getAttribute('aria-pressed') === 'true' && App.state.view === 'list'));
    await zpage.click('#gridBtn');
    // 语义 200%：1280 窗口 Ctrl+缩放 200% ≡ CSS 布局视口 640 + 渲染倍率 2（Chromium 缩放=同时改 CSS 视口与倍率）
    await zpage.setViewportSize({ width: 640, height: 800 });
    await zpage.waitForTimeout(400);
    const z2 = await zpage.evaluate(() => ({ sw: document.documentElement.scrollWidth, hh: Math.round(document.querySelector('header').getBoundingClientRect().height) }));
    check(`Z4 语义 200%（640 布局视口）无横向溢出（scrollWidth ${z2.sw} ≤ 640）`, z2.sw <= 640);
    check(`Z5 语义 200% 搜索框可用 + header 合理（${z2.hh}px）`, await zpage.evaluate(() => !!document.getElementById('q').offsetParent) && z2.hh >= 24 && z2.hh <= 200);

    // —— [FC] forced-colors: active（Chromium headless 模拟支持）——
    console.log('[FC] forced-colors');
    await zpage.emulateMedia({ forcedColors: 'active' });
    await zpage.waitForTimeout(300);
    const fc = await zpage.evaluate(() => { const cs = el => getComputedStyle(el); const b = cs(document.body), t = cs(document.querySelector('#themeBtn'));
      return { bg: b.backgroundColor, fg: b.color, btn: t.color, btnVisible: !!document.getElementById('themeBtn').offsetParent }; });
    check('FC1 body 背景非透明（页面不白屏）', fc.bg !== 'rgba(0, 0, 0, 0)');
    check('FC2 body 文字色非透明且与背景相异（文本可见）', fc.fg !== 'rgba(0, 0, 0, 0)' && fc.fg !== fc.bg);
    check('FC3 主按钮文本色非透明（themeBtn 可读）', fc.btn !== 'rgba(0, 0, 0, 0)');
    note(`forced-colors 实测：body bg=${fc.bg} fg=${fc.fg} themeBtn=${fc.btn}`);
    await zpage.emulateMedia({ forcedColors: null });

    // —— [N] 窄高窗口 300×700 ——
    console.log('[N] 窄高窗口 300×700');
    await page.setViewportSize({ width: 300, height: 700 });
    await page.waitForTimeout(400);
    check('N1 300×700 无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= 300));

    // —— [K] 键盘完整路径（L3 无障碍键盘项）——
    console.log('[K] 键盘完整路径');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
    await page.keyboard.press('/'); // 全局快捷键：聚焦搜索
    check('K1 / 聚焦搜索框', await page.evaluate(() => document.activeElement === document.getElementById('q')));
    await page.keyboard.type('广播');
    await page.waitForTimeout(450); // 120ms 输入防抖 + 整表重渲
    const kw = await page.evaluate(() => { const k = App.state.keyword; const manual = App.state.stations.filter(s => !s.hidden && (s.n + ' ' + s.c).toLowerCase().includes('广播')).length; return { k, vis: App.visible().length, manual }; });
    check(`K2 输入即过滤（keyword='${kw.k}'，界面 ${kw.vis} = 含「广播」口径 ${kw.manual}）`, kw.k === '广播' && kw.vis === kw.manual && kw.vis > 0);
    await page.keyboard.press('Enter'); // #q 无 Enter 专属行为——不崩、状态不漂
    await page.waitForTimeout(200);
    check('K3 Enter 不崩、筛选态不漂（pageerror 零 + keyword 保持）', report.errors.length === 0 && await page.evaluate(() => App.state.keyword === '广播'));
    await page.keyboard.press('Escape'); // #q Esc = 清空
    await page.waitForTimeout(300);
    check('K4 Esc 清空搜索', await page.evaluate(() => App.state.keyword === '' && document.getElementById('q').value === ''));
    // 点播目标劫持为本地静音流（temp 实例内存态；真实流不可保证且 CORS 拒绝会污染 Z1）——行 Enter 后真实到 playing
    await page.evaluate(f => { const s = App.visible()[0]; s.u = [f]; s.mo = [0]; s.moManual = false; }, fake);
    await page.keyboard.press('ArrowDown'); // #q ↓ = 进列表首行（P2-5）
    check('K5 ↓ 焦点进列表首行（role=listitem 行）', await page.evaluate(() => { const ae = document.activeElement; return !!ae && ae.closest('#list') && ae.getAttribute('role') === 'listitem'; }));
    await page.keyboard.press('Enter'); // 行 Enter = 点播（行键盘语义 2795）
    await page.waitForFunction(() => App.phase === 'playing', null, { timeout: 15000 });
    check('K6 行 Enter 点播（本地流真实到 playing）', await page.evaluate(() => Player.station !== null));
    await page.evaluate(() => Player.stop());
    await page.waitForFunction(() => App.phase === 'idle', null, { timeout: 5000 });
    // ？快捷键浮层：焦点先回 body（blur 行焦点），? 从 body 打开——kOpener=body，关后焦点停 body（实际行为断言）
    await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    await page.keyboard.press('?');
    await page.waitForTimeout(200);
    check('K7 ? 出快捷键帮助浮层（role=dialog + aria-label）', await page.evaluate(() => !document.getElementById('keys').hidden
      && document.getElementById('keys').getAttribute('role') === 'dialog' && !!document.getElementById('keys').getAttribute('aria-label')));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('K8 Esc 收浮层 + 焦点回归合理（activeElement=body 或可见元素，无焦点丢进隐藏元素——p6 G5 口径）', await page.evaluate(() => { const ae = document.activeElement; return document.getElementById('keys').hidden && (!ae || ae === document.body || !!ae.offsetParent); }));
    const fav = await page.evaluate(f => { const cnt = {}; for (const s of App.state.stations) cnt[s.n] = (cnt[s.n] || 0) + 1;
      const s = App.state.stations.find(x => !x.hidden && x.health !== 'dead' && cnt[x.n] === 1 && x !== App.visible()[0]);
      s.u = [f]; s.mo = [0]; s.moManual = false; App.toggleFav(s); return keyOf(s); }, fake);
    await page.keyboard.press('ArrowRight'); // ←/→ 收藏间切台（A-5）
    await page.waitForFunction(() => App.phase === 'playing', null, { timeout: 15000 });
    const kf = await page.evaluate(k => Player.station ? keyOf(Player.station) : '', fav);
    check('K7b → 在收藏间切台（当前台 = 刚收藏台，本地流真实到 playing）', kf === fav);
    await page.evaluate(() => Player.stop());
    await page.waitForFunction(() => App.phase === 'idle', null, { timeout: 5000 });

    // —— [A] aria 断言（themeBtn 三态 + aria-expanded + 维护面板 dialog 语义）——
    console.log('[A] aria 断言');
    await page.click('#themeBtn');
    await page.click('#themeMenu [data-theme-v="auto"]');
    await page.waitForTimeout(150);
    check('A1 themeBtn aria-label=主题：跟随系统', await page.evaluate(() => document.getElementById('themeBtn').getAttribute('aria-label') === '主题：跟随系统'));
    await page.click('#themeBtn'); await page.click('#themeMenu [data-theme-v="light"]');
    await page.waitForTimeout(150);
    check('A2 浅色档 aria-label + menu aria-pressed 同步', await page.evaluate(() => document.getElementById('themeBtn').getAttribute('aria-label') === '主题：浅色'
      && [...document.querySelectorAll('#themeMenu [data-theme-v]')].every(b => b.getAttribute('aria-pressed') === String(b.dataset.themeV === 'light'))));
    await page.click('#themeBtn');
    check('A3 菜单开 → themeBtn aria-expanded=true', await page.evaluate(() => document.getElementById('themeBtn').getAttribute('aria-expanded') === 'true'));
    await page.click('#themeMenu [data-theme-v="dark"]');
    await page.waitForTimeout(150);
    check('A4 深色档 aria-label + 菜单收起 aria-expanded=false', await page.evaluate(() => document.getElementById('themeBtn').getAttribute('aria-label') === '主题：深色'
      && document.getElementById('themeBtn').getAttribute('aria-expanded') === 'false'));
    await page.click('#sideManage');
    await page.waitForTimeout(400);
    const md = await page.evaluate(() => { const b = document.querySelector('#manage .mbox'); return b ? { role: b.getAttribute('role'), modal: b.getAttribute('aria-modal'), label: b.getAttribute('aria-label') } : null; });
    check('A5 维护面板 dialog 语义（role=dialog + aria-modal=true + aria-label 存在）', !!md && md.role === 'dialog' && md.modal === 'true' && !!md.label);
    check('A6 维护面板三分区可达', (await page.locator('#mTabC').count()) && (await page.locator('#mTabS').count()) && (await page.locator('#mTabD').count()));
    await page.evaluate(() => { const x = document.getElementById('mClose') || document.getElementById('manageClose'); if (x) x.click(); });
    await page.waitForTimeout(300);
    check('A7 维护面板关闭（页面回列表态）', await page.evaluate(() => document.getElementById('manage').hidden));
    await page.evaluate(() => { Store.set('radio.theme', 'dark'); App.loadUi3(); }); // 恢复深色基线（随后的断言不依赖主题，纯收尾）

    check('Z1 全程零 pageerror / 非资源 console error（双 context 双页）', report.errors.length === 0);
    note(`资源加载噪音 ${report.resourceErrors.length} 条（自举实例合法 404 只记不判，同 pr-smoke 分流口径）`);
    note('未覆盖项（headless 不可靠替代，方案 §3 L3 明确保留人工）：Safari/macOS 实机、NVDA/VoiceOver 读屏语义、Firefox/Edge 夜间矩阵、真实音频输出（无头静音）；200% 缩放为 dsf2+语义双口径近似（真实 Ctrl+缩放含字体 hinting 差异）');
  } catch (e) {
    report.result = 'FAIL'; report.failure = String(e && e.stack || e); process.exitCode = 1;
    console.error('FAIL:', String(e && e.message || e));
    if (pages[0]) await failShot(pages[0], 'failure.png').catch(() => {});
  }
  // —— 清理门（Z2/Z3，同 pr-smoke）：任何泄漏置 FAIL 非零退出 ——
  const cleanupErr = []; let srvGone = !srv, streamGone = !sstream, wtGone = !wtAlive;
  try { if (browser) await browser.close(); } catch (e) { cleanupErr.push('browser:' + String(e.message || e).split('\n')[0]); }
  if (sstream) { try { sstream.close(() => {}); if (sstream.closeAllConnections) sstream.closeAllConnections(); streamGone = true; } catch (e) { cleanupErr.push('stream:' + String(e.message || e).split('\n')[0]); } }
  if (srv) { try { srv.kill(); await new Promise(r => { srv.once('exit', () => { srvGone = true; r(); }); setTimeout(r, 5000); }); if (!srvGone) cleanupErr.push('server: kill 后 5s 无退出信号'); } catch (e) { srvGone = false; cleanupErr.push('server:' + String(e.message || e).split('\n')[0]); } }
  if (wtAlive) { try { git(`worktree remove --force "${wt}"`); wtGone = true; }
    catch (_) { await new Promise(r => setTimeout(r, 800)); try { git(`worktree remove --force "${wt}"`); wtGone = true; }
      catch (e2) { cleanupErr.push('worktree remove 两连败:' + String(e2.message || e2).split('\n')[0]); } } }
  if (report.result !== 'FAIL') report.result = 'PASS';
  if (hostSnap() === before) report.notes.push('Z2 宿主 data/store.json + my-radio.txt 运行前后哈希不变');
  else { report.result = 'FAIL'; report.failure = (report.failure || '') + ' Z2 宿主持久面被改动: ' + before + ' → ' + hostSnap(); process.exitCode = 1; }
  if (cleanupErr.length === 0 && srvGone && wtGone && streamGone) report.notes.push('Z3 清理失败门：browser/伪流服务/server/worktree 全回收（零泄漏成立）');
  else { report.result = 'FAIL'; report.failure = (report.failure || '') + ' Z3 清理失败门未过: ' + cleanupErr.join(' | ') + (srvGone ? '' : ' [server未退出]') + (wtGone ? '' : ' [worktree未移除]') + (streamGone ? '' : ' [伪流未关闭]'); process.exitCode = 1; }
  fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${report.result}: ${report.assertions.length} 断言 + ${report.screenshots.length} 截图（报告 ${path.relative(ROOT, path.join(output, 'validation.json'))}）`);
})();
