/* 新鲜度偏好与时钟状态机。资产事实由调用方提供，绝不从用户偏好推断同步成功。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Freshness = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000, COOLDOWN = 60000;
  function normalize(value) {
    if (typeof value === 'string') {
      if (value.length > 1024) value = null;
      else try { value = JSON.parse(value); } catch (_) { value = null; }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
    const time = x => typeof x === 'number' && Number.isSafeInteger(x) && x > 0 ? x : 0;
    return { reminderDays: [7, 14, 30].includes(value.reminderDays) ? value.reminderDays : 14,
      disabled: value.disabled === true, dismissedUntil: time(value.dismissedUntil), lastPromptAt: time(value.lastPromptAt) };
  }
  function state(value, fact, now) {
    const p = normalize(value);
    const t = fact && fact.refreshedAt;
    const known = fact && fact.provenance && typeof t === 'number' && Number.isSafeInteger(t) && t > 0 && t <= now;
    const age = known ? (now - t >= p.reminderDays * DAY ? 'due' : 'fresh') : 'unknown';
    const dismissed = p.dismissedUntil > now && p.dismissedUntil <= now + DAY;
    const cooling = p.lastPromptAt > 0 && p.lastPromptAt <= now && now - p.lastPromptAt < COOLDOWN;
    return { age, prompt: !p.disabled && !dismissed && !cooling && age !== 'fresh' };
  }
  function markPrompted(value, now) { return Object.assign(normalize(value), { lastPromptAt: now }); }
  function markDismissed(value, now) { return Object.assign(normalize(value), { dismissedUntil: now + DAY }); }
  return { DAY, COOLDOWN, normalize, state, markPrompted, markDismissed };
});
