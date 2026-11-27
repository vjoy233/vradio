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
  // 指针和内容均不可信：逐代限制字节、校验清单与 SHA-256；损坏时尝试上一代。
  async function loadSnapshot(fetcher, base, timeoutMs = 5000) {
    if (typeof AbortController === 'undefined' || typeof TextDecoder === 'undefined' || !globalThis.crypto || !globalThis.crypto.subtle) return [];
    const ctl = new AbortController(); let reader, timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); if (reader) reader.cancel().catch(() => {}); reject(Error('timeout')); }, timeoutMs); });
    async function bytes(url, max) {
      const r = await fetcher(url, {signal:ctl.signal, cache:'no-store'});
      if (!r || !r.ok || !r.headers || !/^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(r.headers.get('content-type') || '') || Number(r.headers.get('content-length')) > max || !r.body || !r.body.getReader) throw Error('invalid response');
      reader = r.body.getReader(); const chunks = []; let size = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > max) { await reader.cancel(); throw Error('too large'); } chunks.push(part.value); }
      reader = null; const out = new Uint8Array(size); let off = 0; for (const part of chunks) { out.set(part, off); off += part.byteLength; } return out;
    }
    const parse = b => JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(b));
    async function run() {
      const pointer = parse(await bytes(base + '/current.json', 4096));
      if (!pointer || pointer.v !== 1) return [];
      for (const id of [pointer.current, pointer.previous]) {
        if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) continue;
        try {
          const prefix = base + '/' + id, m = parse(await bytes(prefix + '/manifest.json', 4096));
          if (!m || m.v !== 1 || m.sha256 !== id || !Number.isInteger(m.bytes) || m.bytes < 1 || m.bytes > 512 * 1024) continue;
          const data = await bytes(prefix + '/radio-discovery.json', 512 * 1024);
          const digest = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data)), x => x.toString(16).padStart(2, '0')).join('');
          if (data.length !== m.bytes || digest !== id) continue;
          const raw = parse(data), at = raw.generatedAt;
          if (typeof at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) continue;
          const rows = normalize(raw); if (rows.length) return rows;
        } catch (_) {} // 当前代不可用时继续上一代
      }
      return [];
    }
    try { return await Promise.race([run(), timeout]); } catch (_) { return []; } finally { clearTimeout(timer); }
  }
  return { MAX, normalize, load, loadSnapshot };
});
