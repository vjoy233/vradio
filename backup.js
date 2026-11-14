/* VRadio 备份 v3 纯逻辑内核（r4/B4，契约 contracts/backup-v3.schema.json）——版本识别 / 键白名单过滤 /
   sidecar 判定与迁移字段裁剪；app.js exportAll/importAll 的可测部分（DOM/网络都在 app.js，本文件零依赖）。
   版本映射固定（B0 契约）：v1={v:1,at,data}（无 my，不动 my-radio.txt）；v2={v:2,…,my:[]}（读 my）；
   v3={format:"vradio-backup",version:3,…,myRadio,extensions}（读 myRadio；app 字段忽略差异）；导出统一写 v3。
   Android data/Backup.kt 同构；黄金样本 contracts/fixtures/backup-v2.json、backup-v3.json 双端一致消费。
   双环境：经典 script 挂 window.BackupV3，CommonJS 供 test/ 直接 require。 */
(function (root) {
  'use strict';
  /* 质量聚合迁移字段白名单（contracts/quality-summary.json 的 aggregate 面——全为计数/时间戳/延迟，天然不含
     响应正文/DNS/IP/临时 token；白名单外的字段导出/导入两侧一律剔除，防未来字段夹带敏感数据） */
  // B2 起质量 sidecar 为嵌套形态（每台 {cf, sources:{源URL:{聚合…}}}，与 Android filesDir 同构）——
  // 迁移白名单只收存储字段：summary 派生值（stability/avgLatency 等）不落 sidecar，导入时重算
  const Q_SRC_NUM = ['okCount', 'failCount', 'lastOkAt', 'lastFailAt', 'lastPlaybackAt', 'latSum', 'latN', 'disconnects'];
  const Q_KEYS_MAX = 2000; // 条目封顶（对齐 health FIFO 2000 量级，防构造巨量键）

  function int0(v) { const n = Math.floor(+v); return Number.isFinite(n) && n >= 0 ? Math.min(n, 1e9) : null; }

  /* 读备份（parse+validate 阶段）：null = 不是 vradio 备份/无有效数据。keys = 键白名单（app.js 传 Store.KEYS，
     测试传 contracts/radio-keys.json；缺省时按 radio.* 前缀宽收——生产路径恒传白名单）。返回：
     { ver:1|2|3, app, data:白名单键值, my:个人电台行|null（null=不动 my-radio.txt）, quality:{v:1,data}|null, n } */
  function readBackup(text, keys) {
    let j;
    try { j = JSON.parse(text); } catch (_) { return null; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const d = j.data;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const wl = Array.isArray(keys) && keys.length ? new Set(keys) : null;
    const data = {};
    for (const k of Object.keys(d)) {
      if (typeof d[k] !== 'string') continue; // 值一律字符串（契约 shape）
      if (wl ? !wl.has(k) : !/^radio\./.test(k)) continue; // 白名单外键静默丢弃
      data[k] = d[k];
    }
    const ver = (j.version === 3 || j.v === 3) ? 3 : (j.v === 2 ? 2 : 1);
    let my = null;
    const src = ver >= 3 ? j.myRadio : ver === 2 ? j.my : null;
    if (Array.isArray(src)) my = src.filter(x => typeof x === 'string' && x.trim());
    // v1 无 my 不动 my-radio.txt；v2/v3 字段缺失也按不动处理（空数组才是「恢复为空」）
    let quality = null;
    if (ver === 3) {
      const q = j.extensions && j.extensions.sidecars && j.extensions.sidecars.quality;
      const qd = q && typeof q === 'object' && !Array.isArray(q) && q.data && typeof q.data === 'object' && !Array.isArray(q.data) ? q.data : null;
      if (qd) quality = { v: 1, data: qualityTrim(qd) };
    } // listenStats（B3 未落地）与其余未知扩展：忽略不失败
    return { ver, app: typeof j.app === 'string' ? j.app : '', data, my, quality, n: Object.keys(data).length };
  }

  /* 导出 v3 组装：{format,version,createdAt,app,data,myRadio,extensions}（对照 schema shape 五字段） */
  function buildV3(o) {
    o = o || {};
    return {
      format: 'vradio-backup', version: 3, createdAt: o.at || Date.now(),
      app: o.app || 'web', data: o.data || {},
      myRadio: Array.isArray(o.myRadio) ? o.myRadio : [],
      extensions: o.extensions && typeof o.extensions === 'object' && !Array.isArray(o.extensions) ? o.extensions : {},
    };
  }

  /* 质量数据迁移裁剪（导出与导入共用同款 trim，§13.2-3，嵌套形态）：台键须 http(s)≤512、台级 cf +
     每源计数/时间戳/延迟/modes/最近诊断与最近播放失败；数值非负取整封顶、每台源 ≤6、台 2000 封顶；裁空丢弃 */
  function qualityTrim(data) {
    const num = x => { const n = Math.floor(+x); return Number.isFinite(n) && n >= 0 ? Math.min(n, 1e9) : null; };
    const evt = x => x && typeof x === 'object' && !Array.isArray(x)
      ? { t: String(x.t || '').slice(0, 16), ok: !!x.ok, at: num(x.at) || 0, lat: num(x.lat) || 0 } : null;
    const out = {};
    for (const k of Object.keys(data)) {
      if (Object.keys(out).length >= Q_KEYS_MAX) break;
      if (!/^https?:\/\//.test(k) || k.length > 512) continue;
      const v = data[k];
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const cf = num(v.cf), e = { cf: cf == null ? 0 : cf, sources: {} };
      const srcs = v.sources && typeof v.sources === 'object' && !Array.isArray(v.sources) ? v.sources : {};
      for (const su of Object.keys(srcs).slice(0, 6)) {
        if (!/^https?:\/\//.test(su) || su.length > 512) continue;
        const s = srcs[su];
        if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
        const es = {};
        for (const f of Q_SRC_NUM) { const n = num(s[f]); if (n != null) es[f] = n; }
        if (Array.isArray(s.modes)) {
          const m = [...new Set(s.modes.map(x => String(x).slice(0, 16)).filter(x => /^(direct|hls|proxy)$/.test(x)))].slice(0, 8);
          if (m.length) es.modes = m;
        }
        const ld = evt(s.lastDiag); if (ld && (ld.at || ld.t)) es.lastDiag = ld;
        const lp = evt(s.lastPlayFail); if (lp && (lp.at || lp.t)) es.lastPlayFail = lp;
        if (Object.keys(es).length) e.sources[su] = es;
      }
      if (Object.keys(e.sources).length || e.cf > 0) out[k] = e;
    }
    return out;
  }

  const B = { read: readBackup, build: buildV3, qualityTrim, Q_SRC_NUM };
  root.BackupV3 = B;
  if (typeof module !== 'undefined' && module.exports) module.exports = B;
})(typeof window !== 'undefined' ? window : globalThis);
