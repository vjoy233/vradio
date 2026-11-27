'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');
const { createMembership } = require('./git-membership');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-membership-'));
function git(...args) {
  return cp.execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-config'), GIT_TERMINAL_PROMPT: '0' } }).trim();
}
try {
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'v2'));
  fs.writeFileSync(path.join(root, 'v2', 'data.json'), 'one');
  git('add', '--', 'v2/data.json');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'first');
  const first = git('rev-parse', 'HEAD');
  const anchor = { repository: 'trusted/repo', objectsDir: path.join(root, '.git', 'objects'), commit: first, paths: ['v2/data.json', 'v2/missing', 'v2'] };
  const session = createMembership(anchor);
  assert.strictEqual(session.read('v2/data.json').toString(), 'one');
  anchor.paths.push('other'); anchor.commit = 'a'.repeat(40);
  assert.throws(() => session.read('other'));
  assert.throws(() => session.read('v2/missing'));
  assert.throws(() => session.read('v2'));
  assert.throws(() => session.read('../v2/data.json'));
  assert.throws(() => createMembership({ ...anchor, commit: 'HEAD' }));
  assert.throws(() => createMembership({ ...anchor, commit: 'a'.repeat(40) }));
  assert.throws(() => createMembership({ ...anchor, commit: first, paths: ['v2/../x'] }));
  fs.writeFileSync(path.join(root, 'v2', 'data.json'), 'two');
  git('add', '--', 'v2/data.json');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'second');
  assert.strictEqual(session.read('v2/data.json').toString(), 'one');
  const second = createMembership({ ...anchor, commit: git('rev-parse', 'HEAD') });
  assert.strictEqual(second.read('v2/data.json').toString(), 'two');
  const blob = git('rev-parse', first + ':v2/data.json');
  git('update-index', '--add', '--cacheinfo', '120000,' + blob + ',link');
  git('update-index', '--add', '--cacheinfo', '160000,' + first + ',submodule');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'special modes');
  const special = createMembership({ ...anchor, commit: git('rev-parse', 'HEAD'), paths: ['link', 'submodule', 'link/x'] });
  assert.throws(() => special.read('link'));
  assert.throws(() => special.read('submodule'));
  assert.throws(() => special.read('link/x'));
  assert.throws(() => createMembership({ ...anchor, commit: blob }));
  // 手工构造并重新哈希，确保畸形语法不是因哈希错误被挡下。
  function store(raw) {
    const id = crypto.createHash('sha1').update(raw).digest('hex');
    const dir = path.join(anchor.objectsDir, id.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id.slice(2)), zlib.deflateSync(raw));
    return id;
  }
  function obj(type, body) { return store(Buffer.concat([Buffer.from(type + ' ' + body.length + '\0'), body])); }
  function commitFor(tree) { return obj('commit', Buffer.from('tree ' + tree + '\n')); }
  function open(commit, paths) { return createMembership({ ...anchor, commit, paths: paths || ['x'] }); }
  function treeFor(entry) { return obj('tree', entry); }
  const high = b => { b = Buffer.from(b); b[0] |= 128; return b; };
  const oidBytes = Buffer.from(blob, 'hex');
  const badHeader = store(Buffer.concat([high('commit'), Buffer.from(' 0\0')]));
  assert.throws(() => open(badHeader), /non-ascii/);
  const badCommit = obj('commit', Buffer.concat([high('tree'), Buffer.from(' ' + '0'.repeat(40) + '\n')]));
  assert.throws(() => open(badCommit), /non-ascii/);
  const badMode = treeFor(Buffer.concat([high('100644'), Buffer.from(' x\0'), oidBytes]));
  assert.throws(() => open(commitFor(badMode)).read('x'), /non-ascii/);
  const badName = treeFor(Buffer.concat([Buffer.from('100644 '), high('x'), Buffer.from([0]), oidBytes]));
  assert.throws(() => open(commitFor(badName)).read('x'));
  const truncated = treeFor(Buffer.concat([Buffer.from('100644 x\0'), oidBytes.slice(0, 19)]));
  assert.throws(() => open(commitFor(truncated)).read('x'), /invalid tree/);
  const duplicate = Buffer.concat([Buffer.from('100644 x\0'), oidBytes]);
  assert.throws(() => open(commitFor(treeFor(Buffer.concat([duplicate, duplicate])))).read('x'), /invalid tree entry/);
  const oversized = obj('blob', Buffer.alloc(1024 * 1024));
  const oversizedTree = treeFor(Buffer.concat([Buffer.from('100644 x\0'), Buffer.from(oversized, 'hex')]));
  assert.throws(() => open(commitFor(oversizedTree)).read('x'));
  const wrongHash = path.join(anchor.objectsDir, blob.slice(0, 2), blob.slice(2));
  fs.chmodSync(wrongHash, 0o600);
  fs.writeFileSync(wrongHash, zlib.deflateSync(Buffer.from('blob 3\0bad')));
  assert.throws(() => session.read('v2/data.json'), /object hash mismatch/);
  const blobFile = wrongHash;
  fs.chmodSync(blobFile, 0o600);
  fs.writeFileSync(blobFile, 'corrupt');
  assert.throws(() => session.read('v2/data.json'));
  console.log('git membership: offline checks passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
