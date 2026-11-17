// FakeClock —— 可推进时间核心（P0a 最小版，方案 §2.2）：显式注入用，绝不自动替换全局时间 API。
// vm sandbox 路线走 fake-browser.sandbox({ clock }) 注入；同 realm 依赖真实定时器的场景才用
// install()/restore() 显式 patch（单测试子进程内 patch + finally 恢复）。Node 14 兼容、零依赖。
class FakeClock {
  constructor(t = 0) { this.t = t; this.q = []; this.seq = 0; }
  now() { return this.t; }
  later(ms, fn) { const x = { id: ++this.seq, at: this.t + (ms || 0), fn, dead: false, every: 0 }; this.q.push(x); return x; }
  every(ms, fn) { const x = this.later(ms, fn); x.every = ms || 1; return x; }
  cancel(x) { if (x) x.dead = true; }
  tick(ms) { // 推进 t+ms：中途到点的定时器按 at 序逐个触发（同刻按注册序），区间型触发后轮转
    const end = this.t + ms;
    for (;;) {
      const due = this.q.filter(v => !v.dead && v.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.t = due.at;
      if (due.every) { due.at += due.every; due.fn(); } else { due.dead = true; due.fn(); }
    }
    this.t = end;
  }
  pending() { return this.q.filter(v => !v.dead).length; }
}

// 真实 realm patch（仅限测试子进程）：返回快照给 restore()，用例必须 try/finally 恢复。
function install(clock) {
  const orig = { now: Date.now, st: global.setTimeout, ct: global.clearTimeout, si: global.setInterval, ci: global.clearInterval };
  Date.now = () => clock.now();
  global.setTimeout = (fn, ms) => clock.later(ms, fn);
  global.clearTimeout = x => clock.cancel(x);
  global.setInterval = (fn, ms) => clock.every(ms, fn);
  global.clearInterval = x => clock.cancel(x);
  return orig;
}
function restore(o) { Date.now = o.now; global.setTimeout = o.st; global.clearTimeout = o.ct; global.setInterval = o.si; global.clearInterval = o.ci; }

module.exports = { FakeClock, install, restore };
