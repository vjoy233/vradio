// 离线真服务：不可信主动内容、类型欺骗及媒体/HLS 透传。
const assert = require('assert'), http = require('http');
const { boot } = require('./harness/api-client');
(async () => {
  const upstream = http.createServer((req, res) => {
    const cases = {
      '/html': ['text/html; charset=utf-8', '<script>window.pwned=1</script>'],
      '/svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>window.pwned=1</script></svg>'],
      '/js': ['application/javascript', 'window.pwned=1'],
      '/spoof': ['text/html', 'window.pwned=1'],
      '/missing': [null, '<script>window.pwned=1</script>'],
      '/mpeg': ['Audio/MPEG; charset=binary', 'media bytes'],
      '/hls': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXTINF:1,\nsegment.ts\n'],
      '/segment': ['video/mp2t', 'segment bytes'],
      '/unknown': ['application/octet-stream', 'binary bytes']
    };
    const c = cases[req.url]; if (!c) return res.writeHead(404).end();
    if (c[0]) res.setHeader('Content-Type', c[0]); res.end(c[1]);
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  let app;
  try {
    app = await boot({ env: { VR_TEST_GUARD: '1' } });
    for (const [name, type] of Object.entries({ html:'application/octet-stream', svg:'application/octet-stream', js:'application/octet-stream', spoof:'application/octet-stream', missing:'application/octet-stream', mpeg:'audio/mpeg', hls:'application/vnd.apple.mpegurl', segment:'video/mp2t', unknown:'application/octet-stream' })) {
      const url = 'http://127.0.0.1:' + upstream.address().port + '/' + name;
      const r = await app.req('GET', '/proxy?url=' + encodeURIComponent(url));
      assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['content-type'], type);
      assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(r.headers['content-security-policy'], "sandbox; default-src 'none'");
      if (name === 'hls') assert(r.body.startsWith('#EXTM3U'));
      if (name === 'js') assert.strictEqual(r.body, 'window.pwned=1');
    }
    console.log('proxy security: 9 cases passed');
  } finally { if (app) await app.close(); await new Promise(r => upstream.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
