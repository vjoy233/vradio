// 离线真实 Chromium 播放矩阵；依赖外置 Playwright/Chromium 与 ffmpeg，不属于 npm test。
const assert = require('assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { boot } = require('../test/harness/api-client');
const playwright = require(process.env.VRADIO_PLAYWRIGHT || 'playwright');
const variants = { correct: null, missing: '', unknown: 'application/x-unknown', wrong: 'text/html', octet: 'application/octet-stream' };
const types = { mp3: 'audio/mpeg', aac: 'audio/aac', m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t' };
function ffmpeg(args) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error('ffmpeg 不可用或生成夹具失败：' + (r.error || r.stderr || r.status));
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vradio-mime-'));
  let fixture, app, browser, primaryError;
  try {
    const input = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=8'];
    ffmpeg([...input, '-c:a', 'libmp3lame', '-y', path.join(dir, 'test.mp3')]);
    ffmpeg([...input, '-c:a', 'aac', '-f', 'adts', '-y', path.join(dir, 'test.aac')]);
    ffmpeg([...input, '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', path.join(dir, 'segment%d.ts'), '-y', path.join(dir, 'test.m3u8')]);
    fixture = http.createServer((req, res) => {
      const parts = new URL(req.url, 'http://localhost').pathname.split('/'), mode = parts[1], file = parts[2];
      if (!Object.prototype.hasOwnProperty.call(variants, mode) || !/^(test\.(mp3|aac|m3u8)|segment\d+\.ts)$/.test(file)) return res.writeHead(404).end();
      const type = variants[mode] === null ? types[file.split('.').pop()] : variants[mode];
      if (type) res.setHeader('Content-Type', type);
      res.end(fs.readFileSync(path.join(dir, file)));
    });
    await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
    app = await boot({ env: { VR_TEST_GUARD: '1' } });
    browser = await playwright.chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(), base = 'http://127.0.0.1:' + app.port;
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== '127.0.0.1' || Number(url.port) !== app.port) return route.abort();
      if (url.pathname === '/mime-matrix-page') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>fixture</title>' });
      return route.continue();
    });
    await page.goto(base + '/mime-matrix-page');
    await page.addScriptTag({ url: '/hls.min.js' });
    console.log('Chromium ' + browser.version());
    for (const format of ['mp3', 'aac', 'm3u8']) for (const mode of Object.keys(variants)) {
      const raw = 'http://127.0.0.1:' + fixture.address().port + '/' + mode + '/test.' + format;
      const proxy = '/proxy?url=' + encodeURIComponent(raw);
      const response = await app.req('GET', proxy);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers['content-type'], mode === 'correct' ? types[format] : 'application/octet-stream');
      assert.strictEqual(response.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(response.headers['content-security-policy'], "sandbox; default-src 'none'");
      const result = await page.evaluate(async ({ format, raw, proxy }) => {
        const audio = document.createElement('audio'); document.body.appendChild(audio);
        let hls; const errors = [];
        try {
          if (format === 'm3u8') {
            hls = new Hls({ enableWorker: false, manifestLoadingMaxRetry: 0, levelLoadingMaxRetry: 0, fragLoadingMaxRetry: 0,
              xhrSetup: (xhr, url) => {
                if (url.includes('/proxy?url=')) return;
                const abs = url.startsWith(location.origin) ? new URL(url.slice(location.origin.length + 1), raw).href : url;
                xhr.open('GET', '/proxy?url=' + encodeURIComponent(abs));
              } });
            hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) errors.push(d.type + ':' + d.details); });
            hls.loadSource(raw); hls.attachMedia(audio);
          } else audio.src = proxy;
          audio.play().catch(e => errors.push(e.name + ':' + e.message));
          const until = Date.now() + 8000;
          while (Date.now() < until && audio.currentTime < 0.2 && !audio.error && !errors.length) await new Promise(r => setTimeout(r, 100));
          return { time: audio.currentTime, error: audio.error && audio.error.code, errors };
        } finally { if (hls) hls.destroy(); audio.pause(); audio.remove(); }
      }, { format, raw, proxy });
      console.log(format + ' / ' + mode + ': ' + JSON.stringify(result));
      assert(result.time >= 0.2 && !result.error && !result.errors.length, format + '/' + mode + ' 未播放');
    }
    console.log('15/15 离线代理播放通过');
  } catch (e) { primaryError = e; }
  finally {
    // 每项各自限时并继续，主测试错误保留；仅清理由脚本创建的资源。
    const failures = [];
    async function cleanup(name, fn) {
      let timer;
      try {
        await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('清理超时（3秒）')), 3000);
        })]);
      } catch (e) { failures.push(name + ': ' + (e && e.stack || e)); }
      finally { clearTimeout(timer); }
    }
    if (browser) await cleanup('browser', () => browser.close());
    if (app) await cleanup('app', () => app.close());
    if (fixture && fixture.listening) await cleanup('fixture', () => new Promise((resolve, reject) => fixture.close(e => e ? reject(e) : resolve())));
    await cleanup('fixture 文件', () => fs.rmSync(dir, { recursive: true, force: true }));
    if (failures.length) {
      console.error('清理未完全成功：\n' + failures.join('\n'));
      if (!primaryError) primaryError = new Error('资源清理失败');
    }
  }
  if (primaryError) throw primaryError;
})().catch(e => { console.error(e); process.exitCode = 1; });
