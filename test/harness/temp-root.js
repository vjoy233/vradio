// 临时根目录（P0a 最小版，方案 §2.4）：os.tmpdir 下建唯一目录 + wipe() 清理。
// 任何会写用户数据的测试禁止写仓库根——要么走 tempRoot，要么走 api-client 的 isolated 快照/还原。
const fs = require('fs'), os = require('os'), path = require('path');

function tempRoot(tag) {
  const dir = path.join(os.tmpdir(), 'vradio-test-' + process.pid + '-' + Math.random().toString(36).slice(2, 8) + (tag ? '-' + tag : ''));
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    p() { const segs = [dir]; for (let i = 0; i < arguments.length; i++) segs.push(arguments[i]); return path.join.apply(path, segs); },
    wipe() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { try { fs.rmdirSync(dir, { recursive: true }); } catch (_) {} } },
  };
}

module.exports = { tempRoot };
