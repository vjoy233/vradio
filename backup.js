/* VRadio 备份 v3 纯逻辑内核（r4/B4，契约 contracts/backup-v3.schema.json）——版本识别 / 键白名单过滤 /
   sidecar 判定与迁移字段裁剪 / 导入提交段（三步覆盖 + 失败回滚含质量快照回写）；app.js exportAll/importAll
   的可测部分（DOM/confirm 留在 app.js，网络经 io 注入，本文件零依赖）。
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
  // 收听统计 sidecar 迁移裁剪口径（listen-stats.js LSCAPS / server LS_* 同源）：只收日桶形态的
  // ms/sessions/stations/categories——天然不含响应正文/DNS/IP/token；键须历法有效日 + 台 URL http(s)≤512、
  // 分类 ≤24 字符；日 90 条封顶（sidecar 本体同款保留期）、每日台/分类 ≤64、总量 512KB 封顶
  const LS_DAYS_MAX = 90, LS_MAP_MAX = 64, LS_CAP = 512 * 1024;

  function int0(v) { const n = Math.floor(+v); return Number.isFinite(n) && n >= 0 ? Math.min(n, 1e9) : null; }

  /* 读备份（parse+validate 阶段）：null = 不是 vradio 备份/无有效数据。keys = 键白名单（app.js 传 Store.KEYS，
     测试传 contracts/radio-keys.json；缺省时按 radio.* 前缀宽收——生产路径恒传白名单）。返回：
     { ver:1|2|3, app, data:白名单键值, my:个人电台行|null（null=不动 my-radio.txt）, quality:{v:1,data}|null, n } */
  function readBackup(text, keys) {
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) return null; // 字符数封顶（AIbot 三轮 P2-2 兜底：app.js 入口按 file.size 字节先行拒，此处防程序化调用）
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
    }
    let ls = null; // 收听统计 sidecar（B4 补齐，schema 已声明；裁空视为无——「含 0 天」无确认意义）
    if (ver === 3) {
      const l = j.extensions && j.extensions.sidecars && j.extensions.sidecars.listenStats;
      const ld = l && typeof l === 'object' && !Array.isArray(l) && l.data && typeof l.data === 'object' && !Array.isArray(l.data) ? l.data : null;
      if (ld) { const d = lsTrim(ld); if (Object.keys(d).length) ls = { v: 1, data: d }; }
    } // 其余未知扩展：忽略不失败
    return { ver, app: typeof j.app === 'string' ? j.app : '', data, my, quality, ls, n: Object.keys(data).length };
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

  /* 收听统计迁移裁剪（导出与导入共用，§13.2-3，与 Android Backup.lsTrim / server lsTrimImport 同语义）：
     日键须历法有效（复用 listen-stats.js 同规则校验；本文件零依赖故内联同款实现）——坏键丢弃只影响统计自身；
     ms/sessions/台/分类数值非负取整封顶 1e9、台键 http(s)≤512、分类 ≤24 字符、每日台/分类 ≤64 条；
     保留最近 90 个自然日（超限裁最旧——客户端宽松裁剪，服务端 replace 通道整体拒绝把关）；
     空日（全零）丢弃；总量 512KB 封顶（超限先删最早日） */
  function lsDayOk(k) {
    if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
    const y = +k.slice(0, 4), m = +k.slice(5, 7), d = +k.slice(8, 10);
    if (m < 1 || m > 12 || d < 1) return false;
    const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= dim[m - 1];
  }
  function lsTrim(data) {
    const num = x => { const n = Math.floor(+x); return Number.isFinite(n) && n >= 0 ? Math.min(n, 1e9) : null; };
    const mapTrim = (o, keyOk) => { // 值清洗 + 键校验 + 条目封顶（超限裁插入序最前）
      const out = {};
      for (const k of Object.keys(o || {})) {
        if (Object.keys(out).length >= LS_MAP_MAX) break;
        if (!keyOk(k)) continue;
        const v = num(o[k]); if (v != null && v > 0) out[k] = v;
      }
      return out;
    };
    let days = {};
    for (const k of Object.keys(data)) {
      if (!lsDayOk(k)) continue;
      const d = data[k];
      if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
      const e = { ms: num(d.ms) || 0, stations: mapTrim(d.stations, k => /^https?:\/\//.test(k) && k.length <= 512),
        categories: mapTrim(d.categories, k => typeof k === 'string' && k.length > 0 && k.length <= 24) };
      e.sessions = Math.min(num(d.sessions) || 0, 1e6);
      if (e.ms > 0 || e.sessions > 0 || Object.keys(e.stations).length || Object.keys(e.categories).length) days[k] = e;
    }
    const ks = Object.keys(days).sort(); // ISO 日键字典序 = 时间序
    for (const k of ks.slice(0, Math.max(0, ks.length - LS_DAYS_MAX))) delete days[k];
    while (Object.keys(days).length && JSON.stringify({ v: 1, days }).length > LS_CAP) delete days[Object.keys(days).sort().shift()];
    return days;
  }

  /* v3 导入提交段（AIbot review P1-2 抽离可测）：四步覆盖（Store → my-radio → 质量 sidecar → 收听统计
     sidecar）+ 任一步失败整体回滚。sidecar 快照纪律：确认恢复（sc = 覆盖备份所含全部 sidecar，B4 起含
     listenStats）即先读旧值留存——无快照不提交（与 my-radio 同纪律）；回滚时把旧快照经同一通道尽力回写
     （服务端可能「写成功响应丢」，不回写则 sidecar 停在导入态），二次失败在文案里如实点名。DOM/confirm 留在
     app.js；存储与网络经 io 注入（生产 = localStorage/fetch，测试 = fake 复现「replace 写成功响应丢」）。
     listenStats 双形态：http 走 /api/listenstats replace 通道、file:// 走 localStorage 快照（quality 仅 http，
     file:// 下 sc 对 quality 无操作）。io 形状：
     { http, storeSnap(), storeApply(d)（应用与回滚同一入口：有值写/缺键删）, storeFlush():Promise<bool>（可等待可判定成功，AIbot 三轮 P1-1）,
       getMy():Promise<文本|null>（404=空串、其余失败 null 中止，三轮 P2-1）, postMy(lines):Promise<bool>,
       getQuality():Promise<旧data|null>, postQuality(data):Promise<bool>（replace:true 通道）, refreshQuality(),
       getListenStats():Promise<旧days|null>, postListenStats(days):Promise<bool>（replace 通道/本地写）, refreshListenStats() }
     返回 { ok, msg }——msg 即 #status 文案（失败文案含回滚结果）。 */
  async function commitImport(info, sc, io) {
    const snap = io.storeSnap();
    let myOld = null; // null = 无需快照（v1/file://）；该读失败（下方中止，绝不无快照提交）
    if (io.http && info.my != null) myOld = await io.getMy();
    if (info.my != null && io.http && myOld == null)
      return { ok: false, msg: '导入失败：无法读取当前个人电台列表（无回滚快照不提交），请重试' };
    let qOld = null; // 旧质量快照：确认恢复且备份含质量 sidecar 才留（file:// 无服务端 sidecar不适用）
    if (sc && info.quality && io.http) {
      qOld = await io.getQuality();
      if (qOld == null) return { ok: false, msg: '导入失败：无法读取当前质量数据（无回滚快照不提交），请重试' };
    }
    let lsOld = null; // 旧收听统计快照：同纪律（file:// = localStorage 读，缺数据按空 days 合法快照）
    if (sc && info.ls) {
      lsOld = await io.getListenStats();
      if (lsOld == null) return { ok: false, msg: '导入失败：无法读取当前收听统计（无回滚快照不提交），请重试' };
    }
    let qTried = false, lsTried = false; // 已提交过的 sidecar（回滚才回写旧快照；提交前失败 = 未动无需回写）
    const rollback = async why => {
      io.storeApply(snap);
      const sOK = await io.storeFlush(); // 回滚也要等待并如实报告（AIbot 三轮 P1-1）：失败只回本地镜像，服务端下次启动重推
      if (myOld != null) await io.postMy(myOld.split(/\r?\n/).filter(l => l.trim()));
      let note = sOK ? '' : '；主数据回滚仅写入本地镜像（服务端可能仍为导入状态，下次启动自动重推）';
      if (qTried) { // 响应丢/超时也走到这：旧快照回写是唯一兜底（服务端侧数据可能已是导入态）
        const ok = await io.postQuality(qOld);
        note += ok ? '' : '；质量数据可能停留在导入状态，可重试导入';
        io.refreshQuality(); // 回写后客户端质量缓存对齐服务端真态
      }
      if (lsTried) {
        const ok = await io.postListenStats(lsOld);
        note += ok ? '' : '；收听统计可能停留在导入状态，可重试导入';
        io.refreshListenStats();
      }
      return { ok: false, msg: '导入失败：' + why + '，已回滚到导入前状态' + note };
    };
    io.storeApply(info.data);
    if (!await io.storeFlush()) return rollback('主数据写入失败'); // Store 落盘失败必须进四件回滚（AIbot 三轮 P1-1），防跨层半导入
    if (info.my != null && io.http) { // v2/v3：个人电台行全量替换（v1 到不了这；file:// 无通道不替换）
      if (!await io.postMy(info.my)) return rollback('个人电台恢复失败');
    }
    if (qOld != null) { // sidecar 最后提交（§13.2-5：不允许 Store 已恢复而 sidecar 半恢复）
      qTried = true;
      if (!await io.postQuality(info.quality.data)) return rollback('质量 sidecar 恢复失败');
      io.refreshQuality(); // 成功：覆盖后重载质量缓存（丢弃未确认旧样本——导入语义=明确覆盖）
    }
    if (lsOld != null) { // 收听统计最后一级（四件事务收官）
      lsTried = true;
      if (!await io.postListenStats(info.ls.data)) return rollback('收听统计 sidecar 恢复失败');
      io.refreshListenStats(); // 成功：丢弃未确认旧增量并重拉（导入=明确覆盖，防旧 pend 重放复活旧账）
    }
    const qNote = qOld != null ? '（含质量 sidecar，已覆盖本机质量数据）' : '';
    const lNote = lsOld != null ? `（含收听统计 ${Object.keys(info.ls.data).length} 天，已覆盖本机收听统计）` : '';
    return { ok: true, msg: '已恢复完整备份' + (info.my != null && !io.http ? '（file:// 形态无法恢复个人电台列表）' : '') + qNote + lNote };
  }

  const B = { read: readBackup, build: buildV3, commitImport, qualityTrim, lsTrim, Q_SRC_NUM };
  root.BackupV3 = B;
  if (typeof module !== 'undefined' && module.exports) module.exports = B;
})(typeof window !== 'undefined' ? window : globalThis);
