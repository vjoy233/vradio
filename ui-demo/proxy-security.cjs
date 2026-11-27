// Chromium 离线真实浏览器：代理媒体类型伪装脚本阻断 + PCM WAV 实际播放。
// VRADIO_PLAYWRIGHT 指向 Playwright 模块；服务与上游均为临时隔离 fixture。
const assert = require('assert'), http = require('http');
const { boot } = require('../test/harness/api-client');
const { chromium } = require(process.env.VRADIO_PLAYWRIGHT || 'playwright');
function wav() {
  const n = 8000, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
(async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/wav') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(wav()); }
    res.writeHead(200, { 'Content-Type': req.url === '/js' ? 'application/javascript' : 'audio/mpeg' });
    res.end('window.proxyPwned = (window.proxyPwned || 0) + 1;');
  });
  await new Promise((resolve, reject) => upstream.listen(0, '127.0.0.1', resolve).on('error', reject));
  let app, browser;
  try {
    app = await boot({ env: { VR_TEST_GUARD: '1' } });
    browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + app.port + '/');
    const proxy = name => '/proxy?url=' + encodeURIComponent('http://127.0.0.1:' + upstream.address().port + '/' + name);
    for (const name of ['js', 'spoof']) {
      const result = await page.evaluate(url => new Promise(resolve => {
        const s = document.createElement('script'); s.onload = () => resolve('load'); s.onerror = () => resolve('error'); s.src = url; document.head.appendChild(s);
      }), proxy(name));
      assert.strictEqual(result, 'error', name + ' 必须触发脚本拒绝');
      assert.strictEqual(await page.evaluate(() => window.proxyPwned || 0), 0, name + ' 不得执行');
    }
    const played = await page.evaluate(url => new Promise((resolve, reject) => {
      const a = new Audio(url), timer = setTimeout(() => reject(new Error('WAV 播放超时')), 10000);
      a.onended = () => { clearTimeout(timer); resolve({ ended: a.ended, time: a.currentTime }); };
      a.onerror = () => { clearTimeout(timer); reject(new Error('WAV 播放失败: ' + (a.error && a.error.code))); };
      a.play().catch(reject);
    }), proxy('wav'));
    assert(played.ended && played.time >= 0.9, 'WAV 必须真实播至末尾');
    console.log('proxy browser: JS + 媒体伪装脚本被拒；PCM WAV 播放完成');
  } finally {
    if (browser) await browser.close();
    if (app) await app.close();
    await new Promise(resolve => upstream.close(resolve));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
