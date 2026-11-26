/* C3 精选 sidecar：默认关闭、只读校验，失败返回空，不触碰主库/Store。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  root.DiscoverySidecar = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MAX = 300;
  function urlOk(u) { try { const x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') && !!x.hostname; } catch (_) { return false; } }
  function normalize(raw) {
    // 只校验标记与格式一致，不证明上游来源或许可真实性。
    if (!raw || typeof raw !== 'object' || raw.v !== 1 || raw.source !== 'recommended-radio-streams' || raw.license !== 'CC0-1.0' || !/^[a-f0-9]{40}$/.test(raw.commit) || !Array.isArray(raw.items)) return [];
    const seen = new Set(), out = [];
    for (const x of raw.items) {
      if (!x || typeof x !== 'object' || !urlOk(x.url) || seen.has(x.url)) continue;
      if (x.upstream && x.upstream !== raw.source) continue;
      if (x.commit && x.commit !== raw.commit) continue;
      const name = String(x.name || '').replace(/[\r\n,|]/g, ' ').trim().slice(0, 80);
      if (!name) continue;
      seen.add(x.url); out.push({ name, url: x.url, genre: String(x.genre || '').slice(0, 40), upstream: raw.source, commit: raw.commit });
      if (out.length >= MAX) break;
    }
    return out;
  }
  async function load(fetcher, url, timeoutMs = 5000) {
    if (typeof AbortController === 'undefined' || typeof TextDecoder === 'undefined') return [];
    const ctl = new AbortController(); let timer, reader;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); if (reader) reader.cancel().catch(() => {}); reject(new Error('timeout')); }, timeoutMs); });
    const run = async () => {
      const r = await fetcher(url, { signal: ctl.signal });
      if (!r || !r.ok || !r.headers || !/^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(r.headers.get('content-type') || '')) return [];
      const len = Number(r.headers.get('content-length')); if (len > 512 * 1024) return [];
      if (!r.body || !r.body.getReader) return [];
      reader = r.body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const x = await reader.read(); if (x.done) break;
        size += x.value.byteLength;
        if (size > 512 * 1024) { await reader.cancel(); ctl.abort(); return []; }
        chunks.push(x.value);
      }
      const bytes = new Uint8Array(size); let off = 0;
      for (const chunk of chunks) { bytes.set(chunk, off); off += chunk.byteLength; }
      return normalize(JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)));
    };
    try { return await Promise.race([run(), timeout]); } catch (_) { return []; } finally { clearTimeout(timer); }
  }
  return { MAX, normalize, load };
});
