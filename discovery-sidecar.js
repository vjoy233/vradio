/* C3 精选 sidecar：默认关闭、只读校验，失败返回空，不触碰主库/Store。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  root.DiscoverySidecar = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MAX = 300;
  function urlOk(u) { try { const x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') && !!x.hostname; } catch (_) { return false; } }
  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || raw.v !== 1 || !Array.isArray(raw.items)) return [];
    const seen = new Set(), out = [];
    for (const x of raw.items) {
      if (!x || typeof x !== 'object' || !urlOk(x.url) || seen.has(x.url)) continue;
      const name = String(x.name || '').replace(/[\r\n,|]/g, ' ').trim().slice(0, 80);
      if (!name) continue;
      seen.add(x.url); out.push({ name, url: x.url, genre: String(x.genre || '').slice(0, 40), upstream: String(x.upstream || 'recommended-radio-streams'), commit: String(x.commit || '') });
      if (out.length >= MAX) break;
    }
    return out;
  }
  async function load(fetcher, url) {
    try { const r = await fetcher(url); if (!r || !r.ok) return []; return normalize(await r.json()); } catch (_) { return []; }
  }
  return { MAX, normalize, load };
});
