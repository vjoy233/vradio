#!/usr/bin/env node
/* VRadio 正式页面 Chromium PR smoke（P0b，docs/testing-strategy-2026-11.md §3 L3 PR 层矩阵）。
   断言口径 = PR 门，uiRefresh on/off 双态参数化（review#38 P2-3）：
   · on 态（FEATURES.uiRefresh 默认开；1280×800 + 390×844 两档）：启动、筛选、主题、播放、维护离开三选、
     390 收纳、无 pageerror、render 全库中位 <100ms；
   · off 态（页面上下文初始化前 addInitScript 注入 localStorage['feat.uiRefresh']='0'——features.js 的
     feat.* 开发覆盖约定）：旧紧凑壳关键入口可交互（列表行播放入口 + header #manageBtn 维护入口）、
     无 pageerror。移动窄屏不代替显式关开关。
   公网阻断策略（review#38 P2-2）：page.route 拦截全部页面请求——127.0.0.1/localhost 本地服务放行，
   其余 http(s) 一律 abort（零公网流量）；仅点播台的目标流请求例外改「挂起」（不回应不拒绝），使播放
   停在受控 connecting 态。本脚本只断言：connecting 状态出现（onphase 事件捕获——禁止用 phase 枚举
   合法性冒充状态转移断言）+ 连接台/挂起请求 = 页面预期选中站点与目标 + 停止后不再续连。完整
   connecting→playing→paused→idle 链路（需本地可解码音频 fixture）明确挂账给后续批次
   （multi-tab/browser-matrix 或 L5，见下方覆盖挂账③）。
   资源门（review#38 P2-4）：response/requestfailed 双通道按 URL+状态分类——本地 4xx/5xx 除小型允许清单
   （自举实例合法缺 my-radio.txt 404 / 浏览器默认 favicon.ico / 经 /proxy 的台标等公网探测——上游可达性
   不可控）一律判 FAIL，启动段快速失败 + 终门各一道；核心脚本/样式/业务 API（/api/*）失败必 FAIL；
   外部请求失败 = 阻断策略生效仅计数不判。资源类 console 文本分类退役（URL+状态双通道已覆盖，防双重计数）。
   失败自测（review#38 P1）：--selfcheck 派生 --selfcheck-fault 子进程，对核心业务请求 /api/store 注入
   500 真触发失败路径，验证：非零退出、原始错误（非 ReferenceError）入 validation.json、报告刷新、
   catch→failShot 现场截图产出、browser/server/worktree 零残留；selfcheck 自身退出码 0（跑前须提交态）。
   清理收口（review#38 P1）：failShot 等 helper 提到 try 外（catch 词法可见）；browser/page/server/
   worktree 全部释放 + validation.json 落盘移入 finally——失败路径不再可能跳过收口，CI 不挂超时、
   不遗留旧 PASS 证据；PASS 时清除旧 failure.png 现场防过期证据误导。
   自举隔离复用 P6 口径：git worktree 临时检出 HEAD → 被测实例 spawn（82xx 随机端口、cwd=临时检出、
   就绪探活）——server 的 data/store.json 与 my-radio.txt 全锚 __dirname，宿主零接触；运行前后宿主两文件
   哈希不变（Z2 终检）。
   覆盖挂账（review#38 P3）：
   ① test/logos.js 后续批次补「Logos 运行时解析 8s abort」确定性用例——AbortSignal 挂起 fake fetch +
     FakeClock 推进 8s 触发超时；完成标准 = 用例入 npm test 全量、零网络、负缓存落库断言通过。
   ② sync/app 侧未测项承接：断网 dirty 重推与多标签真实页面对抗 → ui-demo/multi-tab.cjs；390 档旧壳
     回归/键盘完整路径/aria → ui-demo/browser-matrix.cjs。完成标准 = 两矩阵全绿且纳入
     npm run test:browser / npm run test:nightly 门禁。
   ③ 完整播放链路 connecting→playing→paused→idle（可解码音频 fixture）→ multi-tab/browser-matrix 或
     L5 夜间层承接。
   产物：docs/test-reports/pr-smoke/validation.json（截图仅失败时 failure.png）。
   Playwright 为外部工具（VRADIO_PLAYWRIGHT 指向安装路径，CI 走 .ci/browser/），非仓库依赖。
   跑法：node ui-demo/pr-smoke.cjs；故障自测：node ui-demo/pr-smoke.cjs --selfcheck */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const output = path.resolve(__dirname, '../docs/test-reports/pr-smoke');
const ROOT = path.resolve(__dirname, '..');
const REP = path.join(output, 'validation.json');
const SHOT = path.join(output, 'failure.png');
fs.mkdirSync(output, { recursive: true });
const git = a => execSync('git ' + a, { cwd: ROOT, stdio: 'pipe' }).toString();
const sha1 = f => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch (_) { return 'absent'; } };
const hostSnap = () => ['data/store.json', 'my-radio.txt'].map(p => sha1(path.join(ROOT, p))).join('|'); // Z2 终检：宿主持久面
const httpGet = u => new Promise((resolve, reject) => { const r = http.get(u, res => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); r.setTimeout(2000, () => { r.destroy(); reject(new Error('timeout')); }); });
const pickPort = () => new Promise((resolve, reject) => { // 82xx 段随机起始顺序探空闲（同 p6 口径）
  let p = 8200 + Math.floor(Math.random() * 80), tried = 0;
  const tryOne = () => { if (++tried > 100) return reject(new Error('82xx 端口段全忙')); const s = net.createServer();
    s.once('error', () => tryOne(p >= 8299 ? (p = 8200) : ++p)); s.listen(p, '127.0.0.1', () => s.close(() => resolve(p))); };
  tryOne();
});
const isLocal = u => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|\?|$)/i.test(u); // 本地服务放行（82xx 自举实例）
const SELF = process.argv.indexOf('--selfcheck') >= 0; // 故障自测（父进程）：派生 FAULT 子进程验证失败路径全链
const FAULT = process.argv.indexOf('--selfcheck-fault') >= 0; // selfcheck 派生的注入失败子进程跑法（/api/store 500）
const dirtyFiles = () => git('status --porcelain').split('\n').map(l => { const m = l.trim().match(/^(..)\s+(.+)$/); return m ? m[2].replace(/"/g, '') : ''; })
  .filter(p => p && !p.startsWith('docs/test-reports/pr-smoke/')); // 提交态门：证据只采自提交态（本脚本产物目录豁免）
const earlyFail = msg => { const r = { capturedAt: new Date().toISOString(), mode: 'pr-gate', result: 'FAIL', failure: msg, assertions: [], errors: [], resourceErrors: [], blockedN: 0, blockedS: [], notes: [] };
  fs.writeFileSync(REP, JSON.stringify(r, null, 2) + '\n'); console.error('FAIL:', msg.split('\n')[0]); process.exitCode = 1; };
const failShot = (page, name) => { // 失败现场截图（page 可能未创建：静默跳过）——定义在 try 外，catch 词法可见（review#38 P1）
  if (!page) return Promise.resolve('');
  return page.screenshot({ path: path.join(output, name) }).then(() => '失败现场截图: ' + name).catch(() => '');
};
/* 页面接线（review#38 P2-2/P2-4）：公网阻断 route + 资源门 response/requestfailed 双通道。
   允许清单 = /proxy?url=（台标等公网探测经本地代理，上游可达性不可控）+ my-radio.txt 404（自举实例合法缺）+
   favicon.ico（浏览器默认请求）。核心脚本/样式/业务 API（/api/* 等）失败必 FAIL。返回句柄 st：
   hangOn/hangSet 控制目标流挂起（受控 connecting），hung/hungUrl 记挂起请求，frozen 冻结防收尾期误记 */
function wirePage(page, report, mark) {
  const st = { hangOn: false, hangSet: [], hung: 0, hungUrl: '', frozen: false };
  const resKey = u => { try { const x = new URL(u); return x.pathname + x.search; } catch (_) { return u; } };
  const resAllow = k => k.indexOf('/proxy?url=') === 0 || /^\/my-radio\.txt(\?|$)/.test(k) || /^\/favicon\.ico(\?|$)/.test(k);
  const seen = new Set();
  const resFail = (url, why) => { if (st.frozen) return; const k = resKey(url); if (resAllow(k)) return;
    const key = k + '|' + why; if (seen.has(key)) return; seen.add(key); report.resourceErrors.push(k + ' ' + why); };
  page.on('pageerror', e => { if (!st.frozen) report.errors.push(mark + 'pageerror:' + e.message); });
  page.on('console', m => { if (m.type() !== 'error' || st.frozen) return;
    const t = m.text() || ''; if (/^Failed to load resource/.test(t)) return; // 资源类文本退役：URL+状态双通道覆盖（P2-4）
    report.errors.push(mark + 'console:' + t); });
  page.on('response', r => { const s = r.status(); if (!st.frozen && s >= 400 && isLocal(r.url())) resFail(r.url(), '→ ' + s); });
  page.on('requestfailed', r => { // 本地失败入资源门；外部失败 = 阻断策略生效仅计数（route.abort 不在此处计数防双计）
    if (st.frozen) return;
    const u = r.url();
    if (isLocal(u)) return resFail(u, '(' + ((r.failure() && r.failure().errorText) || 'failed') + ')');
    report.blockedN++; if (report.blockedS.length < 20) report.blockedS.push(u.slice(0, 90));
  });
  page.route('**/*', route => { // 公网阻断（P2-2）：本地放行、目标流挂起（受控 connecting）、其余 abort
    const u = route.request().url();
    if (isLocal(u)) return route.continue().catch(() => {});
    if (st.hangOn && st.hangSet.indexOf(u) >= 0) { st.hung++; if (!st.hungUrl) st.hungUrl = u; return; } // 挂起：不回应不拒绝
    return route.abort().catch(() => {});
  });
  return st;
}
/* 播放探针（review#38 P2-2 方案 B）：挂起选中台的目标流请求 = 受控 connecting——断言 connecting 出现
   （onphase 事件捕获防漏拍）+ 连接台/挂起请求与页面预期目标一致 + 停止后不再续连 */
async function playProbe(page, st, prefix, clickFn, hero, check, note) {
  const tgt = await page.evaluate(h => { // 选中台源集（含蜻蜓 m3u8→64k mp3 换算形态，同 Player.variants 口径）
    const s = h ? App.state.stations.find(x => x.u[0] === App.heroK) : App.visible()[0];
    const vs = [];
    if (s) for (const iu of s.u) { const m = iu.match(/ls\.qingting\.fm\/live\/(\d+)\.m3u8/); if (m) vs.push('http://lhttp.qingting.fm/live/' + m[1] + '/64k.mp3'); vs.push(iu); }
    return { k: s && s.u[0], vs: vs };
  }, hero);
  check(prefix + 'a 选中台存在且源集非空（' + String(tgt.k || '').slice(0, 48) + '）', !!tgt.k && tgt.vs.length > 0);
  await page.evaluate(() => { window.__ph = []; const prev = Player.onphase; Player.onphase = function (ph, s) { window.__ph.push(ph); if (prev) { try { prev(ph, s); } catch (_) {} } }; }); // 瞬时 phase 事件捕获
  st.hangOn = true; st.hangSet = tgt.vs;
  const hung0 = st.hung;
  await clickFn();
  await page.waitForTimeout(500);
  const pv = await page.evaluate(() => ({ phs: window.__ph, conn: Player.connecting && Player.connecting.u[0], cp: Player.curPlay }));
  check(prefix + 'b connecting 状态出现（onphase 事件捕获）', pv.phs.indexOf('connecting') >= 0);
  check(prefix + 'c 连接台 = 页面预期选中站点', pv.conn === tgt.k);
  const cpRaw = pv.cp && pv.cp.indexOf('/proxy?url=') === 0 ? decodeURIComponent(pv.cp.slice('/proxy?url='.length)) : pv.cp;
  check(prefix + 'd 播放请求指向预期目标（curPlay ↔ 挂起请求 ↔ 台源集）', !!st.hungUrl && st.hungUrl === cpRaw && tgt.vs.indexOf(cpRaw) >= 0);
  note(prefix + ' 目标=' + String(tgt.k).slice(0, 56) + ' 挂起=' + String(st.hungUrl).slice(0, 56) + ' phase序=' + pv.phs.join('>'));
  st.hangOn = false;
  const hungStop = st.hung;
  await page.evaluate(() => Player.stop());
  await page.waitForFunction(() => App.phase === 'idle', null, { timeout: 5000 });
  await page.waitForTimeout(1500);
  check(prefix + 'e 停止后 phase=idle 且不再续连（挂起请求零新增）', await page.evaluate(() => App.phase === 'idle' && !Player.connecting) && st.hung === hungStop);
}
async function run(chromium) {
  const before = hostSnap();
  let browser = null, srv = null, wt = null, wtAlive = false, page = null; // 全部资源句柄提到 try 外：finally/catch 均可达
  const report = { capturedAt: new Date().toISOString(), mode: FAULT ? 'selfcheck-fault' : 'pr-gate', url: '', result: '', assertions: [], errors: [], resourceErrors: [], blockedN: 0, blockedS: [], notes: [], perf: {} };
  const check = (name, ok) => { assert(ok, name); report.assertions.push(name); console.log('  ✓', name); };
  const note = t => report.notes.push(t);
  const waitBoot = page => page.waitForFunction(() => typeof App !== 'undefined' && App.state.stations.length > 50, null, { timeout: 20000 });
  const gateThrow = when => { if (report.resourceErrors.length) throw new Error('资源门' + when + '：核心请求失败 ' + report.resourceErrors.join('; ')); };
  try {
    const port = await pickPort();
    const base = `http://127.0.0.1:${port}/`; report.url = base;
    wt = fs.mkdtempSync(path.join(os.tmpdir(), 'vradio-pr-'));
    git(`worktree add --detach "${wt}" HEAD`); wtAlive = true;
    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1' };
    delete env.VR_TEST_Q_MAX;
    srv = spawn(process.execPath, ['server.js'], { cwd: wt, env, stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) { await new Promise(r => setTimeout(r, 100)); if (srv.exitCode !== null) break; try { ready = (await httpGet(base)) === 200; } catch (_) {} }
    if (!ready) throw new Error(`自举隔离服务未就绪（${base}）——端口冲突/服务启动异常`);
    console.log(`自举隔离实例 ${base}（cwd=临时 worktree：data/my-radio 全落临时检出，宿主零接触）`);
    browser = await chromium.launch({ headless: true });

    // —— [on] uiRefresh 开态（FEATURES.uiRefresh 默认开，1280×800）——
    console.log('[on] uiRefresh 开态（1280×800）');
    const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' });
    page = await ctx1.newPage();
    const st1 = wirePage(page, report, '[on] ');
    if (FAULT) await page.route('**/api/store*', r => r.fulfill({ status: 500, contentType: 'text/plain; charset=utf-8', body: 'selfcheck 注入 500：核心业务请求 /api/store 失败' })); // 后注册者优先：压过阻断 route（review#38 P2-4 人为 500）
    await page.goto(base); await page.reload(); await waitBoot(page); // 首轮 GET 与本地镜像清空竞态由 reload 压掉（p6 boot 两轮口径的轻量版）
    check('S1 全库装配 >50 台（临时实例含 radio.txt 全量）', await page.evaluate(() => App.state.stations.length > 50));
    check('S2 无 pageerror（启动段）', report.errors.length === 0);
    check('S3 分类条渲染', (await page.locator('#cats .chip, #cats [data-act]').count()) > 3);
    gateThrow('（启动段快速失败）'); // P2-4：启动段即判核心资源失败（fault 注入在此引爆，不再往下跑）
    note(`全库 ${await page.evaluate(() => App.state.stations.length)} 台 @ ${browser.version()}`);

    // —— [F] 筛选（多词 AND / 搜全部 / 分类）——
    console.log('[F] 筛选');
    const t = await page.evaluate(() => { const s = App.state.stations.find(x => !x.hidden && x.n.length >= 4); return { n: s.n, c: s.c }; });
    const w1 = t.n.slice(0, 2), w2 = t.c.slice(0, 2);
    await page.fill('#q', `${w1} ${w2}`);
    await page.waitForTimeout(400);
    const hitAnd = await page.evaluate(([a, b]) => { const manual = App.state.stations.filter(s => !s.hidden && (s.n + ' ' + s.c).toLowerCase().includes(a) && (s.n + ' ' + s.c).toLowerCase().includes(b)).length; return { vis: App.visible().length, manual }; }, [w1.toLowerCase(), w2.toLowerCase()]);
    check(`F1 多词 AND（界面 ${hitAnd.vis} = 口径 ${hitAnd.manual}）`, hitAnd.vis === hitAnd.manual && hitAnd.vis > 0);
    await page.fill('#q', '绝不存在的电台xyz'); await page.waitForTimeout(300);
    check('F2 空态有搜全部出口', (await page.locator('[data-act="qall"]').count()) === 1);
    await page.click('[data-act="qall"]'); await page.waitForTimeout(300);
    check('F3 搜全部保词解范围', await page.evaluate(k => App.state.scope === 'all' && App.state.keyword === k, '绝不存在的电台xyz'));
    await page.fill('#q', '');

    // —— [T] 主题三选 ——
    console.log('[T] 主题三选');
    await page.click('#themeBtn');
    check('T1 三选菜单三项', await page.locator('#themeMenu [data-theme-v]').count() === 3);
    await page.click('#themeMenu [data-theme-v="light"]');
    await page.waitForTimeout(200);
    check('T2 浅色生效', await page.evaluate(() => document.documentElement.dataset.theme === 'light'));
    await page.click('#themeBtn'); await page.click('#themeMenu [data-theme-v="dark"]');
    await page.waitForTimeout(200);
    check('T3 深色恢复', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));

    // —— [P] 播放（公网阻断 + 目标流挂起 = 受控 connecting；完整 playing 链路后续批次承接，见头注挂账③）——
    console.log('[P] 播放 connecting/停止（受控 connecting）');
    const rec0 = await page.evaluate(() => App.recents.length);
    await playProbe(page, st1, 'P', () => page.click('#heroPlay'), true, check, note);
    check('P1 点播记最近', await page.evaluate(r0 => App.recents.length === r0 + 1, rec0));

    // —— [D] 发现卡真实点击：沿用 Player、筛选不变；不连接公网 ——
    console.log('[D] 本地发现播放与筛选');
    const prior = await page.evaluate(() => { App.state.cat = App.state.stations[0].c; return {cat: App.state.cat, scope: App.state.scope, keyword: App.state.keyword}; });
    const boundWithoutSubtle = await page.evaluate(async () => {
      const original = Object.getOwnPropertyDescriptor(window, 'crypto');
      try { Object.defineProperty(window, 'crypto', { configurable:true, value:undefined }); return !!(await App.loadMeta(App.metaMain)); }
      finally { if (original) Object.defineProperty(window, 'crypto', original); else delete window.crypto; }
    });
    check('D0 无 crypto.subtle 的 HTTP 环境仍验证绑定', boundWithoutSubtle);
    await page.click('#sideMore'); await page.click('#discBtn');
    await page.waitForSelector('#discBody .discrow');
    const disc = await page.evaluate(() => {
      const k = document.querySelector('#discBody .discrow').dataset.k;
      const s = App.state.stations.find(x => x.c + '|' + x.n === k);
      window.__discCalls = 0; const original = Player.play;
      Player.play = function (...args) { window.__discCalls++; return original.apply(this, args); };
      return {k, u0:s.u[0]};
    });
    check('D1 发现展示来源与质量摘要', await page.locator('#discBody .discrow').count() > 0 && await page.locator('#discBody .discrow .srcs').count() > 0 && await page.locator('#discBody .discrow .srcs').evaluateAll(xs => xs.some(x => /来源未知|暂无可信质量样本|稳定|一般|不稳定/.test(x.textContent))));
    await page.locator('#discBody .discrow').first().click();
    check('D2 卡片仅调用既有播放入口一次且指向选中台', await page.evaluate(d => window.__discCalls === 1 && !!Player.connecting && Player.connecting.u[0] === d.u0, disc));
    check('D3 返回后筛选不变', await page.evaluate(p => App.state.cat === p.cat && App.state.scope === p.scope && App.state.keyword === p.keyword && document.getElementById('discovery').hidden, prior));
    await page.evaluate(() => Player.stop());

    // —— [M] 维护离开三选（dirty → 保存/放弃/继续）——
    console.log('[M] 维护离开三选');
    await page.click('#sideManage');
    await page.waitForTimeout(300);
    check('M1 维护面板三分区', (await page.locator('#mTabC').count()) && (await page.locator('#mTabS').count()) && (await page.locator('#mTabD').count()));
    await page.click('#mTabS');
    await page.waitForTimeout(200);
    await page.locator('#mlist [data-act="edit"]').first().click();
    await page.waitForTimeout(300);
    const nameInput = await page.evaluate(() => { const el = document.querySelector('#mEdit input, #dEdit input'); return el ? el.value : null; });
    check('M2 对象编辑器出现', nameInput !== null);
    if (nameInput !== null) {
      await page.fill('#mEdit input, #dEdit input', nameInput + '·验');
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const three = await page.evaluate(() => [...document.querySelectorAll('#editorConfirm button')].map(b => b.textContent));
      check(`M3 dirty 离开三选（${three.join('/')}）`, three.some(x => x.includes('保存')) && three.some(x => x.includes('放弃')) && three.some(x => x.includes('继续')));
      const noBtn = three.find(x => !x.includes('保存')); // 「放弃/继续」任一非保存键收场（草稿不入库）
      if (noBtn) await page.evaluate(() => { const b = [...document.querySelectorAll('#editorConfirm button')].find(x => !x.textContent.includes('保存')); if (b) b.click(); });
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => { const m = document.getElementById('manage'); if (m && !m.hidden) { const x = document.getElementById('mClose') || document.getElementById('manageClose'); if (x) x.click(); } }); // 面板收场（幂等：无面板跳过）

    // —— [H] 性能哨兵（正式页全库 render 中位 <100ms；空闲窗口探测同 p6 口径：FAIL 隔 45s 重试至多 2 轮取最小）——
    console.log('[H] render 性能哨兵');
    const renderProbe = () => page.evaluate(() => { const t = []; for (let i = 0; i < 5; i++) { const t0 = performance.now(); App.render(); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return { median: Math.round(t[2] * 10) / 10, stations: App.state.stations.length }; });
    const rounds = [];
    for (let i = 0; i < 3; i++) {
      const p1 = await renderProbe(); rounds.push(p1.median);
      if (p1.median < 100) break;
      if (i < 2) await new Promise(r => setTimeout(r, 45000));
    }
    const perf = { median: Math.min(...rounds), stations: (await renderProbe()).stations };
    report.perf.renderMedianMs = perf.median; report.perf.renderRoundMedians = rounds; report.perf.stations = perf.stations;
    note(`render() 全库 ${perf.stations} 台各轮中位 ${rounds.join('/')}ms → 取最小 ${perf.median}ms（空闲窗口探测，口径同 p6 H1）`);
    check(`H1 render 中位 ${perf.median}ms < 100ms`, perf.median < 100);

    // —— [S2] 390×844 移动档（启动态/横向溢出/播放入口）——
    console.log('[S2] 390×844 移动档');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    check('M4 390 无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    check('M5 390 header 收纳（≤640 主题控件进 lowfreq）', await page.evaluate(() => document.getElementById('lowfreq').contains(document.getElementById('themeWrap'))));
    check('M6 390 无新增 pageerror', report.errors.length === 0);
    check('Z1 开态全程零 pageerror / 非资源 console error', report.errors.length === 0);
    gateThrow('（开态终门）'); // P2-4：核心脚本/样式/业务 API 失败必 FAIL
    st1.frozen = true;
    await ctx1.close();

    // —— [off] uiRefresh 关闭态（review#38 P2-3）：旧紧凑壳关键入口，窄屏不代替显式关开关 ——
    console.log('[off] uiRefresh 关闭态（1280×800，feat.* 覆盖注入）');
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' });
    await ctx2.addInitScript(() => { try { localStorage.setItem('feat.uiRefresh', '0'); } catch (_) {} }); // 页面脚本前注入（features.js feat.* 约定）
    page = await ctx2.newPage();
    const errOff0 = report.errors.length;
    const st2 = wirePage(page, report, '[off] ');
    await page.goto(base); await page.reload(); await waitBoot(page);
    check('O1 开关关闭：ui-refresh 类不挂 + #heroPlay 不存在（旧壳生效）', await page.evaluate(() => !document.documentElement.classList.contains('ui-refresh') && !document.getElementById('heroPlay')));
    await playProbe(page, st2, 'O2', () => page.locator('#list .cname, #list .name').first().click(), false, check, note); // 旧壳播放入口 = 列表行（点击台名气泡到行）
    await page.click('#manageBtn'); // 旧壳维护入口 = header ⚙（新壳由 #sideManage 接管）
    await page.waitForTimeout(300);
    check('O3 旧壳维护入口打开面板', await page.evaluate(() => { const m = document.getElementById('manage'); return !!(m && !m.hidden); }));
    check('O4 关态零 pageerror / 非资源 console error', report.errors.length === errOff0);
    gateThrow('（关态终门）');
    st2.frozen = true;
    await ctx2.close();
    check('Z5 双态终门：零 pageerror / 非资源 console error', report.errors.length === 0);
    note(`公网阻断 ${report.blockedN} 条外链请求（策略生效，不判 FAIL；样例 ${report.blockedS.length ? report.blockedS[0] : '无'}）`);
  } catch (e) {
    report.result = 'FAIL'; report.failure = String(e && e.stack || e); process.exitCode = 1;
    console.error('FAIL:', String(e && e.message || e));
    const shot = await failShot(page, 'failure.png'); if (shot) report.notes.push(shot);
  } finally {
    // —— 资源释放 + 落盘全部收口在 finally（review#38 P1）：catch 里再抛错也不跳过 ——
    const cleanupErr = []; let srvGone = !srv, wtGone = !wtAlive;
    try { if (browser) await browser.close(); } catch (e) { cleanupErr.push('browser:' + String(e && e.message || e).split('\n')[0]); }
    if (srv) { try { if (srv.exitCode !== null) srvGone = true; else { srv.kill(); await new Promise(r => { srv.once('exit', () => { srvGone = true; r(); }); setTimeout(r, 5000); }); } if (!srvGone) cleanupErr.push('server: kill 后 5s 无退出信号'); } catch (e) { srvGone = false; cleanupErr.push('server:' + String(e && e.message || e).split('\n')[0]); } }
    if (wtAlive) { try { git(`worktree remove --force "${wt}"`); wtGone = true; }
      catch (_) { await new Promise(r => setTimeout(r, 800)); try { git(`worktree remove --force "${wt}"`); wtGone = true; }
        catch (e2) { cleanupErr.push('worktree remove 两连败:' + String(e2 && e2.message || e2).split('\n')[0]); } } }
    if (report.result !== 'FAIL') report.result = 'PASS';
    if (report.result === 'PASS') { try { fs.unlinkSync(SHOT); } catch (_) {} } // 清旧失败现场：PASS 不留过期截图冒充证据
    if (hostSnap() === before) report.notes.push('Z2 宿主 data/store.json + my-radio.txt 运行前后哈希不变');
    else { report.result = 'FAIL'; report.failure = (report.failure || '') + ' Z2 宿主持久面被改动: ' + before + ' → ' + hostSnap(); process.exitCode = 1; }
    if (cleanupErr.length === 0 && srvGone && wtGone) report.notes.push('Z3 清理失败门：browser/server/worktree 全回收（finally 收口，零泄漏成立）');
    else { report.result = 'FAIL'; report.failure = (report.failure || '') + ' Z3 清理失败门未过: ' + cleanupErr.join(' | ') + (srvGone ? '' : ' [server未退出]') + (wtGone ? '' : ' [worktree未移除]'); process.exitCode = 1; }
    fs.writeFileSync(REP, JSON.stringify(report, null, 2) + '\n');
    console.log(`\n${report.result}: ${report.assertions.length} 断言${report.perf.renderMedianMs != null ? '，render 中位 ' + report.perf.renderMedianMs + 'ms' : ''}（报告 docs/test-reports/pr-smoke/validation.json）`);
  }
}
/* 故障自测（review#38 P1）：派生 --selfcheck-fault 子进程对 /api/store 注入 500 真触发失败路径，
   校验非零退出 / 原始错误（非 ReferenceError）入报告 / 报告刷新 / failShot 现场产出 / 零进程与 worktree 残留 */
async function selfcheck() {
  const dirty = dirtyFiles();
  if (dirty.length) { console.error('selfcheck 前置未过——存在未提交改动（与正常跑同提交态门）：\n' + dirty.join('\n')); process.exitCode = 1; return; }
  const m0 = fs.existsSync(REP) ? fs.statSync(REP).mtimeMs : 0;
  try { fs.unlinkSync(SHOT); } catch (_) {} // 清旧现场：之后 failure.png 存在即本轮 failShot 产出
  console.log('selfcheck：派生 --selfcheck-fault 子进程注入 /api/store 500，真触发失败路径…');
  const cp = spawn(process.execPath, [__filename, '--selfcheck-fault'], { stdio: 'inherit' });
  const code = await new Promise(r => cp.once('exit', c => r(c)));
  const bad = [];
  if (code === 0) bad.push('注入失败跑退出码为 0（应非零退出）');
  let r = null;
  try { r = JSON.parse(fs.readFileSync(REP, 'utf8')); } catch (e) { bad.push('validation.json 读取失败: ' + (e && e.message || e)); }
  if (r) {
    if (r.result !== 'FAIL') bad.push('报告 result 应为 FAIL，实为 ' + r.result);
    if (r.mode !== 'selfcheck-fault') bad.push('报告 mode 应为 selfcheck-fault');
    const f = r.failure || '';
    if (!/api\/store|资源门|500/.test(f)) bad.push('原始错误信息未入报告（failure 首行: ' + f.split('\n')[0].slice(0, 120) + '）');
    if (/ReferenceError/.test(f)) bad.push('报告出现 ReferenceError——failShot 作用域回归（P1 未修好）');
    if (!(r.resourceErrors || []).some(x => x.indexOf('/api/store') >= 0)) bad.push('资源门未捕获 /api/store 失败（P2-4 逻辑未生效）');
    if (!r.url) bad.push('报告缺 url（无法验证服务回收）');
  }
  if (fs.statSync(REP).mtimeMs <= m0) bad.push('validation.json 未被刷新');
  if (!fs.existsSync(SHOT)) bad.push('catch→failShot 未产出失败现场截图（failure.png）');
  const leak = git('worktree list --porcelain').split('\n').filter(l => l.indexOf('worktree ') === 0).map(l => l.slice(9)).filter(w => w.indexOf('vradio-pr-') >= 0);
  if (leak.length) bad.push('worktree 残留: ' + leak.join(', '));
  if (r && r.url) { try { await httpGet(r.url); bad.push('自举服务进程残留（端口仍存活）: ' + r.url); } catch (_) { /* 连接失败 = 已回收 */ } }
  if (bad.length) { console.error('selfcheck FAIL:\n - ' + bad.join('\n - ')); process.exitCode = 1; return; }
  console.log('selfcheck PASS：失败路径全链正确（非零退出 / 原始错误入报告 / 报告刷新 / failShot 现场产出 / 零进程与 worktree 残留）');
}
(async () => {
  let chromium = null; // Playwright 加载收口：缺工具也写 FAIL 报告 + 非零退出，不裸崩
  try { chromium = require(process.env.VRADIO_PLAYWRIGHT || 'playwright').chromium; }
  catch (e) { earlyFail('Playwright 加载失败（VRADIO_PLAYWRIGHT 指向安装路径；CI 走 .ci/browser/ npm ci）: ' + (e && e.message || e)); return; }
  const dirty = dirtyFiles();
  if (dirty.length) { earlyFail('存在未提交改动（证据只采自提交态）:\n' + dirty.join('\n')); return; }
  if (SELF) return selfcheck();
  return run(chromium);
})().catch(e => { console.error('未捕获异常:', String(e && e.stack || e)); process.exitCode = 1; });
