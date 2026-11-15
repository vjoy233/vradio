/* VRadio 歌单多格式导入模型（r4/B4，docs/plan-expansion-r4.md §8）—— PLS/XSPF/ASX(WAX/WMX)/m3u/纯 URL
   五格式统一解析器；黄金样本 contracts/fixtures/playlist-*，Android data/PlaylistParser.kt 同构（同输入同输出）。
   安全（§13.4）：纯本地解析**零网络请求**（任何分支都不该碰 fetch/XHR）；XML 不解析外部实体与 DTD——浏览器
   DOMParser 天然不取外部实体，Node 测试环境走手写扫描器（整段跳过 <!DOCTYPE…>、未声明实体引用不展开、
   CDATA 记文本、深度/文本长度封顶）；URL 只收 http(s)，其余剔除并计入非法桶。
   双环境：经典 script 挂 window.PlaylistImport（file:// 硬约束），CommonJS 供 test/ 直接 require。 */
(function (root) {
  'use strict';
  const MAX = 500, XML_MAX = 2 * 1024 * 1024, NAME_MAX = 40, CAT_MAX = 24, DEPTH_MAX = 64;
  const httpRe = /^https?:\/\//i;

  function isHttp(u) { return httpRe.test(u); }
  function hostOf(u) { const m = u.match(/^https?:\/\/([^\/?#]+)/i); return m ? m[1] : ''; }
  function cleanName(n) { return String(n || '').replace(/[\r\n]+/g, ' ').trim().slice(0, NAME_MAX); }
  function cleanCat(c) { return String(c || '').replace(/[,\r\n|#]/g, ' ').trim().slice(0, CAT_MAX) || '自定义'; }
  function fallbackName(u) { return hostOf(u) || String(u).slice(0, NAME_MAX); }
  function mkEntry(url, name, cat, fmt, logo, extId) {
    return { name: name, category: cat, url: url, logo: logo || '', externalId: extId || '', sourceFormat: fmt };
  }
  /* 相对 URL 解析（XSPF/ASX 用）：绝对 http(s) 原样；有 baseUrl 才解析（new URL(rel, base)），失败/无 base = null */
  function resolveUrl(u, baseUrl) {
    const s = String(u || '').trim();
    if (isHttp(s)) return s;
    if (baseUrl && isHttp(baseUrl)) {
      try { const abs = new URL(s, baseUrl); return isHttp(abs.href) ? abs.href : null; } catch (_) { return null; }
    }
    return null;
  }

  /* —— 格式识别（§8.1 顺序）：① 显式扩展名/MIME/格式名 → ② 文件头 → ③ 内容特征 → ④ 纯 URL —— */
  function normHint(f) {
    const s = String(f || '').toLowerCase().trim();
    if (!s) return null;
    if (s.includes('xspf')) return 'xspf';
    if (/\.(asx|wax|wmx|asf)(\?|$)/.test(s) || s.includes('ms-asf') || s.includes('ms-asx')) return 'asx';
    if (/\.pls(\?|$)/.test(s) || s.includes('scpls')) return 'pls';
    if (/\.m3u8?(\?|$)/.test(s) || s.includes('mpegurl')) return 'm3u';
    return ['pls', 'xspf', 'asx', 'm3u', 'url'].includes(s) ? s : null;
  }
  function detect(text, hint) {
    const h = normHint(hint);
    if (h) return h; // ① 显式提示最优先（误标后果 = 空解析，改名重试即可）
    const head = text.slice(0, 4096), hs = head.trimStart();
    if (/^\[playlist\]/i.test(hs)) return 'pls';                                // ② 文件头
    if (/(^|\r?\n)#EXTM3U/i.test(head)) return 'm3u';
    if (/<asx[\s>]/i.test(head) || /<entry[\s>]/i.test(head) || /<entryref[\s>]/i.test(head)) return 'asx';
    if (/<playlist[\s>]/i.test(head) || /<tracklist[\s>]/i.test(head)) return 'xspf';
    if (/file\d+\s*=/i.test(head)) return 'pls';                                // ③ 内容特征（FileN=）
    if (text.includes('#EXTINF')) return 'm3u';
    if (/,\s*https?:\/\//i.test(head)) return 'm3u';                            // csv 风格（radio.txt 形态）
    return 'url';                                                               // ④ 纯 URL 列表
  }

  /* —— XML → 轻量树 {name,attrs,kids,text}（localName 小写比较，命名空间不敏感）：
     浏览器走 DOMParser（不取外部实体/parsererror 全弃）；Node 测试环境走 handXml 扫描器 —— */
  function xmlTree(text) {
    if (text.length > XML_MAX) return null; // XML 文本 >2MB 拒绝（入口长度先钳，DOMParser/扫描器都不进）
    if (typeof DOMParser !== 'undefined') {
      try {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) return null;
        const conv = el => {
          const kids = [], attrs = {};
          let t = '';
          for (const c of el.childNodes) {
            if (c.nodeType === 1) kids.push(conv(c));
            else if (c.nodeType === 3 || c.nodeType === 4) t += c.nodeValue;
          }
          if (el.attributes) for (const a of el.attributes) attrs[a.name.toLowerCase()] = a.value;
          return { name: (el.localName || el.nodeName || '').toLowerCase(), attrs, kids, text: t };
        };
        return { name: '#doc', attrs: {}, kids: [conv(doc.documentElement)], text: '' };
      } catch (_) { return null; }
    }
    return handXml(text);
  }
  /* 手写扫描器（仅 Node 测试环境用；浏览器永远走上面的 DOMParser）：不求 XML 全解——
     DOCTYPE/PI 整段跳过（含内部子集的中括号配平，实体声明连同丢弃→外部实体永无定义）、
     未声明实体引用置空（XXE 面堵死）、五内置实体与数字引用解码、CDATA 记文本、深度封顶防深构造 */
  function handXml(text) {
    const root = { name: '#doc', attrs: {}, kids: [], text: '' };
    const stack = [root];
    const dec = s => s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ''; } })
      .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch (_) { return ''; } })
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&') // amp 最后解码：&amp;lt; 不会被二次腐蚀
      .replace(/&[a-zA-Z_][\w.-]*;/g, ''); // 未声明实体引用不展开
    const n = text.length;
    let i = 0;
    while (i < n) {
      const lt = text.indexOf('<', i);
      if (lt < 0) break;
      if (lt > i) stack[stack.length - 1].text += dec(text.slice(i, lt));
      if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt); i = e < 0 ? n : e + 3; continue; }
      if (text.startsWith('<![CDATA[', lt)) {
        const e = text.indexOf(']]>', lt);
        stack[stack.length - 1].text += text.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue;
      }
      if (text.startsWith('<!', lt) || text.startsWith('<?', lt)) { // DOCTYPE/PI：整段跳过（含内部子集嵌套中括号）
        let j = lt + 2, depth = 0, k = -1;
        while (j < n) {
          const ch = text[j];
          if (ch === '[') depth++;
          else if (ch === ']') depth--;
          else if (ch === '>' && depth <= 0) { k = j; break; }
          j++;
        }
        i = k < 0 ? n : k + 1; continue;
      }
      const gt = text.indexOf('>', lt);
      if (gt < 0) break;
      let tag = text.slice(lt + 1, gt);
      if (tag.startsWith('/')) { // 结束标签：出栈（越界保护防畸形文档）
        if (stack.length > 1) stack.pop();
        i = gt + 1; continue;
      }
      const selfClose = tag.endsWith('/');
      if (selfClose) tag = tag.slice(0, -1);
      const m = tag.match(/^([A-Za-z_][\w.:-]*)([\s\S]*)$/);
      if (!m) { i = gt + 1; continue; } // 畸形标签跳过（尽力收口径）
      const el = { name: m[1].toLowerCase(), attrs: {}, kids: [], text: '' };
      const am = m[2].match(/([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g) || [];
      for (const a of am) {
        const p = a.match(/^([A-Za-z_][\w.:-]*)\s*=/), v = a.match(/"[^"]*"|'[^']*'$/);
        if (p) el.attrs[p[1].toLowerCase()] = dec(v ? v[0].slice(1, -1) : '');
      }
      if (stack.length < DEPTH_MAX + 2) stack[stack.length - 1].kids.push(el); // 深度封顶：过深元素丢弃
      if (!selfClose) stack.push(el);
      i = gt + 1;
    }
    return root;
  }
  function findAll(node, name, cap) {
    const out = [];
    (function walk(x) {
      for (const k of x.kids || []) {
        if (out.length >= cap) return;
        if (k.name === name) out.push(k);
        walk(k);
      }
    })(node);
    return out;
  }
  function kidRaw(el, name) { const c = (el.kids || []).find(k => k.name === name); return c ? String(c.text).trim() : ''; }
  function kidText(el, name) { return cleanName(kidRaw(el, name)); }

  /* —— 各格式解析：统一返回 { entries, invalid }（URL 去重与 500 封顶由外层统一做） —— */
  function parsePls(text) {
    const files = new Map(), titles = new Map(); // N → 值（键大小写不敏感）
    for (const raw of text.split(/\r?\n/)) {
      const i = raw.indexOf('=');
      if (i < 0) continue;
      const key = raw.slice(0, i).trim().toLowerCase(), val = raw.slice(i + 1).trim();
      let m;
      if ((m = key.match(/^file(\d+)$/))) files.set(+m[1], val);
      else if ((m = key.match(/^title(\d+)$/))) titles.set(+m[1], val);
      // NumberOfEntries 只作提示：条目以实际 FileN 为准（错标/缺标不影响）
    }
    const out = [];
    let invalid = 0;
    for (const n of [...files.keys()].sort((a, b) => a - b)) {
      const u = files.get(n);
      if (!isHttp(u)) { invalid++; continue; }
      out.push(mkEntry(u, cleanName(titles.get(n)) || fallbackName(u), '自定义', 'pls'));
    }
    return { entries: out, invalid };
  }
  function parseXspf(text, baseUrl) {
    const doc = xmlTree(text);
    if (!doc) return { entries: [], invalid: 0 };
    const out = [];
    let invalid = 0;
    for (const t of findAll(doc, 'track', MAX * 2)) {
      const locs = (t.kids || []).filter(k => k.name === 'location').map(k => String(k.text).trim());
      let url = null;
      for (const l of locs) { const r = resolveUrl(l, baseUrl); if (r) { url = r; break; } } // 多 location 取首个可解析
      if (!url) { invalid++; continue; }
      const nm = kidText(t, 'title') || kidText(t, 'album'); // 缺标题：album 兜底再退 URL host
      out.push(mkEntry(url, nm || fallbackName(url), '自定义', 'xspf', kidRaw(t, 'image').slice(0, 512), kidRaw(t, 'identifier').slice(0, 128)));
    }
    return { entries: out, invalid };
  }
  function parseAsx(text, baseUrl) { // ASX/WAX/WMX 同构；ENTRYREF 不自动递归网络下载（本模块从不发请求，天然不递归）
    const doc = xmlTree(text);
    if (!doc) return { entries: [], invalid: 0 };
    const out = [];
    let invalid = 0;
    for (const e of findAll(doc, 'entry', MAX * 2)) {
      const hrefs = (e.kids || []).filter(k => k.name === 'ref').map(k => String(k.attrs.href || '').trim());
      let url = null;
      for (const h of hrefs) { const r = resolveUrl(h, baseUrl); if (r) { url = r; break; } }
      if (!url) { invalid++; continue; }
      out.push(mkEntry(url, kidText(e, 'title') || fallbackName(url), '自定义', 'asx'));
    }
    return { entries: out, invalid };
  }
  function parseM3u(text) { // m3u 与 csv（radio.txt 形态）收敛一份：#EXTINF/#genre# 节/URL 行/名字,地址 行
    const out = [];
    let invalid = 0, sec = '自定义', pend = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#VRADIO')) continue; // 本项目导出标记行，不影响导入
      if (line.endsWith('#genre#')) { sec = cleanCat(line.replace(/,#genre#$/, '')); continue; }
      if (/^#EXTINF:/i.test(line)) {
        let q = false, sep = -1; // 引号外的第一个逗号才是「属性区,台名」分隔（属性值可含逗号，app.js parse 同款）
        for (let j = 8; j < line.length; j++) { const ch = line[j]; if (ch === '"') q = !q; else if (ch === ',' && !q) { sep = j; break; } }
        const attrs = sep >= 0 ? line.slice(0, sep) : '', name = sep >= 0 ? line.slice(sep + 1).trim() : '';
        const g = attrs.match(/group-title="([^"]*)"/);
        pend = { n: cleanName(name), c: g && g[1] ? cleanCat(g[1]) : sec }; // group-title 缺省/空 → 当前节
        continue;
      }
      if (line.startsWith('#')) continue;
      if (isHttp(line)) {
        out.push(mkEntry(line, (pend && pend.n) || fallbackName(line), (pend && pend.c) || sec, 'm3u'));
        pend = null; continue;
      }
      const i = line.lastIndexOf(',');
      if (i < 0) { invalid++; continue; }
      const nm = cleanName(line.slice(0, i)), u = line.slice(i + 1).trim();
      if (!nm || !isHttp(u)) { invalid++; continue; }
      out.push(mkEntry(u, nm, sec, 'm3u'));
    }
    return { entries: out, invalid };
  }
  function parseUrls(text) {
    const out = [];
    let invalid = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (isHttp(line)) out.push(mkEntry(line, fallbackName(line), '自定义', 'url'));
      else invalid++;
    }
    return { entries: out, invalid };
  }

  /* —— 入口：parsePlaylist(text, { format, baseUrl }) → 条目数组（URL = 身份，去重 + 500 封顶）。
     数组上挂三个非枚举元数据（枚举外=JSON 序列化/遍历不受扰）：format=识别结果、invalid=非法地址数、dups=文件内重复数 —— */
  function parsePlaylist(text, opts) {
    const o = opts || {};
    text = String(text == null ? '' : text);
    const fmt = detect(text, o.format);
    const r = fmt === 'pls' ? parsePls(text) : fmt === 'xspf' ? parseXspf(text, o.baseUrl)
      : fmt === 'asx' ? parseAsx(text, o.baseUrl) : fmt === 'm3u' ? parseM3u(text) : parseUrls(text);
    const seen = new Set(), out = [];
    let dups = 0;
    for (const e of r.entries) {
      if (seen.has(e.url)) { dups++; continue; }
      seen.add(e.url);
      out.push(e);
      if (out.length >= MAX) break;
    }
    for (const [k, v] of [['format', fmt], ['invalid', r.invalid], ['dups', dups]])
      Object.defineProperty(out, k, { value: v, enumerable: false });
    return out;
  }

  const PI = { parse: parsePlaylist, parsePlaylist, detect, normHint };
  root.PlaylistImport = PI;
  if (typeof module !== 'undefined' && module.exports) module.exports = PI;
})(typeof window !== 'undefined' ? window : globalThis);
