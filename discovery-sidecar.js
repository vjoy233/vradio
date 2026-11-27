/* C3 精选 sidecar：默认关闭、只读校验，失败返回空，不触碰主库/Store。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  root.DiscoverySidecar = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MAX = 300;
  // 复用 C1 已审实现，输入为原始字节而非重编码文本。
  function sha256Bytes(bytes) {
  const bitLength = bytes.length * 8;
  const size = Math.ceil((bytes.length + 9) / 64) * 64, buf = new Uint8Array(size);
  buf.set(bytes); buf[bytes.length] = 128;
  const view = new DataView(buf.buffer);
  view.setUint32(size - 8, Math.floor(bitLength / 4294967296)); view.setUint32(size - 4, bitLength >>> 0);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], w = new Uint32Array(64);
  const r = (x,n) => (x >>> n) | (x << (32-n));
  for (let off = 0; off < size; off += 64) {
    for (let i=0;i<16;i++) w[i] = view.getUint32(off+i*4);
    for (let i=16;i<64;i++) { const a=w[i-15], b=w[i-2]; w[i] = (w[i-16]+(r(a,7)^r(a,18)^(a>>>3))+w[i-7]+(r(b,17)^r(b,19)^(b>>>10))) >>> 0; }
    let [a,b,c,d,e,f,g,z] = h;
    for (let i=0;i<64;i++) { const t1=(z+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+k[i]+w[i])>>>0; const t2=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))>>>0; z=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0; }
    [a,b,c,d,e,f,g,z].forEach((x,i) => { h[i]=(h[i]+x)>>>0; });
  }
  return h.map(x => x.toString(16).padStart(8,'0')).join('');
}
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
  async function loadSnapshot(fetcher, base, timeoutMs = 5000, signal) {
    if (typeof AbortController === 'undefined' || typeof TextDecoder === 'undefined') return [];
    async function stage(task) {
      const ctl = new AbortController(); let reader, timer;
      function cancel(r) { try { Promise.resolve(r.cancel()).catch(() => {}); } catch (_) {} }
      let rejectAbort;
      const abort = () => { ctl.abort(); if (reader) cancel(reader); rejectAbort(Error('aborted')); };
      const timeout = new Promise((_, reject) => { rejectAbort = reject; timer = setTimeout(abort, timeoutMs); });
      if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once:true}); }
      async function bytes(url, max) {
      if (ctl.signal.aborted) throw Error('aborted');
      const r = await fetcher(url, {signal:ctl.signal, cache:'no-store'});
      if (!r || !r.ok || !r.headers || !/^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(r.headers.get('content-type') || '') || Number(r.headers.get('content-length')) > max || !r.body || !r.body.getReader) { if (r && r.body && r.body.cancel) cancel(r.body); throw Error('invalid response'); }
      const active = r.body.getReader(); reader = active; const chunks = []; let size = 0, complete = false;
      try {
        for (;;) { const part = await active.read(); if (part.done) { complete = true; break; } size += part.value.byteLength; if (size > max) throw Error('too large'); chunks.push(part.value); }
        const out = new Uint8Array(size); let off = 0; for (const part of chunks) { out.set(part, off); off += part.byteLength; } return out;
      } finally {
        if (!complete) cancel(active);
        try { active.releaseLock(); } catch (_) {}
        if (reader === active) reader = null;
      }
    }
      let success = false;
      try { const result = await Promise.race([task(bytes), timeout]); success = true; return result; }
      finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); if (!success) { ctl.abort(); if (reader) cancel(reader); } }
    }
    const parse = b => JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(b));
    try {
      const pointer = await stage(async bytes => parse(await bytes(base + '/current.json', 4096)));
      if (!pointer || pointer.v !== 1) return [];
      for (const id of [pointer.current, pointer.previous]) {
        if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) continue;
        try {
          const rows = await stage(async bytes => {
          const prefix = base + '/' + id, m = parse(await bytes(prefix + '/manifest.json', 4096));
          if (!m || m.v !== 1 || m.sha256 !== id || !Number.isInteger(m.bytes) || m.bytes < 1 || m.bytes > 512 * 1024) return [];
          const data = await bytes(prefix + '/radio-discovery.json', 512 * 1024);
          let digest;
          if (globalThis.crypto && globalThis.crypto.subtle) {
            try { digest = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data)), x => x.toString(16).padStart(2, '0')).join(''); } catch (_) {}
          }
          // 不支持 Web Crypto 的 HTTP 局域网以已审核纯字节实现兜底；大文件同步计算可能阻塞 UI。
          if (!digest) digest = sha256Bytes(data);
          if (data.length !== m.bytes || digest !== id) return [];
          const raw = parse(data), at = raw.generatedAt;
          if (typeof at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) return [];
          return normalize(raw);
          });
          if (rows.length) return rows;
        } catch (_) {} // 当前代不可用时继续上一代
      }
      return [];
    } catch (_) { return []; }
  }
  return { MAX, normalize, load, loadSnapshot, sha256Bytes };
});
