#!/usr/bin/env node
/* VRadio 正式页面 Chromium PR smoke（P0b，docs/testing-strategy-2026-11.md §3 L3 PR 层矩阵）。
   断言口径 = PR 门（1280×800 + 390×844 两档）：启动、筛选、主题、播放 connecting/停止、维护离开三选、
   无 pageerror、render 全库中位 <100ms。与 p6-verify.cjs 分工：p6 是 UI 重设计批次全量验收（51 断言 +
   10 视口截图证据），本脚本是**正式页常驻 PR 门**——轻量、无截图产出（失败才留现场），不把 ui-demo
   专属样例数量当契约。真实音频不可保证（沙箱网络），播放仅验证 phase 枚举与停止级联。
   自举隔离复用 P6 口径：git worktree 临时检出 HEAD → 被测实例 spawn（82xx 随机端口、cwd=临时检出、
   就绪探活）——server 的 data/store.json 与 my-radio.txt 全锚 __dirname，宿主零接触；运行前后宿主两文件
   哈希不变（Z2 终检）+ browser/server/worktree 全回收（Z3 清理门），任何清理失败置 FAIL 非零退出。
   产物：docs/test-reports/pr-smoke/validation.json（截图仅失败时 docs/test-reports/pr-smoke/）。
   Playwright 为外部工具（VRADIO_PLAYWRIGHT 指向安装路径，CI 走 .ci/browser/），非仓库依赖。
   跑法：node ui-demo/pr-smoke.cjs */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const output = path.resolve(__dirname, '../docs/test-reports/pr-smoke');
const ROOT = path.resolve(__dirname, '..');
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
(async () => {
  let chromium = null; // Playwright 加载收口：缺工具也写 FAIL 报告 + 非零退出，不裸崩
  try { chromium = require(process.env.VRADIO_PLAYWRIGHT || 'playwright').chromium; }
  catch (e) {
    const report = { capturedAt: new Date().toISOString(), result: 'FAIL', failure: 'Playwright 加载失败（VRADIO_PLAYWRIGHT 指向安装路径；CI 走 .ci/browser/ npm ci）: ' + e.message, assertions: [], errors: [], resourceErrors: [], notes: [] };
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
    console.error('FAIL: Playwright 加载失败——', e.message); process.exitCode = 1; return;
  }
  const dirty = git('status --porcelain').split('\n').map(l => { const m = l.trim().match(/^(..)\s+(.+)$/); return m ? m[2].replace(/"/g, '') : ''; })
    .filter(p => p && !p.startsWith('docs/test-reports/pr-smoke/')); // 提交态门：证据只采自提交态（本脚本产物目录豁免）
  if (dirty.length) { console.error('存在未提交改动（证据只采自提交态）：\n' + dirty.join('\n')); process.exitCode = 1; return; }
  const before = hostSnap();
  let browser = null, srv = null, wt = null, wtAlive = false, page = null;
  const report = { capturedAt: new Date().toISOString(), url: '', assertions: [], errors: [], resourceErrors: [], notes: [], perf: {} };
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
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' });
    page = await ctx.newPage();
    page.on('pageerror', e => report.errors.push('pageerror:' + e.message));
    page.on('console', m => { if (m.type() === 'error') { const t = m.text() || ''; (/^Failed to load resource/.test(t) ? report.resourceErrors : report.errors).push('console:' + t); } }); // 资源噪音分流（同 p6 Z1 口径：自举实例合法缺 my-radio.txt 404）
    const check = (name, ok) => { assert(ok, name); report.assertions.push(name); console.log('  ✓', name); };
    const note = t => report.notes.push(t);
    const vis = sel => page.locator(sel).evaluate(el => !!el.offsetParent);
    const waitBoot = () => page.waitForFunction(() => typeof App !== 'undefined' && App.state.stations.length > 50, null, { timeout: 20000 });
    const failShot = async name => { try { await page.screenshot({ path: path.join(output, name) }); note('失败现场截图: ' + name); } catch (_) {} };

    // —— [S] 启动（1280 桌面档）——
    console.log('[S] 启动（1280×800）');
    await page.goto(base); await page.reload(); await waitBoot(); // 首轮 GET 与本地镜像清空竞态由 reload 压掉（p6 boot 两轮口径的轻量版：全新临时实例无历史镜像，一轮足够）
    check('S1 全库装配 >50 台（临时实例含 radio.txt 全量）', await page.evaluate(() => App.state.stations.length > 50));
    check('S2 无 pageerror（启动段）', report.errors.length === 0);
    check('S3 分类条渲染', (await page.locator('#cats .chip, #cats [data-act]').count()) > 3);
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

    // —— [P] 播放 connecting/停止（真实流不可保证，验证 phase 状态机与停止级联）——
    console.log('[P] 播放 connecting/停止');
    const rec0 = await page.evaluate(() => App.recents.length);
    await page.click('#heroPlay');
    await page.waitForTimeout(2500);
    const ph = await page.evaluate(() => ({ phase: App.phase, recents: App.recents.length }));
    check('P1 点播记最近', ph.recents === rec0 + 1);
    check('P2 onphase 枚举（connecting/playing/buffering/paused/idle）', ['connecting', 'playing', 'buffering', 'paused', 'idle'].includes(ph.phase));
    note(`点播后 phase=${ph.phase}`);
    await page.evaluate(() => Player.stop());
    await page.waitForTimeout(400);
    check('P3 停止后 phase=idle', await page.evaluate(() => App.phase === 'idle'));

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

    // —— [M2] 390×844 移动档（启动态/横向溢出/播放入口）——
    console.log('[S2] 390×844 移动档');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    check('M4 390 无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    check('M5 390 header 收纳（≤640 主题控件进 lowfreq）', await page.evaluate(() => document.getElementById('lowfreq').contains(document.getElementById('themeWrap'))));
    check('M6 390 无新增 pageerror', report.errors.length === 0);

    check('Z1 全程零 pageerror / 非资源 console error', report.errors.length === 0);
    note(`资源加载噪音 ${report.resourceErrors.length} 条（自举实例合法 404 只记不判，同 p6 分流口径）`);
  } catch (e) {
    report.result = 'FAIL'; report.failure = String(e && e.stack || e); process.exitCode = 1;
    console.error('FAIL:', String(e && e.message || e));
    if (page) await failShot('failure.png').catch(() => {});
  }
  // —— 清理门（Z2/Z3，同 p6 口径）：任何泄漏置 FAIL 非零退出 ——
  const cleanupErr = []; let srvGone = !srv, wtGone = !wtAlive;
  try { if (browser) await browser.close(); } catch (e) { cleanupErr.push('browser:' + String(e.message || e).split('\n')[0]); }
  if (srv) { try { srv.kill(); await new Promise(r => { srv.once('exit', () => { srvGone = true; r(); }); setTimeout(r, 5000); }); if (!srvGone) cleanupErr.push('server: kill 后 5s 无退出信号'); } catch (e) { srvGone = false; cleanupErr.push('server:' + String(e.message || e).split('\n')[0]); } }
  if (wtAlive) { try { git(`worktree remove --force "${wt}"`); wtGone = true; }
    catch (_) { await new Promise(r => setTimeout(r, 800)); try { git(`worktree remove --force "${wt}"`); wtGone = true; }
      catch (e2) { cleanupErr.push('worktree remove 两连败:' + String(e2.message || e2).split('\n')[0]); } } }
  if (report.result !== 'FAIL') report.result = 'PASS';
  if (hostSnap() === before) report.notes.push('Z2 宿主 data/store.json + my-radio.txt 运行前后哈希不变');
  else { report.result = 'FAIL'; report.failure = (report.failure || '') + ' Z2 宿主持久面被改动: ' + before + ' → ' + hostSnap(); process.exitCode = 1; }
  if (cleanupErr.length === 0 && srvGone && wtGone) report.notes.push('Z3 清理失败门：browser/server/worktree 全回收（零泄漏成立）');
  else { report.result = 'FAIL'; report.failure = (report.failure || '') + ' Z3 清理失败门未过: ' + cleanupErr.join(' | ') + (srvGone ? '' : ' [server未退出]') + (wtGone ? '' : ' [worktree未移除]'); process.exitCode = 1; }
  fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${report.result}: ${report.assertions.length} 断言（报告 ${path.relative(ROOT, path.join(output, 'validation.json'))}）`);
})();
