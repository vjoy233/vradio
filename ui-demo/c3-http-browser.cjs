'use strict';
// 真实 Chromium 页面 + 本地 HTTP 慢流，独立只读静态根；不启动应用服务器、不写用户数据。
const assert = require('assert'), http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const playwrightPath = process.env.VRADIO_PLAYWRIGHT;
if (!playwrightPath) { console.error('请设置 VRADIO_PLAYWRIGHT 指向 Playwright 安装目录'); process.exit(1); }
const { chromium } = require(playwrightPath);
const payload = Buffer.from(JSON.stringify({v:1,source:'recommended-radio-streams',license:'CC0-1.0',commit:'a'.repeat(40),generatedAt:'2026-11-26T00:00:00.000Z',items:[{name:'回退测试候选',url:'https://example.invalid/stream'}]}));
const previous = crypto.createHash('sha256').update(payload).digest('hex'), current = 'b'.repeat(64);
const sockets = new Set(), requests = []; let stalledClosed = false, browser;
const server = http.createServer((req,res) => {
  const p = new URL(req.url,'http://localhost').pathname; requests.push(p);
  if (p.startsWith('/discovery-snapshots/')) {
    res.setHeader('Content-Type','application/json');
    if (p.endsWith('/current.json')) return res.end(JSON.stringify({v:1,current,previous}));
    if (p === `/discovery-snapshots/${current}/manifest.json`) return res.end(JSON.stringify({v:1,sha256:current,bytes:payload.length}));
    if (p === `/discovery-snapshots/${current}/radio-discovery.json`) { res.on('close',()=>{stalledClosed=true;}); res.write('{'); return; }
    if (p === `/discovery-snapshots/${previous}/manifest.json`) return res.end(JSON.stringify({v:1,sha256:previous,bytes:payload.length}));
    if (p === `/discovery-snapshots/${previous}/radio-discovery.json`) return res.end(payload);
    res.writeHead(404); return res.end('{}');
  }
  if (p.startsWith('/api/')) { res.setHeader('Content-Type','application/json'); return res.end(p === '/api/store' ? JSON.stringify({rev:0,data:{}}) : '{}'); }
  // 用户数据和受保护路径一律不读；模拟首次启动的空个人层。
  if (p.toLowerCase() === '/my-radio.txt' || p.toLowerCase().startsWith('/data/')) { res.writeHead(404); return res.end(); }
  const allowed = /^\/(?:[\w.-]+)$/.test(p) || p === '/';
  if (!allowed) { res.writeHead(404); return res.end(); }
  const file = path.join(root,p === '/' ? 'index.html' : p.slice(1));
  fs.readFile(file,(e,b)=>{ if(e){res.writeHead(404);return res.end();} const ext=path.extname(file); res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.json':'application/json','.txt':'text/plain','.css':'text/css'})[ext] || 'application/octet-stream'); res.end(b); });
});
server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
const watchdog=setTimeout(()=>{console.error('测试总超时'); for(const s of sockets)s.destroy(); if(browser) browser.close().catch(()=>{}); process.exit(1);},30000);
(async()=>{ try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  await context.route('**/*',route=>{ const u=new URL(route.request().url()); return u.origin===base ? route.continue() : route.abort(); });
  await context.addInitScript(()=>{ localStorage.setItem('feat.discovery','1'); localStorage.setItem('feat.uiRefresh','0'); if (localStorage.getItem('feat.discoverySidecar') === null) localStorage.setItem('feat.discoverySidecar','0'); });
  const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base,{waitUntil:'domcontentloaded',timeout:10000}); await page.locator('#discBtn').click({timeout:10000});
  await page.waitForSelector('#discBody .discrow',{timeout:10000});
  assert(!requests.some(x=>x.startsWith('/discovery-snapshots/')), '关闭时不得请求 sidecar');
  assert(!await page.getByText('回退测试候选').count(), '关闭时不渲染候选');
  await page.locator('#discClose').click();
  await page.evaluate(()=>localStorage.setItem('feat.discoverySidecar','1'));
  await page.reload({waitUntil:'domcontentloaded'}); await page.locator('#discBtn').click();
  await page.getByText('回退测试候选').waitFor({timeout:12000});
  assert(requests.includes(`/discovery-snapshots/${current}/radio-discovery.json`));
  assert(requests.includes(`/discovery-snapshots/${previous}/radio-discovery.json`));
  await page.waitForFunction(()=>document.querySelectorAll('[data-sidecar]').length===1);
  await new Promise((resolve,reject)=>{ const deadline=Date.now()+2000; function check(){if(stalledClosed)return resolve();if(Date.now()>deadline)return reject(Error('慢流连接未关闭'));setTimeout(check,20);} check(); });
  assert.deepStrictEqual(errors,[]); await context.close(); console.log('c3-http-browser: 真实页面慢流取消与上一代回退通过');
} finally { clearTimeout(watchdog); if(browser) await browser.close(); for(const s of sockets)s.destroy(); if(server.listening) await new Promise(r=>server.close(r)); } })().catch(e=>{console.error(e);process.exitCode=1;});
