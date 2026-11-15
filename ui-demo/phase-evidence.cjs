#!/usr/bin/env node
/* 阶段验收证据采集（AIbot review PR#29/#30/#31「P2 验收证据」补全，ui-redesign §5.2 真实页面验证）：
   自举隔离——脚本自己 spawn 本 worktree 的 server.js（随机 82xx 端口，data/ 落本检出 gitignored 目录），
   绝不指向常驻实例（对普通 npm start 实例跑采集会清 radio.* 数据，见 PR#34 P0 同款红线）。
   Playwright 为全局 npm 安装的外部工具（VRADIO_PLAYWRIGHT 可覆盖路径），非仓库依赖。
   用法：node ui-demo/phase-evidence.cjs --phase=p1（P2/P3 断言组随各自分支扩展本文件）。
   产物：docs/ui-redesign-assets/evidence/<phase>/（截图 PNG + evidence.json 断言记录，随 PR 提交）；
   任何断言失败 exitCode=1（CI 可用）。boot 预置 radio.baseline='done' 跳过首启基线确认门槛。 */
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), http = require('http');

const PHASE = ((process.argv.find(a => a.startsWith('--phase=')) || '').split('=')[1] || 'p1');
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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
  try {
    await waitReady();
    const { chromium } = require(PW_PATH);
    const browser = await chromium.launch();
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

    if (PHASE === 'p2') { /* PR#30 验收证据：uiRefresh 开关关零回归 / 开关开桌面壳与 1023/1024 断点 / 双主题 / dock 焦点 */
      const snap = p => p.evaluate(() => ({ shell: document.documentElement.classList.contains('ui-refresh'),
        hero: getComputedStyle(document.querySelector('#resumeHero')).display, heroHidden: document.querySelector('#resumeHero').hidden,
        side: getComputedStyle(document.querySelector('.desktop-sidebar')).display,
        list: Math.round(document.querySelector('#list').getBoundingClientRect().width), vw: document.documentElement.clientWidth }));

      console.log('[P2-F1/F2] 开关关（默认）零回归：宽窄视口都不出壳');
      const off = await open();
      await off.setViewportSize({ width: 1024, height: 768 }); await sleep(300);
      let s = await snap(off);
      (!s.shell && s.hero === 'none' && s.side === 'none') ? ok('F2', '1024 开关关：无 ui-refresh 类、hero/侧栏 display:none（紧凑原样）', JSON.stringify(s)) : bad('F2', '开关关 1024', JSON.stringify(s));
      await off.screenshot({ path: path.join(OUT, 'p2-1024-off-compact.png') });
      await off.setViewportSize({ width: 390, height: 844 }); await sleep(250);
      s = await snap(off);
      (!s.shell && Math.abs(s.list - s.vw) <= 36) ? ok('F1', '390 开关关：列表全宽不受壳影响', `list=${s.list} vw=${s.vw}`) : bad('F1', '开关关 390', JSON.stringify(s));

      console.log('[P2-F3] 开关开 @1440：侧栏/主区壳/续听卡就位');
      const on = await open('1');
      await on.setViewportSize({ width: 1440, height: 900 }); await sleep(400);
      s = await snap(on);
      const grid = await on.evaluate(() => getComputedStyle(document.querySelector('.dashboard-shell')).gridTemplateColumns);
      (s.shell && s.side !== 'none' && !s.heroHidden && s.hero !== 'none' && grid.startsWith('200px'))
        ? ok('F3', 'ui-refresh 类 + 侧栏可见 + hero 显示 + 壳 200px 网格', `grid=${grid}`) : bad('F3', '开壳 1440', JSON.stringify({ ...s, grid }));
      await on.screenshot({ path: path.join(OUT, 'p2-1440-shell.png') });

      console.log('[P2-F4/F5] 开关开 <1024：CSS 拦截回紧凑（1023 断点 / 390 / 768）');
      await on.setViewportSize({ width: 1023, height: 768 }); await sleep(350);
      s = await snap(on);
      (s.side === 'none' && s.hero === 'none') ? ok('F4', '1023 侧栏/hero 双拦截（断点 1024 生效）', JSON.stringify(s)) : bad('F4', '1023 拦截', JSON.stringify(s));
      await on.screenshot({ path: path.join(OUT, 'p2-1023-on-compact.png') });
      await on.setViewportSize({ width: 390, height: 844 }); await sleep(250);
      s = await snap(on);
      (s.side === 'none' && s.hero === 'none' && Math.abs(s.list - s.vw) <= 36) ? ok('F5a', '390 紧凑全宽（开壳不泄漏）', `list=${s.list}`) : bad('F5a', '390 开壳紧凑', JSON.stringify(s));
      await on.screenshot({ path: path.join(OUT, 'p2-390-on.png') });
      await on.setViewportSize({ width: 768, height: 1024 }); await sleep(250);
      s = await snap(on);
      (s.side === 'none' && s.hero === 'none') ? ok('F5b', '768 紧凑（同口径）', '') : bad('F5b', '768 开壳紧凑', JSON.stringify(s));

      console.log('[P2-F6] 开壳双主题（ui-* token 双套）');
      await on.setViewportSize({ width: 1440, height: 900 }); await sleep(300);
      await on.click('#themeBtn'); await on.click('#themeMenu [data-theme-v="light"]'); await sleep(300);
      (await on.evaluate(() => document.documentElement.dataset.theme)) === 'light' ? ok('F6a', '开壳 light 生效', '') : bad('F6a', 'light', await on.evaluate(() => document.documentElement.dataset.theme));
      await on.screenshot({ path: path.join(OUT, 'p2-1440-light.png') });
      await on.click('#themeBtn'); await on.click('#themeMenu [data-theme-v="dark"]'); await sleep(300);
      (await on.evaluate(() => document.documentElement.dataset.theme)) === 'dark' ? ok('F6b', '开壳 dark 生效', '') : bad('F6b', 'dark', await on.evaluate(() => document.documentElement.dataset.theme));
      await on.screenshot({ path: path.join(OUT, 'p2-1440-dark.png') });

      console.log('[P2-F7] hero 焦点：签名未变重渲早退不重建（防焦点丢失）');
      const hasHero = await on.evaluate(() => !!document.querySelector('#heroPlay'));
      if (hasHero) {
        await on.evaluate(() => document.querySelector('#heroPlay').focus());
        await on.evaluate(() => App.renderHero()); // 同状态重渲 → 签名早退
        (await on.evaluate(() => document.activeElement && document.activeElement.id)) === 'heroPlay' ? ok('F7', '重渲后焦点仍在 #heroPlay', '') : bad('F7', 'hero 焦点', '焦点丢失');
      } else bad('F7', 'hero 焦点', '无 #heroPlay（候选缺失）');

      console.log('[P2-F8] dock：--dock-h 实测 + footer fixed + 键盘可达');
      const dock = await on.evaluate(() => ({ dock: document.documentElement.style.getPropertyValue('--dock-h'),
        spb: getComputedStyle(document.documentElement).scrollPaddingBottom, foot: getComputedStyle(document.querySelector('footer')).position }));
      (parseFloat(dock.dock) > 0 && dock.foot === 'fixed' && parseFloat(dock.spb || '0') > 0)
        ? ok('F8a', '--dock-h 写入 + footer fixed + scroll-padding 联动', JSON.stringify(dock)) : bad('F8a', 'dock', JSON.stringify(dock));
      await on.evaluate(() => { const rs = document.querySelectorAll('#list [data-k]'); rs[rs.length - 1].focus(); }); // 从列表末行出发：DOM 序 footer 紧随其后
      let inFoot = false; for (let i = 0; i < 6 && !inFoot; i++) { await on.keyboard.press('Tab'); inFoot = await on.evaluate(() => !!(document.activeElement && document.activeElement.closest('footer'))); }
      inFoot ? ok('F8b', '键盘 Tab 可达底栏控件（列表末行 → footer）', '') : bad('F8b', 'Tab 到 footer', '6 次 Tab 未达');
    }

    await browser.close();
  } finally { srv.kill(); }
  const started = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ phase: PHASE, head: require('child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(), started, pass, fail, assertions: rec }, null, 2));
  console.log(`phase-evidence(${PHASE}): ${pass} 通过, ${fail} 失败 → ${path.relative(ROOT, OUT)}`);
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error('phase-evidence 挂了:', e); process.exitCode = 1; });
