'use strict';

// 离线实验：只验证本进程 fake 签发的句柄；不是 provider 认证。
const issued = new WeakMap();
const HEX = /^[0-9a-f]{40}$/;

function validPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 1024 &&
    !p.startsWith('/') && p.split('/').every(s => s && s !== '.' && s !== '..' && /^[A-Za-z0-9._-]+$/.test(s));
}
function validRepository(r) {
  return typeof r === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r) &&
    r.split('/').every(s => s !== '.' && s !== '..');
}
function createFakeProvider() {
  // 不导出签发记录；输入只是测试者提供的模拟事实，并非真实证据。
  const provider = Object.freeze({
    issue(repository, revision, files) {
      if (!validRepository(repository) || typeof revision !== 'string' || !HEX.test(revision) || !files || typeof files !== 'object') throw Error('invalid fake tree');
      const copied = new Map();
      for (const [path, bytes] of Object.entries(files)) {
        if (!validPath(path) || !Buffer.isBuffer(bytes)) throw Error('invalid fake file');
        copied.set(path, Buffer.from(bytes));
      }
      const evidence = Object.freeze({});
      issued.set(evidence, { provider, repository, revision, files: copied });
      return evidence;
    }
  });
  return provider;
}
function createAdapter(config, provider) {
  if (!config || !validRepository(config.repository) || typeof config.revision !== 'string' || !HEX.test(config.revision) ||
      !Array.isArray(config.paths) || !config.paths.length || !config.paths.every(validPath)) throw Error('invalid trusted configuration');
  const repository = config.repository, revision = config.revision, paths = new Set(config.paths);
  // 非 fake provider 没有可用的验证契约，绝不回退到 URL、哈希或自报。
  if (!provider || typeof provider !== 'object') throw Error('no verified provider');
  return Object.freeze({
    read(evidence, path) {
      if (!validPath(path) || !paths.has(path)) throw Error('unauthorized path');
      const record = evidence && typeof evidence === 'object' ? issued.get(evidence) : null;
      if (!record || record.provider !== provider || record.repository !== repository || record.revision !== revision) throw Error('unverified delivery tree');
      if (!record.files.has(path)) throw Error('missing tree member');
      return Buffer.from(record.files.get(path));
    }
  });
}
module.exports = { createFakeProvider, createAdapter };
