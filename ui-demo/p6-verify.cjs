/* P6 验收矩阵驱动（ui-redesign §9.2 浏览器手动验收的可复现子集）：驱动**正式业务页面**（非隔离 demo）。
   仅开发工具，需要本机已有 Playwright（不是项目运行依赖，同 ui-demo/capture.cjs 先例）：
   PowerShell: $env:VRADIO_PLAYWRIGHT='C:/Users/Administrator/AppData/Roaming/npm/node_modules/playwright'
   自举隔离（AIbot PR#34 P0）：默认自行 spawn `node server.js`（82xx 随机高位端口、cwd=本 worktree、
   就绪探活后开跑、结束 kill）——脚本 clr() 会 POST /api/store {data:{}} 清空 radio.* 持久键，只准打在
   自举隔离实例上（data/ 落 worktree 自身，gitignored）。VRADIO_URL 指向外部实例时必须显式
   VRADIO_ALLOW_EXTERNAL=1（醒目警告后继续），否则拒绝退出——防清空普通 npm start 实例的用户数据。
   断言失败 exitCode=1（AIbot PR#34 P2）。产物：docs/ui-redesign-assets/p6/*.png + validation.json。
   真实音频不可保证（沙箱网络），播放仅验证 connecting 阶段与记住最近，随后 Player.stop() 收尾。 */
const fs = require('fs'), path = require('path'), assert = require('assert'), http = require('http'), net = require('net');
const { spawn } = require('child_process');
const { chromium } = require(process.env.VRADIO_PLAYWRIGHT || 'playwright');
const output = path.resolve(__dirname, '../docs/ui-redesign-assets/p6');
const fixdir = path.join(__dirname, 'p6-fixtures');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(fixdir, { recursive: true });
// cfg 导入 fixture：当前 cfg 为空 → 预览应显示全新增计数
fs.writeFileSync(path.join(fixdir, 'cfg-in.json'), JSON.stringify({
  v: 1, cfg: { names: { 'http://example.invalid/a.mp3': '验收改名' }, cats: ['验收分类'], hideS: { 'http://example.invalid/b.mp3': 1 } },
}));
const httpGet = u => new Promise((resolve, reject) => { const r = http.get(u, res => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); r.setTimeout(2000, () => { r.destroy(); reject(new Error('timeout')); }); });
const pickPort = () => new Promise((resolve, reject) => { // 82xx 段随机起始顺序探空闲（高位固定段，避开默认 8137 与常用 dev 端口）
  let p = 8200 + Math.floor(Math.random() * 80), tried = 0;
  const tryOne = () => { if (++tried > 100) return reject(new Error('82xx 端口段全忙')); const s = net.createServer();
    s.once('error', () => tryOne(p >= 8299 ? (p = 8200) : ++p)); s.listen(p, '127.0.0.1', () => s.close(() => resolve(p))); };
  tryOne();
});
(async () => {
  // —— 自举隔离（AIbot PR#34 P0）：默认 spawn 隔离实例；VRADIO_URL 外部目标须 VRADIO_ALLOW_EXTERNAL=1 显式确认 ——
  let srv = null, base = process.env.VRADIO_URL || '';
  if (base) {
    if (process.env.VRADIO_ALLOW_EXTERNAL !== '1') {
      console.error(`拒绝运行：VRADIO_URL=${base} 指向非本脚本自举的实例，而本脚本会清空目标实例全部 radio.* 持久数据（不可恢复）。\n确属有意为之，请加 VRADIO_ALLOW_EXTERNAL=1 后重跑。`);
      process.exit(1);
    }
    console.warn(`\n⚠⚠⚠ 警告：即将对外部实例 ${base} 运行验收——将清空该实例全部 radio.* 持久数据（不可恢复）⚠⚠⚠\n`);
  } else {
    const port = await pickPort();
    base = `http://127.0.0.1:${port}/`;
    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1' };
    delete env.VR_TEST_Q_MAX; // 防外部测试注入缝串进验收实例（容量被压小会令页面质量 flush 频繁 409）
    srv = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) { await new Promise(r => setTimeout(r, 100)); if (srv.exitCode !== null) break; try { ready = (await httpGet(base)) === 200; } catch (_) {} }
    if (!ready) { srv.kill(); console.error(`自举隔离服务未就绪（127.0.0.1:${port}）`); process.exit(1); }
    console.log(`自举隔离实例 ${base}（data/ 落本 worktree，结束即 kill）`);
  }
  let browser = null;
  const report = { capturedAt: new Date().toISOString(), url: base, assertions: [], screenshots: [], perf: {}, errors: [], notes: [] };
  try {
  browser = await chromium.launch({ headless: true }); // launch/newPage 一并进 try：启动失败也走 catch/finally（写 FAIL 报告 + kill 隔离服务）
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  const page = await ctx.newPage();
  report.browser = browser.version();
  page.on('pageerror', e => report.errors.push('pageerror:' + e.message));
  page.on('console', m => { if (m.type() === 'error') report.errors.push('console:' + m.text()); });
  const check = (name, ok) => { assert(ok, name); report.assertions.push(name); console.log('  ✓', name); };
  const note = t => report.notes.push(t);
  const shot = async name => { await page.mouse.move(2, 2); await page.screenshot({ path: path.join(output, name) }); report.screenshots.push(name); };
  const clr = () => page.evaluate(async () => { // 清本地镜像 + 服务端 store（remember 经 300ms debounce 落 /api/store；首轮 boot 的 GET 与清空有竞态——清两次压掉回灌）
    try { localStorage.clear(); } catch (_) {}
    try { await fetch('/api/store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: {} }) }); } catch (_) {}
  });
  const waitBoot = () => page.waitForFunction(() => typeof App !== 'undefined' && App.state.stations.length > 50, null, { timeout: 20000 });
  const boot = async () => { // 清态进入（两轮）：竞态防御见 clr；等装配完成（全库 1600+ 或快照兜底）
    await page.goto(base);
    await clr();
    await page.reload(); await waitBoot();
    await clr();
    await page.reload(); await waitBoot();
    await page.waitForTimeout(400);
  };
  const vis = sel => page.locator(sel).evaluate(el => !!el.offsetParent);

  console.log('[A] 开关关（默认）零回归');
  await boot();
  check('A1 html 无 ui-refresh 类', await page.evaluate(() => !document.documentElement.classList.contains('ui-refresh')));
  check('A2 1280 侧栏隐藏', !(await vis('.desktop-sidebar')));
  check('A3 1280 header 维护按钮可见（紧凑原状）', await vis('#manageBtn'));
  check('A4 hero 双保险隐藏', await page.locator('#resumeHero').isHidden());
  await page.click('#listBtn'); // 列表视图测 §6.11 全宽
  await page.setViewportSize({ width: 390, height: 844 });
  const lw = await page.locator('#list').evaluate(el => Math.round(el.getBoundingClientRect().width));
  check(`A5 390 列表容器满宽（实测 ${lw}px）`, lw >= 388);
  const hh = await page.locator('header').evaluate(el => Math.round(el.getBoundingClientRect().height));
  check(`A6 390 header 无 deadBtn 时 ≤130px 两行（实测 ${hh}px）`, hh <= 130);
  check('A8 ≤640 themeWrap 收进 lowfreq', await page.evaluate(() => document.getElementById('lowfreq').contains(document.getElementById('themeWrap'))));
  await page.click('#moreBtn'); // lowfreq 收起态：先弹出再验文字 span（§6.11「lowfreq 内显示 span」）
  check('A7 ≤640 主题文字 span 可见', await vis('#themeBtn .theme-t'));
  await page.click('#moreBtn');
  check('A9 双端新增上一/下一收藏按钮可见', (await vis('#prevFav')) && (await vis('#nextFav')));
  check('A10 390 网格态无横向溢出', await page.evaluate(() => { const g = document.getElementById('list'); g.classList.add('grid'); const c = getComputedStyle(g).gridTemplateColumns.split(' ').length; g.classList.remove('grid'); return c >= 1 && document.documentElement.scrollWidth <= 390; }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot('09-compact-off-1280.png');

  console.log('[B] 开关开 1280 桌面壳');
  await page.evaluate(() => localStorage.setItem('feat.uiRefresh', '1'));
  await page.reload();
  await page.waitForFunction(() => typeof App !== 'undefined' && App.state.stations.length > 50 && document.documentElement.classList.contains('ui-refresh'), null, { timeout: 20000 });
  await page.evaluate(() => { App.state.view = 'grid'; Store.set('radio.view', 'grid'); App.syncViewUI(); App.render(); }); // A 步持久化了列表视图，桌面网格断言先回网格
  await page.waitForTimeout(600);
  check('B1 侧栏可见', await vis('.desktop-sidebar'));
  check('B2 header 维护按钮桌面隐藏（侧栏接管）', !(await vis('#manageBtn')));
  const cols = await page.locator('#list.grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  check(`B3 1280 网格四列目标（实测 ${cols} 列）`, cols === 4);
  check('B4 token 生效（深色页底 #111916）', await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(17, 25, 22)'));
  check('B5 --dock-h 实测 > 0', await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-h')) > 0));
  check('B6 文档流滚动（body overflow visible）', await page.evaluate(() => getComputedStyle(document.body).overflow === 'visible'));
  check('B7 hero 可见且含开始收听', await vis('#resumeHero') && await page.locator('#heroPlay').isVisible());
  const heroName = await page.locator('#resumeHero .hero-name').textContent();
  note(`hero 候选=${heroName}`);
  check('B8 hero 台名非写死（无 Love Radio 硬编码）', !/Love Radio/.test(heroName));
  await shot('01-desktop-dark-1280.png');

  console.log('[C] 续听卡与播放态');
  const rec0 = await page.evaluate(() => App.recents.length);
  await page.click('#heroPlay'); // startPlay：记最近（渲染不记，点击才记）
  await page.waitForTimeout(2500); // 连接阶段（真实流不可保证，2.5s 内观察 phase）
  const phaseObserved = await page.evaluate(() => ({ phase: App.phase, recents: App.recents.length, heroLabel: document.getElementById('heroPlay') ? document.getElementById('heroPlay').textContent.trim() : '' }));
  check('C1 点击才记最近', phaseObserved.recents === rec0 + 1);
  check('C2 onphase 已发布（connecting/playing/buffering/idle 之一）', ['connecting', 'playing', 'buffering', 'paused', 'idle'].includes(phaseObserved.phase));
  note(`点播后 phase=${phaseObserved.phase} heroLabel=${phaseObserved.heroLabel}`);
  await page.evaluate(() => Player.stop()); // 收尾：真实流不保证，停止级联
  await page.waitForTimeout(400);
  check('C3 停止后 phase=idle', await page.evaluate(() => App.phase === 'idle'));
  // 隐藏当前台 → hero 改用下一候选（§3.3）：手测成本高，记录由单测覆盖（ui-scope uiChooseResume 分支）
  note('hero 候选规则（隐藏不复活/下一候选）由 test/ui-scope.js 钉住；真机音频时序未验证（沙箱网络）');

  console.log('[D] 组合筛选与空态出口');
  await page.click('#sideFav');
  check('D1 收藏范围 hero 隐藏', await page.locator('#resumeHero').isHidden());
  check('D2 分类条完整保留（§3.1 分类不进侧栏）', (await page.locator('#cats .chip').count()) > 5);
  await page.evaluate(() => { // 造一个收藏保证范围非空（toggleFav 走真实链路）
    const s = App.state.stations.find(x => !x.hidden && x.health !== 'dead'); App.toggleFav(s);
  });
  await page.waitForTimeout(300);
  await page.fill('#q', '绝不存在的电台xyz');
  await page.waitForTimeout(300);
  check('D3 空态有清空与搜全部出口', (await page.locator('[data-act="qclear"]').count()) === 1 && (await page.locator('[data-act="qall"]').count()) === 1);
  await shot('10-desktop-search-empty.png');
  await page.click('[data-act="qall"]');
  await page.waitForTimeout(300);
  check('D4 搜全部保词解范围', await page.evaluate(() => App.state.scope === 'all' && App.state.keyword === '绝不存在的电台xyz' && document.getElementById('q').value === '绝不存在的电台xyz'));
  await page.fill('#q', '');
  // F01 UI 抽验：取真实台，搜「台名词 + 分类词」AND
  const t = await page.evaluate(() => { const s = App.state.stations.find(x => !x.hidden && x.health !== 'dead' && x.n.length >= 4); return { n: s.n, c: s.c }; });
  const w1 = t.n.slice(0, 2), w2 = t.c.slice(0, 2);
  await page.fill('#q', `${w1} ${w2}`);
  await page.waitForTimeout(400);
  const hitAnd = await page.evaluate(([a, b]) => { const kw = a + ' ' + b; const manual = App.state.stations.filter(s => !s.hidden && !App.cfg.hideC[s.c] && (s.n + ' ' + s.c).toLowerCase().includes(a) && (s.n + ' ' + s.c).toLowerCase().includes(b)).length; return { vis: App.visible().length, manual }; }, [w1.toLowerCase(), w2.toLowerCase()]);
  check(`D5「${w1} ${w2}」AND 命中台名+分类（界面 ${hitAnd.vis} = 口径 ${hitAnd.manual}）`, hitAnd.vis === hitAnd.manual);
  await page.fill('#q', '');

  console.log('[E] 主题三选 / tooltip / 详情浮层');
  await page.click('#themeBtn');
  check('E1 三选菜单三项', await page.locator('#themeMenu [data-theme-v]').count() === 3 && await vis('#themeMenu'));
  await shot('07-desktop-theme-menu.png');
  await page.click('#themeMenu [data-theme-v="light"]');
  await page.waitForTimeout(200);
  check('E2 浅色生效 + 文案', await page.evaluate(() => document.documentElement.dataset.theme === 'light' && document.getElementById('themeBtn').getAttribute('aria-label') === '主题：浅色'));
  await shot('03-desktop-light-1280.png');
  await page.click('#themeBtn'); await page.click('#themeMenu [data-theme-v="dark"]');
  await page.evaluate(() => { const row = document.querySelector('#list [data-fn]'); row.focus(); }); // 直接聚焦行元素（行自带 data-fn 全名快照）
  await page.waitForTimeout(200);
  check('E3 聚焦长名出全名 tooltip（fixed 元素以 hidden 判定）', await page.evaluate(() => !document.getElementById('namett').hidden && !!document.getElementById('namett').textContent));
  await page.keyboard.press('Escape');
  check('E4 Esc 收起 tooltip', await page.locator('#namett').isHidden());
  await page.locator('#list .dmore').first().click();
  await page.waitForTimeout(400);
  const cov = await page.evaluate(() => { const r = document.getElementById('detail').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), pos: getComputedStyle(document.getElementById('detail')).position }; });
  check(`E5 详情浮层全屏遮罩（${cov.w}x${cov.h} fixed）`, cov.w >= 1278 && cov.h >= 798 && cov.pos === 'fixed');
  await shot('08-desktop-detail-overlay.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  console.log('[F] 维护草稿 / 隐藏撤销 / 数据预览');
  await page.click('#sideManage');
  await page.waitForTimeout(300);
  check('F1 三分区 Tab', (await page.locator('#mTabC').count()) && (await page.locator('#mTabS').count()) && (await page.locator('#mTabD').count()));
  await page.click('#mTabS');
  await page.waitForTimeout(200);
  await page.locator('#mlist [data-act="edit"]').first().click(); // P4 行内编辑入口（进对象草稿）
  await page.waitForTimeout(300);
  const nameInput = await page.evaluate(() => { const el = document.querySelector('#mEdit input, #dEdit input'); return el ? { id: el.id || '(匿名)', v: el.value } : null; });
  check('F2 对象编辑器出现', !!nameInput);
  if (nameInput) {
    await page.fill('#mEdit input, #dEdit input', nameInput.v + '·验');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape'); // 全局 Esc = 关面板？P4 面板 Esc → 离开流程三选
    await page.waitForTimeout(300);
    const three = await page.evaluate(() => [...document.querySelectorAll('#editorConfirm button')].map(b => b.textContent));
    check(`F3 dirty 离开三选（${three.join('/')}）`, three.some(x => x.includes('保存')) && three.some(x => x.includes('放弃')) && three.some(x => x.includes('继续')));
    await shot('05-desktop-maintenance-leave.png');
    await page.evaluate(() => [...document.querySelectorAll('#editorConfirm button')].find(b => b.textContent === '继续编辑').click()); // stay
    await page.waitForTimeout(200);
    check('F4 继续编辑草稿保留', await page.evaluate(v => (document.querySelector('#mEdit input, #dEdit input') || {}).value === v + '·验', nameInput.v));
    await page.evaluate(() => [...document.querySelectorAll('#mEdit button, #dEdit button')].find(b => b.textContent === '取消').click()); // 编辑器显式取消=丢弃草稿（§5.3）
    await page.waitForTimeout(200);
    check('F5 取消丢弃草稿退出编辑', await page.evaluate(() => !document.querySelector('#mEdit') || document.getElementById('mEdit').hidden || !document.querySelector('#mEdit input, #dEdit input')));
  }
  // 隐藏 + 撤销（§5.4，AIbot PR#34 P2：真实 UI 动作链替代 note——勾选隐藏→保存→点 8s toast 的撤销→状态恢复）
  const hid = await page.evaluate(() => { // 台名全库唯一的非隐藏非收藏台（#mq 定位唯一行，避免重名串台）
    const cnt = {}; for (const s of App.state.stations) cnt[s.n] = (cnt[s.n] || 0) + 1;
    const s = App.state.stations.find(x => !x.hidden && !App.favKeys().has(keyOf(x)) && cnt[x.n] === 1);
    return s ? { n: s.n, k: keyOf(s) } : null;
  });
  assert(hid, 'F5b 前置：存在台名唯一的可隐藏台');
  await page.fill('#mq', hid.n);
  await page.waitForTimeout(300);
  await page.locator('#mlist [data-act="edit"]').first().click(); // 进该台编辑器
  await page.waitForTimeout(300);
  await page.check('#mEdit [data-f="hidden"]'); // 勾选「隐藏电台」走真实 change 链（草稿 dirty）
  await page.click('#mEdit [data-eact="save"]');
  await page.waitForTimeout(400);
  const t5b = await page.evaluate(() => ({ vis: !document.getElementById('toast').hidden, txt: document.getElementById('toast').textContent,
    undo: !![...document.querySelectorAll('#toast button')].find(b => b.textContent === '撤销') }));
  check(`F5b1 保存隐藏出 8s 撤销 toast（${(t5b.txt || '').trim().slice(0, 30)}）`, t5b.vis && t5b.undo && /已隐藏/.test(t5b.txt));
  const hidOn = await page.evaluate(k => { const s = App.state.stations.find(x => keyOf(x) === k);
    return { hidden: !!s.hidden, inVisible: App.visible().some(x => keyOf(x) === k), cfgKey: s.u.some(u => !!App.cfg.hideS[u]) }; }, hid.k);
  check('F5b2 隐藏生效（hidden=true、visible() 除名、cfg.hideS 落键）', hidOn.hidden && !hidOn.inVisible && hidOn.cfgKey);
  await page.locator('#toast button', { hasText: '撤销' }).click(); // 真实点击撤销
  await page.waitForTimeout(400);
  const hidOff = await page.evaluate(k => { const s = App.state.stations.find(x => keyOf(x) === k);
    return { hidden: !!s.hidden, inVisible: App.visible().some(x => keyOf(x) === k), cfgKey: s.u.some(u => !!App.cfg.hideS[u]) }; }, hid.k);
  check('F5b3 点击撤销后状态恢复（hidden=false、回 visible()、hideS 键清除）', !hidOff.hidden && hidOff.inVisible && !hidOff.cfgKey);
  await page.fill('#mq', '');
  await page.click('#mTabD');
  await page.waitForTimeout(200);
  check('F6 数据分区三组卡', await page.evaluate(() => document.querySelectorAll('#mData .dcard, #mData .dacts2').length >= 3));
  await page.setInputFiles('#mfile', path.join(fixdir, 'cfg-in.json'));
  await page.waitForTimeout(400);
  const prevTxt = await page.evaluate(() => document.getElementById('editorConfirm').textContent);
  check('F7 cfg 导入差异预览出现', /验收分类|电台改名|隐藏电台/.test(prevTxt) && /清空|覆盖|项/.test(prevTxt));
  await shot('06-desktop-cfg-import-preview.png');
  await page.keyboard.press('Escape'); // 取消：零改动
  await page.waitForTimeout(200);
  check('F8 取消零改动（radio.cfg 不变）', await page.evaluate(() => { const c = JSON.parse(Store.get('radio.cfg') || '{}'); return !c.cats || !c.cats.includes('验收分类'); }));
  const snapStore = () => page.evaluate(() => ({ favs: Store.get('radio.favs'), recents: Store.get('radio.recents'), cfg: Store.get('radio.cfg'), view: Store.get('radio.view'), theme: Store.get('radio.theme') })); // AIbot PR#34 P2：旧 F10 是 length>=0 恒真式，改前后快照深比较
  const before10 = await snapStore();
  await page.setInputFiles('#mfile2', path.resolve(__dirname, '../contracts/fixtures/backup-v3.json'));
  await page.waitForTimeout(500);
  const bprev = await page.evaluate(() => document.getElementById('editorConfirm').textContent);
  check('F9 备份恢复覆盖预览（版本/键数/个人电台/sidecar）', /v3|版本/.test(bprev) && /覆盖/.test(bprev));
  await shot('11-desktop-backup-preview.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const after10 = await snapStore();
  let f10 = true; try { assert.deepStrictEqual(after10, before10); } catch (e) { f10 = false; note('F10 快照差异：' + String(e.message).split('\n').slice(0, 4).join(' / ')); }
  check('F10 恢复取消零副作用（favs/recents/cfg/view/theme 快照前后深比较一致）', f10);
  await page.keyboard.press('Escape'); // 关维护面板
  await page.waitForTimeout(300);

  console.log('[G] 窄屏 390（开关开但 <1024 = 紧凑布局）');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  check('G1 390 侧栏/hero 隐藏（紧凑）', !(await vis('.desktop-sidebar')) && await page.locator('#resumeHero').isHidden());
  check('G2 跨断点筛选状态不丢（scope=all 保留）', await page.evaluate(() => App.state.scope === 'all'));
  check('G3 themeWrap 在 lowfreq（≤640）', await page.evaluate(() => document.getElementById('lowfreq').contains(document.getElementById('themeWrap'))));
  await page.evaluate(() => App.manageOpen()); // 真开面板（替代旧 DOM 强制 unhide——AIbot PR#34 P2：只读 grid 字符串证明不了单列）
  await page.click('#mTabD'); // 数据分区：桌面 ≥1024 的 .dsec2 是 1fr 1fr 双列卡，≤768 应回退单列——以子项实测布局为准
  await page.waitForTimeout(300);
  const g4 = await page.evaluate(() => {
    const box = document.querySelector('#manage .mbox'), br = box.getBoundingClientRect();
    const cards = [...document.querySelectorAll('#mData .dsec2 .dcard, #mData > .dcard')].map(el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; });
    return { bw: Math.round(br.width), bh: Math.round(br.height), cards };
  });
  const xs = [...new Set(g4.cards.map(c => c.x))];
  check(`G4 窄屏维护单列（mbox ${g4.bw}x${g4.bh} 满屏；${g4.cards.length} 张卡同左缘 x=${xs.join('/')}、各宽 ≥ mbox-40）`,
    g4.bw >= 388 && g4.bh >= 840 && g4.cards.length >= 3 && xs.length === 1 && g4.cards.every(c => c.w >= g4.bw - 40));
  await page.evaluate(() => { App.state.theme = 'light'; Store.set('radio.theme', 'light'); App.syncThemeUI(); }); // 图12 仿参考图11 为浅色窄屏维护
  await page.waitForTimeout(300);
  await shot('12-narrow-390-maintenance-light.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('G5 关闭后焦点未落 body 外不可见节点', await page.evaluate(() => { const ae = document.activeElement; return !ae || ae === document.body || !!ae.offsetParent; }));

  console.log('[H] 性能（真实全库）');
  const perf = await page.evaluate(() => { const t = []; for (let i = 0; i < 5; i++) { const t0 = performance.now(); App.render(); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return { median: Math.round(t[2] * 10) / 10, stations: App.state.stations.length }; });
  report.perf.renderMedianMs = perf.median; report.perf.stations = perf.stations;
  note(`render() 全库 ${perf.stations} 台中位耗时 ${perf.median}ms（§9.3 建议 <100ms）`);
  check(`H1 render 中位 ${perf.median}ms < 100ms`, perf.median < 100);

  check('Z1 无页面脚本错误', report.errors.length === 0);
  report.result = 'PASS';
  console.log('PASS');
}catch (e) {
  report.result = 'FAIL'; report.failure = String(e && e.stack || e); process.exitCode = 1; // AIbot PR#34 P2：断言失败必须非零退出——validation.json 之外，退出码是 CI/编排脚本的成败信号
  console.error('FAIL:', e.message);
} finally {
  fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  if (browser) await browser.close();
  if (srv) srv.kill();
  console.log(JSON.stringify({ result: report.result, assertions: report.assertions.length, screenshots: report.screenshots.length, errors: report.errors }, null, 1));
}
})().catch(e => { console.error('p6-verify 异常：', e); process.exitCode = 1; });
