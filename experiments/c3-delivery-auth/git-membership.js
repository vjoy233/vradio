'use strict';
// 仅实验：只读取调用方控制的 SHA-1 loose objects，不支持 pack/alternate。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const HEX = /^[0-9a-f]{40}$/;
const LIMIT = 1024 * 1024;
function validPath(p) {
  return typeof p === 'string' && p.length <= 1024 && p.length > 0 &&
    p.split('/').every(s => s !== '.' && s !== '..' && /^[A-Za-z0-9._-]+$/.test(s));
}
function createMembership(anchor) {
  // repository 是外部策略的身份标签；objectsDir 必须由外部策略绑定到受控仓库。
  if (!anchor || typeof anchor.repository !== 'string' || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(anchor.repository) ||
      typeof anchor.objectsDir !== 'string' || !path.isAbsolute(anchor.objectsDir) ||
      typeof anchor.commit !== 'string' || !HEX.test(anchor.commit) ||
      !Array.isArray(anchor.paths) || !anchor.paths.length || anchor.paths.length > 64 ||
      !anchor.paths.every(validPath) || new Set(anchor.paths).size !== anchor.paths.length) throw Error('invalid external anchor');
  const dir = anchor.objectsDir, commit = anchor.commit, allowed = new Set(anchor.paths);
  function object(id, expected) {
    if (!HEX.test(id)) throw Error('invalid object id');
    const file = path.join(dir, id.slice(0, 2), id.slice(2));
    // 受控且运行期间不可变的对象目录是前提；大小限制不依赖压缩流自报。
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) throw Error('invalid object file');
    const raw = zlib.inflateSync(fs.readFileSync(file), { maxOutputLength: LIMIT });
    if (crypto.createHash('sha1').update(raw).digest('hex') !== id) throw Error('object hash mismatch');
    const zero = raw.indexOf(0);
    if (zero < 0 || zero > 64) throw Error('invalid object header');
    const header = raw.slice(0, zero).toString('ascii');
    const match = /^(commit|tree|blob) (0|[1-9][0-9]*)$/.exec(header);
    if (!match || match[1] !== expected || Number(match[2]) !== raw.length - zero - 1) throw Error('invalid object type or size');
    return raw.slice(zero + 1);
  }
  const body = object(commit, 'commit');
  const first = body.indexOf(10);
  const line = body.slice(0, first).toString('ascii');
  if (first < 0 || !/^tree [0-9a-f]{40}$/.test(line)) throw Error('invalid commit tree');
  const root = line.slice(5);
  function entry(tree, name) {
    const b = object(tree, 'tree'); let pos = 0, result = null; const names = new Set();
    while (pos < b.length) {
      const sp = b.indexOf(32, pos), nul = b.indexOf(0, sp + 1);
      if (sp <= pos || nul <= sp + 1 || nul + 21 > b.length) throw Error('invalid tree');
      const mode = b.slice(pos, sp).toString('ascii'), bytes = b.slice(sp + 1, nul);
      // 限制为无歧义 ASCII 名称，不接受替代字节编码。
      const n = bytes.toString('ascii');
      if (!Buffer.from(n, 'ascii').equals(bytes) || !validPath(n) || n.includes('/') || names.has(n) ||
          !['40000', '100644', '100755', '120000', '160000'].includes(mode)) throw Error('invalid tree entry');
      names.add(n);
      if (n === name) result = { mode, id: b.slice(nul + 1, nul + 21).toString('hex') };
      pos = nul + 21;
    }
    if (!result) throw Error('missing tree member');
    return result;
  }
  return Object.freeze({ read(p) {
    if (arguments.length !== 1 || !validPath(p) || !allowed.has(p)) throw Error('unauthorized path');
    const parts = p.split('/'); let tree = root;
    for (let i = 0; i < parts.length; i++) {
      const e = entry(tree, parts[i]);
      if (i === parts.length - 1) {
        if (e.mode !== '100644' && e.mode !== '100755') throw Error('not a regular blob');
        return Buffer.from(object(e.id, 'blob'));
      }
      if (e.mode !== '40000') throw Error('not a tree');
      tree = e.id;
    }
  } });
}
module.exports = { createMembership };
