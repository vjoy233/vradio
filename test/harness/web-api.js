'use strict';
// Node14 test-only Web API shims. Production modules intentionally remain unchanged.
const util = require('util');
function install(target) {
  target = target || globalThis;
  if (typeof target.AbortController !== 'function') {
    class AbortSignal {
      constructor() { this.aborted = false; this._listeners = []; }
      addEventListener(type, fn) { if (type === 'abort' && typeof fn === 'function') this._listeners.push(fn); }
      removeEventListener(type, fn) { const i = this._listeners.indexOf(fn); if (i >= 0) this._listeners.splice(i, 1); }
    }
    class AbortController {
      constructor() { this.signal = new AbortSignal(); }
      abort() { if (this.signal.aborted) return; this.signal.aborted = true; this.signal._listeners.slice().forEach(fn => { try { fn.call(this.signal); } catch (_) {} }); }
    }
    target.AbortController = AbortController;
  }
  if (typeof target.TextEncoder !== 'function' && typeof util.TextEncoder === 'function') target.TextEncoder = util.TextEncoder;
  if (typeof target.TextDecoder !== 'function' && typeof util.TextDecoder === 'function') target.TextDecoder = util.TextDecoder;
  return target;
}
module.exports = { install };
