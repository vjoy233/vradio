#!/usr/bin/env node
/* 阶段验收证据采集（AIbot review PR#29/#30/#31「P2 验收证据」补全 + 二次复核 P1/P2 采纳）：
   真隔离——server.js 的 data/store.json 与 my-radio.txt 全锚 __dirname，只换端口不换数据目录，故先
   git worktree add 临时检出 HEAD、在被测实例里 spawn server（随机 82xx 端口）：宿主 store/my-radio 零接触、
   天然空 fixture（断言与截图不依赖运行前状态，已有个人台不污染），绝不指向常驻实例。运行前后校验宿主
   data/store.json + my-radio.txt 哈希不变（Z1 终检断言入 evidence.json）。要求无未提交的跟踪文件改动
   （证据只采自提交态；evidence 产物目录的未跟踪文件豁免）。
   统一 finally（AIbot 二次 P2）：browser 关闭 → server kill → 临时 worktree 移除 → evidence.json 落盘
   （失败路径也落盘 + exitCode=1）；Playwright 加载失败同样写 FAIL 报告而非裸崩。
   Playwright 为全局 npm 安装的外部工具（VRADIO_PLAYWRIGHT 可覆盖路径），非仓库依赖。
   用法：node ui-demo/phase-evidence.cjs --phase=p1（P2/P3 断言组随各自分支扩展本文件）；
   故障注入：--fault 首组断言后强制抛错，验证失败路径的退出码/浏览器回收/worktree 清理/宿主不变。
   产物：docs/ui-redesign-assets/evidence/<phase>/（截图 PNG + evidence.json，随 PR 提交）。
   boot 预置 radio.baseline='done' 跳过首启基线确认门槛。 */
const { spawn, execSync } = require('child_process');
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os'), crypto = require('crypto');

const PHASE = ((process.argv.find(a => a.startsWith('--phase=')) || '').split('=')[1] || 'p1');
const FAULT = process.argv.some(a => a === '--fault' || a.startsWith('--fault='));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'ui-redesign-assets', 'evidence', PHASE);
const PORT = 8240 + Math.floor(Math.random() * 39);
const PW_PATH = process.env.VRADIO_PLAYWRIGHT || 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/playwright';

let pass = 0, fail = 0; const rec = [];
const ok = (id, name, detail) => { pass++; rec.push({ id, name, pass: true, detail }); console.log('  ✓', id, name); };
const bad = (id, name, detail) => { fail++; rec.push({ id, name, pass: false, detail }); console.error('  ✗', id, name, '\n     ', detail); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitReady = () => new Promise((res, rej) => { const t0 = Date.now();
  const guard = setTimeout(() => rej(new Error('server 20s 未就绪')), 20000); // 硬上限：连接被静默丢弃也要能退出
  const done = () => { clearTimeout(guard); res(); };
  const ping = () => http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 2000 }, r => r.statusCode < 500 ? done() : retry()).on('error', retry).on('timeout', retry);
  const retry = () => (Date.now() - t0 > 15000 ? rej(new Error('server 15s 未就绪')) : setTimeout(ping, 250)); ping(); });
const git = args => execSync('git ' + args, { cwd: ROOT, stdio: 'pipe' }).toString();
const sha1 = f => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch (_) { return 'absent'; } };
const HOST_FILES = ['data/store.json', 'my-radio.txt'].map(p => path.join(ROOT, p)); // 宿主持久面（Z1 终检）
const hostSnap = () => HOST_FILES.map(sha1).join('|');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dirty = git('status --porcelain').split('\n').map(l => l.trim()).filter(l =>
    l && !(l.startsWith('??') && l.slice(3).replace(/"|\r/g, '').startsWith('docs/ui-redesign-assets/evidence/')));
  if (dirty.length) { console.error('存在未提交改动（证据只采自提交态）：\n' + dirty.join('\n')); process.exitCode = 1; return; }
  const before = hostSnap(), started = new Date().toISOString();
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'vradio-evidence-'));
  let srv = null, browser = null, wtAlive = false;
  try {
    git(`worktree add --detach "${wt}" HEAD`); wtAlive = true; // 被测实例检出：数据面全在临时 worktree
    srv = spawn(process.execPath, ['server.js'], { cwd: wt, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
    await waitReady();
    const { chromium } = require(PW_PATH);
    browser = await chromium.launch();
    const open = async feat => { // 通用开页：feat='1' 预置 feat.uiRefresh（P2 开关开形态；不传 = 开关关 fresh 态）
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx.addInitScript(f => { localStorage.setItem('radio.baseline', 'done'); if (f) localStorage.setItem('feat.uiRefresh', f); }, feat); // 跳过首启基线门槛（不触后台全量体检）
      const page = await ctx.newPage();
      page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(20000); // 交互 15s 兜底：不可点即失败，绝不无限等
      await page.goto(`http://127.0.0.1:${PORT}/`);
      await page.waitForSelector('#list [data-k]', { timeout: 30000 });
      await sleep(900); // 首帧渲染/异步对账稳定
      return page;
    };
    let page = null, shot = null, vw = null, listW = null; // P1 段沿用既有局部名（不重排缩进）
    if (PHASE === 'p1') {
      page = await open();
      shot = (n, full) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: !!full });
      vw = () => page.evaluate(() => document.documentElement.clientWidth);
      listW = () => page.evaluate(() => Math.round(document.querySelector('#list').getBoundingClientRect().width));
    }

    if (PHASE === 'p1') { /* PR#29 验收证据组：窄屏全宽/宽口 900 封顶/640 主题搬家/三选双主题/Esc 焦点归还/组合筛选保词 */
    console.log(`[P1-E1/E2] 窄屏列表全宽（§6.11，commit 3237228 修复项）`);
    const widthPair = async () => ({ l: await listW(), v: await vw() });
    await page.setViewportSize({ width: 390, height: 844 }); await sleep(250);
    { const w = await widthPair();
      (Math.abs(w.l - w.v) <= 36 && w.v === 390) ? ok('E1', '390px 列表全宽（容器≈视口，无死空白）', `list=${w.l} vw=${w.v}`) : bad('E1', '390px 列表全宽', JSON.stringify(w)); }
    await shot('p1-390-grid');
    await page.setViewportSize({ width: 768, height: 1024 }); await sleep(250);
    { const w = await widthPair();
      (Math.abs(w.l - w.v) <= 36) ? ok('E2', '768px 列表全宽', `list=${w.l} vw=${w.v}`) : bad('E2', '768px 列表全宽', JSON.stringify(w)); }
    await shot('p1-768-grid');

    console.log('[P1-E7] 宽视口列表 900 封顶居中、1023/1024 边界无跳变（P1 无桌面壳，断点差异属 P2 断言组）');
    await page.click('#listBtn'); await sleep(300);
    await page.setViewportSize({ width: 1023, height: 768 }); await sleep(250);
    const p1023 = await page.evaluate(() => { const r = document.querySelector('#list').getBoundingClientRect(); const d = document.scrollingElement;
      return { w: Math.round(r.width), x: Math.round(r.x), ov: d.scrollWidth - d.clientWidth }; });
    await page.setViewportSize({ width: 1024, height: 768 }); await sleep(250);
    const p1024 = await page.evaluate(() => { const r = document.querySelector('#list').getBoundingClientRect(); const d = document.scrollingElement;
      return { w: Math.round(r.width), x: Math.round(r.x), ov: d.scrollWidth - d.clientWidth }; });
    (p1023.w === p1024.w && p1023.w <= 902 && p1024.x > 0 && p1023.ov === 0 && p1024.ov === 0)
      ? ok('E7', '两侧同宽 900 封顶居中、无横向溢出、边界无跳变', `1023:${JSON.stringify(p1023)} 1024:${JSON.stringify(p1024)}`)
      : bad('E7', '1023/1024 边界', `1023:${JSON.stringify(p1023)} 1024:${JSON.stringify(p1024)}`);
    await shot('p1-1024-listview');
    await page.click('#gridBtn'); await sleep(200);

    console.log('[P1-E3] 640px 主题入口搬家（#themeWrap 顶栏 ↔ #lowfreq）');
    await page.setViewportSize({ width: 641, height: 900 }); await sleep(300);
    const hostWide = await page.evaluate(() => !!document.querySelector('#themeWrap').closest('header'));
    await page.setViewportSize({ width: 639, height: 900 }); await sleep(300);
    const hostNarrow = await page.evaluate(() => !!document.querySelector('#themeWrap').closest('#lowfreq'));
    const labelText = await page.evaluate(() => { const s = document.querySelector('#themeBtn .theme-t'); return s ? getComputedStyle(s).display !== 'none' : false; });
    await page.click('#moreBtn'); await sleep(250); // 收纳菜单展开见主题入口
    const themeVisible = await page.evaluate(() => !!document.querySelector('#lowfreq #themeBtn') && document.querySelector('#lowfreq #themeBtn').offsetParent !== null);
    await shot('p1-639-lowfreq-theme');
    await page.click('#moreBtn'); await sleep(150);
    (hostWide && hostNarrow && labelText && themeVisible)
      ? ok('E3', '641 在顶栏 / 639 收进 lowfreq 且「主题：」文字可见', `wide=${hostWide} narrow=${hostNarrow} text=${labelText}`)
      : bad('E3', '640 主题入口搬家', `wide=${hostWide} narrow=${hostNarrow} text=${labelText} visible=${themeVisible}`);

    console.log('[P1-E4] 主题三选 + 双主题（点选写 radio.theme，auto 跟随系统；交互都在 1024 顶栏做，390 只截窄屏样张）');
    await page.setViewportSize({ width: 1024, height: 768 }); await sleep(250);
    await page.click('#themeBtn'); await sleep(200);
    (await page.evaluate(() => !document.querySelector('#themeMenu').hidden)) ? ok('E4a', '三选菜单展开', '') : bad('E4a', '菜单展开', 'hidden 未解除');
    await shot('p1-theme-menu');
    await page.click('#themeMenu [data-theme-v="light"]'); await sleep(250);
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light' ? ok('E4b', 'light 生效', '') : bad('E4b', 'light', await page.evaluate(() => document.documentElement.dataset.theme));
    await page.setViewportSize({ width: 390, height: 844 }); await sleep(250); await shot('p1-390-light');
    await page.setViewportSize({ width: 1024, height: 768 }); await sleep(250);
    await page.click('#themeBtn'); await page.click('#themeMenu [data-theme-v="dark"]'); await sleep(250);
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' ? ok('E4c', 'dark 生效', '') : bad('E4c', 'dark', await page.evaluate(() => document.documentElement.dataset.theme));
    await page.setViewportSize({ width: 390, height: 844 }); await sleep(250); await shot('p1-390-dark');
    await page.setViewportSize({ width: 1024, height: 768 }); await sleep(250);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.click('#themeBtn'); await page.click('#themeMenu [data-theme-v="auto"]'); await sleep(250);
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' ? ok('E4d', 'auto 跟随系统（dark）', '') : bad('E4d', 'auto', await page.evaluate(() => document.documentElement.dataset.theme));
    await page.emulateMedia({ colorScheme: 'light' }); await sleep(250);
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light' ? ok('E4e', 'auto 跟随系统（light）实时切换', '') : bad('E4e', 'auto 切换', await page.evaluate(() => document.documentElement.dataset.theme));

    console.log('[P1-E5] 主题菜单 Esc 收起 + 焦点归还触发器');
    await page.setViewportSize({ width: 1024, height: 768 }); await sleep(250);
    await page.evaluate(() => document.querySelector('#themeBtn').focus());
    await page.click('#themeBtn'); await sleep(200);
    await page.evaluate(() => document.querySelector('#themeMenu button').focus()); // 焦点入菜单
    await page.keyboard.press('Escape'); await sleep(200);
    const esc = await page.evaluate(() => ({ hidden: document.querySelector('#themeMenu').hidden, ae: document.activeElement && document.activeElement.id }));
    (esc.hidden && esc.ae === 'themeBtn') ? ok('E5', 'Esc 收起且焦点归还 #themeBtn', JSON.stringify(esc)) : bad('E5', 'Esc/焦点归还', JSON.stringify(esc));

    console.log('[P1-E6] 组合筛选 + 搜全部保词（DOM 接线级，§3.2/§3.4/§6.7）');
    await sleep(1500); // 等 logo 补全/异步对账的整表重渲平息，收藏点击不被重建打断
    const favKey = await page.evaluate(() => document.querySelector('#list [data-fav]').dataset.fav); // 收藏首台
    let favOn = false; // 点击后轮询 aria-pressed，未写上则重试一次（整表 innerHTML 重建可能吃掉首击）
    for (let t = 0; t < 2 && !favOn; t++) {
      await page.click(`#list [data-fav="${favKey}"]`); 
      for (let i = 0; i < 10 && !favOn; i++) { await sleep(200); favOn = await page.evaluate(k => { const b = document.querySelector(`#list [data-fav="${k}"]`); return !!b && b.getAttribute('aria-pressed') === 'true'; }, favKey); }
    }
    favOn ? ok('E6a0', '行内 ☆ 收藏写入（aria-pressed=true）', `k=${favKey.slice(0, 40)}`) : bad('E6a0', '收藏点击', '两次尝试未写上');
    await page.click('[data-c="★收藏"]'); await sleep(400);
    const favList = await page.evaluate(k => [...document.querySelectorAll('#list [data-k]')].map(r => r.dataset.k), favKey);
    (favList.length >= 1 && favList.includes(favKey)) ? ok('E6a', '收藏范围列表含刚收藏台', `n=${favList.length}`) : bad('E6a', '收藏范围', JSON.stringify(favList));
    await shot('p1-scope-fav');
    // 选一个不含收藏台的分类造空态：chip 分类 ≠ 收藏行 badge 分类（badge 在 cat≠全部/跨类时显示 s.c）
    const catChip = await page.evaluate(() => { const b = document.querySelector('#list .badge');
      const favC = b ? b.textContent.trim() : null;
      const cs = [...document.querySelectorAll('#cats [data-c]')].filter(c => !['全部', '★收藏', '最近'].includes(c.dataset.c) && c.dataset.c !== favC);
      return cs.length ? cs[0].dataset.c : null; });
    await page.click(`[data-c="${catChip}"]`); await sleep(400); // 收藏台不在该分类 → 空态
    const emptyMsg = await page.evaluate(() => { const e = document.querySelector('#list .empty'); return !!e && !document.querySelector('#list [data-k]'); });
    emptyMsg ? ok('E6b1', '组合筛选（收藏×分类）空态呈现', `cat=${catChip}`) : bad('E6b1', '组合筛选空态', '空态未出现');
    await page.fill('#q', '新闻'); await sleep(500); // 有关键词的空态才渲染「搜全部电台」（app.js emptyHtml acts 条件）
    const emptyQall = await page.evaluate(() => !!document.querySelector('[data-act="qall"]'));
    emptyQall ? ok('E6b2', '带词空态出现「搜全部电台」', '') : bad('E6b2', '空态 qall', '未见按钮');
    await page.click('[data-act="qall"]'); await sleep(400);
    const after = await page.evaluate(() => ({ q: document.querySelector('#q').value, n: document.querySelectorAll('#list [data-k]').length,
      all: !!document.querySelector('[data-c="全部"][aria-current="true"]'), cat: !!document.querySelector(`[data-c="${CSS.escape('新闻')}"][aria-current="true"]`) }));
    await shot('p1-qall-keepword');
    (after.q === '新闻' && after.n > 0 && after.all) ? ok('E6c', '搜全部保词：#q 保留、范围解除、结果非空', JSON.stringify(after)) : bad('E6c', '搜全部保词', JSON.stringify(after));
    await page.click('[data-c="★收藏"]'); await sleep(300);
    const catReset = await page.evaluate(c => !document.querySelector(`[data-c="${CSS.escape(c)}"][aria-current="true"]`), catChip); // catChip 须经 arg 传入（evaluate 不携带闭包）
    catReset ? ok('E6d', `切范围重置分类（§3.2，原=${catChip}）`, '') : bad('E6d', '切范围重置 cat', '分类 chip 仍高亮');
    } // —— P1 断言组结束 ——

    if (FAULT) throw new Error('故障注入：验证失败路径的退出码/浏览器回收/worktree 清理/宿主不变');
  } catch (e) {
    bad('Z0', '运行期异常（失败路径也落盘报告）', String(e && e.message || e).split('\n')[0]);
    process.exitCode = 1;
  } finally {
    try { if (browser) await browser.close(); } catch (_) {} // 断言抛错也不泄漏 Chromium（AIbot 二次 P2）
    try { if (srv) { srv.kill(); await new Promise(r => { const t = setTimeout(r, 3000); srv.once('exit', () => { clearTimeout(t); r(); }); }); } } catch (_) {}
    if (wtAlive) { try { git(`worktree remove --force "${wt}"`); } catch (_) { await sleep(800); try { git(`worktree remove --force "${wt}"`); } catch (e2) { console.error('临时 worktree 清理失败（请手动 git worktree remove --force）:', wt); } } }
    (hostSnap() === before) ? ok('Z1', '宿主 data/store.json + my-radio.txt 运行前后哈希不变（真隔离终检）', '') : bad('Z1', '宿主持久面被改动', `${before} → ${hostSnap()}`);
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ phase: PHASE, head: git('rev-parse --short HEAD').trim(), started, pass, fail, assertions: rec }, null, 2));
    if (fail) process.exitCode = 1;
    console.log(`phase-evidence(${PHASE}): ${pass} 通过, ${fail} 失败 → ${path.relative(ROOT, OUT)}`);
  }
}
main().catch(e => { console.error('phase-evidence 挂了:', e); process.exitCode = 1; });
