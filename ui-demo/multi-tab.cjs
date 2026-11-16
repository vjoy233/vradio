#!/usr/bin/env node
/* VRadio 多标签真实页面对抗矩阵（P2，docs/testing-strategy-2026-11.md §3 L2.4 + L3 数据状态节）。
   pr-smoke.cjs 的姊妹篇：自举隔离 / Z2 宿主终检 / Z3 清理门 / 提交态门 / 资源噪音分流 / 报告格式全部同款。
   被测拓扑（探针实测拍板，与任务「两 context（同 instance 两 page）」对齐）：
   · context1 双 page（pa/pb）= 真·同浏览器双标签——共享 localStorage 镜像 + BroadcastChannel 跨页可达，
     承载活广播收敛 / 共享镜像对抗写 / 断网 dirty 重推；
   · context2 单 page（pc）= 真·第二浏览器（独立存储分区）——BroadcastChannel 不跨 context（实测 pulls=0），
     承载空库开局页 unload 防清库（issue #42 回归门，reload 直接触发 beforeunload 链）/ 对账收敛（boot apply
     同链）/ 分区镜像真·last-write-wins / 最终一致舞步。
   实测语义基线（写入断言口径，脚本 note 同步留痕）：
   · 同浏览器他页写 → 本页镜像立即收敛（共享存储）+ 广播 pull 后 Store.rev 收敛；App 内存态**不**随广播重载
     ——store.js apply() 以「镜像 ≠ 后端」为重载门槛，共享镜像下两者恒等（memFav=false 实测）——内存收敛走
     reload/boot 读镜像路径，断言按此分层；
   · 他页经 /api/store 直写不产 Store 广播（广播只在 Store.flush）——维护冲突用直写 + 显式 Store.pull()
     驱动，pull 是广播到达后运行的同一条真实处理链（fetch → apply 键级比对 → applyServerStore → externalChanged）。
   播放样本：脚本自建本地静音 WAV 流（127.0.0.1 83xx 端口，真机 headless Chromium 实测可到 playing；
   真实公网流不可保证），点播 → playing → quality/listenstats 服务端样本全走真实客户端链。
   产物：docs/test-reports/multi-tab/validation.json（失败截图 docs/test-reports/multi-tab/）。
   已知缺陷豁免（review#40 P2）：KNOWN_FAILURES/BLOCKED_REQUIREMENTS 结构化数组随报告输出——跨浏览器
   陈旧 unload 覆盖（KF2）/M6 旧投影名（KF3）/生产修复挂账（KF4）按现状特征化断言（全 PASS 不代表
   跨端收敛/投影重投已验收）；同页内存不同步（KF1）已随链内 review#37 P1-2 修复转 expectFixed 回归守卫；
   守卫口径：expectBuggy 特征化场景意外转绿 / expectFixed 已修场景回归，均整场报错提示处置。
   Playwright 为外部工具（VRADIO_PLAYWRIGHT 指向安装路径），非仓库依赖。
   跑法：VRADIO_PLAYWRIGHT=".../playwright" node ui-demo/multi-tab.cjs */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const output = path.resolve(__dirname, '../docs/test-reports/multi-tab');
const ROOT = path.resolve(__dirname, '..');
fs.mkdirSync(output, { recursive: true });
const git = a => execSync('git ' + a, { cwd: ROOT, stdio: 'pipe' }).toString();
const sha1 = f => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch (_) { return 'absent'; } };
const hostSnap = () => ['data/store.json', 'my-radio.txt'].map(p => sha1(path.join(ROOT, p))).join('|'); // Z2 终检：宿主持久面
const httpGet = u => new Promise((resolve, reject) => { const r = http.get(u, res => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); r.setTimeout(2000, () => { r.destroy(); reject(new Error('timeout')); }); });
const getJson = u => new Promise((resolve, reject) => { http.get(u, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject); });
const pickPort = base => new Promise((resolve, reject) => { // base=82xx 应用实例 / 83xx 伪流（同段探空闲，同 p6 口径）
  let p = base + Math.floor(Math.random() * 80), tried = 0;
  const tryOne = () => { if (++tried > 100) return reject(new Error(base + ' 端口段全忙')); const s = net.createServer();
    s.once('error', () => tryOne(p >= base + 79 ? (p = base) : ++p)); s.listen(p, '127.0.0.1', () => s.close(() => resolve(p))); };
  tryOne();
});
// 本地静音 WAV 流（8000Hz 单声道 16bit × 240s，定长 Content-Length）：URL .mp3 走直流 variant，真实到 playing
function wavBuf() { const rate = 8000, secs = 240, pcm = Buffer.alloc(rate * 2 * secs); const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); }
// —— 已知缺陷结构化豁免（review#40 P2）：特征化测试的状态台账，随 validation.json 输出。
//    status: open = 缺陷仍在（特征化断言 + expectBuggy 守卫：意外转绿即报错提示移除豁免）；
//    fixed = 已随链内修复转绿（expectFixed 回归守卫：再转红即报错提示恢复豁免）。
//    ⚠ KF1 状态演进：PR #40 原基线实测「内存不随广播收敛」，rebase 后链内 71fbdf9（review#37 P1-2，
//    apply 改比对本页内存基线）已修——豁免转为回归守卫，台账如实记录而非删除。 ——
const KNOWN_FAILURES = [
  { id: 'KF1', status: 'fixed', scenario: 'SA 段（同浏览器双标签）', expected: '他页写 → 广播到达 → 本页 App 内存态即时收敛（活广播重载内存）',
    actual: 'PR #40 原基线：内存不随广播重载（apply 旧门槛「镜像 ≠ 后端」，共享镜像下恒等）只能 reload 兜底；rebase 后已修——71fbdf9 review#37 P1-2 改比对「本页内存基线」而非共享镜像，广播 pull 即收敛（[KF] 段 KF1 探针实证）',
    tracking: '链内 71fbdf9 review#37 P1-2 已修（原挂 issue #42 关联面）；回归守卫 = expectFixed KF1' },
  { id: 'KF2', status: 'open', scenario: 'SD 段（跨浏览器第二浏览器）', expected: '他端写入后本端自动收敛；陈旧 unload 不覆盖他端写入',
    actual: '跨浏览器无 BC 通道：reload/关闭的 beforeunload flush 以本页陈旧快照覆盖他端写入（空覆盖门只在服务端拦全空快照，非空陈旧快照仍 LWW 覆盖）；收敛须手动 Store.pull()+flush 舞步（SD5/SD5a/SD6 按显式 pull 断言）。⚠ 探针 flaky 面已实证：Chromium unload 期 keepalive fetch 偶发不派发 → 陈旧 flush 没发 → 服务端 vol 停 0.66 被误读「意外转绿」（reviewer 单次转绿 / wt40-r2 复跑 3/3 成立 / 链尾复验单次转绿，三方不一致=概率性）——probe 已加固：服务端 rev 增量核验陈旧 flush 是否真的发出，未发重试一次，两次未发判探针失效记 note（本轮不判 KF2，豁免状态维持）',
    tracking: 'issue #42 + 生产修复批次（跨端收敛协议）' },
  { id: 'KF3', status: 'open', scenario: 'M6（维护冲突「重新加载最新值」）', expected: '重载后输入框显示后端权威值（B 名）',
    actual: '输入框回到上一投影名（round1 落库的 A 名）——远程 cfg.names 改名不经 applySources 不重投 uiStationProjection 的 s.n；草稿丢弃正确但显示陈旧',
    tracking: 'issue #42 + UI 维护面板生产修复批次' },
  { id: 'KF4', status: 'open', scenario: '生产修复挂账（本矩阵范围外）', expected: '跨端自动收敛 / 投影重投随生产修复落地',
    actual: 'KF2/KF3 按现状特征化断言，对应场景全部 PASS 不代表修复完成；KF1 已随链内修复转回归守卫（见其 status）', tracking: 'issue #42（空覆盖门已落）/ 后续生产修复批次' },
];
const BLOCKED_REQUIREMENTS = [ // 阻塞中的验收要求：修复落地前，相关段不可解读为「已验收」（已修项移出）
  { req: '跨浏览器最终一致（陈旧 unload 不覆盖他端）', blockedBy: 'KF2 特征化现状（手动 pull/flush 收敛为临时口径）', tracking: 'issue #42 + 生产修复批次' },
  { req: '维护冲突重载显示后端权威值（投影重投）', blockedBy: 'KF3 特征化现状（草稿丢弃正确但显示旧投影名）', tracking: 'issue #42 + UI 维护面板生产修复批次' },
];
(async () => {
  let chromium = null; // Playwright 加载收口（同 pr-smoke）：缺工具也写 FAIL 报告 + 非零退出，不裸崩
  try { chromium = require(process.env.VRADIO_PLAYWRIGHT || 'playwright').chromium; }
  catch (e) {
    const report = { capturedAt: new Date().toISOString(), result: 'FAIL', failure: '环境失败——Playwright 加载失败（VRADIO_PLAYWRIGHT 指向安装路径；CI 走 .ci/browser/）: ' + e.message, assertions: [], errors: [], resourceErrors: [], notes: [] };
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
    console.error('FAIL（环境失败）: Playwright 加载失败——', e.message); process.exitCode = 1; return;
  }
  const dirty = git('status --porcelain').split('\n').map(l => { const m = l.trim().match(/^(..)\s+(.+)$/); return m ? m[2].replace(/"/g, '') : ''; })
    .filter(p => p && !p.startsWith('docs/test-reports/multi-tab/')); // 提交态门：证据只采自提交态（本脚本产物目录豁免）
  if (dirty.length) { console.error('存在未提交改动（证据只采自提交态）：\n' + dirty.join('\n')); process.exitCode = 1; return; }
  const before = hostSnap();
  let browser = null, srv = null, sstream = null, wt = null, wtAlive = false, page = null;
  const pages = []; const report = { capturedAt: new Date().toISOString(), url: '', assertions: [], errors: [], resourceErrors: [], notes: [] };
  const check = (name, ok) => { assert(ok, name); report.assertions.push(name); console.log('  ✓', name); };
  const note = t => report.notes.push(t);
  // 已知缺陷特征化守卫（review#40 P2）：cond=true = 现状缺陷仍在（豁免成立，记断言）；cond=false =
  // 意外转绿（生产已修）→ 整场报错退出，提示更新对应断言并从 KNOWN_FAILURES 移除该豁免，防豁免腐化
  const expectBuggy = (id, cond, hint) => {
    if (!cond) throw new Error(`KNOWN_FAILURE ${id} 意外转绿：${hint}`);
    report.assertions.push(`${id} 豁免成立`); console.log('  ✓', `${id} 豁免成立（特征化现状保留）`);
  };
  // 已修复缺陷回归守卫（KF1 同款）：cond=true = 链内修复仍生效（记断言）；cond=false = 回归 →
  // 整场报错退出，提示恢复 KNOWN_FAILURES 豁免并核查对应修复
  const expectFixed = (id, cond, hint) => {
    if (!cond) throw new Error(`KNOWN_FAILURE ${id} 回归（原豁免已随链内修复移除）：${hint}`);
    report.assertions.push(`${id} 修复回归守卫`); console.log('  ✓', `${id} 修复回归守卫（原缺陷已修，防回退）`);
  };
  const failShot = async name => { try { if (pages[0]) { await pages[0].screenshot({ path: path.join(output, name) }); note('失败现场截图: ' + name); } } catch (_) {} }; // 顶层定义（catch 域可见；pr-smoke 内联版有同位 ReferenceError 隐患，此处收口）
  try {
    const port = await pickPort(8200), sport = await pickPort(8300);
    const base = `http://127.0.0.1:${port}/`, fake = `http://127.0.0.1:${sport}/live.mp3`;
    report.url = base;
    wt = fs.mkdtempSync(path.join(os.tmpdir(), 'vradio-mtab-'));
    git(`worktree add --detach "${wt}" HEAD`); wtAlive = true;
    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1' };
    delete env.VR_TEST_Q_MAX;
    srv = spawn(process.execPath, ['server.js'], { cwd: wt, env, stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) { await new Promise(r => setTimeout(r, 100)); if (srv.exitCode !== null) break; try { ready = (await httpGet(base)) === 200; } catch (_) {} }
    if (!ready) throw new Error(`自举隔离服务未就绪（${base}）——端口冲突/服务启动异常`);
    const wav = wavBuf();
    sstream = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length), 'Access-Control-Allow-Origin': '*' }); res.end(wav); });
    await new Promise(r => sstream.listen(sport, '127.0.0.1', r));
    console.log(`自举隔离实例 ${base}（cwd=临时 worktree 宿主零接触）+ 本地静音流 ${fake}`);

    browser = await chromium.launch({ headless: true });
    const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' }); // 同浏览器双标签
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' }); // 第二浏览器（独立分区）
    const pa = await ctx1.newPage(), pb = await ctx1.newPage(), pc = await ctx2.newPage();
    pages.push(pa, pb, pc);
    for (const p of pages) {
      p.on('pageerror', e => report.errors.push('pageerror:' + e.message));
      p.on('console', m => { if (m.type() === 'error') { const t = m.text() || ''; (/^Failed to load resource/.test(t) ? report.resourceErrors : report.errors).push('console:' + t); } }); // 资源噪音分流（同 pr-smoke：自举实例合法 404 只记不判）
    }
    const waitBoot = p => p.waitForFunction(() => typeof App !== 'undefined' && App.state.stations.length > 50, null, { timeout: 20000 });
    const pullsOf = p => p.evaluate(() => window.__pulls || 0);
    const srvState = async () => (await getJson(base + 'api/store')).data || {}; // Node 侧直读后端（GET 免 Origin）
    const pickSt = (p, exclude) => p.evaluate(ex => { const cnt = {}, ucnt = {}; for (const s of App.state.stations) { cnt[s.n] = (cnt[s.n] || 0) + 1; for (const u of s.u) ucnt[u] = (ucnt[u] || 0) + 1; } const exK = new Set(ex || []);
      // 名唯一 + 主 URL 全库唯一（URL 被他台共享时改名会按 URL 连坐改名 → keyOf 撞名 → 编辑器 resolve 多重匹配抛错）
      const s = App.state.stations.find(x => !x.hidden && x.health !== 'dead' && !App.favKeys().has(keyOf(x)) && !exK.has(keyOf(x)) && cnt[x.n] === 1 && ucnt[x.u[0]] === 1 && Array.from(x.n).length <= 20);
      return s ? { k: keyOf(s), u0: s.u[0], n: s.n } : null; }, exclude || []);
    const counts = p => p.evaluate(() => ({ pulls: window.__pulls || 0, rev: Store.rev, favs: Store.get('radio.favs') || '', theme: Store.get('radio.theme') || '', view: Store.get('radio.view') || '', dead: Store.get('radio.showdead') || '', vol: Store.get('radio.vol') || '' }));
    const instrument = p => p.evaluate(() => { window.__pulls = 0; const op = Store.pull.bind(Store); Store.pull = (...a) => { window.__pulls++; return op(...a); }; }); // pull 计数（BC 广播到达证据；自页 flush 不回声）
    const boot = async p => { await p.goto(base); await p.reload(); await waitBoot(p); await p.waitForTimeout(300); };

    // —— [S] 三页启动（pa/pb 同浏览器双标签，pc 第二浏览器）——
    console.log('[S] 启动（ctx1 双标签 pa/pb + ctx2 第二浏览器 pc）');
    await boot(pa); await instrument(pa); await boot(pb); await instrument(pb); await boot(pc); await instrument(pc);
    for (const [nm, p] of [['pa', pa], ['pb', pb], ['pc', pc]]) check(`S1 ${nm} 全库装配 >50 台`, await p.evaluate(() => App.state.stations.length > 50));
    check('S2 后端 /api/store 可达（rev/data 形态）', typeof (await getJson(base + 'api/store')).rev === 'number');
    check('S3 三页零 pageerror（启动段）', report.errors.length === 0);

    // —— [SA] A 写 → B 活广播收敛（同浏览器：镜像共享即时 + quiesce 后端收敛 + reload 内存收敛）——
    console.log('[SA] A 写 → B 收敛');
    const st1 = await pickSt(pa);
    const pBBase = await pullsOf(pb);
    await pa.evaluate(k => App.toggleFav(App.state.stations.find(x => keyOf(x) === k)), st1.k); // 行内 ☆ 同款 API（p6 口径）
    await pb.waitForFunction(k => (localStorage.getItem('radio.favs') || '').includes(k), st1.k, { timeout: 5000 });
    const b1 = await counts(pb);
    check(`SA1 B 页镜像即时收敛（radio.favs 含 ${st1.n}——同浏览器同源共享存储区，写者 setItem 对他页同步可见）`, b1.favs.includes(st1.k));
    await new Promise(r => setTimeout(r, 1200)); // quiesce：300ms debounce flush + 广播 + 各页 pull 全落地（含 boot 链尾延迟 flush，探针实测口径）
    check('SA2 B 页广播重拉后 Store.rev 收敛到后端', (await counts(pb)).rev === (await getJson(base + 'api/store')).rev);
    check('SA3 后端已落 A 的收藏（Node 直读 /api/store）', ((await srvState())['radio.favs'] || '').includes(st1.k));
    // BC 无回声 + 跨页投递（确定性验证）：pa 自发 'store'——BC 规范排除发送者自身 → pa 不 pull；pb 同通道必收 → 恰拉一次
    const pABase = await pullsOf(pa);
    await pa.evaluate(() => Store.bc && Store.bc.postMessage('store'));
    await pb.waitForFunction(n => window.__pulls > n, pBBase, { timeout: 5000 });
    check('SA4 自发广播：pa 零回声（Store.pull 增量 0）、pb 跨页收到', (await pullsOf(pa)) === pABase);
    note('内存态语义（KF1 状态演进如实记录）：PR #40 原基线实测不随广播重载（apply 旧门槛「镜像 ≠ 后端」，共享镜像下恒等）；rebase 后链内 71fbdf9 review#37 P1-2 改比对内存基线，广播 pull 即收敛内存——[KF] 段 KF1 修复回归守卫实证；SA5/SB2 的 reload 保留为冗余收敛路径验证');
    await pb.reload(); await waitBoot(pb);
    check('SA5 B 页 reload 后 App 内存收敛（favKeys 命中）', await pb.evaluate(k => App.favKeys().has(k), st1.k));
    await pb.click('#cats .chip[data-c="★收藏"]');
    await pb.waitForTimeout(300);
    check('SA6 B 页 UI 收敛（★收藏范围恰 1 台）', await pb.evaluate(() => App.state.scope === 'favorites' && App.visible().length === 1 && document.querySelectorAll('#list [data-fn]').length === 1));
    await pb.click('#cats .chip[data-c="全部"]');
    await pa.click('#themeBtn'); await pa.click('#themeMenu [data-theme-v="light"]'); // 真实三选菜单链
    await new Promise(r => setTimeout(r, 1200));
    check('SA7 A 主题写落后端（light）', (await srvState())['radio.theme'] === 'light');
    await pb.reload(); await waitBoot(pb);
    check('SA8 B 页主题随 A 收敛（data-theme=light + 内存）', await pb.evaluate(() => document.documentElement.dataset.theme === 'light' && App.state.theme === 'light'));

    // —— [SB] B 写 → A 反向收敛 ——
    console.log('[SB] B 写 → A 收敛');
    const st2 = await pickSt(pb);
    await pb.evaluate(k => App.toggleFav(App.state.stations.find(x => keyOf(x) === k)), st2.k);
    await pb.click('#themeBtn'); await pb.click('#themeMenu [data-theme-v="dark"]');
    await new Promise(r => setTimeout(r, 1200)); // quiesce：双写一次 flush 全量携两条 + 广播 + pa pull（pa 无待推写 → 无回写竞态）
    const sbd = await srvState();
    check('SB1 后端收敛到 B 的写入（favs 含新台 + theme dark）', sbd['radio.favs'].includes(st2.k) && sbd['radio.theme'] === 'dark');
    await pa.reload(); await waitBoot(pa);
    const ra = await pa.evaluate(k => ({ fav: App.favKeys().has(k), theme: document.documentElement.dataset.theme, favN: App.favKeys().size }), st2.k);
    check(`SB2 A 页 reload 后收藏收敛（含 ${st2.n}，共 2 台）`, ra.fav && ra.favN === 2);
    check('SB3 A 页主题随 B 收敛（data-theme=dark）', ra.theme === 'dark');

    // —— [SC] 同浏览器对抗写（两页几乎同时各写不同键 → 共享镜像全量快照推送，后推者胜、双方零丢失）——
    console.log('[SC] 同浏览器对抗写');
    await pa.evaluate(() => Store.set('radio.view', 'list'));
    await pb.evaluate(() => Store.set('radio.showdead', '1'));
    await new Promise(r => setTimeout(r, 1100)); // 两页 debounce flush + 双向广播 pull 全落地
    const sd = await srvState();
    check('SC1 后端两键均落库（全量快照携对方写入，零丢失）', sd['radio.view'] === 'list' && sd['radio.showdead'] === '1');
    const ca = await counts(pa), cb = await counts(pb);
    const srvRev = (await getJson(base + 'api/store')).rev;
    check('SC2 双方 rev 收敛一致（= 后端 rev，后推者发号为准）', ca.rev === cb.rev && cb.rev === srvRev);
    check('SC3 镜像互见（A 见 B 的 showdead、B 见 A 的 view）', ca.dead === '1' && cb.view === 'list');
    note('共享镜像下两页 flush 载荷恒相同（后推者胜体现为 rev 单调推进而非数据分叉）；分叉镜像的真·LWW 在 [SD] 跨浏览器档');

    // —— [SD] 空库开局页 unload 防清库（issue #42 回归门）+ 跨浏览器真·last-write-wins + 双方最终一致 ——
    // pc 是 [S] 段空库态开局的第二浏览器（独立分区镜像零写、boot 时空库未 apply 过非空数据）：reload 触发的
    // beforeunload flush 正是 issue #42 场景——修复前以全空快照整库清掉 SA/SB/SC 写入（探针实测发现项）；
    // 修复后客户端空覆盖门拦下（store.js：不发推改走对账）+ 服务端 rev>0 拒全空快照（server.js 409）双保险，
    // reload 恢复安全；reload 后 boot 即「pull 后收敛」同链（GET→键级比对→applyServerStore），无需显式 pull。
    console.log('[SD] 空库开局页 unload 防清库 + 跨浏览器 last-write-wins');
    const sdBefore = await srvState();
    await pc.reload(); await waitBoot(pc); // 空库开局页 unload flush(true) 过门——SD0 全景验收
    await pc.waitForFunction(({ k1, k2 }) => App.favKeys().has(k1) && App.favKeys().has(k2), { k1: st1.k, k2: st2.k }, { timeout: 8000 });
    const sdAfter = await srvState();
    check('SD0 空库开局页 unload 不清库（issue #42）：他页写入（favs 两台/主题/视图/无效源开关）全数仍在（空覆盖门 + 服务端双保险）',
      sdAfter['radio.favs'] === sdBefore['radio.favs'] && sdAfter['radio.theme'] === sdBefore['radio.theme']
      && sdAfter['radio.view'] === sdBefore['radio.view'] && sdAfter['radio.showdead'] === sdBefore['radio.showdead']);
    const rc0 = await pc.evaluate(() => ({ theme: App.state.theme, rev: Store.rev }));
    check('SD1 第二浏览器对账收敛（两收藏/主题随主源，内存经 apply diff 重载）', rc0.theme === 'dark' && rc0.rev === (await getJson(base + 'api/store')).rev);
    await new Promise(r => setTimeout(r, 1200)); // quiesce：pc 对账 applyServerStore→rebind 回写链的 debounce flush 落地（其快照缺 vol，先落地再写 vol 防互踩）
    await pa.evaluate(() => Store.set('radio.vol', '0.8')); await pa.evaluate(() => Store.flush()); await new Promise(r => setTimeout(r, 500));
    check('SD2 A 写 vol 落后端', (await srvState())['radio.vol'] === '0.8');
    const revBefore = (await getJson(base + 'api/store')).rev;
    await pc.evaluate(() => Store.set('radio.view', 'grid')); await pc.evaluate(() => Store.flush()); await new Promise(r => setTimeout(r, 500));
    const sd2 = await srvState();
    check('SD3 后推者 pc 全量快照胜：view 翻转落库 + A 的 vol 被覆盖出局 + rev 前进（显式 LWW，无按键合并）',
      sd2['radio.view'] === 'grid' && sd2['radio.vol'] === undefined && (await getJson(base + 'api/store')).rev > revBefore);
    check('SD4 A 本地镜像不丢（失败不丢镜像保证的常态面）', (await counts(pa)).vol === '0.8');
    await pc.evaluate(() => Store.set('radio.showdead', '1')); await pc.evaluate(() => Store.flush());
    await new Promise(r => setTimeout(r, 1200)); // quiesce：pc flush/回写链全落地
    // 收敛舞步（实测语义：跨浏览器 reload 的 beforeunload flush 会以本页**非空陈旧**快照清掉他页写入——
    // 这是 LWW 自带「最后同步者胜」的既有语义（issue #42 明确不批增量对账/lastSeenRev 改造），与空库开局页
    // 的全空 wipe（SD0 门管）不同面；收敛必须走「落后页 pull 对手态（apply 键级比对：新值覆盖、后端缺键保
    // 本地）→ 推全量」链，不能用 reload。pa pull 后其镜像 = 并集 {vol 本地保留, grid/showdead 自 pc}：
    await pa.evaluate(() => Store.pull());
    await pa.waitForFunction(() => Store.get('radio.view') === 'grid', null, { timeout: 8000 }); // apply 完成信号（pc 的 grid 到达）
    const paMid = await counts(pa);
    check('SD5a pa pull 对账成并集（view grid/showdead 1 自 pc，vol 本地保留——后端缺键不抹本地）', paMid.view === 'grid' && paMid.dead === '1' && paMid.vol === '0.8');
    await pa.evaluate(() => Store.flush()); // pa 推并集全量
    await new Promise(r => setTimeout(r, 800)); // pa 回写链 + 本次 flush 落地
    const sd3 = await srvState();
    check('SD5 收敛舞步后后端全量齐备（vol/view/showdead 三键共存）', sd3['radio.vol'] === '0.8' && sd3['radio.view'] === 'grid' && sd3['radio.showdead'] === '1');
    await pc.evaluate(() => Store.pull());
    await pc.waitForFunction(() => Store.get('radio.vol') === '0.8', null, { timeout: 8000 });
    const rc1 = await pc.evaluate(() => ({ vol: Store.get('radio.vol'), view: Store.get('radio.view'), dead: Store.get('radio.showdead'), memView: App.state.view }));
    check('SD6 双方最终一致：pc 镜像+内存与后端/A 镜像三方齐', rc1.vol === '0.8' && rc1.view === 'grid' && rc1.dead === '1' && rc1.memView === 'grid');

    // —— [Q] 质量/统计 sidecar 多标签合流（A/B 各点播一台，合流不互踩）——
    console.log('[Q] 质量/统计 sidecar 合流');
    const playToPlaying = async (p, st) => { // 点播 → 本地静音流真实到 playing → 结算 ≥1s → 统计 flush → 停止
      await p.evaluate(({ k, fake }) => { const s = App.state.stations.find(x => keyOf(x) === k);
        s.u.push(fake); s.mo = s.u.map((_, i) => i); s.moManual = false; // mo 重建使追加源进入有效序（applyCfg 装配的 mo 只含原 s.u 索引）
        Player.play(s, s.u.length - 1); }, { k: st.k, fake });
      await p.waitForFunction(() => App.phase === 'playing', null, { timeout: 15000 });
      await new Promise(r => setTimeout(r, 1400)); // 收听 tick 结算（tickMin=1s）+ 质量样本 500ms debounce flush
      await p.evaluate(() => ListenStats.flush());
      await p.evaluate(() => Player.stop());
      await p.waitForFunction(() => App.phase === 'idle', null, { timeout: 5000 });
    };
    const sa = await pickSt(pa), sb = await pickSt(pb, [sa.k]);
    check('Q0 两台身份不同（合流前提）', sa.u0 !== sb.u0);
    await playToPlaying(pa, sa);
    let q = await getJson(base + 'api/quality'), l = await getJson(base + 'api/listenstats');
    const today = await pa.evaluate(() => { const d = new Date(), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); });
    const qs = q.data[sa.u0] && Object.values(q.data[sa.u0].sources || {}).some(x => x.okCount >= 1);
    const lsA = l.days[today] && l.days[today].stations[sa.u0] >= 1 && l.days[today].sessions >= 1;
    check(`Q1 A 点播后质量样本落服务端（ok 样本 ≥1，identity=${sa.u0.slice(0, 36)}…）`, !!qs);
    check('Q2 A 点播后收听统计落服务端（当日台桶 ms≥1 + session ≥1）', !!lsA);
    await playToPlaying(pb, sb);
    q = await getJson(base + 'api/quality'); l = await getJson(base + 'api/listenstats');
    const both = [sa.u0, sb.u0].every(u0 => q.data[u0] && Object.values(q.data[u0].sources || {}).some(x => x.okCount >= 1));
    check('Q3 B 点播另一台后质量 sidecar 两台并存（合流不互踩）', both);
    const lday = l.days[today] || {};
    check('Q4 统计 sidecar 两台并存且会话累计 ≥2', (lday.stations || {})[sa.u0] >= 1 && (lday.stations || {})[sb.u0] >= 1 && lday.sessions >= 2);
    note(`播放样本经本地静音 WAV 流真实到 playing（headless 可复现）；quality rev=${q.rev} listenstats rev=${l.rev}`);

    // —— [M] 维护冲突三选（P4：重新加载最新值/明确覆盖此对象/继续编辑）——
    console.log('[M] 维护冲突三选');
    const apiWriteCfg = (u0, name) => pb.evaluate(async ({ u0, name }) => { // B 页经 /api/store 直改 radio.cfg（模拟他页已保存；直写不产 Store 广播——广播只在 Store.flush）
      const r = await fetch('/api/store').then(x => x.json()); const data = (r && r.data) || {};
      let cfg = {}; try { cfg = JSON.parse(data['radio.cfg'] || '{}'); } catch (_) {}
      cfg.v = 2; cfg.names = cfg.names || {}; cfg.names[u0] = name;
      data['radio.cfg'] = JSON.stringify(cfg);
      const w = await fetch('/api/store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) }).then(x => x.json());
      return !!(w && w.ok);
    }, { u0, name });
    // pull 触发器说明：pa 显式 Store.pull() = 他页广播到达后运行的同一条真实处理链（fetch → apply 键级比对
    // → applyServerStore → mEditor.externalChanged）——API 直写缺广播这一触发器，此处补齐（语义见脚本头注）。
    const pullThenWait = async name => { await apiWriteCfg(sa.u0, name); await pa.evaluate(() => Store.pull());
      await pa.waitForFunction(({ u0, name }) => App.cfg.names && App.cfg.names[u0] === name, { u0: sa.u0, name }, { timeout: 8000 }); };
    await pa.click('#sideManage'); await pa.waitForTimeout(400);
    check('M1 维护面板三分区 + dialog 语义', (await pa.locator('#mTabC').count()) && (await pa.locator('#mTabS').count()) && (await pa.locator('#mTabD').count())
      && await pa.evaluate(() => { const b = document.querySelector('#manage .mbox'); return b && b.getAttribute('role') === 'dialog' && b.getAttribute('aria-modal') === 'true' && !!b.getAttribute('aria-label'); }));
    await pa.click('#mTabS'); await pa.waitForTimeout(200);
    await pa.fill('#mq', sa.n); await pa.waitForTimeout(300);
    await pa.locator('#mlist [data-act="edit"]').first().click(); await pa.waitForTimeout(400);
    const okEditor = await pa.evaluate(() => !!document.querySelector('#mEdit input, #dEdit input'));
    check('M2 对象编辑器出现（编辑器输入态可定位）', okEditor);
    const sel = '#mEdit input, #dEdit input', selSave = '#mEdit [data-eact="save"], #dEdit [data-eact="save"]';
    const dlgBtns = () => pa.evaluate(() => [...document.querySelectorAll('#editorConfirm button')].map(b => b.textContent.trim()));
    const dlgClick = async label => { await pa.evaluate(l => { const b = [...document.querySelectorAll('#editorConfirm button')].find(x => x.textContent.trim() === l); if (b) b.click(); }, label); await pa.waitForFunction(() => document.getElementById('editorConfirm').hidden, null, { timeout: 5000 }); };
    // —— Round 1：明确覆盖此对象 → A 页版本落库 ——
    const bname1 = sa.n + '·B改1', aname1 = sa.n + '·验A1';
    await pullThenWait(bname1);
    check('M3 B 直写后 A 内存 cfg 收敛（externalChanged 冲突态已挂）', await pa.evaluate(() => !!document.querySelector('#mEdit .econflict, #dEdit .econflict')));
    await pa.fill(sel, aname1); await pa.waitForTimeout(200);
    await pa.click(selSave); await pa.waitForFunction(() => !document.getElementById('editorConfirm').hidden, null, { timeout: 5000 });
    const three1 = await dlgBtns();
    check(`M4 冲突三选 UI（${three1.join('/')}）`, three1.includes('重新加载最新值') && three1.includes('明确覆盖此对象') && three1.includes('继续编辑'));
    await dlgClick('明确覆盖此对象');
    await pa.waitForFunction(({ u0, name }) => App.cfg.names && App.cfg.names[u0] === name, { u0: sa.u0, name: aname1 }, { timeout: 5000 });
    await new Promise(r => setTimeout(r, 800)); // commit → saveCfg → 300ms debounce flush
    check('M5 明确覆盖后 A 页版本落库（后端 names= A 名）', (JSON.parse((await srvState())['radio.cfg'] || '{}').names || {})[sa.u0] === aname1);
    // —— Round 2：重新加载最新值 → A 页草稿丢，最新值进编辑器 ——
    const bname2 = sa.n + '·B改2';
    await pullThenWait(bname2);
    await pa.fill(sel, aname1.replace('A1', 'A2')); await pa.waitForTimeout(200);
    await pa.click(selSave); await pa.waitForFunction(() => !document.getElementById('editorConfirm').hidden, null, { timeout: 5000 });
    await dlgClick('重新加载最新值');
    await pa.waitForTimeout(300);
    // 实测语义：投影 name 取 station 对象 s.n（uiStationProjection），远程 cfg.names 改名不经 applySources
    // 不重投 s.n——重载后输入框回到「上一投影名」（round1 落库名），A 草稿消失；后端权威值 = B 名（M7 钉）
    check('M6 重新加载后草稿丢弃（输入回上一投影名，A 草稿 ·验A2 消失）', await pa.evaluate(([cur, draft]) => { const v = (document.querySelector('#mEdit input, #dEdit input') || {}).value || ''; return v === cur && v !== draft; }, [aname1, aname1.replace('A1', 'A2')]));
    check('M7 放弃后冲突态清除 + 后端仍为 B 版本', await pa.evaluate(() => !document.querySelector('#mEdit .econflict, #dEdit .econflict'))
      && (JSON.parse((await srvState())['radio.cfg'] || '{}').names || {})[sa.u0] === bname2);
    // KF3 特征化守卫（review#40 P2）：现状缺陷 = 输入框仍是旧投影名（草稿已消失）。若生产已修（投影重投、
    // 输入框显示 B 名），此处报错提示更新 M6 断言并移除豁免
    expectBuggy('KF3', await pa.evaluate(([cur, draft]) => { const v = (document.querySelector('#mEdit input, #dEdit input') || {}).value || ''; return v !== draft; }, [aname1, aname1.replace('A1', 'A2')]),
      '重载后输入框已显示后端权威值（投影重投已修）——更新 M6 断言并从 KNOWN_FAILURES 移除 KF3');
    // —— Round 3：继续编辑 → 草稿原样保留回编辑态 ——
    const bname3 = sa.n + '·B改3', aname3 = bname3 + '·验A3';
    await pullThenWait(bname3);
    await pa.fill(sel, aname3); await pa.waitForTimeout(200);
    await pa.click(selSave); await pa.waitForFunction(() => !document.getElementById('editorConfirm').hidden, null, { timeout: 5000 });
    await dlgClick('继续编辑');
    await pa.waitForTimeout(300);
    check('M8 继续编辑回草稿态（输入保留 A 草稿 + 冲突横幅仍在）', await pa.evaluate(n => (document.querySelector('#mEdit input, #dEdit input') || {}).value === n
      && !!document.querySelector('#mEdit .econflict, #dEdit .econflict'), aname3));
    check('M9 继续编辑未写库（后端仍为 B 版本）', (JSON.parse((await srvState())['radio.cfg'] || '{}').names || {})[sa.u0] === bname3);
    await pa.evaluate(() => { const b = [...document.querySelectorAll('#mEdit button, #dEdit button')].find(x => x.textContent === '取消'); if (b) b.click(); }); // 显式取消 = 丢弃草稿（§5.3）
    await pa.waitForTimeout(300);
    await pa.evaluate(() => { const x = document.getElementById('mClose') || document.getElementById('manageClose'); if (x) x.click(); });
    await pa.waitForTimeout(300);
    check('M10 面板收场（维护面板关闭）', await pa.evaluate(() => document.getElementById('manage').hidden));

    // —— [X] 断网 dirty → 恢复 reload 先重推再对账（P1-2 真页验证）——
    console.log('[X] 断网 dirty 重推');
    await ctx1.setOffline(true);
    await pa.evaluate(() => Store.set('radio.vol', '0.9'));
    await new Promise(r => setTimeout(r, 800)); // debounce flush 必败 → dirty 持久化
    check('X1 断网写后 dirty 置位（radio.storeDirty=1 持久标记）', await pa.evaluate(() => Store.dirty === true && localStorage.getItem('radio.storeDirty') === '1'));
    check('X2 后端未被断网写污染（vol 仍为 SD 档的 0.8，改动只在镜像）', (await srvState())['radio.vol'] === '0.8');
    await ctx1.setOffline(false);
    await pa.reload(); await waitBoot(pa);
    await pa.waitForFunction(() => Store.dirty === false, null, { timeout: 8000 }); // boot 尾部 dirty→flush 异步：以 dirty 复位为完成信号
    const xa = await counts(pa);
    check('X3 恢复网络 reload：boot dirty→flush 先重推，后端收到断网写（vol=0.9）', (await srvState())['radio.vol'] === '0.9');
    check('X4 重推后 dirty 复位 + 镜像保序', xa.rev === (await getJson(base + 'api/store')).rev && xa.vol === '0.9' && await pa.evaluate(() => Store.dirty === false));

    // —— [KF] 已知缺陷特征化 probe（review#40 P2）：现状缺陷仍在 = 豁免成立；意外转绿 → expectBuggy 报错 ——
    console.log('[KF] 已知缺陷 probe（豁免腐化守卫，KNOWN_FAILURES KF1/KF2）');
    const kd = await ctx1.newPage(), ke = await ctx1.newPage(), kf = await ctx2.newPage();
    pages.push(kd, ke, kf);
    for (const p of [kd, ke, kf]) p.on('pageerror', e => report.errors.push('pageerror:' + e.message));
    await boot(kd); await boot(ke); await boot(kf);
    const stk3 = await pickSt(kd);
    await kd.evaluate(k => App.toggleFav(App.state.stations.find(x => keyOf(x) === k)), stk3.k);
    await ke.waitForFunction(k => (localStorage.getItem('radio.favs') || '').includes(k), stk3.k, { timeout: 5000 });
    await new Promise(r => setTimeout(r, 1200)); // quiesce：debounce flush + 广播 + 各页 pull 全落地
    // KF1 修复回归守卫（原已知缺陷，链内 71fbdf9 review#37 P1-2 已修）：ke App 内存必须随广播收敛
    //（SA 段旧注记的 memFav 探针口径反转）；若回归（内存不收敛）报错提示恢复 KF1 豁免
    expectFixed('KF1', await ke.evaluate(k => App.favKeys().has(k), stk3.k),
      'ke App 内存未随广播收敛（review#37 P1-2 内存基线重载失效）——恢复 KF1 豁免并核查 store.js apply 重载判定');
    // KF2 probe：第二浏览器新页（快照 = 启动时全量、不含 kd 的新写）陈旧 reload 的 beforeunload flush
    // （keepalive fetch，可穿 unload）以本页快照覆盖他页写入——跨端收敛协议未修（SD 段实测语义）。
    // 注意 Chromium 无 sticky user activation 不派发 beforeunload——探针页须先有真实键入再 reload
    await kd.evaluate(() => { Store.set('radio.vol', '0.66'); Store.flush(); });
    await new Promise(r => setTimeout(r, 600));
    check('KF2 前置：kd 写 vol=0.66 已落服务端', (await srvState())['radio.vol'] === '0.66');
    // ⚠ flaky 探针面加固（review#40-r2 实跑差异：reviewer 单次转绿 / wt40-r2 复跑 3/3 豁免成立 /
    // 链尾复验单次转绿——三方不一致证明概率性）：Chromium unload 期 keepalive fetch 偶发不派发，
    // 陈旧 flush 没发出 → 服务端 vol 停 0.66 被误读「协议已修」。以服务端 rev 增量核验「陈旧 flush
    // 是否真的发出」：未发出重试一次（再键入再 reload），两次都未发出判探针失效（note 记录、本轮
    // 不判 KF2，豁免状态维持——既不误报转绿也不误报腐化）
    const kfAttempt = async () => {
      const rev0 = (await getJson(base + 'api/store')).rev;
      await kf.keyboard.press('x'); // 无副作用键（未绑定）——仅取 sticky activation，保证 reload 派发 beforeunload
      await kf.reload(); await waitBoot(kf);
      await new Promise(r => setTimeout(r, 1200)); // beforeunload flush POST 落地
      return (await getJson(base + 'api/store')).rev > rev0; // rev 推进 = 陈旧 flush 确实发出
    };
    if (await kfAttempt() || await kfAttempt()) {
      expectBuggy('KF2', (await srvState())['radio.vol'] === '0.9',
        '陈旧 unload flush 未再覆盖他页写入（跨端收敛协议已修）——更新 SD 段断言并从 KNOWN_FAILURES 移除 KF2');
    } else {
      note('KF2 探针失效：两次 reload 的 beforeunload keepalive 均未派发（flaky 面）——本轮不判 KF2，豁免状态维持');
    }
    await kd.close(); await ke.close(); await kf.close();

    check('Z1 全程零 pageerror / 非资源 console error（三页）', report.errors.length === 0);
    note(`资源加载噪音 ${report.resourceErrors.length} 条（自举实例合法 404 只记不判，同 pr-smoke 分流口径）`);
  } catch (e) {
    report.result = 'FAIL'; report.failure = String(e && e.stack || e); process.exitCode = 1;
    console.error('FAIL:', String(e && e.message || e));
    if (pages[0]) await failShot('failure.png').catch(() => {});
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
  report.knownFailures = KNOWN_FAILURES; report.blockedRequirements = BLOCKED_REQUIREMENTS; // review#40 P2：结构化豁免随报告输出
  note('全部 PASS ≠「活广播内存收敛/跨端自动收敛/真实 reload LWW」已验收——KF1/KF2/KF3 按现状特征化断言（见 knownFailures 字段），KF4 = 生产修复挂账（issue #42）；意外转绿由 expectBuggy 现场报错');
  fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${report.result}: ${report.assertions.length} 断言（报告 ${path.relative(ROOT, path.join(output, 'validation.json'))}）`);
})();
