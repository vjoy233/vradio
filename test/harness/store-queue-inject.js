'use strict';
// 仅测试 preload：暂停首个 store rename，记录第二个 POST 完整交给服务端后再由测试释放。
const fs = require('fs'), http = require('http');
const dir = process.env.VR_TEST_STORE_QUEUE_DIR;
if (dir) {
  const rename = fs.rename, createServer = http.createServer;
  let held = false, posts = 0;
  fs.rename = function (from, to, cb) {
    if (!held && /store\.json$/.test(to)) {
      held = true;
      fs.writeFileSync(dir + '/held', '1');
      const timer = setInterval(() => { if (fs.existsSync(dir + '/release')) { clearInterval(timer); rename.call(fs, from, to, cb); } }, 10);
      return;
    }
    return rename.call(fs, from, to, cb);
  };
  http.createServer = function (handler) {
    return createServer.call(http, (req, res) => {
      handler(req, res);
      if (req.method === 'POST' && req.url === '/api/store' && ++posts === 2)
        req.on('end', () => setImmediate(() => fs.writeFileSync(dir + '/second', '1')));
    });
  };
}
