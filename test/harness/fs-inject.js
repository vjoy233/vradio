// 测试专用 fs.rename 注入 preload（review#40 rename-retry 确定性覆盖用，同 VR_TEST_* 先例：env 显式
// 设置才生效，生产路径绝不自启——本文件只出现在测试子进程命令行 `-r`，server.js 不感知、不改一字）。
// 语义：env VR_TEST_RENAME_INJECT = JSON {failFirst, code, pathIncludes}——前 failFirst 次目标路径
// 含 pathIncludes 的 fs.rename 回调注入 code 错误（EPERM=可重试 / ENOSPC=不可重试），其后透传真实调用；
// env VR_TEST_RENAME_LOG 指定日志文件（逐行 JSON {path, injected}，命中 pathIncludes 的每次调用都记），
// 供测试断言「注入命中/重试确实走过」——不用计时器猜。Node 14 兼容零依赖。
const fs = require('fs');
let cfg = null;
try { cfg = JSON.parse(process.env.VR_TEST_RENAME_INJECT || 'null'); } catch (_) { cfg = null; }
if (cfg && cfg.failFirst > 0 && cfg.pathIncludes) {
  const orig = fs.rename;
  let seen = 0;
  fs.rename = function (from, to, cb) { // 形态与 Node 14 的 fs.rename(from, to, cb) 一致
    if (String(to).indexOf(cfg.pathIncludes) < 0) return orig.call(fs, from, to, cb);
    const hit = seen < cfg.failFirst;
    seen++;
    if (process.env.VR_TEST_RENAME_LOG) {
      try { fs.appendFileSync(process.env.VR_TEST_RENAME_LOG, JSON.stringify({ path: String(to), injected: hit ? cfg.code : null }) + '\n'); } catch (_) {}
    }
    if (!hit) return orig.call(fs, from, to, cb);
    const e = new Error('injected rename failure: ' + cfg.code);
    e.code = cfg.code;
    return process.nextTick(cb, e); // 异步回错误（与真实 fs 异步语义一致）
  };
}
