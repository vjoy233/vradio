/* VRadio 应用层 —— 列表/搜索/分类/收藏/最近播放/导入导出/渲染的唯一所有者（模块契约见 docs/review.md 十一节债务 2）。
   播放一律经 Player 接口；同步/体检由 sync.js 编排本文件暴露的方法；台标数据经 Logos 模块获取（本文件只拼渲染片段）。
   身份公理（债务 1）：URL = 持久身份（收藏/最近记录源 URL，名字漂移后按 URL 回绑），名字 = 显示层。 */

// C3 可信发布链未完成安全验收，只有源码发布才能开放。
const trustedC3Release = false;

/* ---------- 内置精选（地址已实测直连可用；含同一电台的多个备选源。l = 台标，蜻蜓频道页封面实测可直连） ---------- */
const STARTER = [
  { c:'常听', n:'Love Radio FM103.7 经典金曲', u:['http://lhttp.qingting.fm/live/273/64k.mp3','http://ls.qingting.fm/live/273.m3u8'], l:'http://pic.qtfm.cn/2014/0909/20140909125130474.jpg!200' },
  { c:'常听', n:'动感101 FM101.7', u:['http://lhttp.qingting.fm/live/274/64k.mp3','http://live.xmcdn.com/live/53/64.m3u8'], l:'http://pic.qtfm.cn/2014/0909/20140909123511693.jpg!200' },
  { c:'常听', n:'经典947 FM94.7', u:['http://lhttp.qingting.fm/live/267/64k.mp3'], l:'http://pic.qtfm.cn/sso/48/1641437907698_k0NNOUP54.jpeg!200' },
  { c:'常听', n:'上海东广新闻台', u:['http://lhttp.qingting.fm/live/275/64k.mp3'], l:'http://pic.qtfm.cn/sso/198/1606449636209_K8-0Zavn2.png!200' },
  { c:'常听', n:'上海交通台 FM105.7', u:['http://lhttp.qingting.fm/live/266/64k.mp3','http://ls.qingting.fm/live/266.m3u8'], l:'http://pic.qtfm.cn/sso/48/1641437453117_JxQnTn1vv.jpeg!200' },
  { c:'常听', n:'CNR 中国之声', u:['http://ngcdn001.cnr.cn/live/zgzs/index.m3u8'] },
  { c:'常听', n:'CNR 音乐之声', u:['http://ngcdn003.cnr.cn/live/yyzs/index.m3u8'] },
  { c:'常听', n:'CRI 环球资讯广播 FM90.5', u:['http://sk.cri.cn/905.m3u8'] },
  { c:'常听', n:'CRI 怀旧金曲频道', u:['https://lhttp.qingting.fm/live/5022038/64k.mp3'], l:'http://pic.qtfm.cn/2024/0726/20240726111933.png!200' },
  { c:'常听', n:'Asia FM 亚洲经典台', u:['https://lhttp.qingting.fm/live/5021912/64k.mp3'], l:'http://pic.qtfm.cn/2022/0712/20220712122112.jpeg!200' },
  { c:'亚洲·港台', n:'YES 933 (新加坡)', u:['http://playerservices.streamtheworld.com/api/livestream-redirect/YES933AAC.aac'] },
  { c:'亚洲·港台', n:'Class 95 (新加坡)', u:['http://playerservices.streamtheworld.com/api/livestream-redirect/CLASS95AAC.aac'] },
  { c:'亚洲·港台', n:'Listen.Moe JPop', u:['https://listen.moe/stream'] },
  { c:'欧美音乐', n:'Nightwave Plaza', u:['http://radio.plaza.one/opus'] },
];

const $ = id => document.getElementById(id);
const keyOf = s => s.c + '|' + s.n;
const DAY = 86400000; // 死台分档各时间阈值共用（TTL/升级跨度/复测间隔/孤儿清理）
function stableStr(v) { // 键序无关的稳定序列化（rebind 前后快照比较专用，review#43 P3）：对象键按名排序后
  return JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? // 输出——语义相同仅键序不同 = 等价，不触发落盘
    Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x);
}
const SRC_CAP = 6; // 每台最终源集合统一封顶（plan §5.4「每台最多 6 条」，review P1：装配 applyCfg 收口、
                   // 详情/批量诊断同口径；Android 侧 C.SRC_TOTAL_CAP 镜像，双端不漂移）

/* ---------- 发现页纯派生（B3-C，plan-expansion-r4 §7.3）：本地字段六分组——不联网、不改主列表排序、
   不复制播放决策（点击统一走 Player.play）。纯函数（数据全注入，test/discovery.js 直测）：
   input = { rows:[{k,n,c,u0,u,hidden,dead,om}], quality:(u0,u)=>QualityAggregate|null,
             meta:{stations:{u0:{firstSeenAt}}}|null, recents:[{k,u:[]}], revives:Map(u0→ts),
             playingKey, connectingKey }
   规则固定：手动隐藏台一律过滤（无正在播例外——手动是明确意图）；dead 台默认过滤（正在播/连接中例外，
   沿用 visible() 口径）；QualityStore 无记录不进任何质量分组（unknown 计数供 UI「暂无质量数据」提示，
   绝不误判进 poor）；精选按 originMask（om 位，applySources 装配时打、不持久化）；
   排序 = 「最近新增」按 firstSeenAt 降序、其余按 lastObservedAt（B2 已派生字段，绝不引入 lastSeenAt 别名）
   降序，再 identityUrl 字典序稳定排序；每组 ≤20、组内不重复（构造即保证）、同一台可跨组。 ---------- */
function buildDiscovery(input) {
  const q = input.quality || (() => null);
  const metaSt = input.meta && input.meta.stations && typeof input.meta.stations === 'object' ? input.meta.stations : null;
  // radio-meta 的 firstSeenAt 挂在每个 source 上（继承上一份）：台级取最早源；容错直挂台级的形态
  const firstSeen = m => {
    if (!m) return 0;
    if (m.firstSeenAt) return m.firstSeenAt;
    if (Array.isArray(m.sources)) { let mn = 0; for (const x of m.sources) if (x && x.firstSeenAt && (!mn || x.firstSeenAt < mn)) mn = x.firstSeenAt; return mn; }
    return 0;
  };
  const heard = new Set();
  for (const r of input.recents || []) { if (r.k) heard.add(r.k); for (const u of r.u || []) heard.add(u); }
  const pk = input.playingKey || '', ck = input.connectingKey || '';
  const g = { starter: [], stable: [], fresh: [], revived: [], icy: [], unheard: [] };
  let unknown = 0;
  for (const r of input.rows || []) {
    if (!r || !r.u0) continue;
    if (r.hidden) continue;                                   // ① 手动隐藏台：彻底过滤
    if (r.dead && r.k !== pk && r.k !== ck) continue;         // ② dead 默认过滤（正在播/连接中例外口径沿用）
    const qa = q(r.u0, r.u);
    if (!qa) unknown++;                                       // ③ 无质量记录：不进质量分组、不误判
    const row = { k: r.k, n: r.n, c: r.c, u0: r.u0, obs: qa ? (qa.lastObservedAt || 0) : 0 };
    if (r.om) g.starter.push(row);                            // ④ 精选 = originMask（同名但 URL 由主列表提供的精选台也命中）
    if (qa && qa.stability === 'good' && qa.directCount > 0) g.stable.push(row); // 稳定直连：good 且有直流源（B2 directCount 口径）
    const at = metaSt ? firstSeen(metaSt[r.u0]) : 0;
    if (at) g.fresh.push(Object.assign({ at }, row));         // ⑤ 最近新增：radio-meta firstSeenAt（无 meta 该组为空）
    if (input.revives && input.revives.get(r.u0)) g.revived.push(row);               // ⑥ 最近恢复：只认明确转移记录
    if (qa && qa.metadata === 'icy') g.icy.push(row);                                // 有曲讯：metadata==icy
    if (!heard.has(r.k) && !(r.u || []).some(u => heard.has(u))) g.unheard.push(row); // 未听过：不在 radio.recents（键/URL 双口径）
  }
  const byObs = (a, b) => (b.obs - a.obs) || (a.u0 < b.u0 ? -1 : a.u0 > b.u0 ? 1 : 0);
  const byAt = (a, b) => ((b.at || 0) - (a.at || 0)) || (a.u0 < b.u0 ? -1 : a.u0 > b.u0 ? 1 : 0);
  for (const key of ['starter', 'stable', 'revived', 'icy', 'unheard']) g[key] = g[key].sort(byObs).slice(0, 20);
  g.fresh = g.fresh.sort(byAt).slice(0, 20);
  return { groups: g, unknown };
}

/* ---------- 筛选纯函数（ui-redesign §6.2/§6.3，P1 单一筛选状态）：state.scope='all'|'favorites'|'recent' 与
   state.cat（真实分类）双轨——旧 ★收藏/最近 哨兵不再写入 cat。依赖全显式注入（数据只读，不写 Store/不改
   stations），test/ui-scope.js 经 vm 沙箱直测。可见性规则：手动隐藏（台/分类）永不豁免——正在播也不豁免
   （手动是明确意图）；all=true 仅豁免自动 dead 标记（空态判断「只是被死台隐藏」用），正在播/连接中例外照旧。
   搜索 = 台名 + 空格 + 分类名拼接后逐词 AND（§3.4：不同词可分别命中台名/分类；dCat 留底不参与）。 ---------- */
function uiStationShown(s, opt) {
  if (!s || s.hidden || opt.hiddenCategories[s.c]) return false;
  const k = opt.key(s);
  return !!(opt.all || opt.showDead || s.health !== 'dead' || k === opt.playingKey || k === opt.connectingKey);
}
function uiProjectStations(opt) { // 范围投影：recent 源 = recents 前 20 条回绑解析（失配丢弃、URL 回绑、keyOf 去重保队首）；
  // favorites 按 favoriteKeys 过滤；category 只收真实分类（'全部' 不过滤）；多词 AND 可分别命中台名/分类
  const words = String(opt.keyword || '').toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set();
  const source = opt.scope === 'recent'
    ? opt.recents.slice(0, 20).map(opt.resolveRecent).filter(Boolean)
    : opt.stations;
  return source.filter(s => {
    const k = opt.key(s);
    if (seen.has(k) || !uiStationShown(s, opt)) return false;
    if (opt.scope === 'favorites' && !opt.favoriteKeys.has(k)) return false;
    if (opt.category !== '全部' && s.c !== opt.category) return false;
    const text = (s.n + ' ' + s.c).toLowerCase();
    if (!words.every(w => text.includes(w))) return false;
    seen.add(k); return true;
  });
}
function uiChooseResume(opt) { // 续听候选（§6.3，本批次先立纯函数，P2 接首页渲染）：当前播放/暂停 → 最近前 20 条 →
  // STARTER 精选，三级逐级回退；eligible 由调用方按 uiStationShown 组装（不受当前搜索影响）。无合格 → null
  const current = opt.current && opt.resolveCurrent(opt.current);
  if (current && opt.eligible(current)) return { station: current, origin: 'current' };
  for (const entry of opt.recents.slice(0, 20)) {
    const s = opt.resolveRecent(entry);
    if (s && opt.eligible(s)) return { station: s, origin: 'recent' };
  }
  for (const s of opt.starters) {
    if (s && opt.eligible(s)) return { station: s, origin: 'starter' };
  }
  return null;
}
/* 唱片旋转判定（ui-redesign §6.10 纯逻辑，P3 立函数供测试）：仅「真实 playing + 页面可见 + 未开启减动效」
   才转（§4.4：连接/缓冲/暂停/失败/ended/后台/系统减动效一律静止；不得以 play 事件或 paused=false 提前宣称） */
function uiPhaseRunning(phase, hidden, reduce) {
  return phase === 'playing' && !hidden && !reduce;
}

/* ---------- 数据分区预览纯函数（ui-redesign §5.5，P5）：cfg 差异计数与备份覆盖预览组装——只算数不触 DOM，
   test/ui-data.js 直测。uiCfgDiff 逐字段统计 增/删/改 键数（cats 数组按去重集合差、无「改」态；其余数组值
   整值比较——srcs/srcManualOrder 等元素顺序有意义）；计数可交换 → 键序无关；空 incoming（重置/空配置导入）
   = 全清计数，是「将清空全部 N 项」明示的依据。uiBackupPreview 把 BackupV3.read 的 info 组装成面板行/
   版本兼容说明/本形态不可用项/sidecar 可恢复性（质量 sidecar 仅 http 形态可恢复，收听统计双形态——
   file:// 走本地快照；与 BackupV3.commitImport 的 io.http 分支严格同口径）。 ---------- */
const UI_CFG_FIELDS = [ // 预览展示序 + 中文标签（cfg 字段 → 面板行；tag = 失配清单用的默认名快照，一并计入）
  ['moves', '电台移动分类'], ['names', '电台改名'], ['hideS', '隐藏电台'], ['renames', '分类改名'],
  ['hideC', '隐藏分类'], ['cats', '自建分类'], ['srcs', '追加备选源'], ['srcManualOrder', '源手动排序'],
  ['srcDisabled', '源禁用'], ['srcLabels', '源标签'], ['tag', '维护标记快照'],
];
function uiCfgDiff(cur, inc) {
  const out = { fields: {}, total: 0 };
  for (const [k] of UI_CFG_FIELDS) {
    let add = 0, del = 0, chg = 0;
    if (k === 'cats') { // 数组字段：按去重集合差计 增/删
      const a = new Set(Array.isArray(cur && cur.cats) ? cur.cats : []);
      const b = new Set(Array.isArray(inc && inc.cats) ? inc.cats : []);
      for (const x of b) if (!a.has(x)) add++;
      for (const x of a) if (!b.has(x)) del++;
    } else {
      const a = (cur && cur[k]) || {}, b = (inc && inc[k]) || {};
      for (const key of Object.keys(b)) {
        if (!Object.prototype.hasOwnProperty.call(a, key)) add++;
        else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) chg++;
      }
      for (const key of Object.keys(a)) if (!Object.prototype.hasOwnProperty.call(b, key)) del++;
    }
    out.fields[k] = { add, del, chg };
    out.total += add + del + chg;
  }
  return out;
}
function uiBackupPreview(info, opt) { // info = BackupV3.read 结果；opt.http = 当前形态。返回 {rows,notes,unavailable,side}
  const http = !!(opt && opt.http);
  const myN = info.my == null ? null : info.my.filter(l => !l.endsWith('#genre#')).length;
  const qN = info.quality ? Object.keys(info.quality.data).length : 0;
  const lN = info.ls ? Object.keys(info.ls.data).length : 0;
  const rows = [{ k: '备份版本', v: 'v' + info.ver + (info.ver < 3 ? '（旧版格式，按兼容口径读取）' : '') }];
  if (info.app) rows.push({ k: '来源应用', v: info.app });
  rows.push({ k: 'Store 数据', v: info.n + ' 个数据键（收藏/维护配置/健康标记/歌曲历史等，恢复时全部替换）' });
  rows.push({ k: '个人电台', v: myN == null ? '备份不含个人电台——本机 my-radio.txt 保持不动'
    : myN + ' 台（恢复时全量替换 my-radio.txt' + (!http ? '；file:// 形态无法写入，本项将跳过' : '') + '）' });
  if (info.quality) rows.push({ k: '质量 sidecar', v: qN + ' 台（覆盖本机质量数据' + (!http ? '；需 http 形态，本形态跳过' : '') + '）' });
  if (info.ls) rows.push({ k: '收听统计 sidecar', v: lN + ' 天（覆盖本机收听统计' + (!http ? '，写本地快照' : '') + '）' });
  const notes = [];
  if (info.ver === 1) notes.push('v1 备份不含个人电台数据：恢复不动 my-radio.txt');
  if (info.ver < 3) notes.push('旧版备份不含质量/收听统计 sidecar');
  const unavailable = []; // 本形态不可用项（§5.5：依赖后端的项目在预览面板明示，不用 toast 轰炸）
  if (!http) {
    if (info.my != null) unavailable.push('个人电台列表恢复——my-radio.txt 写入需要 http 形态（npm start）');
    if (info.quality) unavailable.push('质量 sidecar 恢复——服务端 /api/quality 需要 http 形态（npm start）');
  }
  const side = { qN, lN, hasQuality: !!info.quality, hasLs: !!info.ls,
    qualityOk: !!info.quality && http, lsOk: !!info.ls,
    any: (!!info.quality && http) || !!info.ls }; // 勾选框是否需要出现（无 sidecar 或本形态全不可恢复 → 不出勾选）
  return { rows, notes, unavailable, side };
}
/* 主题入口窄屏收纳（§6.11，boot 装配一次并留销毁函数）：同一节点（#themeWrap 含三选菜单）搬家——≤640px 收进
   #lowfreq（「⋯ 更多」内，文字 span 由 CSS 放出）、更宽回顶栏原锚点（#file 之前）；监听/radio.theme 随节点走，
   不复制 id。跨断点焦点：焦点在将隐藏的菜单内先关菜单（归还触发器）；DOM 搬家必脱焦——焦点还给随行 themeBtn，
   它不可见（lowfreq 收起态）则退到可见入口 #moreBtn，不让焦点落到隐藏节点或 body */
function uiPlaceTheme(wrap, desktopHost, before, compactHost) {
  const mq = matchMedia('(max-width:640px)');
  const place = () => {
    const ae = document.activeElement, take = !!(ae && wrap.contains(ae));
    if (take && ae !== $('themeBtn')) App.themeMenuClose(); // 菜单内焦点：先关菜单归还触发器
    if (mq.matches) compactHost.appendChild(wrap);
    else desktopHost.insertBefore(wrap, before);
    if (take) { const tb = $('themeBtn'); (tb.offsetParent ? tb : $('moreBtn')).focus({ preventScroll: true }); }
  };
  if (mq.addEventListener) mq.addEventListener('change', place);
  else mq.addListener(place);
  place();
  return () => { if (mq.removeEventListener) mq.removeEventListener('change', place); else mq.removeListener(place); };
}

/* ---------- 维护草稿引擎（ui-redesign §5/§6.4/§6.8/§6.9，P4 批次；语义内联自 docs/ui-redesign-assets/

   handoff-helpers.js——该文件是文档参考实现，不是生产代码） ----------
   草稿只在 App 内存（身份/基线不持久化，无新增 radio.* 键）；URL 是持久身份——草稿锚定稳定源 URL，
   绝不物理改 s.u[]。字段清除区分「删除属性」与空字符串（uiReadCell/uiSameCell 的 exists 语义）。
   调用方纪律：map 键限本次允许的 cfg 字段白名单；键必须是已解析验证的 URL（禁止任意输入当 key）；
   冲突检测比较完整对象投影（M02 同对象外部变化 → 三选，绝不默认覆盖）；显式覆盖只能由确认结果传
   force=true（M01 无关对象变化 → 在最新 cfg 上只合并本对象字段）；隐藏撤销同理 force=false（M03）。
   分类改名/删除是逻辑对象变更集合，走 uiBuildCatNext 原子级联（§6.4 明示不经简单 map 助手拼凑）。 ---------- */
function uiClone(value) { return JSON.parse(JSON.stringify(value)); }
function uiReadCell(cfg, map, key) { // 读 cfg 上一个 map 键的「单元格」：exists 区分「键不存在」与「值为空串」
  const box = cfg[map] || {};
  return Object.prototype.hasOwnProperty.call(box, key)
    ? { exists: true, value: uiClone(box[key]) } : { exists: false };
}
function uiSameCell(a, b) {
  return a.exists === b.exists && (!a.exists || JSON.stringify(a.value) === JSON.stringify(b.value));
}
function uiApplyCells(latest, cells, force) { // 在最新 cfg 上应用明确条目（map/key/after 均由调用方白名单校验）：
  // force=false 时任一 before 与最新值不符 → 整体拒绝（M03 撤销「拒绝盲撤」）；force=true 仅限显式确认传入
  const conflicts = cells.filter(c => !uiSameCell(uiReadCell(latest, c.map, c.key), c.before));
  if (conflicts.length && !force) return { ok: false, conflicts };
  const next = uiClone(latest);
  for (const c of cells) {
    if (!next[c.map]) next[c.map] = {};
    if (c.after.exists) next[c.map][c.key] = uiClone(c.after.value);
    else delete next[c.map][c.key];
  }
  return { ok: true, cfg: next, conflicts };
}
function uiNewDraft(identityUrl, projection) {
  return { identityUrl, base: uiClone(projection), patch: {},
    dirty: false, conflict: false, pendingAction: null, submitting: false };
}
function uiSameProj(a, b) { return JSON.stringify(a) === JSON.stringify(b); } // 完整投影比较（JSON 序差异最多保守误报冲突，§6.4）
function uiResolveUnique(stations, url, hintKey) { // 锚点 → 唯一台（失配/多重匹配 throw，绝不按名字猜台——§5.3）。
  // hintKey = begin 时刻的 keyOf（App.resolve 同款身份语义：键优先、URL 兜底）——精选层与主列表
  // 共享流 URL 的台（同蜻蜓 id 不同名）凭 URL 会多重匹配，凭会话内稳定键可唯一锚定；都不唯一仍拒绝
  const matches = stations.filter(s => s.u.includes(url));
  if (matches.length === 1) return matches[0];
  if (hintKey) {
    const byKey = stations.filter(s => keyOf(s) === hintKey);
    if (byKey.length === 1 && (matches.length > 1 || matches.length === 0)) return byKey[0];
  }
  throw new Error(matches.length ? '源 URL 匹配到多个电台，请重新选择' : '电台已失配（源地址漂移），请重新加载');
}
function uiValidName(name) { // 现.askName 校验语义等价，但**不静默裁切**：内联报错由用户修正（§6.8）
  const v = String(name == null ? '' : name).trim();
  if (!v) return '名称不能为空';
  if (/[|,\r\n]/.test(v)) return '名称不能含 | 或逗号（列表分隔符）';
  if (Array.from(v).length > 24) return '名称最多 24 个字符';
  return '';
}
function uiNameTaken(stations, s, cat, name) { // 同分类撞名（keyOf 串台防护，与现.stRename 同口径：按生效名/分类比较）
  return stations.some(x => x !== s && x.c === cat && x.n === name);
}
function uiHasAdj(cfg, s) { // 该台是否还有任何个人调整（tag 快照「只增有据、无调整即清」的判定依据；B1 全字段口径）
  return s.u.some(u => !!(cfg.names[u] || cfg.moves[u] || cfg.hideS[u] || cfg.srcs[u] || cfg.srcLabels[u]))
    || !!(cfg.srcManualOrder[s.u[0]] || cfg.srcDisabled[s.u[0]]);
}
function uiTagCells(latest, work, s, baseName) { // tag 快照差量（失配清单显示用）：有任一调整 → 写默认名；全清 → 删键
  const cells = [];
  for (const u of s.u) {
    const before = uiReadCell(latest, 'tag', u);
    const after = uiHasAdj(work, s) ? { exists: true, value: baseName } : { exists: false };
    if (!uiSameCell(before, after)) cells.push({ map: 'tag', key: u, before, after });
  }
  return cells;
}

/* ---------- 对象投影（完整投影 = 同对象全部可编辑配置，纳入 M02 冲突检测） ---------- */
function uiStationProjection(cfg, s) {
  const out = { kind: 'st', urls: s.u.slice(), name: s.n, category: s.c, hidden: !!s.hidden, maps: {} };
  for (const map of ['names', 'moves', 'hideS', 'tag', 'srcs', 'srcManualOrder', 'srcDisabled', 'srcLabels']) {
    out.maps[map] = {};
    for (const u of s.u) if (Object.prototype.hasOwnProperty.call(cfg[map] || {}, u)) out.maps[map][u] = uiClone(cfg[map][u]);
  }
  return out;
}
function uiCatProjection(cfg, subj) { // subj = {orig, name}：分类在编辑会话中记录原名与基线（§5.3）
  return { kind: 'cat', orig: subj.orig, name: subj.name, custom: (cfg.cats || []).includes(subj.name),
    from: Object.keys(cfg.renames || {}).find(k => cfg.renames[k] === subj.name) || null,
    hidden: !!cfg.hideC[subj.name],
    movesTo: Object.keys(cfg.moves || {}).filter(k => cfg.moves[k] === subj.name).sort() };
}
function uiSrcProjection(cfg, s) { // §6.9 步骤1：本台 srcs + u[0] 的 srcManualOrder/srcDisabled + 全部源 URL 的 srcLabels + 原始 u 快照
  const key = s.u.find(x => Object.prototype.hasOwnProperty.call(cfg.srcs || {}, x)) || null;
  return { kind: 'src', urls: s.u.slice(), srcsKey: key, srcs: key ? uiClone(cfg.srcs[key]) : null,
    manual: uiClone(cfg.srcManualOrder[s.u[0]] || null), disabled: uiClone(cfg.srcDisabled[s.u[0]] || null),
    labels: Object.fromEntries(s.u.filter(u => Object.prototype.hasOwnProperty.call(cfg.srcLabels || {}, u)).map(u => [u, cfg.srcLabels[u]])) };
}

/* ---------- 下一份 cfg（只在最新 cfg 上写本对象的变更集合；M01：无关对象以最新值为准） ---------- */
function uiBuildStationNext(latest, s, patch, base, force) {
  const has = (p, k) => Object.prototype.hasOwnProperty.call(p, k);
  const cells = [];
  for (const u of s.u) {
    if (has(patch, 'name')) { // 等于默认名 = 撤键（与.stMove「选默认 = 删 moves 键」同思路），绝不写冗余键
      const nm = String(patch.name).trim();
      const def = s.dName || base.name;
      cells.push({ map: 'names', key: u, before: uiReadCell(latest, 'names', u), after: nm === def ? { exists: false } : { exists: true, value: nm } });
    }
    if (has(patch, 'category')) { // 目标 = 默认分类（按最新 cfg 命名折算）→ 撤 moves 键（↺ 语义）
      const def = (latest.renames || {})[s.dCat] || s.dCat || base.category;
      cells.push({ map: 'moves', key: u, before: uiReadCell(latest, 'moves', u), after: patch.category === def ? { exists: false } : { exists: true, value: patch.category } });
    }
    if (has(patch, 'hidden'))
      cells.push({ map: 'hideS', key: u, before: uiReadCell(latest, 'hideS', u), after: patch.hidden ? { exists: true, value: 1 } : { exists: false } });
  }
  const work = uiApplyCells(latest, cells, true).cfg; // 草稿副本上先套非 tag 条目再算 tag 差量（内部 scratch，恒 force）
  cells.push(...uiTagCells(latest, work, s, s.dName || base.name));
  return uiApplyCells(latest, cells, force).cfg; // cells 的 before 取自 latest 本身 → 本层结构上无冲突；
  // 冲突唯一闸门 = 引擎的完整投影比对（force 仅标记「显式覆盖」的意图，语义与 §6.4 一致）
}
function uiBuildSrcNext(latest, s, patch, base, force) { // §6.9 步骤5：本台变更集合合并最新 cfg（uiApplyCells）
  const cells = [];
  const key = s.u.find(x => Object.prototype.hasOwnProperty.call(latest.srcs || {}, x)) || s.u[0]; // 挂键 = 台上任一已有 srcs 键，否则主 URL（.srcAppend 同口径）
  const removes = patch.removes || [], appends = patch.appends || [];
  const arr = (latest.srcs[key] || []).filter(u => !removes.includes(u)); // 现值 − 移除（值域必是追加源）
  for (const a of appends) if (!arr.includes(a) && !s.u.includes(a)) arr.push(a); // + 追加（去重、原序在前追加序在后）
  const bSrc = uiReadCell(latest, 'srcs', key);
  const aSrc = arr.length ? { exists: true, value: arr } : { exists: false };
  if (!uiSameCell(bSrc, aSrc)) cells.push({ map: 'srcs', key, before: bSrc, after: aSrc });
  if (patch.manual !== null) { // 人工顺序：完整序材料化（含禁位殿后，与.moveSrc 同口径）；[] = 撤键
    const b = uiReadCell(latest, 'srcManualOrder', s.u[0]);
    const a = patch.manual.length ? { exists: true, value: patch.manual.slice() } : { exists: false };
    if (!uiSameCell(b, a)) cells.push({ map: 'srcManualOrder', key: s.u[0], before: b, after: a });
  }
  if (patch.disabled !== null) { // 禁用表：非空写入、空数组撤键
    const b = uiReadCell(latest, 'srcDisabled', s.u[0]);
    const a = patch.disabled.length ? { exists: true, value: patch.disabled.slice() } : { exists: false };
    if (!uiSameCell(b, a)) cells.push({ map: 'srcDisabled', key: s.u[0], before: b, after: a });
  }
  for (const [u, v] of Object.entries(patch.labels || {})) { // 标签：空串 = 删键（删除属性 ≠ 空字符串）
    const val = String(v).trim();
    const b = uiReadCell(latest, 'srcLabels', u);
    const a = val ? { exists: true, value: val } : { exists: false };
    if (!uiSameCell(b, a)) cells.push({ map: 'srcLabels', key: u, before: b, after: a });
  }
  const work = uiApplyCells(latest, cells, true).cfg;
  cells.push(...uiTagCells(latest, work, s, s.dName || base.name));
  return uiApplyCells(latest, cells, force).cfg; // 同 uiBuildStationNext：before 取自 latest，冲突闸门在引擎投影比对
}
function uiBuildCatNext(latest, orig, patch, base, force, catExists) { // 分类改名级联（复用现.catRename 顺序：renames →
  // moves 目标 → hideC 键；撞名合并 = 自建分类让位消失）；隐藏切换随后套在最终名上——一个逻辑对象一次提交
  const next = uiClone(latest);
  const has = (p, k) => Object.prototype.hasOwnProperty.call(p, k);
  const cur = (next.renames || {})[orig] || orig;
  let finalName = cur;
  if (has(patch, 'name')) {
    const neu = String(patch.name).trim();
    if (neu && neu !== cur) {
      if ((next.cats || []).includes(cur)) next.cats = catExists(neu) ? next.cats.filter(x => x !== cur) : next.cats.map(x => x === cur ? neu : x);
      else { const org = Object.keys(next.renames || {}).find(k => next.renames[k] === cur);
        if (org) next.renames[org] = neu; else next.renames[cur] = neu; }
      for (const k of Object.keys(next.moves || {})) if (next.moves[k] === cur) next.moves[k] = neu; // 移动目标级联
      if (next.hideC[cur]) { next.hideC[neu] = 1; delete next.hideC[cur]; } // 隐藏标记随名转移
      finalName = neu;
    }
  }
  if (has(patch, 'hidden')) { if (patch.hidden) next.hideC[finalName] = 1; else delete next.hideC[finalName]; }
  return next;
}

/* ---------- 逐对象编辑器（§6.8）：io 依赖显式注入——resolve（URL/原名锚点 → 唯一对象，失配/多重匹配
   必须 throw 绝不猜）、readCfg、project（完整投影）、newPatch/dirtyOf/fields（补丁结构与字段白名单）、
   validate、buildNext（最新 cfg 上只写本对象，返回下一份完整 cfg）、beforeCommit?（保存前追加确认，
   如分类合并影响）、commit、render、confirmLeave（'save'|'discard'|'stay'）、confirmConflict
   （'reload'|'overwrite'|'stay'）。弹窗等待期间再收到他页更新 → 每轮对最新对象重校验（attempt ≤4）；
   校验失败留草稿就地纠错；提交中 submitting=true 禁本对象重复保存（不阻塞音频）；失败保留草稿（§5.2）。
   一次只进一个对象（draft 单槽）。 ---------- */
function uiCreateEditor(io) {
  let draft = null, saving = false;
  const paint = () => io.render(draft ? uiClone(draft) : null, saving);
  const fresh = (identity, kind, hintKey) => {
    const d = uiNewDraft(identity, io.project(io.readCfg(), io.resolve(identity, kind, hintKey), kind));
    d.kind = kind; d.hintKey = hintKey || ''; d.error = ''; d.patch = io.newPatch ? io.newPatch(kind) : {};
    return d;
  };
  async function save() {
    if (!draft || saving) return false;
    saving = true; draft.submitting = true; paint();
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const subj = io.resolve(draft.identityUrl, draft.kind, draft.hintKey), latest = io.readCfg();
        const proj = io.project(latest, subj, draft.kind);
        const error = io.validate(subj, draft.patch, latest, draft.kind);
        if (error) { draft.error = error; paint(); return false; } // 校验失败：留在编辑，pendingAction 不执行
        if (!uiSameProj(proj, draft.base)) { // M02 同对象外部变化：留草稿标 conflict，三选（不默认覆盖）
          draft.conflict = true; paint();
          const choice = await io.confirmConflict(uiClone(draft), uiClone(proj));
          if (choice === 'reload') { draft = fresh(draft.identityUrl, draft.kind, draft.hintKey); paint(); return false; }
          if (choice !== 'overwrite') return false; // 继续编辑：草稿原样保留
          const cur = io.resolve(draft.identityUrl, draft.kind, draft.hintKey), freshCfg = io.readCfg();
          if (!uiSameProj(io.project(freshCfg, cur, draft.kind), proj)) continue; // 弹窗期间又变：重校验
          const go = io.beforeCommit ? await io.beforeCommit(cur, draft, freshCfg) : 'go';
          if (go !== 'go') { paint(); return false; }
          io.commit(io.buildNext(freshCfg, cur, draft.patch, draft.base, true, draft.kind), draft, cur); // 覆盖也只写本对象
        } else {
          const go = io.beforeCommit ? await io.beforeCommit(subj, draft, latest) : 'go';
          if (go !== 'go') { paint(); return false; }
          io.commit(io.buildNext(latest, subj, draft.patch, draft.base, false, draft.kind), draft, subj);
        }
        // 保存成功：基线推进到最新、草稿清空（留编辑态）。hint 由刚提交的对象重算（io.hint——改名后
        // keyOf 已变，旧 hint 会失配）；重挂基线自身失配（对象此刻消失，理论罕见）不回头否定已成功的提交
        const hint2 = io.hint ? io.hint(subj) : (draft.hintKey || '');
        try { draft = fresh(draft.identityUrl, draft.kind, hint2); }
        catch (_) { draft = null; paint(); return true; }
        paint(); return true;
      }
      draft.error = '对象持续变化，请重新加载后再保存'; paint(); return false;
    } catch (e) { if (draft) { draft.error = (e && e.message) || '保存失败'; paint(); } return false; }
    finally { saving = false; if (draft) draft.submitting = false; paint(); }
  }
  return {
    getDraft: () => draft ? uiClone(draft) : null,
    get saving() { return saving; },
    begin(url, kind, hintKey) { draft = fresh(url, kind || 'st', hintKey); paint(); },
    end() { if (!draft) return; draft = null; paint(); },
    change(field, value) { // 白名单字段编辑：值回到基线即撤补丁（不偷偷写 Store，§6.8）
      if (!draft || saving) return;
      if (!(io.fields(draft.kind) || []).includes(field)) throw new Error('不允许编辑此字段');
      if (uiSameProj(value, draft.base[field])) delete draft.patch[field]; else draft.patch[field] = value;
      draft.dirty = io.dirtyOf(draft.patch, draft.base); draft.error = ''; paint();
    },
    mutate(fn) { // 结构化补丁入口（源草稿的排序/禁用/标签/追加/移除）：fn(patch, base) 就地改，脏态统一收口
      if (!draft || saving) return;
      fn(draft.patch, draft.base);
      draft.dirty = io.dirtyOf(draft.patch, draft.base); draft.error = ''; paint();
    },
    externalChanged() { // Store 对账/同步重建后的复核挂点：不替换原 render/同步链，只复核当前草稿 conflict 态
      if (!draft) return;
      try { draft.conflict = !uiSameProj(io.project(io.readCfg(), io.resolve(draft.identityUrl, draft.kind, draft.hintKey), draft.kind), draft.base); }
      catch (e) { draft.conflict = true; draft.error = e.message; }
      paint();
    },
    async depart(next) { // 离开流程（§5.3）：dirty → 三选；「保存并继续」失败停在编辑不执行 next；Esc=继续编辑
      if (saving) return false;
      if (draft && draft.dirty) {
        const choice = await io.confirmLeave(uiClone(draft));
        if (choice === 'stay') return false;
        if (choice === 'save' && !await save()) return false;
        if (choice !== 'save' && choice !== 'discard') return false;
      }
      next(); return true;
    },
    save,
  };
}

/* ---------- 统一确认弹窗层（§6.8）：#editorConfirm 唯一实例（hidden div + .mbox 复用样式，与
   #manage/#detail 同款机制，不引入新机制）。Promise 只 resolve 一次（按钮/Esc/点遮罩）；内容用
   textContent 构造防注入；快速关/开的陈旧事件经 done 标记 + 监听器移除防护（handoff-helpers 排队
   close 防护的同款语义，接入时不得删）；Esc = opt.safe（默认 'stay' = 继编辑/取消）；最上层参与
   全局焦点陷阱（嵌套确认关闭不误关父面板）。绝不把 confirm() 布尔结果塞进三选流程。 ---------- */
function uiChooseDialog(title, message, choices, opt = {}) {
  const box = $('editorConfirm'), dlg = box.querySelector('.ecbox');
  if (!box.hidden) return Promise.reject(new Error('确认弹窗已在使用中'));
  return new Promise(resolve => {
    const opener = document.activeElement, safe = opt.safe || 'stay';
    let done = false;
    const finish = value => {
      if (done) return; done = true; // 只 resolve 一次（快速关/开的排队事件不再触发）
      box.removeEventListener('keydown', onKey, true);
      box.removeEventListener('click', onBackdrop);
      box.hidden = true; dlg.replaceChildren();
      const ae = document.activeElement;
      if (opener && opener.isConnected && (!ae || ae === document.body)) opener.focus(); // 焦点归还呼出点
      resolve(value);
    };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(safe); } };
    const onBackdrop = e => { if (e.target === box) finish(safe); }; // 点遮罩 = 安全项（stay），不误触发副作用
    box.addEventListener('keydown', onKey, true); // capture：抢在全局 Esc 链之前处理确认层
    box.addEventListener('click', onBackdrop);
    const head = document.createElement('div'); head.className = 'mhead';
    const hb = document.createElement('b'); hb.id = 'ecHead'; hb.textContent = title; head.appendChild(hb); // 与静态 aria-labelledby 对应
    const body = document.createElement('div'); body.className = 'ecbody';
    const p = document.createElement('p'); p.textContent = message; body.appendChild(p);
    if (opt.build) opt.build(body); // 扩展内容（撤回确认的影响预览清单/勾选项）
    const acts = document.createElement('div'); acts.className = 'ecacts';
    let safeBtn = null;
    for (const c of choices) {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'btn' + (c.primary ? ' acc' : ''); b.textContent = c.label;
      b.addEventListener('click', () => finish(c.value), { once: true });
      if (c.value === safe) safeBtn = b;
      acts.appendChild(b);
    }
    body.appendChild(acts);
    dlg.replaceChildren(head, body);
    box.hidden = false;
    (safeBtn || acts.querySelector('button')).focus(); // 初始焦点落安全项（继续编辑/取消）
  });
}
/* 底栏高度观察器（ui-redesign §6.5 原样抄入）：启动一次、页面卸载清理；--dock-h = 实测 footer 高度，
   桌面壳用作 dashboard-main 的 padding-bottom 占位与 scroll-padding-bottom（紧凑态不消费、90px 规则不动）。
   参数传实际 footer 节点而非猜 id */
function uiWatchDock(dock) {
  const root = document.documentElement;
  const update = () => root.style.setProperty('--dock-h', Math.ceil(dock.getBoundingClientRect().height) + 'px');
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
  if (ro) ro.observe(dock);
  window.addEventListener('resize', update);
  update();
  return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', update); };
}

/* 更多工具桌面收纳（ui-redesign P2/§6.6，uiPlaceTheme 同款搬家范式）：ui-refresh 且 ≥1024px 时把 #lowfreq
   整体搬进侧栏 #sideTools（节点唯一、监听随节点走，同步/体检/导入/导出/发现行为不变）；更窄搬回 header
   原锚点（#moreBtn 之前）。跨断点焦点在搬移节点内 → 先收 popover 再归还可见触发器（桌面 #sideMore /
   紧凑 #lowfreq 内首个可见按钮，都不见则 #moreBtn），不让焦点落到隐藏节点 */
function uiPlaceTools(low, desktopBox, headerAnchor) {
  const mq = matchMedia('(min-width:1024px)');
  const place = () => {
    if (!document.documentElement.classList.contains('ui-refresh')) return; // 开关关：不搬家，紧凑布局原位
    if (mq.matches === (low.parentNode === desktopBox)) return; // 已在正确宿主：幂等早退（resize 兜底轮询零搬动/零脱焦）
    const ae = document.activeElement, take = !!(ae && low.contains(ae));
    App.sideToolsClose(); // 跨断点先收 popover（aria-expanded 同步复位）
    if (mq.matches) desktopBox.appendChild(low);
    else headerAnchor.parentNode.insertBefore(low, headerAnchor);
    if (take) {
      const t = mq.matches ? $('sideMore') : [...low.querySelectorAll('button')].find(b => b.offsetParent);
      (t || $('moreBtn')).focus({ preventScroll: true });
    }
  };
  if (mq.addEventListener) mq.addEventListener('change', place);
  else mq.addListener(place);
  addEventListener('resize', place); // 兜底：个别环境（如部分仿真/分屏）断点事件不发出时，随窗口尺寸变化对齐宿主
  place();
  return () => { if (mq.removeEventListener) mq.removeEventListener('change', place); else mq.removeListener(place); removeEventListener('resize', place); };
}

const App = {
  /* 集中状态（docs/review.md 架构-风险 2）：stations 数据 + 渲染哨兵 + 行索引（体检增量更新用，去 O(n²)）
     view：网格/列表视图（boot 从 localStorage 恢复，网格为默认——单列长列表浪费纵向空间）
     showDead：无效源（体检 ✗）台是否显示，默认隐藏（boot 从 localStorage 恢复）
     theme：auto/light/dark，默认跟随系统（boot 从 localStorage 恢复，写 <html data-theme>）
     scope：范围筛选（ui-redesign §3.2 单一筛选状态）='all'|'favorites'|'recent'——内存态不持久化（刷新回全部）；
     cat 只存真实分类名（旧 ★收藏/最近 哨兵绝不写入，切范围入口统一转 scope），与 scope/keyword 组合筛选 */
  state: { stations: STARTER.slice(), scope: 'all', cat: '全部', keyword: '', view: 'grid', showDead: false, theme: 'auto', stamp: 0, index: new Map() },
  rowIdx: 0, // 方向键导航落点（UI 审计 P2-5）：roving tabindex——仅此行 tabindex=0，Tab 不再穿全库停靠点
  favs: [],    // [{k, u:[源URL…]}] —— 带 URL 的条目永不回收（休眠待回绑），旧名字键回绑失败即刻回收
  recents: [], // [{k, n, u:[…]}] 最近在前、≤20；队首即「上次收听」（E3 与 lastKey 合并为单一队列）
  cfg: null,   // 个人维护层（radio.cfg，owner 三批拍板）：分类重命名/隐藏/自建 + 电台移动/重命名/隐藏 + 追加备选源（P1-a/r2 ⑨）。
               // 键 = 源 URL（身份公理），同步重建后自动复用；tag = URL→原始台名快照，仅供失配清单显示
  songFor: '',   // 曲讯归属台（B-6/B-7）：切台/刷新即清零重取（当前曲名本体在 B3 管线 metaPipe.last）
  phase: '',     // 瞬时播放阶段（P3/§6.10，Player.onphase 只读投影）：'connecting'|'playing'|'buffering'|'paused'|'idle'
                 // 固定枚举；仅驱动唱片旋转与续听卡按钮，不新增持久键、不覆盖 onstate 任何副作用
  metaPipe: null,  // 曲讯事件管线（B3-A）：boot 创建（Metadata.mpCreate）——世代校验/清洗/同曲去重/入史决策的唯一所在
  metaV2: false,   // sink 选择（boot 按 FEATURES.metadataV2 定格）：false=Legacy（现状行为）/true=V2（归一化字段消费），绝不双写
  metaLast: null,  // V2 sink 记的最近一次归一化事件（artist/track/program 供统计/发现派生；Legacy 不写）
  metaCache: null, // radio-meta.json 懒加载缓存（B3-C 发现页「最近新增」；file:// 无 script 包装 → null 该组为空）
  revives: new Map(), // dead→可用 状态转移记录（B3-C「最近恢复」唯一依据）：身份 URL → 时间戳，7 天过期，无记录不猜测

  /* ---------- 持久化（localStorage 全部容错读取 + 旧格式迁移） ---------- */
  loadStore() {
    let favs; try { favs = JSON.parse(Store.get('radio.favs') || '[]'); } catch (_) { favs = []; }
    this.favs = (Array.isArray(favs) ? favs : []).map(f => typeof f === 'string' ? { k: f, u: [] } : { k: String(f.k), u: Array.isArray(f.u) ? f.u : [] });
    let rec; try { rec = JSON.parse(Store.get('radio.recents') || '[]'); } catch (_) { rec = []; }
    rec = Array.isArray(rec) ? rec : [];
    const last = localStorage.getItem('radio.last'); // 旧「上次收听」键 → 并入 recents 队首
    if (last && !rec.some(r => r.k === last)) rec.unshift({ k: last, n: '', u: [] });
    localStorage.removeItem('radio.last');
    this.recents = rec.slice(0, 20).map(r => ({ k: String(r.k), n: r.n || String(r.k).split('|').pop() || '', u: Array.isArray(r.u) ? r.u : [] }));
    // 死台标记持久化（radio.health）：键 → { u:[源URL快照], t:最近确认, t0:首死, n:连续确认数, perm:1=停运档 }。
    // 分档（grill R1-R4 拍板）：疑似档兜底 TTL 180 天（纯数据卫生——静默复测常态化下唯一触发场景 = 半年没开
    // 页面，复活反而是合理探测）；停运档永不过期（复活只走复测撤销，即 patchHealth 的 ok 分支）；
    // ✓ 标记不持久化（会话级反馈即可，隐藏只关心死台）。旧数据兼容：无 t0/n/perm 按「疑似档、n=1、t0=t」读
    let hp; try { hp = JSON.parse(Store.get('radio.health') || '{}'); } catch (_) { hp = {}; }
    this.healthMarks = {};
    for (const k of Object.keys(hp || {})) {
      const e = hp[k]; if (!e || !Array.isArray(e.u)) continue;
      if (!e.perm && Date.now() - (e.t || 0) >= 180 * DAY) continue;
      this.healthMarks[k] = { u: e.u, t: e.t || 0, t0: e.t0 || e.t || 0, n: Math.max(1, e.n | 0), perm: e.perm ? 1 : 0 };
    }
  },
  saveFavs() { Store.set('radio.favs', JSON.stringify(this.favs)); },
  saveRecents() { Store.set('radio.recents', JSON.stringify(this.recents)); },
  saveHealth() { // FIFO 分档封顶（R4 拍板：疑似 1000 + 停运 1000；时间序扫描，停运档最后才挤——只增不减的
    // 停运台天然封顶于 radio.txt 在列数，2000 条合计约 1MB，5MB 配额内可控）
    const ks = Object.keys(this.healthMarks).sort((a, b) => (this.healthMarks[a].t || 0) - (this.healthMarks[b].t || 0));
    let n1 = 0, n2 = 0;
    for (const k of ks) { if (this.healthMarks[k].perm) { if (++n2 > 1000) delete this.healthMarks[k]; } else if (++n1 > 1000) delete this.healthMarks[k]; }
    Store.set('radio.health', JSON.stringify(this.healthMarks));
  },

  /* ---------- 「最近恢复」记录（B3-C 发现页）：health dead→可用 的明确状态转移——体检复活（patchHealth）
     与他页复测对账（applyServerStore）两路径落账；内存 Map + localStorage 运行时缓存（键 discovery.revives，
     非 radio.*，7 天过期）。无转移记录绝不猜测（同步重建/换名不产生复活）。 ---------- */
  loadRevives() {
    this.revives = new Map();
    try {
      const j = JSON.parse(localStorage.getItem('discovery.revives') || '{}');
      const now = Date.now();
      for (const [u, t] of Object.entries(j || {})) if (Number.isFinite(t) && now - t < 7 * DAY) this.revives.set(u, t);
    } catch (_) {}
  },
  markRevive(s) {
    const u = s && s.u && s.u[0]; if (!u) return;
    this.revives.set(u, Date.now());
    while (this.revives.size > 200) { // 与健康标记 FIFO 同量级兜底：丢最旧
      let old = null;
      for (const [k, v] of this.revives) if (!old || v < old[1]) old = [k, v];
      this.revives.delete(old[0]);
    }
    try { localStorage.setItem('discovery.revives', JSON.stringify(Object.fromEntries(this.revives))); } catch (_) {}
  },

  /* ---------- 维护配置（radio.cfg）：localStorage 全部容错读取，结构与导入共用一套校验 ---------- */
  loadCfg() {
    let c; try { c = JSON.parse(Store.get('radio.cfg') || 'null'); } catch (_) { c = null; }
    this.cfg = this.normCfg(c);
  },
  normCfg(c) { // 结构校验/补齐（导入的 JSON 也走这里，坏形状回退空配置）。v2（B0）：无 v 视为 v1 走迁移，
    // 未知字段忽略（只保留已知字段集），坏结构在调用方回退空配置
    c = this.migrateCfgV1(c);
    const o = { v: 2 };
    for (const k of ['moves', 'names', 'tag']) o[k] = this.normStrMap(c[k]);                      // URL → 字符串
    o.renames = this.normStrMap(c.renames, true);                                                // 分类名 → 分类名（键非 URL，不做 URL 过滤）
    const urlKeys = m => Object.fromEntries(Object.entries(m).filter(([k]) => /^https?:\/\//.test(k)));
    o.hideS = c.hideS && typeof c.hideS === 'object' ? urlKeys(c.hideS) : {};                   // URL → 1（手藏电台）
    // 追加备选源（P1-a/r2 ⑨）：URL → [追加源 URL…]。条数 6 / 单条 512 封顶对齐 mystation 护栏口径；只追加不动身份
    const urlArrMap = m => { const o = {}; for (const [k, v] of Object.entries(m || {})) if (/^https?:\/\//.test(k) && Array.isArray(v)) { const a = [...new Set(v.map(x => String(x).trim().slice(0, 512)).filter(x => /^https?:\/\//.test(x)))].slice(0, 6); if (a.length) o[k.trim()] = a; } return o; };
    o.srcs = urlArrMap(c.srcs);
    // 源生命周期三字段（B0 契约冻结，B1 接线播放/体检/详情语义）：人工顺序只生成运行时顺序不物理重排 s.u[]；
    // 禁用表结构同款（URL → 被禁源列表）；标签只改展示。键/元素清洗与 srcs 同口径
    o.srcManualOrder = urlArrMap(c.srcManualOrder);
    o.srcDisabled = urlArrMap(c.srcDisabled);
    o.srcLabels = this.normStrMap(c.srcLabels);
    const strKeys = m => Object.fromEntries(Object.entries(m).filter(([k, v]) => typeof k === 'string' && k.trim() && v !== null && v !== false));
    o.hideC = c.hideC && typeof c.hideC === 'object' ? strKeys(c.hideC) : {};                   // 分类名 → 1（藏分类）
    o.cats = Array.isArray(c.cats) ? [...new Set(c.cats.filter(x => typeof x === 'string' && x.trim() && !x.includes('|')).map(x => x.trim()))] : [];
    return o;
  },
  migrateCfgV1(c) { // v1（无 v 字段）→ v2：字段集合兼容、仅补版本语义，原样透传给 normCfg 清洗；未知字段随 normCfg 丢弃
    if (!c || typeof c !== 'object' || Array.isArray(c)) return {};
    return c.v === undefined ? Object.assign({}, c, { v: 2 }) : c;
  },
  normStrMap(m, anyKey) { const o = {}; for (const [k, v] of Object.entries(m || {})) if (typeof v === 'string' && v.trim() && (anyKey || /^https?:\/\//.test(k))) o[k.trim()] = v.trim(); return o; },
  saveCfg() { Store.set('radio.cfg', JSON.stringify(this.cfg)); },

  /* ---------- 列表解析：radio.txt（"分类,#genre#" 分节 + 名字,地址 行）与 m3u（#EXTINF + URL 行）双格式 ---------- */
  parse(text) {
    const map = new Map(); let sec = '未分类', pend = null;
    const add = (c, n, u) => {
      if (!n || !/^https?:\/\//.test(u)) return;
      const k = c + '|' + n;
      if (!map.has(k)) map.set(k, { c, n, u: [] });
      if (!map.get(k).u.includes(u)) map.get(k).u.push(u);
    };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#VRADIO')) continue; // 本项目导出标记行（E4），不影响导入
      if (line.endsWith('#genre#')) { sec = line.replace(/,#genre#$/, ''); continue; }
      if (/^#EXTINF:/i.test(line)) {
        // 属性值可含逗号（如 tvg-logo="http://a/b,c.png"）：引号外的第一个逗号才是「属性区,台名」分隔符
        let q = false, sep = -1;
        for (let j = 8; j < line.length; j++) { const ch = line[j]; if (ch === '"') q = !q; else if (ch === ',' && !q) { sep = j; break; } }
        const attrs = sep >= 0 ? line.slice(0, sep) : '', name = sep >= 0 ? line.slice(sep + 1).trim() : '';
        const g = attrs.match(/group-title="([^"]*)"/);
        pend = { c: (g && g[1].trim()) || sec, n: name };
        continue;
      }
      if (line.startsWith('#')) continue;
      if (/^https?:\/\//.test(line)) { if (pend) { add(pend.c, pend.n, line); pend = null; } continue; } // m3u 的 URL 行
      const i = line.lastIndexOf(','); if (i < 0) continue; // csv 风格：名字,地址
      add(sec, line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    return [...map.values()];
  },

  /* ---------- 数据装配（决策 B/C）：主列表 replace + STARTER 精选层（按精确名去重）+ 个人层常驻 ---------- */
  applySources(mainList, myList) {
    const byKey = new Map(), byName = new Set();
    const starterNames = new Set(STARTER.map(x => x.n)), starterUrls = new Set(); // B3 originMask：精选身份 URL/精确名集合
    for (const st of STARTER) for (const u of st.u) starterUrls.add(u);
    for (const s of mainList) { byKey.set(keyOf(s), s); byName.add(s.n); }
    for (const st of STARTER) if (!byName.has(st.n)) { // 决策 C：与主列表精确重名的精选台不再并入（http 模式下常听=纯重复）
      byKey.set(keyOf(st), { c: st.c, n: st.n, u: st.u.slice(), l: st.l }); byName.add(st.n);
    }
    for (const s of myList || []) {
      const cur = byKey.get(keyOf(s));
      if (cur) s.u.forEach(u => !cur.u.includes(u) && cur.u.push(u));
      else { byKey.set(keyOf(s), s); byName.add(s.n); }
    }
    this.state.stations = [...byKey.values()];
    for (const s of this.state.stations) {
      s.dCat = s.c; s.dName = s.n; s.dU = s.u.slice(); // 同步默认口径留底（面板 ↺恢复/撤回移动/撤回追加源用）
      // B3 originMask：STARTER 身份 URL 命中、或与精选台精确同名（同名台 URL 由主列表提供）→ 打 starter 位。
      // 运行时字段不持久化（radio.txt/radio.*/备份均不带）——发现页「精选」分组按 om 位判定，不按 u[0] 字面比对
      s.om = starterUrls.has(s.u[0]) || starterNames.has(s.n) ? 1 : 0;
    }
    this.applyCfg(); // 维护层最后套用（覆盖分类/台名/隐藏，收藏随后按 URL 回绑不受影响）
    this.rebind(); // 收藏/最近按 URL 回绑（债务 1）——一轮即够（audit B1：历史双调，幂等但白做一遍全量回绑 + 3 次落盘）
    this.render();
    if (!Player.station) this.showLast();
    if (this.mEditor) this.mEditor.externalChanged(); // 同步重建 = 外部变更：复核当前草稿 conflict 态（§5.2 草稿不因对账丢失）
  },
  /* 维护层套用：电台移动/重命名/手动隐藏/追加源按「任一源 URL 命中」（变体换序免疫）；
     手动隐藏 = 彻底消失（全部/收藏/搜索/体检一律不可见，owner 拍板无正在播例外——手动是明确意图，
     与死台隐藏的「正在播例外」口径不同）；分类重命名最后映射（移动目标在改名时已级联改写） */
  applyCfg() {
    const { moves, names, hideS, renames, srcs } = this.cfg;
    for (const s of this.state.stations) {
      s.hidden = false;
      for (const u of s.u) {
        if (hideS[u]) s.hidden = true;
        if (moves[u]) s.c = moves[u];
        if (names[u]) s.n = names[u];
      }
      // 追加备选源（P1-a/r2 ⑨）：只挂到台尾——绝不插前/改删原源（s.u[0] 是 srcmem/收藏/健康标记的身份键，
      // 动了四处回绑全断）；先收集后 push，避免遍历中修改 s.u。variants()/srcmem 天然吃新序列，无需另行接线
      const add = [];
      for (const u of s.u) { const a = srcs[u]; if (a) for (const x of a) if (!s.u.includes(x) && !add.includes(x)) add.push(x); }
      if (add.length) s.u.push(...add);
      // 每台最多 6 条（plan §5.4，review P1）：对合并追加后的最终源集合统一封顶——保主源 s.u[0] 首位、
      // 只裁台尾（原生超编同理裁尾）；详情中心/批量诊断（diagIdx）同口径，双端与 Android SRC_TOTAL_CAP 不漂移
      if (s.u.length > SRC_CAP) s.u = s.u.slice(0, SRC_CAP);
      if (renames[s.c]) s.c = renames[s.c];
      this.srcLife(s); // 源生命周期（B1）：追加合并后计算有效序/禁用集（见 srcLife 注释）
    }
  },
  /* 源生命周期接线（B1，plan-expansion-r4 §5.4，双端冻结口径）：cfg 字段 → 台对象运行时三态——
     s.mo = 启用源有效序（SrcOrder.effective 的 order，禁位已剔；Android 侧 mo=含禁位完整序+派生有效序，语义等价）、
     s.dis = 禁用索引、s.moManual = 存在人工排序。srcManualOrder/srcDisabled 键 = 身份 URL u[0] 严格命中
     （排序/禁用是台属性，与 srcs 的「任一源命中」口径不同）；srcLabels 键 = 源 URL（标签属具体源，仅展示）。
     绝不物理重排 s.u[]（身份公理）；srcmem2.i/禁用/排序的持久索引空间一律是原始 s.u 下标 */
  srcLife(s) {
    const manual = this.cfg.srcManualOrder[s.u[0]] || null, dis = this.cfg.srcDisabled[s.u[0]] || null;
    const r = SrcOrder.effective(s.u, manual, dis);
    s.mo = r.order; s.dis = r.dis; s.moManual = !!(manual && manual.length);
  },
  reapplyCfg() { // 面板改动后即时生效：回滚到装配默认再重套，并重走回绑/分类条/渲染/面板自身。
    // u 也随留底回滚——追加源每次从 cfg 重放，撤除/移除即刻生效（P1-a）
    for (const s of this.state.stations) { if (s.dCat !== undefined) { s.c = s.dCat; s.n = s.dName; s.u = s.dU.slice(); } }
    this.applyCfg();
    this.rebind(); this.render(); this.renderManage();
  },
  /* 主列表（radio.txt）+ 个人层（my-radio.txt）重拉重并；仅 http:// 下可用（file:// 下 fetch 必失败，P3-12 同源守卫） */
  async reloadMain() {
    if (!location.protocol.startsWith('http')) return false;
    const get = f => fetch(f + '?t=' + Date.now()).then(r => r.ok ? r.text() : Promise.reject()).catch(() => null); // 穿透缓存（audit D2：添台后 my-radio 旧缓存会让新台不出现）；my 层走下方三态通道
    const main = await get('radio.txt');
    if (main === null) return false; // 主列表拉不到就不动（保底，绝不清空）
    // 个人层三态（AIbot PR#33 P1，与 commitImport getMy 同口径）：'' = 404 合法空列表 / 文本 = 有内容 /
    // null = 网络错·5xx——失败绝不按空列表 replace（旧口径会把既有/刚恢复的个人台从列表静默清掉）：改用
    // 最近一次成功的个人层缓存 _myKeep 重并（主 radio.txt 成功部分照常应用）+ toast 提示一次（后台任务
    // 走 toast 的既有口径，单轮只提示一条防风暴）；成功才刷新缓存（404 空列表也刷——空也是磁盘真态）
    const my = await fetch('my-radio.txt?t=' + Date.now()).then(r => r.status === 404 ? '' : r.ok ? r.text() : null).catch(() => null);
    let myL;
    if (my === null) { myL = this._myKeep || []; this.toast('个人电台列表刷新失败，已保留当前显示'); }
    else { myL = this.parse(my); this._myKeep = myL; }
    this.applySources(this.parse(main), myL);
    return true;
  },

  /* ---------- 收藏/最近的 URL 回绑与存取（债务 1） ---------- */
  rebind() {
    // 回绑前内存态快照：回绑产生实际变化才落盘（audit B1「白做一遍 3 次落盘」的根治）。空库开局页不得
    // 被无条件写入的空结构值（favs '[]'/health '{}'）污染镜像——那会让快照非空，绕过 Store 空覆盖门
    // （issue #42：跨实例空页 unload 以「空结构快照」整库覆盖他端数据）。
    // 快照比较用稳定键序序列化（stableStr）：对象键插入序不影响等价判定——语义相同仅键序不同的
    // 回绑结果不触发落盘（review#43 P3：JSON.stringify 对键序敏感，未来改动插入序会凭空扩大写放大
    // 并改变空门状态）
    const jf0 = stableStr(this.favs), jr0 = stableStr(this.recents), jh0 = stableStr(this.healthMarks);
    const find = e => this.state.stations.find(s => keyOf(s) === e.k)
      || (e.u.length && this.state.stations.find(s => s.u.some(u => e.u.includes(u))));
    const nf = [];
    for (const f of this.favs) {
      const st = find(f);
      if (st) nf.push({ k: keyOf(st), u: st.u.slice(0, 6) }); // 回绑成功：刷新键与 URL 快照
      else if (f.u.length) nf.push(f); // 带 URL 的休眠条目永不回收，待上游恢复/换名后自动回绑
      // 旧名字键（无 URL）回绑失败 → 即刻回收（迁移策略）
    }
    this.favs = nf;
    // recents 回绑后按键去重：上游改名会让新旧两条解析到同一台，「最近」不出现重复行
    const seen = new Set();
    this.recents = this.recents.map(r => { const st = find(r); return st ? { k: keyOf(st), n: st.n, u: st.u.slice(0, 6) } : r; })
      .filter(r => { if (seen.has(r.k)) return false; seen.add(r.k); return r.u.length || this.state.stations.some(s => keyOf(s) === r.k); })
      .slice(0, 20);
    // 死台标记按 URL 身份回绑（上游改名/换分类后仍对得上）：命中即 s.health='dead'（刷新后依然默认隐藏），
    // 键与 URL 快照随之刷新（t0/n/perm 档位随行，t 保留原值——回绑不是复测，不刷新确认时间）；
    // 回绑不上的休眠孤儿 90 天清理（R4 拍板：上游都找不到这个台了，留着只占 FIFO 配额）
    const hm = {};
    for (const k of Object.keys(this.healthMarks)) {
      const e = this.healthMarks[k];
      const st = this.state.stations.find(s => keyOf(s) === k)
        || (e.u.length && this.state.stations.find(s => s.u.some(u => e.u.includes(u))));
      if (st) { st.health = 'dead'; st.perm = e.perm; hm[keyOf(st)] = { ...e, u: st.u.slice(0, 6) }; }
      else if (Date.now() - e.t0 < 90 * DAY) hm[k] = e;
    }
    this.healthMarks = hm;
    if (stableStr(this.favs) !== jf0) this.saveFavs(); // 实际变化才落盘（无变化 = 无信息量，等价零写）
    if (stableStr(this.recents) !== jr0) this.saveRecents();
    if (stableStr(this.healthMarks) !== jh0) this.saveHealth();
    this.qualityKeep(); // B2：收藏/最近回绑后刷新 trim 保护集
  },
  favKeys() { return new Set(this.favs.map(f => f.k)); },
  /* Store 对账后的内存全量重载（方案二：boot 异步对账/多标签重拉/恢复备份共用）——station 对象本身不动
     （Player 引用着），只重载收藏/最近/健康标记/配置与 Player 记忆，再回绑渲染 */
  /* UI 态三键（view/showdead/theme）DOM 同步 + 镜像读取（audit C4）：boot 装载与他页 Store 对账联动
     （applyServerStore）共用——他页改写后本页即时跟随，此前要刷新才生效 */
  syncViewUI() {
    $('gridBtn').classList.toggle('on', this.state.view === 'grid'); $('gridBtn').setAttribute('aria-pressed', String(this.state.view === 'grid'));
    $('listBtn').classList.toggle('on', this.state.view === 'list'); $('listBtn').setAttribute('aria-pressed', String(this.state.view === 'list'));
  },
  syncDeadUI() {
    $('deadBtn').classList.toggle('on', this.state.showDead); $('deadBtn').setAttribute('aria-pressed', String(this.state.showDead));
  },
  syncThemeUI() { // this.mq 由 boot 装配（auto 态系统切换监听也在那）；未装配时现取（matches 只读，无副作用）。
    // 三选菜单（§6.11/Q25）：图标 + 「主题：xx」文字 span（显隐走 CSS，boot/系统切换/Store 对账/点选后每次重写恒带）
    // + aria-pressed 选中态；aria-label/title 只报当前档，不再宣称「点击循环」
    const mq = this.mq || matchMedia('(prefers-color-scheme: light)');
    document.documentElement.dataset.theme = this.state.theme === 'auto' ? (mq.matches ? 'light' : 'dark') : this.state.theme;
    const tn = { auto: '跟随系统', light: '浅色', dark: '深色' }[this.state.theme];
    $('themeBtn').innerHTML = { auto: '<svg class="ic"><use href="#i-auto"/></svg>', light: '<svg class="ic"><use href="#i-sun"/></svg>', dark: '<svg class="ic"><use href="#i-moon"/></svg>' }[this.state.theme] + `<span class="theme-t">主题：${tn}</span>`;
    $('themeBtn').setAttribute('aria-label', '主题：' + tn);
    $('themeBtn').title = '主题：' + tn;
    for (const b of document.querySelectorAll('#themeMenu [data-theme-v]')) b.setAttribute('aria-pressed', String(b.dataset.themeV === this.state.theme));
  },
  themeMenuClose() { // 三选菜单收起统一口（点选/Esc/点外/断点收纳前）：焦点在菜单内则归还 themeBtn（同 srcPopClose 口径）
    const m = $('themeMenu');
    if (m.hidden) return;
    const back = m.contains(document.activeElement);
    m.hidden = true; $('themeBtn').setAttribute('aria-expanded', 'false');
    if (back) $('themeBtn').focus();
  },
  loadUi3() { // 三键从镜像读入 + 刷 DOM（boot 装载与 applyServerStore 对账联动共用）
    this.state.view = Store.get('radio.view') === 'list' ? 'list' : 'grid'; // 网格为默认
    this.state.showDead = Store.get('radio.showdead') === '1'; // 默认隐藏无效台
    const th = Store.get('radio.theme');
    this.state.theme = ['auto', 'light', 'dark'].includes(th) ? th : 'auto';
    this.syncViewUI(); this.syncDeadUI(); this.syncThemeUI();
  },
  applyServerStore() {
    const wasDead = new Set(this.state.stations.filter(s => s.health === 'dead').map(s => s.u[0])); // B3：他页复测复活（healthMarks 消失）的转移证据快照
    this.loadStore(); this.loadCfg();
    Player.reloadMems();
    for (const s of this.state.stations) { s.health = ''; s.perm = 0; this.srcLife(s); } // 清旧标记由 rebind 按 healthMarks 重挂；源生命周期随对账联动（他页禁用/排序即刻生效，B1）
    this.loadUi3(); // view/showdead/theme 三 UI 态随对账联动（audit C4）
    this.rebind(); this.render(); this.renderManage();
    for (const s of this.state.stations) if (wasDead.has(s.u[0]) && s.health !== 'dead') this.markRevive(s); // B3：dead→无标记 = 有明确转移，落「最近恢复」
    if (this.mEditor) this.mEditor.externalChanged(); // 对账回调里复核当前草稿 conflict 态（§6.8：不替换原 render/同步链）
  },
  /* 同步消失名单 × 收藏比对（N4/r2 ⑥）：双通道——显示名 + 消失台 URL 集合（AIbot P3-1：经维护面板本地
     改名的收藏台键名已换、按名会漏，URL 快照按身份公理仍对得上）。必须在 reloadMain 之后调用——
     URL 回绑已救回「改名台」（新名不在消失名单，天然不误报），撞上名单/URL 且当前解析不到的才是真消失 */
  favsGone(names, urls) {
    const set = new Set(names || []), uset = new Set(urls || []), hits = [];
    for (const f of this.favs) {
      const nm = f.k.slice(f.k.lastIndexOf('|') + 1);
      if ((set.has(nm) || f.u.some(u => uset.has(u))) && !this.resolve(f)) hits.push(nm);
    }
    return hits;
  },
  toggleFav(s) {
    const k = keyOf(s);
    const i = this.favs.findIndex(f => f.k === k);
    if (i >= 0) this.favs.splice(i, 1); else { this.favs.push({ k, u: s.u.slice(0, 6) }); this.logosEnsure(); } // 新收藏优先补台标
    this.saveFavs(); this.render();
  },
  remember(s) { // 播放即记入最近（队首 = 上次收听）
    const k = keyOf(s);
    this.recents = this.recents.filter(r => r.k !== k);
    this.recents.unshift({ k, n: s.n, u: s.u.slice(0, 6) });
    this.recents = this.recents.slice(0, 20);
    this.saveRecents();
  },
  /* 按键或 URL 解析 station（收藏回绑/续播共用） */
  resolve(entry) {
    if (!entry) return null;
    return this.state.stations.find(s => keyOf(s) === entry.k)
      || (entry.u && entry.u.length && this.state.stations.find(s => s.u.some(u => entry.u.includes(u))))
      || null;
  },
  scopeFavRecent(max = 30) { // 静默体检范围（B-10，Sync 调用）：收藏 + 最近播放（键/URL 回绑解析、去重、上限）；手动隐藏的台不测——隐藏是明确意图
    const seen = new Set(), list = [];
    const push = e => { const s = this.resolve(e); if (s && !s.hidden && !seen.has(keyOf(s))) { seen.add(keyOf(s)); list.push(s); } };
    for (const f of this.favs) push(f);
    for (const r of this.recents) push(r);
    return list.slice(0, max);
  },
  scopeDead(now = Date.now()) { // 死标记台复测范围（R4 节流拍板，语义全保留）：t 距今超档位间隔（疑似 24h/
    // 停运 7 天）才入列，最旧优先、每 boot 封顶 200 轮转——FIFO 顶格 2000 时把最坏单次后台探活从 1-2 小时
    // 压回分钟级，终止对已停运台的永久日级探测；档内标记多于 200 时按 t 轮转全覆盖
    const out = []; // O(标记数×台数) 的 find（FIFO 顶格 2000×1600+≈3M 次）：每次 boot 一次性可接受（AIbot P3-6 备忘，量级上来再做 URL→台索引）
    for (const k of Object.keys(this.healthMarks)) {
      const e = this.healthMarks[k];
      if (now - (e.t || 0) < (e.perm ? 7 : 1) * DAY) continue;
      const st = this.state.stations.find(s => keyOf(s) === k)
        || this.state.stations.find(s => s.u.some(u => e.u.includes(u)));
      if (st && !st.hidden) out.push([e.t || 0, st]);
    }
    return out.sort((a, b) => a[0] - b[0]).slice(0, 200).map(x => x[1]);
  },
  baselineList() { // 首启基线范围（R4 拍板）：无体检证据的国内台——欧美两分类同步期已逐个实测跳过
    // （dCat = 维护层套用前的默认分类留底，免疫分类重命名/单台移动的显示层改写）。
    // 基线是全库口径：显式全库投影（scope/cat/keyword 一律不带，§6.7「搜索不能截断全库基线」），
    // all=true 只忽略自动 dead（基线本来就要给死台落标记），不走用户当前筛选的 visible()
    return uiProjectStations({
      stations: this.state.stations, scope: 'all', category: '全部', keyword: '',
      recents: [], resolveRecent: () => null, favoriteKeys: new Set(), hiddenCategories: this.cfg.hideC,
      showDead: this.state.showDead, all: true, key: keyOf,
      playingKey: Player.station && keyOf(Player.station), connectingKey: Player.connecting && keyOf(Player.connecting),
    }).filter(s => !['欧美音乐', '国际新闻·谈话'].includes(s.dCat || s.c));
  },
  toast(msg, opt = {}) { // 极简 toast（R1 拍板新增）：后台任务专用（增量体检/自动基线/多标签提示），
    // 用户主动操作走 #status——两通道不双写，读屏器不念两遍（R4 分工规则）。action = {label, fn} 确认门槛用；
    // dismiss = 「暂不」类纯关闭按钮的文案（常驻 toast 的显式出口，AIbot P3-5）
    const t = $('toast');
    t.innerHTML = '';
    const sp = document.createElement('span'); sp.textContent = msg; t.appendChild(sp);
    if (opt.action) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn mbtn';
      b.textContent = opt.action.label; b.onclick = () => { t.hidden = true; opt.action.fn(); };
      t.appendChild(b);
    }
    if (opt.dismiss) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn mbtn';
      b.textContent = opt.dismiss; b.onclick = () => { t.hidden = true; };
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(this._toastT);
    this._toastRemain = 0;
    if (opt.ms !== 0) { const ms = opt.ms || 4000; this._toastEnd = Date.now() + ms; this._toastT = setTimeout(() => { t.hidden = true; this._toastT = 0; }, ms); } // 隐藏撤销等 toast≈8s（§5.4）
  },
  toastPause() { // 焦点/悬停在撤销区域时延长时限（§5.4）：暂停倒计时、记剩余
    if (!this._toastT) return;
    clearTimeout(this._toastT); this._toastT = 0;
    this._toastRemain = Math.max(0, (this._toastEnd || 0) - Date.now());
  },
  toastResume() { // 离开撤销区域：按剩余时限恢复倒计时
    if (!this._toastRemain || $('toast').hidden) { this._toastRemain = 0; return; }
    this._toastEnd = Date.now() + this._toastRemain;
    this._toastT = setTimeout(() => { $('toast').hidden = true; this._toastT = 0; this._toastRemain = 0; }, this._toastRemain);
    this._toastRemain = 0;
  },
  showLast() {
    const s = this.recents[0] && this.resolve(this.recents[0]);
    $('nowline').textContent = s ? '上次收听：' + s.n : '未在播放';
  },

  /* ---------- 渲染（唯一入口）：网格 = 精简卡片 / 列表 = 两行详情（元信息行含「正在播」节目） ---------- */
  keepFocus(box, ...attrs) { // innerHTML 整表重建会把键盘焦点弹回 body：重建前后找回同节点。
    // 多锚点按序兜底（§6.7）：主 attr 失配（如维护改名后 data-k 变了）退到下一锚点（data-u0 URL 不变），焦点不丢
    const ae = document.activeElement;
    if (!box.contains(ae) || !ae.dataset) return () => {};
    const pairs = attrs.map(a => [a, ae.dataset[a]]).filter(([, v]) => v != null);
    return () => {
      for (const [a, v] of pairs) { const t = box.querySelector(`[data-${a}="${CSS.escape(v)}"]`); if (t) { t.focus({ preventScroll: true }); return; } }
    };
  },
  favBtn(k, on, s) {
    return `<button type="button" class="fav${on ? ' on' : ''}" data-fav="${this.esc(k)}" aria-pressed="${on}" aria-label="${on ? '取消收藏' : '收藏'}：${this.esc(s.n)}" title="${on ? '取消收藏' : '收藏'}">${on ? '<svg class="ic"><use href="#i-star-filled"/></svg>' : '<svg class="ic"><use href="#i-star"/></svg>'}</button>`;
  },
  buildCats() {
    const restore = this.keepFocus($('cats'), 'c');
    const present = new Set(this.state.stations.filter(s => !s.hidden && !this.cfg.hideC[s.c]).map(s => s.c));
    const pins = [...new Set(['华语音乐', '欧美音乐'].map(c => this.cfg.renames[c] || c))]; // 音乐置顶（owner 拍板）；重命名跟随新名；双音乐类互相合并后去重防重复 chip
    const hid = c => this.cfg.hideC[c];
    const order = [...pins.filter(c => present.has(c)),                                  // 置顶双音乐类
      ...this.cfg.cats.filter(c => present.has(c) && !hid(c) && !pins.includes(c)),       // 自建分类（移入台后才出现）
      ...[...present].filter(c => !pins.includes(c) && !this.cfg.cats.includes(c))];     // 其余按数据序
    const cats = ['全部', '★收藏', '最近', ...order]; // 紧凑布局保留三范围入口（§3.2）：chip 点击映射 scope，真实分类映射 cat
    if (this.state.cat !== '全部' && !order.includes(this.state.cat)) this.state.cat = '全部'; // 有效性只查真实分类（scope 独立有效——切收藏/最近不误回全部）；数据更新/分类被藏后回退
    // 数量角标（UI 审计 P3-5，owner 拍板）：范围计数=全库口径、分类计数=当前 scope 口径（见 catCounts）
    const cc = this.catCounts();
    const cnt = c => c === '全部' ? cc.all : c === '★收藏' ? cc.favN : c === '最近' ? cc.recN : (cc.m.get(c) || 0);
    const on = c => c === '全部' ? this.state.scope === 'all' : c === '★收藏' ? this.state.scope === 'favorites' : c === '最近' ? this.state.scope === 'recent' : c === this.state.cat; // 范围 chip 与分类 chip 各自高亮——组合筛选（收藏+分类）两个都亮
    // 互斥单选语义用 aria-current（aria-pressed 是独立开关语义，不适用）
    $('cats').innerHTML = cats.map(c => `<button type="button" class="chip${on(c) ? ' on' : ''}" data-c="${this.esc(c)}"${on(c) ? ' aria-current="true"' : ''}>${this.esc(c)}<i class="n">${cnt(c)}</i></button>`).join('');
    restore();
    this.updateCatsFade();
  },
  /* chip 角标计数（§3.2 口径）：范围计数（全部/收藏/最近三个 chip）沿用全库健康/手动隐藏口径（不含 keyword/category）；
     分类计数按当前 scope 投影但**不应用**当前 category 与 keyword——搜索时分类条不消失、0 计数也可恢复。
     死台默认隐藏不计（正在播/连接中例外，与 visible 一致） */
  catCounts() {
    const pk = Player.station && keyOf(Player.station), ck = Player.connecting && keyOf(Player.connecting), favs = this.favKeys();
    const shown = s => !s.hidden && !this.cfg.hideC[s.c] && (this.state.showDead || s.health !== 'dead' || keyOf(s) === pk || keyOf(s) === ck);
    const seen = new Set(), recentKeys = new Set(); // recent 集合：recents 前 20 条回绑解析 + shown + keyOf 去重（与 uiProjectStations 同源口径）
    for (const r of this.recents.slice(0, 20)) { const s = this.resolve(r); if (s && shown(s) && !seen.has(keyOf(s))) { seen.add(keyOf(s)); recentKeys.add(keyOf(s)); } }
    const inScope = s => this.state.scope === 'favorites' ? favs.has(keyOf(s)) : this.state.scope === 'recent' ? recentKeys.has(keyOf(s)) : true;
    const m = new Map(); let all = 0, favN = 0;
    for (const s of this.state.stations) {
      if (!shown(s)) continue;
      all++; if (favs.has(keyOf(s))) favN++;
      if (inScope(s)) m.set(s.c, (m.get(s.c) || 0) + 1);
    }
    const recN = [...recentKeys].length; // 已在 recentKeys 构建时按 resolve+去重收口（回绑失配的不计）
    return { m, all, favN, recN };
  },
  /* 分类条两端渐隐（UI 审计 P3-5）：滚动位置离端点远才渐隐该端，提示横向可滚（细滚动条已在 CSS） */
  updateCatsFade() {
    const c = $('cats');
    c.classList.toggle('fade-l', c.scrollLeft > 4);
    c.classList.toggle('fade-r', c.scrollLeft + c.clientWidth < c.scrollWidth - 4);
  },
  /* ---------- 单一筛选状态（ui-redesign §3.2/§6.7）：scope/cat/keyword 组合筛选的三个入口。
     切范围重置 cat（keyword/view/播放不动）；选分类只改 cat（scope/keyword 不动）；搜全部解除 scope+cat
     但保留 keyword。均为内存态，无持久键；绝不把 ★收藏/最近 哨兵写进 cat ---------- */
  setScope(scope) {
    if (!['all', 'favorites', 'recent'].includes(scope)) return; // 非法值忽略（状态不被污染）
    this.state.scope = scope; this.state.cat = '全部'; this.rowIdx = 0;
    this.swapRender();
  },
  setCategory(category) {
    this.state.cat = category; this.rowIdx = 0;
    this.swapRender();
  },
  searchEverywhere() { // 空态「搜全部电台」入口：解除范围/分类限制，关键词与 #q.value 保留
    this.state.scope = 'all'; this.state.cat = '全部'; this.rowIdx = 0;
    this.swapRender();
  },
  /* 当前筛选下的可见列表（渲染/方向键/收藏切台唯一口径）。all=true 仅忽略自动 dead（空态判断用），
     scope/category/keyword 照常生效、手动隐藏任何情况不可见——投影逻辑全在 uiProjectStations 纯函数 */
  visible(all) {
    return uiProjectStations({
      stations: this.state.stations, scope: this.state.scope,
      category: this.state.cat, keyword: this.state.keyword,
      recents: this.recents, resolveRecent: r => this.resolve(r),
      favoriteKeys: this.favKeys(), hiddenCategories: this.cfg.hideC,
      showDead: this.state.showDead, all: !!all, key: keyOf,
      playingKey: Player.station ? keyOf(Player.station) : null,
      connectingKey: Player.connecting ? keyOf(Player.connecting) : null,
    });
  },
  // 电台名/分类来自远程上游仓库，渲染前必须转义（防注入）
  esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  emptyHtml() { // 空态给出原因和下一步动作（§6.2）：scope 空收藏/空最近点名；有 keyword 给「清空搜索」与
    // 「搜全部电台」两个出口（data-act 委托在 #list onclick——qclear 清词保 scope/cat，qall 解除范围保词）；
    // visible(true) 非空说明只是被自动 dead 过滤（手动隐藏任何情况不出现，不给误导入口）
    const kw = this.state.keyword;
    const msg = this.state.scope === 'favorites' && !this.favs.length ? '还没有收藏电台——点电台左侧 ☆ 即可收藏'
      : this.state.scope === 'recent' && !this.recents.length ? '还没有播放记录——点任意电台即开始收听'
      : this.visible(true).length ? '当前筛选的电台均已体检不可用（默认隐藏）——点上方「✗ 无效源」开关显示它们'
      : kw ? `没有匹配「${this.esc(kw)}」的电台，换个关键词试试`
      : this.state.cat !== '全部' ? '该分类暂无电台' : '该范围内暂无电台';
    const acts = kw ? `<div style="display:flex;gap:8px;flex-wrap:wrap;padding:12px 0 0">
      <button type="button" class="btn" data-act="qclear">清空搜索</button>
      <button type="button" class="btn" data-act="qall">搜全部电台</button></div>` : '';
    return `<div class="empty">${msg}${acts}</div>`; // 动作并进 .empty 内层：网格视图空态占满整行的规则（#list.grid .empty）连按钮一起生效
  },
  render() {
    this.buildCats(); // 角标与列表同源刷新（AIbot PR#9 review P2-a）：render 内统一调，调用方无需再单独调 buildCats
    this.syncSidebar(); // 侧栏高亮/计数/范围标题（P2 壳）：紧凑态元素不显示，更新无副作用
    const restore = this.keepFocus($('list'), 'k', 'fav', 'u0'); // 焦点在行/卡片或按钮上都找回；data-u0 兜底（改名后 data-k 失配仍可按 URL 锚点找回，§6.7）
    const list = this.visible();
    $('deadBtn').hidden = !this.state.stations.some(s => s.health === 'dead'); // 出现过死台才亮「无效源」开关
    this.state.stamp++;
    this.state.index = new Map(list.map((s, i) => [s, i])); // 行索引（体检增量更新用，替代 indexOf 的 O(n²)）
    const pk = Player.station && keyOf(Player.station), ck = Player.connecting && keyOf(Player.connecting);
    const favs = this.favKeys(), grid = this.state.view === 'grid';
    $('list').classList.toggle('grid', grid); // §6.5：classList 替代 className 整体赋值（整体赋值会抹掉 swap 淡入等挂类）
    const scT = { all: '全部电台', favorites: '收藏', recent: '最近' }[this.state.scope] || '全部电台';
    $('q').placeholder = `在${scT}${this.state.cat !== '全部' ? ' · ' + this.state.cat : ''}内搜索`; // placeholder 明确当前范围（§3.4，范围/分类/搜索入口共用 render 收口）
    const ri = Math.min(this.rowIdx || 0, list.length - 1); // roving tabindex（P2-5）：仅落点行可 Tab 停靠
    $('list').innerHTML = list.map((s, i) => {
      const k = keyOf(s), on = favs.has(k), playing = k === pk;
      const base = `${playing ? ' playing' : ''}${k === ck ? ' connecting' : ''}${s.health === 'dead' ? ' dead' : ''}`;
      // title=全名（UI 审计 P3-9）：截断长名（最长 84 字）此前无处可看全名；死台按档位叠加提示（R1 拍板分文案）
      // data-u0 = 身份 URL 锚点（§6.7）：维护改名后 data-k 失配，keepFocus 按它兜底找回焦点
      // data-fn = 全名快照（P3/§4.2）：单例 tooltip 聚焦可见的填充源——截断提示不能只依赖浏览器 title（键盘聚焦不出原生提示）
      const attrs = `data-k="${this.esc(k)}" data-u0="${this.esc(s.u[0])}" data-fn="${this.esc(s.n)}" data-i="${i}" role="listitem" tabindex="${i === ri ? 0 : -1}" aria-label="${this.esc(s.n)}${playing ? '（播放中）' : ''}"${playing ? ' aria-current="true"' : ''} title="${this.esc(s.n)}${s.health === 'dead' ? (s.perm ? '（长期确认停运）' : '（疑似不可达，点击仍可尝试播放）') : ''}"`;
      const hp = s.health ? `<span class="health ${s.health === 'ok' ? 'ok' : 'bad'}" title="体检${s.health === 'ok' ? '可用' : (s.perm ? '长期确认停运' : '疑似不可用')}">${s.health === 'ok' ? '<svg class="ic"><use href="#i-check"/></svg>' : '<svg class="ic"><use href="#i-x"/></svg>'}</span>` : '';
      // 信息降噪（UI 审计 P2-1/P2-2，owner 拍板）：① 台名剥离「[国别]」后缀进 meta（搜索/aria/身份仍用全名，
      // 数据层不动）；② meta 行按视图降级——分类 badge 只在 cat=全部（含 scope 态）显示（分类视图下 100% 冗余），
      // 源数只在 ≥2 源时显示；国别在 meta 与源数并列展示
      const cm = s.n.match(/\s*\[([^\]]+)\]\s*$/), cn = cm ? cm[1] : '', dn = cm ? s.n.slice(0, s.n.length - cm[0].length) : s.n;
      const inCat = this.state.cat !== '全部'; // cat 只存真实分类（scope 态 cat=全部时 badge 照常，收藏+分类组合不重复显示）
      const parts = `${s.perm ? '<span class="badge permb" title="长期确认停运（复测可达会自动回归）">已停运</span>' : ''}${!inCat ? `<span class="badge">${this.esc(s.c)}</span>` : ''}${cn ? `<span class="srcs" title="国家/地区">${this.esc(cn)}</span>` : ''}${s.u.length > 1 ? `<span class="srcs" title="备选源数量">${s.u.length}源</span>` : ''}`;
      const cfoot = (parts || hp) ? `<div class="cfoot">${parts}${hp}</div>` : '';
      const more = `<button type="button" class="fav dmore" data-more="${this.esc(k)}" aria-label="电台详情：${this.esc(s.n)}" title="详情与逐源诊断（B1）"><svg class="ic"><use href="#i-info"/></svg></button>`;
      if (grid) return `<div class="card${base}" ${attrs}><div class="chead">${Logos.visual(s)}<span class="cname station-title">${this.esc(dn)}</span>${this.favBtn(k, on, s)}${more}</div>${cfoot}</div>`;
      const meta = parts ? `<div class="meta">${parts}</div>` : '';
      return `<div class="row${base}" ${attrs}>${this.favBtn(k, on, s)}<div class="col"><div class="l1">${Logos.visual(s)}<span class="name station-title">${this.esc(dn)}</span>${hp}</div>${meta}</div>${more}</div>`;
    }).join('') || this.emptyHtml();
    restore();
    const ae = document.activeElement; // 重渲后焦点行找回（keepFocus）：同步 roving 落点，防 Tab 跳回别行
    if (ae && ae.dataset && ae.dataset.i != null) this.rowIdx = +ae.dataset.i;
    // 定位闪烁窗口（N5/r2 ⑦）：flash 生效期内的重渲保持高亮与视口（1s 超时后不干扰常规浏览）
    if (this._flashK) {
      const fr = $('list').querySelector(`[data-k="${CSS.escape(this._flashK)}"]`);
      if (fr) { fr.classList.add('flash'); fr.scrollIntoView({ block: 'center' }); }
    }
    this.renderHero(); // 续听卡（P2/§3.3）：只更新自身节点，不整表重渲（紧凑态 CSS 拦截不显示）
  },
  /* 方向键导航落点（UI 审计 P2-5）：焦点搬家 + 滚动跟随；搜索框 ↓ 也落到列表首行 */
  focusRow(i) {
    const t = $('list').querySelector(`[data-i="${i}"]`);
    if (!t) return;
    const p = $('list').querySelector('[tabindex="0"]'); // roving 落点随焦点搬家（AIbot PR#9 review P3-1）：Tab 离开列表再回来不跳回旧行
    if (p && p !== t) p.tabIndex = -1;
    t.tabIndex = 0;
    this.rowIdx = i; t.focus(); t.scrollIntoView({ block: 'nearest' });
  },
  /* 切换淡入（E 批）：swap 类挂期间行/卡片 140ms 淡入；搜索逐键重渲不挂类不闪；reduced-motion 由 CSS 关 */
  swapRender() {
    const l = $('list');
    l.classList.add('swap');
    this.render();
    clearTimeout(this._swapT);
    this._swapT = setTimeout(() => l.classList.remove('swap'), 160);
  },

  /* ---------- 桌面新版壳接线（ui-redesign P2，FEATURES.uiRefresh 开关）：侧栏同步 / 续听卡 / 更多工具
     popover。紧凑布局（开关关或 <1024px）下全部无副作用：侧栏元素 display:none、hero CSS 拦截、popover
     宿主随 #lowfreq 留在 header。 ---------- */
  /* 侧栏同步（render 内调用）：范围按钮高亮（aria-current）+ 计数角标（catCounts 现成口径）+ 顶栏范围标题 */
  syncSidebar() {
    const cc = this.catCounts(), names = { all: '全部电台', favorites: '我的收藏', recent: '最近收听' };
    const set = (id, sc, n) => {
      const b = $(id); if (!b) return;
      const on = this.state.scope === sc;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      const i = b.querySelector('.n'); if (i) i.textContent = n;
    };
    set('sideAll', 'all', cc.all); set('sideFav', 'favorites', cc.favN); set('sideRec', 'recent', cc.recN);
    const t = $('scopeTitle');
    if (t) t.textContent = (names[this.state.scope] || '全部电台') + (this.state.cat !== '全部' ? ' · ' + this.state.cat : '');
  },
  /* 续听卡（§3.3/§6.3）：候选 = 当前播放/暂停 → 最近前 20 → STARTER 精选（uiChooseResume 纯函数）；
     eligible 走 uiStationShown（all=false：手动隐藏永不复活——正在播也不豁免、首页改用下一候选；自动
     死台遵守 showDead，正在播/连接中的死台例外保留，与主列表 visible 同口径，AIbot P1 修复）。显示条件 =
     ui-refresh 开 + scope=all + cat=全部 + 无关键词（<1024px
     由 CSS display:none 拦截）。渲染用维护后现名 + Logos.visual 现有链（同步读缓存，绝不发新请求）；
     只更新自身节点不整表重渲，签名未变直接返回（防无谓重建与焦点丢失；隐藏时清签名——否则同候选
     回显时签名早退抢在 hidden=false 复位前，hero 会保持隐藏，AIbot P1 修复）；唱片为静态装饰（旋转 P3） */
  heroK: '', // 候选 URL 锚点（u[0]）：点击时重新解析最新对象，防渲染后台名/装配变化错台（§6.3）
  renderHero() {
    const hero = $('resumeHero');
    const on = document.documentElement.classList.contains('ui-refresh')
      && this.state.scope === 'all' && this.state.cat === '全部' && !this.state.keyword.trim();
    if (!on) { hero.hidden = true; this.heroK = ''; delete hero.dataset.sig; return; }
    const self = this;
    const pick = uiChooseResume({
      current: Player.station || Player.connecting || null,
      resolveCurrent: s => { // 按当前台身份 URL 对照最新 stations 回绑：恰 1 个命中才认，0/多重匹配不猜（§6.3）
        const u0 = s && s.u && s.u[0];
        if (!u0) return null;
        const hits = self.state.stations.filter(x => x.u.includes(u0));
        return hits.length === 1 ? hits[0] : null;
      },
      recents: this.recents, resolveRecent: r => this.resolve(r),
      starters: this.state.stations.filter(s => s.om),
      eligible: s => uiStationShown(s, { hiddenCategories: this.cfg.hideC, key: keyOf, all: false,
        showDead: this.state.showDead,
        playingKey: Player.station ? keyOf(Player.station) : null,   // 在播/连接中的自动死台例外（同主列表口径）
        connectingKey: Player.connecting ? keyOf(Player.connecting) : null }),
    });
    const conn = pick && Player.connecting && keyOf(Player.connecting) === keyOf(pick.station);
    const cur = pick && Player.station && keyOf(Player.station) === keyOf(pick.station);
    // 按钮四态（P3 收敛 P2 的 isPaused 代理，§6.10）：以真实 phase 为准——buffering 是「播着但短暂缺数据」，
    // 按钮语义仍为「暂停」（点了确实是暂停）；仅 playing/buffering 算「在播」，连接期不提前宣称（§4.4）
    const act = this.phase === 'playing' || this.phase === 'buffering';
    const label = !pick ? '' : conn ? '正在连接' : cur && act ? '暂停' : cur ? '继续收听' : '开始收听';
    const kick = !pick ? '' : pick.origin === 'current' ? '当前电台' : pick.origin === 'recent' ? '接着上次收听' : '今日精选';
    const sig = pick ? [pick.station.u[0], kick, label, conn].join('|') : 'empty';
    if (hero.dataset.sig === sig) return;
    hero.dataset.sig = sig;
    if (!pick) {
      this.heroK = '';
      hero.innerHTML = `<span class="vinyl" aria-hidden="true"></span><div class="hero-info">
        <span class="hero-kicker">暂无可收听电台</span>
        <span class="hero-meta">收藏或播放一些电台后，这里会接着上次继续</span>
        <span class="hero-actions"><button type="button" class="btn" data-act="herolib">打开电台库</button></span></div>`;
    } else {
      const s = pick.station;
      this.heroK = s.u[0];
      hero.innerHTML = `<span class="vinyl" aria-hidden="true">${Logos.visual(s)}</span><div class="hero-info">
        <span class="hero-kicker">${kick}</span>
        <b class="hero-name" title="${this.esc(s.n)}">${this.esc(s.n)}</b>
        <span class="hero-meta">${this.esc(s.c)}${s.u.length > 1 ? ' · ' + s.u.length + ' 个源' : ''}</span>
        <span class="hero-actions"><button type="button" class="btn" id="heroPlay" data-act="heroplay"${conn ? ' disabled' : ''} aria-label="${label}：${this.esc(s.n)}"><svg class="ic"><use href="#i-${label === '暂停' ? 'pause' : 'play'}"/></svg><span>${label}</span></button></span></div>`;
    }
    hero.hidden = false;
    this.syncVinyl(); // 重建即重挂旋转类（innerHTML 清掉了 .running；判定走 uiPhaseRunning 纯函数，P3/§6.10）
  },
  /* 真实播放阶段投影（P3/§6.10，Player.onphase 消费方）：只存瞬时 phase + 局部更新——唱片旋转类与续听卡
     按钮（renderHero 自带签名短路，无变化零开销），绝不整表重渲、不新增 radio.*、不覆盖 onstate 副作用 */
  onPhase(ph, s) {
    this.phase = ph;
    this.syncVinyl();
    if (s && Player.station === s) this.renderHero(); // 仅当前台的事件才可能改按钮四态
  },
  syncVinyl() { // 唱片 running 类 = uiPhaseRunning(phase, 页面可见, 未减动效)；visibilitychange/reduced-motion 变化时由 boot 监听重算
    const v = document.querySelector('#resumeHero .vinyl');
    if (!v) return;
    const rm = this.reduceMq || matchMedia('(prefers-reduced-motion: reduce)');
    v.classList.toggle('running', uiPhaseRunning(this.phase, document.hidden, rm.matches));
  },
  /* 更多工具 popover（§6.6）：普通按钮 popover（不贴 role=menu），Esc/点外/点操作项收起，焦点归还触发器；
     显隐只动 #sideTools 的 .open 类——绝不碰 display:contents 的 #lowfreq 容器 */
  sideToolsToggle() {
    const t = $('sideTools'), on = !t.classList.contains('open');
    t.classList.toggle('open', on);
    $('sideMore').setAttribute('aria-expanded', String(on));
    if (on) [...t.querySelectorAll('button')].find(b => !b.hidden)?.focus(); // 开即移焦首个可见项（睡眠菜单同口径）
  },
  sideToolsClose() {
    const t = $('sideTools');
    if (!t || !t.classList.contains('open')) return;
    const back = t.contains(document.activeElement);
    t.classList.remove('open');
    $('sideMore').setAttribute('aria-expanded', 'false');
    if (back) $('sideMore').focus(); // 焦点原在弹层内则归还触发器（srcPopClose 同口径）
  },
  /* 体检增量落库（sync.js 调用）：stamp 未变时顺手更新该行 DOM，否则只落数据由结束时的兜底 render 收口（P3-13）。
     healthMarks 只改内存，落盘由 Sync 各收尾统一一次——全量体检标死几百台时逐台全量写 localStorage 会卡主线程；
     复活即撤销标记，体检结束的兜底 render 会让它回归列表。返回档位（'ok'|'sus'|'perm'）供编排方分档统计 */
  patchHealth(s, ok, stamp) {
    const k = keyOf(s);
    const wasDead = s.health === 'dead';
    s.health = ok ? 'ok' : 'dead';
    if (ok) { s.perm = 0; delete this.healthMarks[k]; if (wasDead) this.markRevive(s); } // B3：dead→可用 状态转移落「最近恢复」（无转移不记）
    else {
      const old = this.healthMarks[k], now = Date.now();
      const t0 = old ? old.t0 : now, n = old ? (old.n || 1) + 1 : 1;
      // 升级停运档（D1 拍板）：复测连续确认 ≥3 次且首死 ≥30 天——单次探活分不出「停运」与「被墙/运维」，
      // 分档证据只能来自持续复测（时长×次数），30 天跨度防短窗口网络抖动误升级
      const perm = (old && old.perm) || (n >= 3 && now - t0 >= 30 * DAY) ? 1 : 0;
      s.perm = perm;
      this.healthMarks[k] = { u: s.u.slice(0, 6), t: now, t0, n, perm };
      $('deadBtn').hidden = false; // 首个死台出现即亮开关
    }
    const r = ok ? 'ok' : (s.perm ? 'perm' : 'sus');
    if (this.state.stamp !== stamp) return r;
    const row = $('list').querySelector(`[data-i="${this.state.index.get(s)}"]`); // 行/卡片通用
    if (!row) return r;
    if (!ok && !this.state.showDead
      && !(Player.station && keyOf(Player.station) === k) && !(Player.connecting && keyOf(Player.connecting) === k)) {
      row.remove(); return r; // 默认隐藏：死台行当场消失，与 visible() 口径一致（正在播/连接中的台不消失）
    }
    row.classList.toggle('dead', !ok);
    row.title = s.n + (ok ? '' : (s.perm ? '（长期确认停运）' : '（疑似不可达，点击仍可尝试播放）')); // 与整表 render 的 title 口径一致（AIbot PR#9 review P3-5）
    const old2 = row.querySelector('.health'); if (old2) old2.remove();
    const sp = document.createElement('span'); sp.className = 'health ' + (ok ? 'ok' : 'bad');
    sp.title = ok ? '体检可用' : (s.perm ? '体检长期确认停运' : '体检疑似不可用');
    sp.innerHTML = ok ? '<svg class="ic"><use href="#i-check"/></svg>' : '<svg class="ic"><use href="#i-x"/></svg>';
    // meta 行按视图降级后（UI 审计 P2-1）分类视图的卡片可能没有 cfoot：兜底挂到 chead（台名行）
    const tgt = row.querySelector('.cfoot, .l1, .chead'); if (tgt) tgt.appendChild(sp);
    return r;
  },

  togglePlay(k) { // 再点当前台 = 暂停/继续；点其他台 = 切换
    const s = this.state.stations.find(x => keyOf(x) === k); if (!s) return;
    if (Player.station && keyOf(Player.station) === k) {
      Player.isPaused() ? Player.resume() : Player.pause();
      return;
    }
    this.startPlay(s);
  },
  startPlay(s, prefer) { // 点播装配共用（remember + 台标 + 最近重排）；prefer=手动指定源序号（②：footer 浮层/⚙ 面板传入，当次最高优先）
    this.remember(s);
    this.logosEnsure(); // 正在播的台也优先补台标
    if (this.state.scope === 'recent') this.render(); // 最近队列头插后刷新顺序（§6.7：哨兵迁移后按 scope 判断）
    Player.play(s, prefer);
  },
  stepFav(d) { // ←/→ 在收藏间切台（A-5）：顺序取当前可见列表内的收藏台；当前台不在收藏则从队首/队尾起步
    const favs = this.favKeys();
    const list = this.visible().filter(s => favs.has(keyOf(s)));
    if (!list.length) { $('status').textContent = '还没有收藏电台——点电台旁 ☆ 收藏后可用 ←/→ 键切换'; return; } // 「旁」：网格视图收藏钮在卡片右侧（audit C5）
    const cur = Player.station ? list.findIndex(s => keyOf(s) === keyOf(Player.station)) : -1;
    const nx = cur < 0 ? (d > 0 ? 0 : list.length - 1) : (cur + d + list.length) % list.length;
    this.togglePlay(keyOf(list[nx]));
  },
  /* 回到正在播（N5/r2 ⑦）：点 footer 台名定位列表行——当前范围/分类/搜索词下不可见则先清全部筛选
     （scope=all + cat=全部 + 清搜索，§3.2「不解除手动隐藏，不改健康开关」——手动隐藏台依然不可见，静默不跳） */
  locatePlaying() {
    const s = Player.station;
    if (!s) return;
    const k = keyOf(s);
    if (!this.visible().some(x => keyOf(x) === k)) {
      this.state.scope = 'all'; this.state.cat = '全部'; this.state.keyword = ''; $('q').value = '';
    }
    this.render(); // 整表重建：定位必须放在 render 之后
    const row = $('list').querySelector(`[data-k="${CSS.escape(k)}"]`);
    if (!row) return;
    const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ block: 'center', behavior: rm ? 'auto' : 'smooth' });
    row.classList.add('flash'); // 立即挂（此时 _flashK 尚未设置，render 尾部管的是后续重渲）
    this._flashK = k;
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => {
      this._flashK = '';
      for (const x of $('list').querySelectorAll('.flash')) x.classList.remove('flash');
    }, 1000);
  },

  /* 台标补全（收藏 + 正在播优先，请求量可控）：Logos.ensure 落库后回调重渲一次展示；
     正在播台的台标若此刻才解析到，顺手刷一次锁屏元数据（r2 ⑩——ICY 曲讯 setSong 只覆盖直流台，
     m3u8 台等不到换歌，后解析的台标在这里补上） */
  logosEnsure() {
    if (!location.protocol.startsWith('http')) return;
    const seen = new Set(), list = [];
    for (const f of this.favs) { const s = this.resolve(f); if (s && !seen.has(keyOf(s))) { seen.add(keyOf(s)); list.push(s); } }
    if (Player.station && !seen.has(keyOf(Player.station))) list.push(Player.station);
    Logos.ensure(list, () => {
      this.render();
      if (Player.station) { const cur = Metadata.mpCurrent(this.metaPipe); Player.setSong(cur && cur.title || ''); } // B3：当前曲名在管线
    });
  },
  /* 底部栏刷新（Player.onstate 用）：当前台名 + 播放/暂停态 + 均衡器动画 */
  playerNow() {
    const s = Player.station;
    if (s) {
      const k = keyOf(s);
      if (this.songFor !== k) { // 切台/刷新：曲讯清零（新台从零取，旧曲名不得串台）——B3 管线世代重置，旧事件一律丢弃
        this.songFor = k;
        Metadata.mpReset(this.metaPipe, Player.srcToken(), s.u[0]);
        this.metaClearUI();
      }
      $('nowline').textContent = s.n;
      $('nowline').classList.add('canfind'); $('nowline').title = '点击回到正在播的电台（N5）'; // 台名可点定位（r2 ⑦）
      $('pp').innerHTML = (Player.connecting || !Player.isPaused()) ? '<svg class="ic"><use href="#i-pause"/></svg>' : '<svg class="ic"><use href="#i-play"/></svg>'; // 台名不再带 ▶（UI 审计 P3-4）：与列表行的 ▶ 前缀重复，footer 已有按钮+均衡器表达状态
    } else { $('pp').innerHTML = '<svg class="ic"><use href="#i-play"/></svg>'; this.showLast(); $('song').hidden = true; $('nowline').classList.remove('canfind'); $('nowline').title = ''; }
    $('eq').classList.toggle('on', !!s && !Player.isPaused()); // 均衡器动画（E6）：活着且在播
    // 选源按钮（②a）：多源台且播/暂停中才亮（按次渲染动态判定——同步后单源变多源自动出现）；切台后浮层过期即收起
    $('srcWrap').hidden = !(s && s.u.length > 1);
    $('detailBtn').hidden = !s; // 详情入口（B1）：有正在播台即可看详情/逐源诊断
    if (!$('srcMenu').hidden && this.srcPopK !== (s ? keyOf(s) : '')) this.srcPopClose();
  },
  doRefresh() { // 手动刷新回直播头（plan-refresh-live §3.2）：footer ↻ 与 R 键共用入口。songFor 先置空——
    // play 的 emit→playerNow 会走「新台」分支整体清零曲讯；不置空则同台重播不清，旧歌名挂到下一轮 15s 轮询
    if (!Player.station) return; // 空台/全部源失败：无响应（状态矩阵见方案 §2）
    this.songFor = '';
    Player.refresh();
  },

  /* ---------- 源质量样本接线（B2，plan-expansion-r4 §6.1）：Player 原始转换 → QualityStore op ----------
     映射口径与 Android 冻结一致：playing 到达 = play/switch（ok 样本，延迟 = 建流锚起算）；disconnect =
     watchdog（同源重连）/error（级联换源），均计 disconnects；级联耗尽 = error。自动体检绝不产 playback——
     本方法只接 Player 回调，体检通道走 Sync.runCheck 的 diagnostic。 */
  qosMap(ev) {
    const s = ev && ev.station;
    if (!s || !s.u || !s.u.length) return;
    const su = s.u[ev.si] || s.u[0]; // 身份键与源 URL 分离记录（聚合按源、淘汰按台）
    if (ev.phase === 'playing')
      QualityStore.recordPlayback(s.u[0], { sourceUrl: su, ok: true, latencyMs: ev.lat || 0, mode: ev.mode || '', trigger: ev.trig || 'play' });
    else if (ev.phase === 'disconnect')
      QualityStore.recordPlayback(s.u[0], { sourceUrl: su, ok: false, latencyMs: 0, mode: ev.mode || '', trigger: ev.reason || 'error' });
    else if (ev.phase === 'exhaust')
      QualityStore.recordPlayback(s.u[0], { sourceUrl: su, ok: false, latencyMs: 0, mode: ev.mode || '', trigger: 'error' });
  },
  qualityKeep() { // trim 保护集（B2）：收藏+最近解析出的台身份 URL（≤64；boot/rebind 随行刷新，服务端 trim 与本地降级共用）
    const set = [];
    const push = e => { const s = this.resolve(e); if (s && s.u[0] && !set.includes(s.u[0])) set.push(s.u[0]); };
    for (const f of this.favs) push(f);
    for (const r of this.recents) push(r);
    QualityStore.keepHint = set.slice(0, 64);
  },
  fmtAgo(ts) { // 相对时间（详情质量摘要「最近播放」用）
    const m = Math.max(0, Date.now() - ts);
    if (m < 60000) return '刚刚';
    if (m < 3600000) return Math.floor(m / 60000) + ' 分钟前';
    if (m < 86400000) return Math.floor(m / 3600000) + ' 小时前';
    return Math.floor(m / 86400000) + ' 天前';
  },

  /* ---------- footer 选源浮层（②a/grill 拍板）：正在听时发现源不好，四步深的 ⚙ 面板救不了急——
     这里是主入口（⚙ 为管理+预选源的双入口副）。内容随打开时刻重算，级联中不自动跳变 ---------- */
  srcPopK: '',
  srcPopClose() { // 收起选源浮层统一口（Esc/点外/行点击/切台收起，AIbot P2-1/P3-4）：焦点原在浮层内则还给源按钮，键盘流连续开关不掉焦
    const m = $('srcMenu');
    if (m.hidden) return;
    const back = m.contains(document.activeElement);
    m.hidden = true; $('srcBtn').setAttribute('aria-expanded', 'false');
    if (back && !$('srcWrap').hidden) $('srcBtn').focus(); // 单源台切台收起时按钮已隐藏，focus 无落点则跳过
  },
  renderSrcPop() {
    const s = Player.station;
    if (!s || s.u.length < 2) return;
    this.srcPopK = keyOf(s);
    const dft = Player.srcOrder(s)[0], mem = Player.srcMem[s.u[0]];
    const okMem = mem && Number.isInteger(mem.i) && mem.i >= 0 && mem.i < s.u.length && !(s.dis || []).includes(mem.i); // 与 play() 同口径（AIbot P3-2 + B1）：坏形状/越界/已禁用按无记忆
    const rows = this.srcOrderView(s).map(i => { // 有效序展示（B1）：禁用源殿后且不可点（点播级联本就跳过）
      const u = s.u[i];
      if ((s.dis || []).includes(i)) return `<div class="srcrow off" title="${this.esc(u)}（已禁用，⚙ 面板可启用）">
        <i class="idx">${i + 1}</i><span class="u">${this.esc(u)}</span>${this.srcBadges(s, i, dft)}
      </div>`;
      return `<button type="button" class="btn srcrow${Player.curSi === i ? ' cur' : ''}" data-i="${i}" title="${this.esc(u)}">
        <i class="idx">${i + 1}</i><span class="u">${this.esc(u)}</span>${this.srcBadges(s, i, dft)}
      </button>`;
    }).join('');
    $('srcMenu').innerHTML = `<div class="st">${this.esc(s.n)} · ${s.u.length} 个源，点行切换（失败自动顺延）</div>` + rows
      // 记忆源=默认源时按钮自指（清了又立刻记回同源，AIbot P3-1），不渲染
      + (okMem && mem.i !== dft ? `<button type="button" class="btn srcrow" data-act="srcreset" title="清掉「上次成功的源」记忆，立即从默认源重播"><svg class="ic"><use href="#i-undo"/></svg><span>恢复默认源（忘掉源 ${mem.i + 1} 的记忆）</span></button>` : '');
    $('srcMenu').hidden = false;
    $('srcBtn').setAttribute('aria-expanded', 'true');
    $('srcMenu').querySelector('button')?.focus(); // 与睡眠菜单同口径：开即移焦（禁用行是 div，天然跳过）
  },
  srcReset() { // 恢复默认源（②c/grill 拍板）：清当前台 srcmem + 立即按启发式默认重播
    const s = Player.station; if (!s) return;
    const had = Player.forgetSrc();
    this.startPlay(s); // 无 prefer 且记忆已清 → 纯启发式序
    $('status').textContent = had ? '已恢复默认源，从默认源重播' : '本无源记忆，按默认序重播';
  },

  /* ---------- 曲讯事件管线接线（B3-A，契约 contracts/metadata-event.json）：/api/nowplaying 轮询结果先转
     MetadataEvent 再进管线（固定顺序：世代校验→清洗→丢过旧→当前曲讯→与上一曲比较→必要时写 radio.songs→
     MediaSession/UI）；管线只出决策，消费由当前生效的 sink 执行——Legacy/V2 二选一（metaV2 定格于 boot），
     绝不双写历史。m3u8 结构性无 ICY：不轮询、保持空曲讯不猜歌。 ---------- */
  /* 双 sink 显式分支（AIbot P1-2；boot 按 FEATURES.metadataV2 定格二选一，绝不双写）：
     LegacyMetadataSink = B2 前行为逐项保留（footer 曲名+icy-br 同格式 / MediaSession setSong / radio.songs
     {t,at} 格式与键不变）；MetadataV2Sink = 同一显示 + 归一化字段留 metaLast（统计/发现消费）。 */
  metaSinkLegacy: {
    current(ev) { // 新曲上屏（title = 清洗后完整显示文本；icy-br 随帧显示——仅 ICY 直流有；B2 同款文案格式）
      $('song').textContent = '♪ ' + ev.title + (ev.bitrateKbps > 0 ? ' · ' + ev.bitrateKbps + 'kbps' : '');
      $('song').hidden = false;
      Player.setSong(ev.title);
    },
    hist(h) { App.pushSongHist(h.u, h.t); }, // 换歌旧曲入史（B-7，键=台主 URL——身份公理；radio.songs 现有格式不变）
  },
  metaSinkV2: {
    current(ev) { App.metaSinkLegacy.current(ev); App.metaLast = ev; }, // 同一显示 + 归一化事件留底（v2 新消费面）
    hist(h) { App.metaSinkLegacy.hist(h); },
  },
  get metaSink() { return this.metaV2 ? this.metaSinkV2 : this.metaSinkLegacy; },
  metaClearUI() { // 切台/刷新/全部失败：先清空旧曲讯再接受新世代事件（MediaSession 回台名，play 会随新台重写）
    $('song').hidden = true; $('song').textContent = '';
    if (Player.station) Player.setSong('');
  },
  /* 轮询（B-6 语义不变：正在播 + 未暂停 + 页面可见 + 直流形态；15s 常驻轮）。
     世代快照（gen + 身份 URL）在 fetch 前捕获——响应迟到时旧世代事件由管线丢弃（切台/刷新后不串台） */
  async tickSong() {
    const s = Player.station;
    if (!s || Player.isPaused() || document.hidden || !location.protocol.startsWith('http')) return;
    const raw = Player.curUrl;
    if (!raw || /\.m3u8(\?|$)/i.test(raw)) return;
    const gen = Player.srcToken(), u0 = s.u[0];
    let j;
    try { j = await fetch('/api/nowplaying?url=' + encodeURIComponent(raw)).then(x => x.json()); } catch (_) { return; }
    const t = (j && j.title) || '';
    const ev = Metadata.normalizeMetadata( // 统一事件入口：轮询结果 → MetadataEvent（黄金样本口径归一化）
      { title: t, bitrateKbps: j && +j.br > 0 ? +j.br : 0, source: t ? 'icy' : 'none', at: Date.now() },
      { identityUrl: u0, stationName: s.n });
    ev.token = gen;
    const d = Metadata.mpAccept(this.metaPipe, ev);
    if (d.hist) this.metaSink.hist(d.hist);        // 换歌：旧曲入史（gap/空曲讯不入史——现状语义）
    if (d.st === 'new') this.metaSink.current(ev); // 新曲上屏；空曲讯（noop/gap）不覆盖有效曲名
  },

  /* ---------- 歌曲历史（B-7）：换歌时旧歌入史（当前曲只显示不入史），按台主 URL 存 localStorage（radio.songs，身份公理——AIbot P3-6） ---------- */
  pushSongHist(u0, title) {
    if (!title) return;
    let songs; try { songs = JSON.parse(Store.get('radio.songs') || '{}'); } catch (_) { songs = {}; }
    const list = songs[u0] || [];
    if (!list.length || list[0].t !== title) { list.unshift({ t: title, at: Date.now() }); songs[u0] = list.slice(0, 12); } // 每台 12 首封顶
    const ks = Object.keys(songs).sort((a, b) => (songs[b][0] ? songs[b][0].at : 0) - (songs[a][0] ? songs[a][0].at : 0));
    for (const x of ks.slice(50)) delete songs[x]; // 台数 50 FIFO（按最近有歌活动排序砍最旧）
    Store.set('radio.songs', JSON.stringify(songs));
  },
  toggleSongHist() { // 点击曲名行：本台最近播放浮层（当前曲在曲名行本身，不入列）
    const el = $('songhist');
    if (!el.hidden) { el.hidden = true; return; }
    if (!Player.station) return;
    let songs; try { songs = JSON.parse(Store.get('radio.songs') || '{}'); } catch (_) { songs = {}; }
    const list = (songs[Player.station.u[0]] || []).slice(0, 12); // 同 pushSongHist 的 URL 键
    el.innerHTML = '<div class="shhead"><b>本台最近播放</b><button type="button" class="btn mbtn" data-act="exportsongs" title="导出所有台的收听历史为 txt（拿去音乐 App 搜）">导出全部</button></div>' + (list.length
      ? list.map(x => `<div class="shrow">${this.esc(x.t)}</div>`).join('')
      : '<div class="shrow" style="color:var(--dim)">暂无历史（换歌后自动记录）</div>');
    el.hidden = false;
    $('keys').hidden = true; // 与快捷键浮层互斥（AIbot P3-3）：同位会重叠，开一方关另一方
    el.querySelector('[data-act="exportsongs"]').onclick = () => this.exportSongs();
  },
  exportSongs() { // 歌曲历史导出（N2/r2 ④）：全部台历史按时间倒序拼 txt；台名按台主 URL 反解，休眠台用 URL 截断兜底
    let songs; try { songs = JSON.parse(Store.get('radio.songs') || '{}'); } catch (_) { songs = {}; }
    const rows = [];
    for (const u0 of Object.keys(songs)) {
      const st = this.state.stations.find(s => s.u.includes(u0));
      const nm = st ? st.n : u0.replace(/^https?:\/\//, '').slice(0, 40);
      for (const it of songs[u0] || []) rows.push({ t: it.t, at: it.at, nm });
    }
    if (!rows.length) { $('status').textContent = '暂无歌曲历史（换歌后自动记录）'; return; }
    rows.sort((a, b) => b.at - a.at);
    const p = n => String(n).padStart(2, '0'), fmt = ts => { const d = new Date(ts); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
    const lines = rows.map(r => `${r.t}（${r.nm} · ${fmt(r.at)}）`); // 纯文本文件不过 HTML 转义（exportFavs 同口径）
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    a.download = 'vradio-songs.txt';
    a.click(); URL.revokeObjectURL(a.href);
    $('status').textContent = `已导出 ${rows.length} 条收听历史（vradio-songs.txt）`;
  },

  /* ---------- 收藏导出/导入（Tier 1 E4）：导出 = 带 #VRADIO:FAV 标记的 m3u（通用播放器可读），
     导回同文件时恢复收藏态；round-trip 即天然回归用例（docs/review.md G 组） ---------- */
  exportFavs() {
    const favs = this.favKeys();
    const list = this.state.stations.filter(s => favs.has(keyOf(s)));
    if (!list.length) { $('status').textContent = '还没有收藏，先点 ☆ 收藏再导出'; return; }
    const lines = ['#EXTM3U', '#VRADIO:FAV'];
    for (const s of list) for (const u of s.u) // m3u 是纯文本：只清分隔/换行符，不过 HTML 转义（否则 R&B 会腐蚀成 R&amp;B）
      lines.push(`#EXTINF:-1 group-title="${s.c.replace(/["\r\n]/g, '')}",${s.n.replace(/[\r\n,]/g, ' ')}`, u);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' }));
    a.download = 'vradio-favorites.m3u';
    a.click(); URL.revokeObjectURL(a.href);
    $('status').textContent = `已导出 ${list.length} 个收藏电台（vradio-favorites.m3u）`;
  },

  /* ---------- 维护面板（⚙，owner 两轮拍板 + ui-redesign P4 重做）：三分区（分类/电台/数据）+ 逐对象
     行内编辑（草稿保存/取消，未保存离开三选，外部变更冲突三选，§5.1–§5.3）。
     分类页：编辑（重命名/隐藏草稿化，撞名合并保存时确认影响）/新建/删除自建（独立提交语义不变）；
     电台页：搜索定位后编辑（名称/分类/隐藏）/备选源/↺ 恢复；失配清单：URL 漂移的个人调整可观测 ---------- */
  mTab: 'cats', mKw: '',
  mSrcVal: '',  // 源草稿追加输入框内容（重渲不清输入，同 mq 持久做法）
  mEditor: null,   // 逐对象编辑器（uiCreateEditor，boot 装配）：一次只进一个对象；草稿只在内存（身份/基线不持久化）
  _hideUndo: null, // 隐藏撤销补丁（§5.4）：仅 hideS/hideC 的反转条目；撤销 = 在最新 cfg 上 force=false 应用（M03 拒绝盲撤）
  manageOpen() { this.mOpener = document.activeElement; $('manage').hidden = false; this.renderManage(); $('mClose').focus(); }, // 打开即移焦 + 记录归还点（P2-7）
  manageClose() { // 关闭入口统一走离开流程（§5.3）：dirty → 三选（保存并继续失败则留在面板）；Esc=继续编辑
    this.mDepart(() => { this.mEditorEnd(); this.manageHide(); });
  },
  manageHide() { // 原始关闭（离开流程批准后调用）：焦点归还触发器；主列表滚动不受影响（面板只是遮罩层）
    $('manage').hidden = true;
    // 归还触发器：桌面壳（P2）下 header #manageBtn 已隐藏（侧栏接管维护入口），退到可见的 #sideManage
    const b = this.mOpener && this.mOpener.isConnected ? this.mOpener
      : ($('manageBtn').offsetParent ? $('manageBtn') : $('sideManage'));
    if (b && b.focus) b.focus();
  },
  renderManage() {
    if ($('manage').hidden) return;
    const tab = this.mTab || 'cats';
    for (const [id, on] of [['mTabC', tab === 'cats'], ['mTabS', tab === 'st'], ['mTabD', tab === 'data']]) {
      $(id).classList.toggle('on', on); $(id).setAttribute('aria-pressed', String(on));
    }
    $('mCats').hidden = tab !== 'cats'; $('mStations').hidden = tab !== 'st'; $('mData').hidden = tab !== 'data';
    this.renderMiss();
    if (tab === 'cats') this.renderMCats(); else if (tab === 'st') this.renderMStations(); else this.renderDataEnv();
  },
  renderDataEnv() { // 数据分区能力矩阵（§5.5 file:// 诚实降级）：就地明示可用/不可用项，不用 toast 轰炸；按钮现状保持（动作自身已有降级）
    const el = $('mDataEnv'); if (!el) return;
    el.innerHTML = location.protocol.startsWith('http') ? ''
      : '<div class="miss"><b>file:// 降级形态能力说明</b>：可用——备份导出（含本地收听统计）/维护配置导出·导入·重置/歌单与粘贴导入（纯本地解析）/收听统计 sidecar 恢复（写本地快照）。'
      + '不可用（需 npm start 的 http 形态）——恢复备份中的个人电台列表与质量 sidecar 写入、添加自定义电台（探活）、同步与体检、曲讯显示。</div>';
  },
  askName(title, def = '') { // 弹名 + 校验：非空、无 |（keyOf 分隔符）、24 字内
    let v = null; try { v = prompt(title + '（不能含 |，24 字以内）', def); } catch (_) { return ''; }
    return v === null ? '' : v.trim().replace(/\|/g, ' ').slice(0, 24);
  },
  mCatOptions() { // 分类下拉选项 = 当前生效分类（数据序，含重命名后名——与分类条一致）+ 自建分类
    const seen = new Set(); for (const s of this.state.stations) if (s.c) seen.add(s.c);
    return [...seen, ...this.cfg.cats];
  },
  /* tag 快照维护已收敛进 uiTagCells（P4）：任一调整存在才写默认名、全清即删键（旧 cfgTag「只增不减」退役） */

  /* ---------- 逐对象编辑器接线（P4，§5.2/§5.3/§6.8）：所有离开编辑上下文的入口（关面板/换对象/切分区/
     独立操作）先 mDepart 过三选门；草稿锚点 = 稳定源 URL / 分类原名，失配绝不猜（uiResolveUnique 抛错） ---------- */
  mEditHost() { return $('detail').hidden ? $('mEdit') : $('dEdit'); }, // 编辑区宿主：详情开着进 #dEdit，否则 #mEdit
  mEditorEnd() { if (this.mEditor) this.mEditor.end(); },
  mDepart(next) { // 独立操作/离开前的草稿门（§5.3）：dirty → 三选弹窗；无编辑器/不脏 → 直接 next
    if (!this.mEditor) { next(); return Promise.resolve(true); }
    return this.mEditor.depart(next);
  },
  mBeginEditor(kind, identity, hintKey) { // 换对象：先 depart（dirty 三选）再 begin；锚点失配就地报错、留旧态
    let began = false;
    return this.mDepart(() => {
      try { this.mEditor.begin(identity, kind, hintKey); began = true; }
      catch (e) { $('status').textContent = e.message || '对象已失配，无法编辑'; }
    }).then(ok => ok && began);
  },
  mCatResolve(orig) { // 分类锚点解析：原名 → 现名（他页改名跟随映射；被合并/删除则失配要求重载，§5.3）
    const name = this.cfg.renames[orig] || orig;
    if (!this.mCatOptions().includes(name)) throw new Error('该分类已被其他页面改名或删除，请重新加载');
    return { orig, name };
  },
  mEditorSubject(draft) { // 草稿锚点 → 当前对象（渲染/显示名用）；失配 throw 由调用方兜
    return draft.kind === 'cat' ? this.mCatResolve(draft.identityUrl) : uiResolveUnique(this.state.stations, draft.identityUrl, draft.hintKey);
  },
  mEditorDisplayName(draft) {
    try { const x = this.mEditorSubject(draft); return typeof x === 'string' ? x : x.name || x.n; } catch (_) { return draft.identityUrl; }
  },
  mValidate(subj, patch, latest, kind) { // 校验照现规则但不静默裁切（§6.8：内联报错由用户修正）
    const has = (p, k) => Object.prototype.hasOwnProperty.call(p, k);
    if (kind === 'st') {
      const name = has(patch, 'name') ? String(patch.name).trim() : subj.n;
      const cat = has(patch, 'category') ? patch.category : subj.c;
      const e = uiValidName(name); if (e) return e;
      if (!this.mCatOptions().includes(cat)) return '目标分类已被其他页面修改，请重新选择';
      if (uiNameTaken(this.state.stations, subj, cat, name)) return '该分类下已有同名电台（重名会串台），请换个名字';
      return '';
    }
    if (kind === 'cat') return has(patch, 'name') ? uiValidName(String(patch.name).trim()) : '';
    if (kind === 'src') return this.mSrcValidate(subj, patch);
    return '';
  },
  async mBeforeCommit(subj, draft, latest) { // 保存前追加确认（§6.8）：分类改名撞上已有分类 → 合并影响明示后再提交
    if (draft.kind !== 'cat' || !Object.prototype.hasOwnProperty.call(draft.patch, 'name')) return 'go';
    const neu = String(draft.patch.name).trim();
    if (!neu || neu === subj.name || !this.mCatOptions().includes(neu)) return 'go';
    const nSt = this.state.stations.filter(s => s.c === subj.name).length;
    const nMv = Object.keys(latest.moves).filter(k => latest.moves[k] === subj.name).length;
    return uiChooseDialog(`「${subj.name}」将并入「${neu}」`,
      `目标分类已存在：合并后按一个分类处理，不易拆分（想拆只能逐台移动）。\n影响：该分类下 ${nSt} 个电台并入「${neu}」${nMv ? `，${nMv} 条移动目标级联改写` : ''}，隐藏标记随行转移。`,
      [{ value: 'go', label: '确认合并并保存', primary: true }, { value: 'stop', label: '取消' }], { safe: 'stop' });
  },
  mCommit(next, draft, subj) { // 编辑器提交边界（§5.2）：normCfg → saveCfg → reapplyCfg；
    // 新隐藏生效 → toast≈8s 带「撤销」（§5.4），其余保存反馈走 #status（只说本地生效，不宣称多端已同步）
    const patch = draft.patch || {}, base = draft.base || {};
    const newlyHidden = Object.prototype.hasOwnProperty.call(patch, 'hidden') && patch.hidden === true && !base.hidden;
    this.cfg = this.normCfg(next);
    this.saveCfg();
    this.reapplyCfg();
    this._hideUndo = null;
    if (newlyHidden && draft.kind === 'st') {
      // 撤销目标台：优先用刚提交的对象本体（reapplyCfg 原地改写，改名后引用仍有效），失配再按锚点解析
      const st = (subj && subj.u && this.state.stations.includes(subj)) ? subj
        : (() => { try { return uiResolveUnique(this.state.stations, draft.identityUrl, draft.hintKey); } catch (_) { return null; } })();
      if (st) {
        this._hideUndo = st.u.map(u => ({ map: 'hideS', key: u, before: { exists: true, value: 1 }, after: { exists: false } }));
        const playing = Player.station && keyOf(Player.station) === keyOf(st);
        this.toast(`已隐藏「${st.n}」${playing ? '，当前播放继续' : ''}`, { ms: 8000, action: { label: '撤销', fn: () => this.mUndoHide() } });
        return;
      }
    }
    if (newlyHidden && draft.kind === 'cat') {
      const name = Object.prototype.hasOwnProperty.call(patch, 'name') ? String(patch.name).trim() : (this.cfg.renames[draft.identityUrl] || draft.identityUrl);
      this._hideUndo = [{ map: 'hideC', key: name, before: { exists: true, value: 1 }, after: { exists: false } }];
      this.toast(`已隐藏分类「${name}」`, { ms: 8000, action: { label: '撤销', fn: () => this.mUndoHide() } });
      return;
    }
    $('status').textContent = '已保存调整';
  },
  mUndoHide() { // 撤销只还原本次 hideS/hideC 的确切键值：before/after 反转补丁 force=false 应用最新 cfg
    // （§6.4/M03：对应隐藏键已被他页改动 → 拒绝盲撤提示，不覆盖；不解除同次保存的改名等其他字段）
    const cells = this._hideUndo;
    this._hideUndo = null;
    if (!cells) return;
    const r = uiApplyCells(this.cfg, cells, false);
    if (!r.ok) { $('status').textContent = '无法撤销：该隐藏项已被其他页面修改（可在维护面板重新恢复显示）'; return; }
    this.cfg = this.normCfg(r.cfg);
    this.saveCfg();
    this.reapplyCfg();
    $('status').textContent = '已撤销隐藏';
  },
  mDialogLeave(draft) { // 离开三选（§5.3）：保存并继续 / 放弃修改 / 继续编辑；Esc=继续编辑
    return uiChooseDialog('有尚未保存的修改',
      `「${this.mEditorDisplayName(draft)}」还有未保存的修改。保存后继续，还是放弃修改？`,
      [{ value: 'save', label: '保存并继续', primary: true }, { value: 'discard', label: '放弃修改' }, { value: 'stay', label: '继续编辑' }],
      { safe: 'stay' });
  },
  mDialogConflict(draft) { // 冲突三选（§5.3）：重载最新 / 明确覆盖此对象 / 继续编辑；绝不默认覆盖
    return uiChooseDialog('此对象已有外部修改',
      `「${this.mEditorDisplayName(draft)}」在编辑期间被其他页面修改。你的草稿已保留：可重新加载最新值（丢弃本对象草稿），或明确覆盖此对象的已编辑字段（保存前仍会重新校验，且只写本对象）。`,
      [{ value: 'reload', label: '重新加载最新值' }, { value: 'overwrite', label: '明确覆盖此对象' }, { value: 'stay', label: '继续编辑' }],
      { safe: 'stay' });
  },

  /* ---------- 编辑区渲染（§6.6 DOM 存活纪律）：#mEdit/#dEdit 与 mlist/mCats 分离——renderManage 重建
     列表、Store 对账、台标回调都不碰编辑区；电台/分类编辑器原地更新（不重建输入，光标/焦点不丢）；
     输入值以草稿补丁为唯一真源（input 事件逐键入补丁），重渲不清输入；失配态保留草稿只读 + 重载/取消 ---------- */
  renderEditor(draft, saving) {
    const host = this.mEditHost(), other = host.id === 'mEdit' ? $('dEdit') : $('mEdit');
    if (other.dataset.sig) { other.innerHTML = ''; delete other.dataset.sig; } // 宿主切换后清旧容器
    if (!draft) { if (host.dataset.sig) { host.innerHTML = ''; delete host.dataset.sig; } return; }
    const sig = draft.kind + '|' + draft.identityUrl;
    let subj = null, fail = '';
    try { subj = this.mEditorSubject(draft); } catch (e) { fail = e.message; }
    if (fail) { // 锚点失配（URL 漂移/分类被并）：保留草稿只读展示 + 重载/取消（不能猜一个同名对象覆盖，§5.3）
      host.innerHTML = `<div class="medit"><div class="medit-h"><b>编辑对象失配</b></div><div class="merr">${this.esc(fail)}</div><div class="emed"><div class="medit-a"><button type="button" class="btn" data-eact="reload">重新加载</button><button type="button" class="btn" data-eact="cancel">取消</button></div></div></div>`;
      host.dataset.sig = sig;
      host.querySelector('[data-eact="reload"]').focus();
      return;
    }
    const build = host.dataset.sig !== sig;
    if (draft.kind === 'st') this.renderEditorSt(host, draft, subj, saving, build);
    else if (draft.kind === 'cat') this.renderEditorCat(host, draft, subj, saving, build);
    else this.renderEditorSrc(host, draft, subj, saving, build);
  },
  mEditorFoot(draft, saving) { // 错误/冲突横幅 + 保存/取消 + 状态（.emed 内整片更新，不含文本输入不伤焦点）
    return `${draft.error ? `<div class="merr">${this.esc(draft.error)}</div>` : ''}${
      draft.conflict ? '<div class="econflict">此对象已被其他页面修改——点「保存」时会询问处理方式（重新加载最新值 / 明确覆盖 / 继续编辑）</div>' : ''}<div class="medit-a">
      <button type="button" class="btn acc" data-eact="save"${saving || !draft.dirty ? ' disabled' : ''}>${saving ? '保存中…' : '保存'}</button>
      <button type="button" class="btn" data-eact="cancel"${saving ? ' disabled' : ''}>取消</button>
      <span class="estatus">${draft.dirty ? '有尚未保存的修改' : draft.conflict ? '草稿保留（外部已修改）' : ''}</span>
    </div>`;
  },
  mEditorPaintFoot(host, draft, saving) { const e = host.querySelector('.emed'); if (e) e.innerHTML = this.mEditorFoot(draft, saving); },
  renderEditorSt(host, draft, s, saving, build) {
    const patch = draft.patch, has = k => Object.prototype.hasOwnProperty.call(patch, k);
    if (build) {
      const canRestoreNameCat = s.u.some(u => this.cfg.names[u] || this.cfg.moves[u]);
      host.innerHTML = `<div class="medit" data-kind="st">
        <div class="medit-h"><b>编辑电台</b><span class="srcs" title="${this.esc(s.n)}">默认名：${this.esc(s.dName || s.n)} · 默认分类：${this.esc(this.cfg.renames[s.dCat] || s.dCat || s.c)}</span><span class="srcs">（仅显示层；收藏/最近按源 URL 回绑不受影响）</span>
        ${canRestoreNameCat ? '<button type="button" class="btn mbtn" data-eact="strestore" title="只撤本台名称与分类调整（追加源/隐藏/源调整保留；立即生效）">恢复名称与分类</button>' : ''}</div>
        <div class="medit-f">
          <label>名称 <input type="text" data-f="name" data-fa="name" maxlength="80" aria-label="电台名称"></label>
          <label>分类 <select data-f="category" data-fa="category" aria-label="所属分类"></select></label>
          <label class="medit-ck"><input type="checkbox" data-f="hidden"> 隐藏电台（全部/收藏/搜索/体检一律不可见；不删数据，可在此恢复显示）</label>
        </div>
        <div class="emed"></div>
      </div>`;
      host.dataset.sig = draft.kind + '|' + draft.identityUrl;
      host.querySelector('[data-fa="name"]').focus(); // 进入编辑即移焦（§5.1）
    }
    const nm = has('name') ? String(patch.name) : s.n;
    const nmEl = host.querySelector('[data-f="name"]');
    if (nmEl.value !== nm) nmEl.value = nm; // 同值不写（不搅动光标）
    const cat = has('category') ? patch.category : s.c;
    const opts = this.mCatOptions().map(c => `<option value="${this.esc(c)}"${c === cat ? ' selected' : ''}>${this.esc(c)}${this.cfg.hideC[c] ? '（已隐藏）' : ''}</option>`).join('');
    const catEl = host.querySelector('[data-f="category"]');
    if (catEl.innerHTML !== opts) catEl.innerHTML = opts; // 他页改分类集后下拉随行
    const hid = has('hidden') ? !!patch.hidden : !!s.hidden;
    const hidEl = host.querySelector('[data-f="hidden"]');
    if (hidEl.checked !== hid) hidEl.checked = hid;
    this.mEditorPaintFoot(host, draft, saving);
  },
  renderEditorCat(host, draft, subj, saving, build) {
    const patch = draft.patch, has = k => Object.prototype.hasOwnProperty.call(patch, k);
    if (build) {
      host.innerHTML = `<div class="medit" data-kind="cat">
        <div class="medit-h"><b>编辑分类</b><span class="srcs">原名：${this.esc(subj.orig)}${subj.name !== subj.orig ? ` · 现名：${this.esc(subj.name)}` : ''}</span></div>
        <div class="medit-f">
          <label>名称 <input type="text" data-f="name" data-fa="name" maxlength="80" aria-label="分类名称"></label>
          <label class="medit-ck"><input type="checkbox" data-f="hidden"> 隐藏该分类（含全部/搜索；电台数据不动，可在此恢复显示）</label>
        </div>
        <div class="srcs" style="padding:2px 0">改名会级联更新移动目标与隐藏标记；改成已有分类名 = 保存时确认「合并」（不易拆分）。</div>
        <div class="emed"></div>
      </div>`;
      host.dataset.sig = draft.kind + '|' + draft.identityUrl;
      host.querySelector('[data-fa="name"]').focus();
    }
    const nm = has('name') ? String(patch.name) : subj.name;
    const nmEl = host.querySelector('[data-f="name"]');
    if (nmEl.value !== nm) nmEl.value = nm;
    const hid = has('hidden') ? !!patch.hidden : !!subj.hidden;
    const hidEl = host.querySelector('[data-f="hidden"]');
    if (hidEl.checked !== hid) hidEl.checked = hid;
    this.mEditorPaintFoot(host, draft, saving);
  },
  /* ---------- 源草稿（§6.9 六步，P4）：排序/禁用/标签只改草稿（保存才提交），追加先探活、每台 ≤6 条；
     原生源可禁不提供删除、只移除追加源；展示序按 SrcOrder.effective 语义（不复制引擎选源）；
     保存前核对最新源集合（重复/条数/URL 合法/他台占用 → 停止自动归属）。详情中心的启停/排序/标签
     动作共用同一编辑器草稿（不保留绕过草稿的即时保存分支）。 ---------- */
  mEditorStation() { const d = this.mEditor && this.mEditor.getDraft(); if (!d || d.kind !== 'src') return null; try { return uiResolveUnique(this.state.stations, d.identityUrl, d.hintKey); } catch (_) { return null; } },
  mEditorRepaint() { if (this.mEditor) this.renderEditor(this.mEditor.getDraft(), this.mEditor.saving); },
  mEditorPaint(d, saving) { // 编辑器重绘出口（boot io.render 接线，AIbot P2）：编辑器区照常重绘 + #detail 开着时
    // 源行随草稿实时重算（详情行动作/编辑器行动作/标签逐键/保存/取消全走这里，data-i 与新有效序一致）
    this.renderEditor(d, saving); if (!$('detail').hidden) this.renderDetail();
  },
  mSrcDraft(s, patch) { // 草稿有效源集合（review-r2 P1）：原生 s.u − 待保存移除 + 待保存追加 patch.appends——
    // 追加源探活通过即入列（可见/可标签/可排序/可禁用/可移除），保存才落 cfg；不建此集合则 pending 追加
    // 只有顶部计数看得见、行集与详情全不渲染，用户无法审查将提交的源（§6.9「追加后可继续管理」不成立）
    const rm = patch.removes || [], ap = patch.appends || [];
    return { urls: s.u.filter(u => !rm.includes(u)).concat(ap),
      manual: patch.manual !== null ? (patch.manual.length ? patch.manual : null) : (this.cfg.srcManualOrder[s.u[0]] || null),
      disabled: patch.disabled !== null ? patch.disabled : (this.cfg.srcDisabled[s.u[0]] || null) };
  },
  mSrcEffective(s, patch) { // 草稿感知的有效序（AIbot P2 + review-r2 P1 扩容）：作用域=草稿有效源集合，urls 随行返回，
    // 行渲染/行内动作一律 eff.urls[i] 取址（绝不回 s.u[i]——草稿行序与 s.u 下标不同空间）；patch 键 null=未改用 cfg 现值；[]=撤销人工排序
    const d = this.mSrcDraft(s, patch);
    const r = SrcOrder.effective(d.urls, d.manual, d.disabled);
    return { order: r.order, dis: r.dis, urls: d.urls };
  },
  mSrcMove(s, i, d) { // 排序只改草稿：有效序内移动后材料化完整顺序（启用序在前 + 禁用殿后，与旧 moveSrc 同口径）
    this.mEditor.mutate(patch => {
      const eff = this.mSrcEffective(s, patch);
      const at = eff.order.indexOf(i), to = at + d;
      if (at < 0 || to < 0 || to >= eff.order.length) return;
      const mo = eff.order.slice();
      mo.splice(to, 0, mo.splice(at, 1)[0]);
      patch.manual = [...mo, ...eff.dis].map(x => eff.urls[x]); // 材料化对草稿集合（待保存追加 URL 可入人工序）
    });
  },
  mSrcToggleDis(s, i) { // 禁用/启用只改草稿（原生源可禁，无删除入口；封顶与旧 toggleSrcDisabled 同为 6；待保存追加同管）
    this.mEditor.mutate(patch => {
      const u = this.mSrcEffective(s, patch).urls[i]; // i 是草稿集合下标（待保存追加也在内）
      if (!u) return;
      const cur = patch.disabled !== null ? patch.disabled.slice() : (this.cfg.srcDisabled[s.u[0]] || []).slice();
      const at = cur.indexOf(u);
      if (at >= 0) cur.splice(at, 1);
      else if (cur.length < SRC_CAP) cur.push(u);
      patch.disabled = cur;
    });
  },
  mSrcRemoveAppend(s, u) { // 只移除追加源（原生源无删除入口，绝不触碰 s.u）：待保存的从 patch.appends 删即从草稿消失，
    // 材料化的人工序/禁用表/标签草稿一并清（不留幽灵键——校验按草稿集合点名，幽灵会假报「源集合已变化」）；
    // 已落库的入 patch.removes 保存才生效（材料化序/禁用同步剔除，落库后装配层对残留 URL 本就忽略）
    this.mEditor.mutate(patch => {
      const ai = patch.appends.indexOf(u);
      if (ai >= 0) patch.appends.splice(ai, 1);
      else if (s.u.includes(u) && !patch.removes.includes(u)) patch.removes.push(u);
      else return;
      delete patch.labels[u];
      if (patch.manual) patch.manual = patch.manual.filter(x => x !== u);
      if (patch.disabled) patch.disabled = patch.disabled.filter(x => x !== u);
    });
  },
  mSrcLabelInput(u, val) { // 标签逐键入草稿（§6.9：不再 prompt）；空串在保存时 = 删键（删除属性 ≠ 空字符串）
    if (!this.mEditor) return;
    this.mEditor.mutate(patch => { patch.labels[u] = val; });
  },
  mSrcValidate(subj, patch) { // §6.9 步骤4/6：保存前核对最新源集合——重复/条数/URL 合法性；追加源被他台共用/失配 → 停止自动归属
    const removes = patch.removes || [], appends = patch.appends || [];
    const natives = subj.u.filter(u => !removes.includes(u)); // 原生−移除：追加去重基线（追加序内去重经 seen.add 累进）
    const seen = new Set(natives);
    for (const a of appends) {
      if (!/^https?:\/\//.test(a)) return '追加源需以 http(s):// 开头';
      if (seen.has(a)) return '追加源与本台现有源重复，请先移除';
      seen.add(a);
      const owner = this.state.stations.find(x => x !== subj && x.u.includes(a));
      if (owner) return `追加源已属于其他电台「${owner.n}」，已停止自动归属——请先移除（不能通过改身份归属解决）`;
    }
    const live = natives.concat(appends); // 草稿有效源集合（review-r2 P1）：人工序/禁用表对它点名——待保存追加 URL 合法在列
    if (live.length > SRC_CAP) return `每台最多 ${SRC_CAP} 条源，请先移除再追加`; // 封顶对「原生−移除+追加」合集生效（探活收编时已前置判满）
    for (const u of patch.manual || []) if (!live.includes(u)) return '人工排序含未知源地址（源集合已变化），请重新加载';
    for (const u of patch.disabled || []) if (!live.includes(u)) return '禁用表含未知源地址（源集合已变化），请重新加载';
    return '';
  },
  async mSrcProbe(s, btn) { // §6.9 步骤2：追加 URL 先经既有探活接口验证，通过才进草稿；判满前置（同旧 srcAppend 口径）
    const inp = btn.closest('.msrc-add').querySelector('input');
    const u = (inp.value || '').trim().replace(/\s+/g, ''); // URL 内不该有空白/换行，容错顺手清（坑③）
    if (!/^https?:\/\//.test(u)) { $('status').textContent = '追加源需以 http(s):// 开头'; return; }
    if (s.u.includes(u)) { $('status').textContent = '该地址已在源列表中'; return; }
    const d = this.mEditor.getDraft();
    if (d.patch.appends.includes(u)) { $('status').textContent = '该地址已在待保存的追加列表中'; return; }
    const total = s.u.filter(x => !d.patch.removes.includes(x)).length + d.patch.appends.length; // 与 mSrcValidate 同口径：原生−移除+追加合集判满
    if (total >= SRC_CAP) { $('status').textContent = `该台源数将达上限（${SRC_CAP} 条），先移除一条再追加`; return; }
    btn.disabled = true; btn.textContent = '探活中…';
    let r = null;
    // t=12000 与 /api/mystation 同口径（AIbot P1-1）：蜻蜓系慢源建流 5-10s 属正常，默认窗口会整类误拒
    try { r = await fetch('/api/check?t=12000&url=' + encodeURIComponent(u)).then(x => x.json()); }
    catch (e) { $('status').textContent = '追加失败（探活请求）：' + (e && e.message || e); }
    if (!r || !r.ok) { // 失败保留输入、不写草稿（§6.9 步骤2），重绘恢复按钮态
      if (r) $('status').textContent = '探活未通过，未追加（输入保留）：' + (r.detail || '源不可用（假流/死链）');
      this.mEditorRepaint();
      return;
    }
    this.mSrcVal = '';
    this.mEditor.mutate(patch => { patch.appends.push(u); }); // 入草稿有效集合：行即刻可见可管（review-r2 P1）
    $('status').textContent = `探活通过，已加入待保存的追加列表（${r.detail || '可用'}）——可排序/禁用/打标签，点「保存」写入`;
  },
  renderEditorSrc(host, draft, s, saving, build) {
    // 源行集合随排序/禁用变化，必须整片重建——data-fa 锚点恢复焦点与 selectionStart（§6.6）
    const ae = document.activeElement;
    let anchor = null, pos = 0;
    if (ae && host.contains(ae) && ae.dataset && ae.dataset.fa != null) { anchor = ae.dataset.fa; pos = ae.selectionStart != null ? ae.selectionStart : 0; }
    host.innerHTML = this.mEditorSrcHtml(draft, s, saving);
    host.dataset.sig = draft.kind + '|' + draft.identityUrl;
    if (anchor != null) {
      const t = host.querySelector(`[data-fa="${anchor.replace(/"/g, '\\"')}"]`);
      if (t) { t.focus({ preventScroll: true }); try { if (t.setSelectionRange && pos != null) t.setSelectionRange(pos, pos); } catch (_) {} }
    }
  },
  mEditorSrcHtml(draft, s, saving) {
    const patch = draft.patch;
    const eff = this.mSrcEffective(s, patch); // 草稿有效源集合（review-r2 P1）：待保存追加同行同序渲染，可即刻管理
    const dftU = s.u[Player.srcOrder(s)[0]] || null; // 「默认」徽标按 URL 对齐（落点基座与播放决策同一 srcOrder；待保存行天然不命中）
    const on = Player.station && keyOf(Player.station) === keyOf(s); // keyOf 口径（AIbot P3-3）
    const curU = on && s.u[Player.curSi] || null; // 「正在用」按 URL：curSi 是装配态下标，草稿行序与它不同空间
    const rows = [...eff.order, ...eff.dis].map(i => {
      const u = eff.urls[i], d = eff.dis.includes(i), pend = patch.appends.includes(u), appended = !s.dU.includes(u);
      const lb = Object.prototype.hasOwnProperty.call(patch.labels, u) ? patch.labels[u] : (this.cfg.srcLabels[u] || '');
      const at = eff.order.indexOf(i);
      return `<div class="srcline${u === curU ? ' cur' : ''}${d ? ' off' : ''}">
        <i class="idx">${i + 1}</i><span class="u" title="${this.esc(u)}">${this.esc(u)}</span>
        <input type="text" class="lbin" data-lu="${this.esc(u)}" data-fa="lb:${i}" value="${this.esc(lb)}" placeholder="标签（仅展示）" aria-label="源 ${i + 1} 的标签">
        ${u === dftU ? '<span class="badge">默认</span>' : ''}${u === curU ? '<span class="badge acc">正在用</span>' : ''}${d ? '<span class="badge permb">已禁用</span>' : ''}${pend ? '<span class="badge" title="探活已通过、点「保存」才并入本台源（取消即丢弃）">追加·待保存</span>' : appended ? '<span class="badge">追加</span>' : ''}
        <button type="button" class="btn mbtn" data-sact="up" data-i="${i}" title="上移（草稿内生效，保存后写入人工源顺序）"${d || at <= 0 ? ' disabled' : ''}>上移</button>
        <button type="button" class="btn mbtn" data-sact="down" data-i="${i}" title="下移（草稿内生效，保存后写入人工源顺序）"${d || at < 0 || at >= eff.order.length - 1 ? ' disabled' : ''}>下移</button>
        ${d ? `<button type="button" class="btn mbtn" data-sact="undis" data-i="${i}" title="取消禁用（草稿内生效，保存后恢复参与播放/体检）">启用</button>`
          : `<button type="button" class="btn mbtn" data-sact="dis" data-i="${i}" title="禁用该源（草稿内生效；播放与体检都跳过；主源只禁不删）">禁用</button>`}
        ${appended ? `<button type="button" class="btn mbtn" data-sact="rm" data-u="${this.esc(u)}" title="移除这条追加源（${pend ? '尚未保存，移除即丢弃' : '草稿内生效，保存后落地'}；原源不可删）">移除</button>` : ''}
        ${d || pend ? '' : `<button type="button" class="btn mbtn" data-sact="play" data-i="${i}" title="用此源立即播放（有待保存修改会先询问；成功后记源记忆）">▶</button>`}
        ${pend && !d ? '<span class="srcs">保存后可试听</span>' : ''}
      </div>`;
    }).join('');
    const ok = location.protocol.startsWith('http'); // 探活依赖后端，file:// 降级禁用（同添加电台口径）
    const total = eff.urls.length; // 与行集合同源（原生−移除+待保存追加），不再是看不见的计数
    return `<div class="medit" data-kind="src">
      <div class="medit-h"><b>源管理：${this.esc(s.n)}</b>
        <button type="button" class="btn mbtn" data-eact="srcmemclr" title="清掉该台「上次成功的源」记忆（立即生效；保留人工排序与禁用）">恢复默认播放源</button></div>
      <div class="msrc">
        <div class="msrc-t">共 ${total} 条（${patch.appends.length ? `${patch.appends.length} 条待保存追加；` : ''}${eff.dis.length ? `${eff.dis.length} 个禁用；` : ''}有效序=启用源在前）——上移/下移/禁用/标签只改草稿，点「保存」才写入；追加源探活通过才进草稿（每台 ≤${SRC_CAP} 条）；原源只禁不删，不动身份</div>
        ${rows}
        <div class="msrc-add">
          <input type="url" data-fa="app" value="${this.esc(this.mSrcVal || '')}" placeholder="追加流地址 http(s)://…（探活通过才进草稿）" aria-label="追加备选源地址"${ok ? '' : ' disabled title="file:// 降级模式无后端探活，npm start 后可用"'}>
          <button type="button" class="btn mbtn" data-sact="srcadd"${ok && !saving ? '' : ' disabled'}>探活并追加</button>
        </div>
      </div>
      <div class="emed">${this.mEditorFoot(draft, saving)}</div>
    </div>`;
  },


  /* —— 分类页 —— */
  renderMCats() {
    const cnt = new Map(); for (const s of this.state.stations) cnt.set(s.c, (cnt.get(s.c) || 0) + 1); // 数据口径（含隐藏台）
    const rows = [], seen = new Set();
    const row = c => {
      if (seen.has(c)) return; seen.add(c);
      const hid = !!this.cfg.hideC[c], custom = this.cfg.cats.includes(c);
      rows.push(`<div class="mrow${hid ? ' hidden-item' : ''}" data-cat="${this.esc(c)}">
        <span class="nm">${this.esc(c)}</span><span class="cnt">${cnt.get(c) || 0} 台${hid ? '·已隐藏' : ''}</span>
        <button type="button" class="btn mbtn" data-act="edit" title="编辑：重命名/隐藏（草稿保存，未保存离开会询问）；改成已有分类名 = 保存时确认合并"><svg class="ic"><use href="#i-pencil"/></svg></button>
        ${custom ? `<button type="button" class="btn mbtn" data-act="del" title="删除自建分类（其中电台回到同步默认分类）"><svg class="ic"><use href="#i-trash"/></svg></button>` : ''}
      </div>`);
    };
    for (const s of this.state.stations) row(s.c); // 含被隐藏分类（可在编辑里恢复显示）
    for (const c of this.cfg.cats) row(c); // 空自建分类也要能改名/删除
    $('mCats').innerHTML = rows.join('') + `<div style="padding:10px 0"><button type="button" class="btn" data-act="new"><svg class="ic"><use href="#i-plus"/></svg><span>新建分类</span></button><span class="cnt" style="margin-left:8px">新建后可在「电台」页把电台编辑进该分类；分类条要移入电台才显示</span></div>`;
  },
  catNew() { // 独立提交语义保留（confirm 即提交，不入草稿，§5.2）
    const c = this.askName('新建分类'); if (!c) return;
    if (this.mCatOptions().includes(c)) { alert('已有同名分类'); return; }
    this.cfg.cats.push(c); this.saveCfg(); this.renderManage();
  },
  catDel(c) {
    if (!confirm(`删除自建分类「${c}」？其中电台将回到同步默认分类。`)) return;
    for (const k of Object.keys(this.cfg.moves)) if (this.cfg.moves[k] === c) { delete this.cfg.moves[k]; delete this.cfg.tag[k]; } // 台撤回默认，tag 快照一并清
    this.cfg.cats = this.cfg.cats.filter(x => x !== c); delete this.cfg.hideC[c];
    if (this.state.cat === c) this.state.cat = '全部';
    this.saveCfg(); this.reapplyCfg();
  },

  /* —— 电台页（搜索含已隐藏台，恢复入口也在这）—— */
  renderMStations() {
    const box = $('mlist'), keepScroll = box.scrollTop; // innerHTML 重建丢滚动位置：先记后还
    const kw = (this.mKw || '').toLowerCase(), all = this.state.stations;
    // 命中当前名或原始名（改过名的用旧名也搜得到）；无关键词只列前 100，避免 1600+ 行整表渲染
    // dName/dCat 用 || 兜底（file:// 降级模式 boot 已快照，双保险防再漏）
    const list = kw ? all.filter(s => s.n.toLowerCase().includes(kw) || (s.dName || s.n).toLowerCase().includes(kw)) : all.slice(0, 100);
    const opts = this.mCatOptions();
    // 添加电台表单（A-2）分类下拉随行刷新；默认选中当前分类（全部/收藏/最近等非数据分类则落第一项）
    $('mACat').innerHTML = opts.map(c => `<option value="${this.esc(c)}"${c === this.state.cat ? ' selected' : ''}>${this.esc(c)}</option>`).join('');
    box.innerHTML = list.map(s => {
      const dN = s.dName || s.n;
      // moved 按 moves 键命中而非 s.c !== dC：分类级重命名会把整类台的 s.c 都改掉，但那不是单台移动，
      // ↺ 也撤不掉分类改名——按名字比较会让全类台误亮 ↺（PR#5 二轮 review 微小观察）
      const k = keyOf(s), moved = s.u.some(u => this.cfg.moves[u]), named = s.n !== dN;
      const srcl = !!(this.cfg.srcManualOrder[s.u[0]] || this.cfg.srcDisabled[s.u[0]] || s.u.some(u => this.cfg.srcLabels[u])); // 源生命周期调整（B1，台字段键=u[0] 严格命中）：↺ 一并撤销
      const srcd = s.u.some(u => !s.dU.includes(u)) || srcl; // 有追加源（P1-a）：↺ 一并撤销
      // P4：改名/移动/隐藏合并进「编辑」对象草稿；备选源管理 = 源草稿编辑器（§6.9，保存才提交）
      return `<div class="mrow${s.hidden ? ' hidden-item' : ''}" data-k="${this.esc(k)}">
        <span class="nm" title="${this.esc(named ? '原名：' + dN : s.n)}${s.hidden ? '（已隐藏）' : ''}">${this.esc(s.n)}</span>
        <span class="cnt">${[moved && '已移分类', named && '已改名', s.hidden && '已隐藏', srcd && '源已调整'].filter(Boolean).join(' · ')}</span>
        <button type="button" class="btn mbtn" data-act="edit" title="编辑：名称/分类/隐藏（草稿保存，未保存离开会询问）"><svg class="ic"><use href="#i-pencil"/></svg></button>
        ${(moved || named || s.hidden || srcd) ? `<button type="button" class="btn mbtn" data-act="reset" title="撤销此台全部个人调整（回到默认分类/默认名/显示/移除全部追加源/撤销源启停与排序）"><svg class="ic"><use href="#i-undo"/></svg></button>` : ''}
        <button type="button" class="btn mbtn" data-act="srcs" title="备选源管理：排序/禁用/标签/探活追加（草稿保存，未保存离开会询问）"><svg class="ic"><use href="#i-dots"/></svg></button>
      </div>`;
    }).join('') || '<div class="empty">没有匹配的电台</div>';
    if (!kw && all.length > 100) box.innerHTML += '<div class="empty" style="padding:8px 30px;">电台较多，仅列前 100 台——用上方搜索缩小范围</div>';
    box.scrollTop = keepScroll;
  },
  /* —— 备选源管理（P1-a/r2 ⑨ + ②手动选源 + B1 源生命周期）：展开行内按有效序列出全部源（追加的可移除，
     原源只读——身份公理：s.u[0] 是 srcmem/收藏/健康标记的身份键）+ 启用/禁用 + 上移/下移（人工顺序）+
     标签编辑（仅展示）+ 「▶ 用此源播放」（与 footer 浮层双入口）+ 先 /api/check 探活再收的追加输入 —— */
  srcBadges(s, i, dft) { // 源行徽标片段（footer 选源浮层专用，装配态口径）：默认=有效序首选、正在用=curSi 所在源、已禁用、追加
    // 源草稿编辑器不再共用（review-r2 P1）：其行序是草稿集合空间，徽标在 mEditorSrcHtml 内按 URL 对齐自行组装
    // 正在用按 keyOf 而非引用相等（AIbot P3-3）：同步重建 stations 后 Player.station 仍指旧对象，引用比较会丢高亮
    const on = Player.station && keyOf(Player.station) === keyOf(s);
    return (i === dft ? '<span class="badge">默认</span>' : '')
      + (on && Player.curSi === i ? '<span class="badge acc">正在用</span>' : '')
      + ((s.dis || []).includes(i) ? '<span class="badge permb">已禁用</span>' : '')
      + (s.dU.includes(s.u[i]) ? '' : '<span class="badge">追加</span>');
  },
  srcOrderView(s) { // 源展示序（footer 浮层/详情共用，B1）：启用源按有效序在前、禁用源殿后（原序）
    return [...(Array.isArray(s.mo) && s.mo.length ? s.mo : s.u.map((_, i) => i)), ...(s.dis || [])];
  },
  dSrcRows(s) { // 详情源行的序/禁用/标签（AIbot P2 + review-r2 P1）：本台源草稿在编 → 按草稿实时（mSrcEffective
    // 草稿有效源集合 + 草稿标签），待保存追加同行可见（urls/pends 随行返回，行 URL 一律 urls[i]、绝不 s.u[i]）；
    // 无草稿回装配态（= srcOrderView 拆解）。labels 只含草稿已改键，未改键回落 cfg
    const d = this.mEditor && this.mEditor.getDraft();
    if (d && d.kind === 'src' && d.identityUrl === s.u[0]) {
      const eff = this.mSrcEffective(s, d.patch);
      return { order: eff.order, dis: eff.dis, labels: d.patch.labels || {}, urls: eff.urls, pends: d.patch.appends || [] };
    }
    return { order: Array.isArray(s.mo) && s.mo.length ? s.mo : s.u.map((_, i) => i), dis: s.dis || [], labels: {}, urls: s.u, pends: [] };
  },
  /* 旧即时源生命周期入口（srcRowHtml/srcAppend/srcRemove/toggleSrcDisabled/moveSrc/editSrcLabel/clearSrcOrder）
     已由源草稿编辑器取代（P4 §6.9）：排序/禁用/标签/追加/移除只改草稿，保存经 uiBuildSrcNext/uiApplyCells
     提交；探活口径（t=12000、判满前置、6 条封顶）与恢复动作语义（resetSrcDefaults 只清记忆）原样保留 */

  resetSrcDefaults(s) { // 两动作之一（B1 拍板）：恢复默认播放源 = 只清 radio.srcmem2（保留人工序与禁用），立即生效
    const had = Player.forgetSrc(s);
    $('status').textContent = had ? '已清除该台的源记忆（下次点播按默认序）' : '本无源记忆，无需恢复';
    this.renderDetail();
  },

  /* ---------- 详情中心（B1，plan-expansion-r4 §5.3）：台信息 + 逐源诊断 + 源生命周期动作 + 歌曲历史。
     入口 = 列表行/网格卡「⋯」按钮、footer ⓘ 按钮、⚙ 面板源管理「详情」；探活走 /api/check?detail=1（≤4/批）。 ---------- */
  detail: { stationKey: '', results: [], loading: false, error: '', openedAt: 0 },
  dOpener: null, // 打开时焦点（关闭归还，同 manage 面板口径）
  detailStation() { return this.state.stations.find(x => keyOf(x) === this.detail.stationKey); },
  openDetail(s) {
    const d = this.mEditor && this.mEditor.getDraft();
    if (d && !(d.kind === 'src' && d.identityUrl === s.u[0])) // 开别的台详情：他台草稿先过三选门（§5.3，AIbot P1）
      return this.mDepart(() => { this.mEditorEnd(); this.openDetail(s); }); // stay=中止不打开；保存/放弃后才关旧草稿换台
    this.detail = { stationKey: keyOf(s), results: [], loading: false, error: '', openedAt: Date.now() };
    this.dOpener = document.activeElement;
    $('detail').hidden = false;
    this.renderDetail();
    this.mEditorRepaint(); // 宿主切到 #dEdit：本台源草稿编辑器（若有）迁入详情
    $('dClose').focus();
    this.checkStationSources(s); // 打开即诊断全部源（file:// 下给出降级提示）
  },
  closeDetail() { // 原始关闭（离开流程批准后调用）
    if ($('detail').hidden) return;
    $('detail').hidden = true;
    const b = this.dOpener && this.dOpener.isConnected ? this.dOpener : null;
    if (b && b.focus) b.focus();
  },
  async mSrcDetailOp(s, i, op) { // 详情配置动作 → 本台源草稿（§6.9：共用同一编辑器，不保留绕过草稿的即时保存分支）
    const d = this.mEditor && this.mEditor.getDraft();
    const same = d && d.kind === 'src' && d.identityUrl === s.u[0];
    if (!same && !(await this.mBeginEditor('src', s.u[0], keyOf(s)))) return; // 换对象：dirty 三选；失配：报错留旧态（hintKey=会话内稳定键）
    if (op === 'up' || op === 'down') this.mSrcMove(s, i, op === 'up' ? -1 : 1);
    else if (op === 'dis' || op === 'undis') this.mSrcToggleDis(s, i);
    else if (op === 'label') { const el = this.mEditHost().querySelector(`[data-fa="lb:${i}"]`); if (el) el.focus(); return; } // 只聚焦编辑器标签输入，草稿未变不重绘
    else if (op === 'clrorder') { // 草稿化裁量（§6.9）：撤销人工排序与面板同语义，写进草稿、保存后生效（不清禁用与源记忆）
      if (!this.cfg.srcManualOrder[s.u[0]] && !(this.mEditor.getDraft().patch.manual !== null)) { $('status').textContent = '本无人工源排序'; return; }
      this.mEditor.mutate(patch => { patch.manual = []; });
    }
  },
  /* 批量诊断名单（B1 review P1）：启用源有效序取前 SRC_CAP 条——手动禁用的源绝不进 /api/check?detail=1
     的 URL 集合（§5.4「禁用源不发诊断请求」），全禁台返回空（零请求）。纯函数可测（test/source-lifecycle.js）；
     Android checkDetailSources 同口径（effOrder 全量启用序，装配封顶后两侧集合一致） */
  diagIdx(s) {
    return (Array.isArray(s.mo) && s.mo.length ? s.mo : s.u.map((_, i) => i))
      .filter(i => !(s.dis || []).includes(i)).slice(0, SRC_CAP);
  },
  /* 逐源诊断（B1）：>4 源分批（服务端单次放大面 4 封顶不变）；名单走 diagIdx（禁用源不发请求 + 每台 6 封顶，
     review P1）；结果按 new URL 归一化回绑 u 空间索引（safeTarget 归一 = new URL().href，客户端同款归一可精确
     对上）；被护栏拒收的 URL 本地落 INVALID_URL 占位 */
  async checkStationSources(s) {
    const k = keyOf(s);
    if (this.detail.stationKey !== k) return;
    if (!location.protocol.startsWith('http')) { this.detail.error = 'file:// 降级模式无后端，诊断不可用——npm start 后可用'; this.renderDetail(); return; }
    const idx = this.diagIdx(s), norm = x => { try { return new URL(x).href; } catch (_) { return null; } };
    this.detail.loading = true; this.detail.error = '';
    this.detail.results = new Array(s.u.length);
    this.renderDetail();
    try {
      for (let b = 0; b < idx.length; b += 4) {
        const batch = idx.slice(b, b + 4);
        const qs = batch.map(i => 'url=' + encodeURIComponent(s.u[i])).join('&');
        const j = await fetch('/api/check?detail=1&' + qs).then(x => x.json());
        if (this.detail.stationKey !== k) return; // 诊断期间切了台/重开详情：丢弃过期结果
        for (const r of (j && Array.isArray(j.results) ? j.results : [])) {
          const bi = batch.findIndex(i => norm(s.u[i]) === r.url || s.u[i] === r.url);
          if (bi >= 0) this.detail.results[batch[bi]] = r;
        }
        batch.forEach(i => { // 服务端 safeTarget 拒收（私网/非 http）→ 无结果：本地 INVALID_URL 占位
          if (!this.detail.results[i]) {
            const h = /\.m3u8?(\?|$)/i.test(s.u[i]);
            this.detail.results[i] = { url: s.u[i], ok: false, code: 'INVALID_URL', hls: h, mode: h ? 'hls' : 'direct',
              httpStatus: 0, contentType: '', bytes: 0, latencyMs: 0, why: '地址被服务端安全护栏拒收（仅公网 http(s)）', checkedAt: Date.now() };
          }
        });
      }
    } catch (e) {
      if (this.detail.stationKey === k) this.detail.error = '诊断请求失败：' + (e && e.message || e);
    }
    if (this.detail.stationKey === k) {
      this.detail.loading = false;
      for (const r of this.detail.results) if (r) QualityStore.recordDiagnostic(s.u[0], r, 'manual'); // B2：手动逐源诊断样本
      this.renderDetail();
    }
  },
  async recheckSource(s, i) { // 单源复诊（详情源行「诊断」）：禁用源不发请求（B1 拍板——显示禁用原因 + 取消禁用入口）
    if ((s.dis || []).includes(i)) return;
    if (!location.protocol.startsWith('http')) { this.detail.error = 'file:// 降级模式无后端，诊断不可用——npm start 后可用'; this.renderDetail(); return; }
    const k = keyOf(s);
    this.detail.loading = true; this.renderDetail();
    try {
      const j = await fetch('/api/check?detail=1&url=' + encodeURIComponent(s.u[i])).then(x => x.json());
      if (this.detail.stationKey !== k) return;
      const r = j && Array.isArray(j.results) && j.results[0];
      if (r) { this.detail.results = this.detail.results.slice(); this.detail.results[i] = r; QualityStore.recordDiagnostic(s.u[0], r, 'manual'); } // B2 诊断样本
      else this.detail.error = '诊断无结果';
    } catch (e) { if (this.detail.stationKey === k) this.detail.error = '诊断请求失败：' + (e && e.message || e); }
    if (this.detail.stationKey === k) { this.detail.loading = false; this.renderDetail(); }
  },
  copySource(url) { // 复制源地址：clipboard API 优先（localhost 属安全上下文），旧接口兜底
    const done = () => { $('status').textContent = '已复制源地址'; };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(url).then(done, () => this.copyFallback(url, done));
    this.copyFallback(url, done);
  },
  copyFallback(url, done) {
    const t = document.createElement('textarea');
    t.value = url; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { if (document.execCommand('copy')) done(); } catch (_) {}
    t.remove();
  },
  playSource(s, i) { this.startPlay(s, i); this.renderDetail(); }, // 详情不关：底部栏可见连接进展，可连续试源
  /* 质量摘要片段（B2）：QualityStore.summary（与 Android 冻结口径一致的四档稳定性）——稳定性徽标 +
     成功率/平均延迟/断流/最近播放；质量只做展示，永不替代死台隐藏判定（契约硬点） */
  qualityHtml(s) {
    const qa = QualityStore.summary(s.u[0], s.u);
    if (!qa) return '<div class="srcs" style="padding:2px 0 6px">暂无质量样本（播放与体检后自动累计）</div>';
    const Q_TXT = { good: '稳定', fair: '一般', poor: '不稳定', unknown: '样本不足' };
    const cls = qa.stability === 'good' ? 'okb' : qa.stability === 'poor' ? 'badb' : '';
    const total = qa.okCount + qa.failCount;
    const rate = total ? Math.round(100 * qa.okCount / total) : 0;
    const icy = { icy: '有曲讯（直流）', none: '无曲讯', mixed: '混合源' }[qa.metadata] || qa.metadata;
    return `<div class="srcs" style="padding:2px 0 6px">
      <span class="badge ${cls}" title="stability: ${this.esc(qa.stability)}（近 30 天成功率/延迟/连续失败综合）">● ${Q_TXT[qa.stability] || qa.stability}</span>
      成功率 ${rate}%（${qa.okCount}/${total}）· 平均延迟 ${qa.avgLatencyMs}ms · 断流 ${qa.disconnects} 次 · ${icy}
      · 最近播放 ${qa.lastPlaybackAt ? this.fmtAgo(qa.lastPlaybackAt) : '—'}
    </div>`;
  },
  /* 详情渲染（唯一入口）：code 徽标走固定文案表（UI 不反推 why），质量摘要 B2 接线前先占位 */
  renderDetail() {
    if ($('detail').hidden) return;
    const s = this.detailStation();
    if (!s) return this.closeDetail(); // 台已消失（同步重建失配）：详情随之关闭
    const k = keyOf(s), fav = this.favKeys().has(k);
    const st = Player.getSourceState();
    const on = !!(st.station && keyOf(st.station) === k);
    let songs; try { songs = JSON.parse(Store.get('radio.songs') || '{}')[s.u[0]] || []; } catch (_) { songs = []; }
    const dv = this.dSrcRows(s), dis = dv.dis, urls = dv.urls; // 源行序/禁用/标签：草稿在编时随草稿实时（含待保存追加，review-r2 P1）
    const pendU = new Set(dv.pends || []);
    const rmap = {}; (this.detail.results || []).forEach((r, ri) => { if (r) rmap[s.u[ri]] = r; }); // 诊断结果按 URL 回绑：草稿行序与 s.u 下标不同空间
    const onU = on && st.sourceIndex >= 0 ? s.u[st.sourceIndex] : null, memU = on && st.srcMemIndex >= 0 ? s.u[st.srcMemIndex] : null; // 徽标按 URL 对齐
    const CODE_TXT = { OK: '可用', NETWORK: '网络失败', HTML: 'HTML 假流', HTTP: 'HTTP 错误', EMPTY_PLAYLIST: '空清单', NO_SEGMENT: '无可用分片', SHORT_BODY: '字节不足', REDIRECT_REJECTED: '重定向被拒', INVALID_URL: '地址不合法' };
    const rows = [...dv.order, ...dv.dis].slice(0, SRC_CAP).map(i => { // 每台 6 封顶（与装配/批量诊断同口径，review P1）
      const u = urls[i], r = rmap[u], d = dis.includes(i), pend = pendU.has(u);
      const lbv = Object.prototype.hasOwnProperty.call(dv.labels, u) ? dv.labels[u] : this.cfg.srcLabels[u];
      const lb = lbv ? `<span class="badge acc" title="源标签">${this.esc(lbv)}</span>` : '';
      const tag = (u === s.u[0] ? '<span class="badge" title="主源（身份键，不可替换/不可删）">主源</span>' : pend ? '<span class="badge" title="探活已通过、点「保存」才并入本台源（取消即丢弃）">追加·待保存</span>' : (s.dU.includes(u) ? '' : '<span class="badge">追加</span>')) + lb
        + (u === onU ? '<span class="badge acc">正在用</span>' : '')
        + (u === memU && u !== onU ? '<span class="badge">源记忆</span>' : '');
      const state = d
        ? '<span class="badge permb">已禁用</span><span class="srcs">该源已被手动禁用，不能诊断</span>'
        : pend ? '<span class="srcs">追加时探活已通过（保存后可诊断/试听）</span>'
        : r ? `<span class="badge ${r.ok ? 'okb' : 'badb'}" title="code: ${this.esc(r.code)}">${CODE_TXT[r.code] || r.code}</span><span class="srcs" title="${this.esc(r.why)}">${this.esc(r.why)} · ${r.latencyMs || 0}ms · ${r.bytes || 0}B · ${r.mode}</span>`
        : '<span class="srcs">未诊断</span>';
      const acts = [
        d ? `<button type="button" class="btn mbtn" data-act="dUndis" data-i="${i}" title="取消禁用该源（写进本台源草稿，保存后生效）">启用</button>`
          : `<button type="button" class="btn mbtn" data-act="dDis" data-i="${i}" title="禁用后播放与体检都跳过该源（写进本台源草稿，保存后生效）">禁用</button>`,
        `<button type="button" class="btn mbtn" data-act="dUp" data-i="${i}" title="上移（写进本台源草稿的人工顺序，保存后生效）">↑</button>`,
        `<button type="button" class="btn mbtn" data-act="dDown" data-i="${i}" title="下移（写进本台源草稿的人工顺序，保存后生效）">↓</button>`,
        `<button type="button" class="btn mbtn" data-act="dLabel" data-i="${i}" title="编辑源标签（仅展示用，写进草稿）">标签</button>`,
        `<button type="button" class="btn mbtn" data-act="dCopy" data-i="${i}">复制</button>`,
        pend ? '' : `<button type="button" class="btn mbtn" data-act="dRecheck" data-i="${i}">诊断</button>`,
        d || pend ? '' : `<button type="button" class="btn mbtn" data-act="dPlay" data-i="${i}" title="用此源立即播放（失败自动顺延；有待保存的源修改会先询问）">▶ 播放</button>`,
      ].join('');
      return `<div class="dsrc${d ? ' off' : ''}${u === onU ? ' cur' : ''}">
        <i class="idx">${i + 1}</i>
        <div class="dsrc-m"><div class="dsrc-u" title="${this.esc(u)}">${this.esc(u)}</div><div class="dsrc-i">${tag}${state}</div></div>
        <span class="dsrc-a">${acts}</span>
      </div>`;
    }).join('');
    $('detailBody').innerHTML = `
      <div class="dheadinfo">${Logos.visual(s)}<div class="dstats">
        <b title="${this.esc(s.n)}">${this.esc(s.n)}</b>
        <span class="srcs">${this.esc(s.c)} · ${urls.length} 个源${dv.pends && dv.pends.length ? ` · ${dv.pends.length} 条待保存追加` : ''}${dis.length ? ` · ${dis.length} 个已禁用` : ''}${on && st.connecting ? ' · 连接中…' : on && !Player.isPaused() ? ' · 播放中' : ''}</span>
      </div>${this.favBtn(k, fav, s)}</div>
      ${on ? `<div class="dcur">当前源：${st.sourceIndex >= 0 ? `源 ${st.sourceIndex + 1}` : '—'}${st.variantUrl ? ` · ${st.mode === 'hls' ? 'HLS' : '直流'}` : ''}${st.connecting ? '（连接中）' : ''}</div>` : ''}
      <div class="dsec"><b>源诊断</b>${this.detail.loading ? '<span class="srcs">诊断中…</span>' : '<button type="button" class="btn mbtn" data-act="dAll">全部诊断</button>'}</div>
      ${this.detail.error ? `<div class="derr">${this.esc(this.detail.error)}</div>` : ''}
      ${rows}
      <div class="dsec"><b>源管理</b></div>
      <div class="dacts">
        <button type="button" class="btn mbtn" data-act="dResetMem" title="清掉「上次成功的源」记忆（保留人工排序与禁用；立即生效）">恢复默认播放源（清源记忆）</button>
        <button type="button" class="btn mbtn" data-act="dClearOrder" title="撤销人工源排序（写进本台源草稿，保存后生效；不清禁用与源记忆）">撤销人工源排序</button>
      </div>
      <div class="dsec"><b>质量摘要</b></div>
      ${this.qualityHtml(s)}
      <div class="dsec"><b>歌曲历史（本台最近）</b></div>
      ${songs.length ? songs.map(x => `<div class="shrow">${this.esc(x.t)}</div>`).join('') : '<div class="srcs" style="padding:2px 0 6px">暂无历史（换歌后自动记录）</div>'}`;
  },

  /* ---------- 发现页（B3-C）：独立浮层视图（#detail 同范式），入口 = header「发现」按钮（features.discovery
     关时隐藏）。纯本地派生——buildDiscovery 数据注入（质量摘要/健康/最近/radio-meta/revives 全本地），不联网、
     不改主列表排序；点击行统一 startPlay→Player.play（不复制播放决策）。 ---------- */
  dscOpener: null,
  discoverySidecar: null,
  async openDiscovery() {
    this.dscOpener = document.activeElement;
    $('discovery').hidden = false;
    $('discBody').innerHTML = '<div class="empty">正在生成推荐…</div>';
    $('discClose').focus();
    if (!this.metaCache) this.metaCache = await this.loadMeta(); // 懒加载一次（radio-meta.json 静态文件，非 dotfile/data 段天然可 GET）
    if (trustedC3Release && FEATURES.discoverySidecar && !this.discoverySidecar && window.DiscoverySidecar) {
      const rows = await DiscoverySidecar.loadSnapshot((u, opts) => fetch(u, opts), 'discovery-snapshots');
      if (rows === null) $('status').textContent = '当前页面缺少安全校验能力，精选候选不可用；请使用 localhost 或 HTTPS';
      else if (rows.length) this.discoverySidecar = rows;
    }
    this.renderDiscovery();
    if (trustedC3Release && FEATURES.discoverySidecar && this.discoverySidecar && this.discoverySidecar.length) this.renderDiscoverySidecar();
  },
  async loadMeta() { // file://：meta 无经典 script 包装不可读 → null（「最近新增」为空，其余组不受影响）
    if (!location.protocol.startsWith('http')) return null;
    try { return await fetch('radio-meta.json').then(r => r.ok ? r.json() : null); } catch (_) { return null; }
  },
  closeDiscovery() {
    if ($('discovery').hidden) return;
    $('discovery').hidden = true;
    const b = this.dscOpener && this.dscOpener.isConnected ? this.dscOpener : null;
    if (b && b.focus) b.focus();
  },
  renderDiscoverySidecar() {
    const host = $('discBody'); if (!host) return;
    const rows = this.discoverySidecar || [];
    const html = '<div class="dsec"><b>精选候选（需手动加入）</b><span class="srcs">独立来源，来源信息仅格式校验，未验证真实性</span></div>' + rows.slice(0, 300).map((r, i) => `<button type="button" class="btn mbtn discrow" data-sidecar="${i}"><span class="dn">${this.esc(r.name)}</span><span class="badge">${this.esc(r.genre || '精选')}</span><span class="srcs">探活并加入个人电台</span></button>`).join('');
    host.insertAdjacentHTML('beforeend', html);
    host.querySelectorAll('[data-sidecar]').forEach(b => b.onclick = () => this.addDiscoveryStation(rows[+b.dataset.sidecar]));
  },
  async addDiscoveryStation(r) {
    let u;
    try { u = new URL(r && r.url); } catch (_) { return; }
    // 仅作前端纵深校验；后端 safeTarget + guardLookup 仍是 SSRF/DNS rebinding 的安全边界。
    if (!r || !/^https?:$/.test(u.protocol) || !u.hostname || /^(localhost|.*\.local)$/i.test(u.hostname) || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname) || !confirm(`将「${r.name}」加入个人电台并先探活？`)) return;
    if (!location.protocol.startsWith('http')) { $('status').textContent = 'file:// 无法写入个人电台，请使用 npm start'; return; }
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 8000);
    try {
      const q = await fetch('/api/mystation', {method:'POST', headers:{'Content-Type':'application/json'}, signal: ctl && ctl.signal, body:JSON.stringify({n:r.name,u:r.url,c:'精选'})});
      const ct = String(q.headers && q.headers.get ? q.headers.get('content-type') || '' : '').toLowerCase();
      const len = Number(q.headers && q.headers.get ? q.headers.get('content-length') || 0 : 0);
      if (len > 8192 || (ct && !ct.includes('application/json'))) throw Error('bad response');
      let text = '', reader = q.body && q.body.getReader ? q.body.getReader() : null;
      if (!reader) throw Error('stream unavailable');
      let total = 0; const decoder = new TextDecoder('utf-8', {fatal:true});
      for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > 8192) { try { await reader.cancel(); } catch (_) {} throw Error('large response'); } text += decoder.decode(part.value, {stream:true}); }
      text += decoder.decode();
      const res = JSON.parse(text);
      if (!res || typeof res.ok !== 'boolean') throw Error('invalid response');
      $('status').textContent = res && res.ok ? `已加入个人电台：${r.name}` : '加入失败：探活未通过或服务不可用';
      if (res && res.ok) this.reloadMain();
    } catch (_) { $('status').textContent = '请求结果未知，服务端可能已加入；请稍后刷新个人电台确认后再重试'; try { await this.reloadMain(); } catch (_) {} }
    finally { clearTimeout(timer); }
  },
  renderDiscovery() {
    const d = buildDiscovery({
      rows: this.state.stations.map(s => ({ k: keyOf(s), n: s.n, c: s.c, u0: s.u[0] || '', u: s.u,
        hidden: !!(s.hidden || this.cfg.hideC[s.c]), dead: s.health === 'dead', om: s.om ? 1 : 0 })),
      quality: (u0, u) => QualityStore.summary(u0, u),
      meta: this.metaCache, recents: this.recents, revives: this.revives,
      playingKey: Player.station && keyOf(Player.station), connectingKey: Player.connecting && keyOf(Player.connecting),
    });
    const GROUPS = [ // 固定六组（§7.3）；只渲染非空组——发现是「给灵感」，空组不出占位噪音
      ['starter', '精选电台', '内置实测精选层'],
      ['stable', '稳定直连', '近 30 天稳定性 good 且有直流源'],
      ['fresh', '最近新增', '同步新进电台'],
      ['revived', '最近恢复', '从失效标记复活的电台'],
      ['icy', '有曲讯', '直流 ICY——播放时可显示歌名'],
      ['unheard', '未听过', '还从未播放过'],
    ];
    let html = '';
    for (const [id, t, desc] of GROUPS) {
      const list = d.groups[id];
      if (!list.length && !(id === 'stable' && d.unknown)) continue;
      html += `<div class="dsec"><b>${t}</b><span class="srcs">${desc}</span></div>`;
      if (!list.length) { html += `<div class="srcs" style="padding:2px 0 8px">暂无质量数据（播放与体检后自动累计）</div>`; continue; }
      html += list.map(r => `<button type="button" class="btn mbtn discrow" data-k="${this.esc(r.k)}" title="播放：${this.esc(r.n)}">
        <span class="dn">${this.esc(r.n)}</span><span class="badge">${this.esc(r.c)}</span>
        ${id === 'fresh' ? `<span class="srcs">${this.fmtAgo(r.at)}</span>` : r.obs ? `<span class="srcs">${this.fmtAgo(r.obs)}</span>` : ''}
      </button>`).join('');
    }
    $('discBody').innerHTML = html || '<div class="empty">暂无推荐——收藏/播放/体检后这里会越来越准</div>';
  },

  /* ---------- B3-B 收听统计接线：Player 派生态 → ListenStats 状态机（只读快照推导，不复制播放决策）。
     IDLE/CONNECTING/PAUSED/PLAYING 由 onstate 推导；FAILED 由 onfail 显式给；PLAYING 的 session 建立
     只认 Player.onqos phase='playing'（新建流到达——resume 不经 load 不采样，重锚不开新 session）。 ---------- */
  lsState() {
    if (!Player.station) return ListenStats.onState('IDLE');
    if (Player.connecting) return ListenStats.onState('CONNECTING');
    ListenStats.onState(Player.isPaused() ? 'PAUSED' : 'PLAYING');
  },

  /* 电台改名/移动/隐藏的即时保存入口（.stMove/.stRename/.stHide）已由逐对象草稿编辑器取代（P4 §5.2）：
     「编辑」进草稿 → 保存经 uiBuildStationNext/uiApplyCells 写 cfg（选默认 = 撤键，与旧 stMove ↺ 语义一致） */
  cfgResetStation(s, alsoMem) { // 撤回此台全部个人调整（§5.4 表：全字段口径，含 B1 生命周期三字段）；
    // radio.srcmem2 按任务裁量 = 预览勾选「同时清除播放源记忆」才清（默认不清，既有现状保持）
    for (const u of s.u) { delete this.cfg.moves[u]; delete this.cfg.names[u]; delete this.cfg.hideS[u]; delete this.cfg.tag[u]; delete this.cfg.srcLabels[u]; } // tag 只在失配清单用，恢复默认即清（防只增不减）；标签属展示层调整一并撤（B1）
    for (const k of Object.keys(this.cfg.srcs)) if (s.u.includes(k)) delete this.cfg.srcs[k]; // 追加源一并撤（键=任一源 URL，均在此台 s.u 内）
    for (const k of ['srcManualOrder', 'srcDisabled']) delete this.cfg[k][s.u[0]]; // 源生命周期一并撤（B1，键=身份 URL 严格命中）
    if (alsoMem) Player.forgetSrc(s); // 裁量项：仅在预览明确勾选时清源记忆
    this.saveCfg(); this.reapplyCfg();
    $('status').textContent = '已撤回此台全部个人调整' + (alsoMem ? '（含播放源记忆）' : '');
  },
  async confirmResetStation(s) { // §5.4「撤回此台全部个人调整」：先预览影响清单再确认提交（执行体 = cfgResetStation）
    const items = [];
    for (const u of s.u) if (this.cfg.names[u]) { items.push('改名：' + this.cfg.names[u] + (s.dName && s.dName !== this.cfg.names[u] ? '（默认名：' + s.dName + '）' : '')); break; }
    for (const u of s.u) if (this.cfg.moves[u]) { items.push('分类移动：→ ' + this.cfg.moves[u]); break; }
    if (s.u.some(u => this.cfg.hideS[u])) items.push('隐藏电台');
    const srcsN = new Set();
    for (const k of Object.keys(this.cfg.srcs)) if (s.u.includes(k)) for (const x of this.cfg.srcs[k]) srcsN.add(x);
    if (srcsN.size) items.push('追加备选源 ' + srcsN.size + ' 条');
    if (this.cfg.srcManualOrder[s.u[0]]) items.push('人工源排序');
    if (this.cfg.srcDisabled[s.u[0]]) items.push('禁用源 ' + this.cfg.srcDisabled[s.u[0]].length + ' 个');
    const lbN = s.u.filter(u => this.cfg.srcLabels[u]).length;
    if (lbN) items.push('源标签 ' + lbN + ' 个');
    if (!items.length) { $('status').textContent = '此台没有个人调整可撤回'; return; }
    let memCb = null;
    const v = await uiChooseDialog(`撤回「${s.n}」的全部个人调整`,
      '将移除以下调整，确认后立即生效（电台数据与收藏不受影响）：',
      [{ value: 'ok', label: '确认撤回', primary: true }, { value: 'stay', label: '取消' }],
      { safe: 'stay', build: body => {
        const pre = document.createElement('div'); pre.className = 'ecpreview';
        pre.textContent = items.map(x => '· ' + x).join('\n');
        body.appendChild(pre);
        const lab = document.createElement('label'); lab.className = 'ecck';
        const cb = document.createElement('input'); cb.type = 'checkbox';
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(' 同时清除播放源记忆（下次点播按默认源序）'));
        body.appendChild(lab);
        memCb = cb;
      } });
    if (v !== 'ok') return;
    this.cfgResetStation(s, memCb && memCb.checked);
  },
  mRestoreNameCat(s) { // §5.4「恢复名称与分类」：只撤本台 names/moves——追加源/隐藏/源调整严格保留（与恢复默认源策略分开）
    let any = false;
    for (const u of s.u) {
      if (this.cfg.names[u]) { delete this.cfg.names[u]; any = true; }
      if (this.cfg.moves[u]) { delete this.cfg.moves[u]; any = true; }
    }
    if (!any) { $('status').textContent = '本台无名称/分类调整'; return; }
    if (!uiHasAdj(this.cfg, s)) for (const u of s.u) delete this.cfg.tag[u]; // 已无任何调整 → tag 快照一并清
    this.saveCfg(); this.reapplyCfg();
    $('status').textContent = '已恢复默认名称与分类（追加源与源调整保留）';
  },

  /* —— 失配清单（P4 扩容）：moves/names/hideS/srcs/srcLabels 的键没命中任何当前台的源 URL、
     srcManualOrder/srcDisabled（键 = 身份 URL u[0] 严格命中）没命中任何台主 URL = 上游 URL 漂移
     （欧美台同步重建常见）——B1 生命周期三字段此前不可观测，本批补上 ---------- */
  missList() {
    const used = new Set(); for (const s of this.state.stations) for (const u of s.u) used.add(u);
    const u0s = new Set(); for (const s of this.state.stations) u0s.add(s.u[0]);
    const bad = [];
    for (const [m, kind] of [[this.cfg.moves, '移动'], [this.cfg.names, '改名'], [this.cfg.hideS, '隐藏'], [this.cfg.srcs, '备源'], [this.cfg.srcLabels, '标签']])
      for (const u of Object.keys(m)) if (!used.has(u)) bad.push({ u, kind, name: this.cfg.tag[u] || u.replace(/^https?:\/\//, '').slice(0, 40) });
    for (const [m, kind] of [[this.cfg.srcManualOrder, '排序'], [this.cfg.srcDisabled, '禁用']])
      for (const u of Object.keys(m)) if (!u0s.has(u)) bad.push({ u, kind, name: this.cfg.tag[u] || u.replace(/^https?:\/\//, '').slice(0, 40) });
    return bad;
  },
  renderMiss() {
    const bad = this.missList();
    $('mMiss').innerHTML = !bad.length ? '' : `<div class="miss"><b><svg class="ic"><use href="#i-warn"/></svg> ${bad.length} 条个人调整已失配</b>（上游同步后源地址漂移，多为欧美台重建）：${bad.map(b => `${this.esc(b.name)}（${b.kind}）`).join('、')}。在「电台」页搜台名可重新指定，<button type="button" class="btn mbtn" data-act="missclear">或清理这些失配项</button></div>`;
  },
  missClear() { // 清失配项 = cfg 变更，走与正常提交相同的 saveCfg→reapplyCfg 链（AIbot P1：主列表随行重套/重渲，不再只刷面板）
    for (const b of this.missList()) { delete this.cfg.moves[b.u]; delete this.cfg.names[b.u]; delete this.cfg.hideS[b.u]; delete this.cfg.srcs[b.u]; delete this.cfg.srcLabels[b.u]; delete this.cfg.srcManualOrder[b.u]; delete this.cfg.srcDisabled[b.u]; delete this.cfg.tag[b.u]; }
    this.saveCfg(); this.reapplyCfg();
  },

  /* —— 配置导入导出（owner 拍板：只含维护层；收藏另有 m3u 导出）—— */
  /* tag（失配清单默认名快照）一并计入（AIbot P2）：与 uiCfgDiff 的 UI_CFG_FIELDS 字段集合同口径——
     否则 tag-only 差异「预览列了明细、总数却是 0 项」自相矛盾（重置/导入两预览共用这两个计数） */
  cfgCount(c) { return Object.keys(c.moves).length + Object.keys(c.names).length + Object.keys(c.tag).length + Object.keys(c.hideS).length + Object.keys(c.renames).length + Object.keys(c.hideC).length + Object.keys(c.srcs).length + Object.keys(c.srcManualOrder).length + Object.keys(c.srcDisabled).length + Object.keys(c.srcLabels).length + c.cats.length; },
  exportCfg() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ v: 1, cfg: this.cfg }, null, 2)], { type: 'application/json' }));
    a.download = 'vradio-config.json'; a.click(); URL.revokeObjectURL(a.href);
    $('status').textContent = `已导出维护配置（${this.cfgCount(this.cfg)} 项，vradio-config.json）`;
  },
  mDataErr(msg) { // 数据分区就地错误（§5.5：不用 alert——#editorConfirm 是 role=alertdialog，可聚焦/读屏可达）
    uiChooseDialog('导入失败', msg, [{ value: 'x', label: '关闭' }], { safe: 'x' }).catch(() => {});
  },
  importCfg(text) { // §5.5：解析 → normCfg 校验 → 差异预览 → 明确覆盖确认 → 提交（提交语义不变：normCfg → 全量覆盖 → saveCfg → reapplyCfg）
    let j; try { j = JSON.parse(text); } catch (_) { return this.mDataErr('文件不是合法 JSON，无法导入。'); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return this.mDataErr('文件不是 vradio 维护配置对象（应为 { v, cfg } 形态的 JSON）。');
    const hasCfg = j.cfg && typeof j.cfg === 'object' && !Array.isArray(j.cfg);
    const c = this.normCfg(j.cfg); // 校验走实际 normCfg（坏形状字段被清洗/丢弃，以清洗后结果为准预览）
    const d = uiCfgDiff(this.cfg, c), curN = this.cfgCount(this.cfg), newN = this.cfgCount(c);
    uiChooseDialog('导入维护配置 · 覆盖预览',
      hasCfg ? '导入将全量覆盖本地维护配置（个人调整层——不删除收藏、电台主库、个人文件）。请核对差异后确认：'
        : '文件中没有 cfg 配置对象——按「空配置」导入，等同于清空全部个人维护配置。',
      [{ value: 'ok', label: '确认覆盖导入', primary: true }, { value: 'stay', label: '取消' }], {
      safe: 'stay',
      build: body => {
        const pre = document.createElement('div'); pre.className = 'ecpreview';
        const lines = [];
        if (!newN && curN) lines.unshift(`将清空全部 ${curN} 项个人维护配置`); // 空 incoming 必须明示（§5.5）
        for (const [k, lab] of UI_CFG_FIELDS) {
          const f = d.fields[k], seg = [];
          if (f.add) seg.push('新增 ' + f.add);
          if (f.del) seg.push('删除 ' + f.del);
          if (f.chg) seg.push('修改 ' + f.chg);
          if (seg.length) lines.push(lab + '：' + seg.join(' · '));
        }
        if (!d.total) lines.push('导入内容与当前配置一致（无差异）');
        pre.textContent = lines.join('\n');
        body.appendChild(pre);
        const sum = document.createElement('p'); sum.className = 'ecsum';
        sum.textContent = `覆盖后共 ${newN} 项（当前 ${curN} 项，含 ${c.cats.length} 个自建分类）。`;
        body.appendChild(sum);
      } }).then(ok => {
        if (ok !== 'ok') return; // 严格按值判定（P6 验收抓到的真实缺陷：Esc/取消 resolve 'stay' 是真值字符串，布尔判定会把「取消」当「确认」执行导入）
        this.cfg = c; this.saveCfg(); this.reapplyCfg();
        $('status').textContent = `已导入维护配置（覆盖后 ${newN} 项）`;
      }).catch(() => {}); // 确认层被占用（理论罕见）：静默放弃，不打断既有弹窗
  },
  async resetCfg() { // §5.4 表「重置全部维护配置」升级：预览清除数量与范围（复用 uiCfgDiff(current, {})），明示不删除清单；确认后执行（语义不变）
    const d = uiCfgDiff(this.cfg, this.normCfg(null)), curN = this.cfgCount(this.cfg);
    if (!d.total) { $('status').textContent = '当前没有可重置的维护配置'; return; }
    let v;
    try {
      v = await uiChooseDialog('重置全部维护配置', '将清空以下全部个人维护配置，分类与电台回到同步默认：',
        [{ value: 'ok', label: '确认重置', primary: true }, { value: 'stay', label: '取消' }], {
        safe: 'stay',
        build: body => {
          const pre = document.createElement('div'); pre.className = 'ecpreview';
          const lines = [];
          for (const [k, lab] of UI_CFG_FIELDS) {
            const f = d.fields[k], n = f.add + f.del + f.chg;
            if (n) lines.push(lab + ' ' + n + ' 项');
          }
          pre.textContent = lines.join('\n');
          body.appendChild(pre);
          const keep = document.createElement('p'); keep.className = 'ecsum';
          keep.textContent = `共清除 ${curN} 项。不会删除：收藏与最近播放、电台主库（radio.txt）、个人电台文件（my-radio.txt）、歌曲历史。`;
          body.appendChild(keep);
        } });
    } catch (_) { return; } // 确认层被占用（理论罕见）：放弃重置，不打断既有弹窗
    if (v !== 'ok') return;
    this.cfg = this.normCfg(null); this.saveCfg(); this.state.cat = '全部'; this.reapplyCfg();
    $('status').textContent = `已重置维护配置（清除 ${curN} 项）`;
  },

  /* —— 完整备份导出/导入（R4 拍板 → r4/B4 升 v3，BackupV3 纯逻辑内核）：全部 radio.* + 个人电台行
     （+ 可选质量 sidecar）打包单 JSON——换浏览器/换机的兜底通道；与既有单项导出并存（m3u/songs/config）。
     导入三阶段（§13.2）：parse → validate/preview（版本/键白名单/sidecar 明示「含 N 台质量数据、将覆盖
     本机质量数据」）→ commit（BackupV3.commitImport：先快照 Store/my-radio/旧质量三件，任一步失败整体
     回滚——质量旧快照经 replace 尽力回写，二次失败文案如实点名「可能停留在导入状态」） —— */
  async exportAll() {
    const http = location.protocol.startsWith('http');
    let myRadio = [], myNote = '';
    if (http) {
      const t = await fetch('my-radio.txt?t=' + Date.now()).then(r => r.ok ? r.text() : null).catch(() => null);
      if (t == null) myNote = '（个人电台列表拉取失败，本次备份未含）';
      else myRadio = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    }
    const ext = {};
    if ($('mSidecar') && $('mSidecar').checked) { // 「包含本机 sidecar」复选（默认关）：只留迁移字段
      ext.sidecars = {};
      if (http) { // 质量 sidecar 仅 http 形态（服务端 quality.json）
        const q = await fetch('/api/quality').then(r => r.json()).catch(() => null);
        if (q && q.data && !q.notModified) {
          const d = BackupV3.qualityTrim(q.data);
          if (Object.keys(d).length) ext.sidecars.quality = { v: 1, data: d };
        }
      }
      // 收听统计 sidecar 双形态（B4）：http 读服务端 /api/listenstats、file:// 读本地快照——裁剪后随行
      const lsRaw = http
        ? await fetch('/api/listenstats').then(r => r.json()).then(j => j && j.days && !j.notModified ? j.days : null).catch(() => null)
        : (() => { try { const j = JSON.parse(localStorage.getItem('listenstats.local') || 'null'); return j && j.days ? j.days : null; } catch (_) { return null; } })();
      if (lsRaw) {
        const d = BackupV3.lsTrim(lsRaw);
        if (Object.keys(d).length) ext.sidecars.listenStats = { v: 1, data: d };
      }
      if (!Object.keys(ext.sidecars).length) delete ext.sidecars;
    }
    const o = BackupV3.build({ at: Date.now(), app: 'web', data: Store.snapshot(), myRadio, extensions: ext });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' }));
    a.download = 'vradio-backup.json'; a.click(); URL.revokeObjectURL(a.href);
    const sc = ext.sidecars
      ? '，含' + [ext.sidecars.quality ? `质量 sidecar ${Object.keys(ext.sidecars.quality.data).length} 台` : '',
          ext.sidecars.listenStats ? `收听统计 ${Object.keys(ext.sidecars.listenStats.data).length} 天` : ''].filter(Boolean).join('、')
      : '';
    $('status').textContent = `已导出完整备份 v3（收藏/配置/健康标记/歌曲历史${myRadio.length ? '/个人电台' : ''}${sc}${myNote}；台标缓存可重建不包含）`;
  },
  async importAll(text) {
    // §5.5（P5）：交互壳重做——parse + validate/preview（BackupV3.read：版本识别 + 键白名单过滤 + sidecar 判定）
    // 后不再走 confirm() 链，改为结构化覆盖预览面板（图10 信息层级）+ sidecar 勾选 + submitting 态；
    // 阶段三 commitImport 调用与 io 注入表一行语义不改（三阶段四快照回滚在 backup.js，B01 已有事务测试）。
    if (this._restoreBusy) return; // 提交中禁重复入口（预览「开始恢复」点击后即置，直到事务返回）
    const info = BackupV3.read(text, Store.KEYS);
    if (!info) return this.mDataErr('不是 vradio 完整备份文件（支持 v1/v2/v3）。请选择「备份全部」导出的 vradio-backup.json。');
    if (!info.n) return this.mDataErr('备份中无有效数据（Store 键为空或全被白名单过滤），未做任何改动。');
    const http = location.protocol.startsWith('http');
    const pv = uiBackupPreview(info, { http });
    let scCb = null, v; // sidecar 勾选项（默认勾选，替换原 confirm）；commitImport 的 sc = 单开关恢复备份所含全部 sidecar
    try {
      v = await uiChooseDialog('备份恢复 · 覆盖预览',
        '恢复将覆盖本地全部数据；恢复不触发自动播放，提交中不可重复触发，结果如实区分「未提交 / 已回滚 / 回滚失败」。请核对覆盖范围：',
        [{ value: 'ok', label: '开始恢复', primary: true }, { value: 'stay', label: '取消' }], {
        safe: 'stay',
        build: body => {
          const list = document.createElement('div'); list.className = 'ecrows';
          for (const r of pv.rows) {
            const row = document.createElement('div'); row.className = 'ecrow';
            const k = document.createElement('span'); k.className = 'k'; k.textContent = r.k;
            const b = document.createElement('span'); b.className = 'v'; b.textContent = r.v;
            row.appendChild(k); row.appendChild(b); list.appendChild(row);
          }
          body.appendChild(list);
          for (const note of pv.notes) { const p = document.createElement('p'); p.className = 'ecsum'; p.textContent = '· ' + note; body.appendChild(p); }
          if (pv.unavailable.length) { // file:// 下不可用项明示（§5.5）
            const un = document.createElement('div'); un.className = 'econflict';
            un.textContent = '本形态（file://）不可用项：\n' + pv.unavailable.map(x => '· ' + x).join('\n');
            body.appendChild(un);
          }
          if (pv.side.any) {
            const lab = document.createElement('label'); lab.className = 'ecck';
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
            lab.appendChild(cb);
            const parts = [];
            if (pv.side.hasQuality) parts.push('质量 ' + pv.side.qN + ' 台' + (pv.side.qualityOk ? '' : '（需 http 形态，本次跳过）'));
            if (pv.side.hasLs) parts.push('收听统计 ' + pv.side.lN + ' 天' + (http ? '' : '（写本地快照）'));
            lab.appendChild(document.createTextNode(' 一并恢复统计数据：' + parts.join(' + ') + '（覆盖本机对应数据；取消勾选则全部保持不变）'));
            body.appendChild(lab);
            scCb = cb;
          } else if (pv.side.hasQuality) { // 仅质量 sidecar 且 file://：无可恢复项，明示而非出无效勾选框
            const p = document.createElement('p'); p.className = 'ecsum';
            p.textContent = '备份含质量 sidecar，需 http 形态（npm start）才能恢复；本机数据保持不变。';
            body.appendChild(p);
          }
        } });
    } catch (_) { return; } // 确认层被占用（理论罕见）：放弃恢复，不打断既有弹窗
    if (v !== 'ok') return;
    const sc = !!(scCb && scCb.checked);
    this._restoreBusy = true; // submitting 态：入口禁用 + 按钮禁用换文案（预览按钮由 done 标记防连点）
    const btn = $('mRestore'), oldLabel = btn.textContent;
    btn.disabled = true; btn.textContent = '恢复中…';
    // 阶段三 commit（BackupV3.commitImport，AIbot P1-2 抽离可测）：先快照四件（Store + my-radio + 旧质量 +
    // 旧收听统计 sidecar——确认恢复即先读留存，无快照不提交），任一步失败整体回滚（sidecar 旧快照经各自通道
    // 尽力回写，二次失败文案如实点名）；取消在上一步 = 零副作用。io 注入真实现（fetch/localStorage/QualityStore/ListenStats）。
    const lsLocalRead = () => { try { const j = JSON.parse(localStorage.getItem('listenstats.local') || 'null'); return j && j.days && typeof j.days === 'object' ? j.days : {}; } catch (_) { return null; } };
    let r;
    try {
      r = await BackupV3.commitImport(info, sc, {
        http,
        storeSnap: () => { const s = {}; for (const k of Store.KEYS) s[k] = localStorage.getItem(k); return s; },
        storeApply: d => { for (const k of Store.KEYS) { if (d[k] != null) localStorage.setItem(k, d[k]); else localStorage.removeItem(k); } },
        storeFlush: async () => { await Store.flush(); return !Store.dirty; }, // 可等待可判定成功（AIbot 三轮 P1-1）：flush 后 dirty=false 才算落盘成功（file:// 恒成功）
        getMy: () => fetch('my-radio.txt?t=' + Date.now()).then(r => r.status === 404 ? '' : r.ok ? r.text() : null).catch(() => null), // 404=空列表合法；其余失败 null 中止（三轮 P2-1，不再误当空文件清掉 my-radio）
        postMy: lines => this.postMyRadio(lines),
        getQuality: () => fetch('/api/quality').then(r => r.json()).then(j => j && j.data && typeof j.data === 'object' && !Array.isArray(j.data) ? j.data : null).catch(() => null),
        postQuality: data => fetch('/api/quality', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replace: true, data }) })
          .then(x => x.json()).then(j => !!(j && j.ok)).catch(() => false),
        refreshQuality: () => { QualityStore.pend.length = 0; QualityStore.pull(); }, // 覆盖后缓存对齐服务端：丢弃未确认旧样本（导入=明确覆盖）再重拉
        getListenStats: () => http // 收听统计双形态：http 读服务端日桶、file:// 读本地快照（缺数据 = 空 days 合法快照；null 仅读失败）
          ? fetch('/api/listenstats').then(r => r.json()).then(j => j && j.days && typeof j.days === 'object' && !Array.isArray(j.days) ? j.days : null).catch(() => null)
          : Promise.resolve(lsLocalRead()),
        postListenStats: days => http // replace 覆盖通道（server B4：{replace:true,days}，与 quality 同纪律）
          ? fetch('/api/listenstats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replace: true, days }) })
              .then(x => x.json()).then(j => !!(j && j.ok)).catch(() => false)
          : new Promise(res => { try { localStorage.setItem('listenstats.local', JSON.stringify({ v: 1, days })); res(true); } catch (_) { res(false); } }),
        refreshListenStats: () => { ListenStats.pend.length = 0; ListenStats.dirty = false; ListenStats.pull(); }, // 同 refreshQuality 纪律：丢弃未确认旧增量（防重放复活旧账）再重拉
      });
    } catch (e) { // io 全兜错理论不抛；兜底仍如实报错并解除 submitting 态（finally 先于本 catch 执行）
      $('status').textContent = '恢复失败：' + (e && e.message || e);
      return;
    } finally { // 无论事务返回还是抛错，submitting 态一律解除
      this._restoreBusy = false;
      btn.disabled = false; btn.textContent = oldLabel;
    }
    if (r.ok) await this.afterRestore(info && info.my); // 恢复成功才即时生效（AIbot P1：Store 对账 + 主列表重拉重并，不触发自动播放）；my = 备份个人行兜底（见 afterRestore）
    $('status').textContent = r.msg; // 结果 = commitImport 的 r.msg 原样展示（成功/回滚/回滚失败文案在 backup.js 内如实区分）
    const title = r.ok ? '备份恢复完成'
      : r.msg.includes('已回滚') ? '恢复失败——已回滚到导入前状态' : '恢复失败——未提交（本机数据未改动）';
    const hint = r.ok ? '' : '\n\n既有恢复路径：用同一备份文件重新导入重试；如担心当前数据状态，可先「备份全部」导出保全。';
    uiChooseDialog(title, r.msg + hint, [{ value: 'x', label: '知道了' }], { safe: 'x' }).catch(() => {});
  },
  async afterRestore(myLines) { // 恢复成功的即时生效（AIbot P1，importAll r.ok 专用）：先 Store 对账重渲（收藏/配置/记忆，
    // 不触发自动播放），再主列表重拉重并——commitImport 已把备份的 my-radio.txt 全量替换落盘，applyServerStore
    // 不重读个人层，缺这步则恢复出的个人台要整页刷新才出现。reloadMain 仅 http（file:// 恒 false 协议门直返：
    // 该形态个人台本就不可恢复、commitImport 文案已明示）；拉不到主列表时 stations 停留在对账态，绝不清空。
    // myLines = 备份的个人电台行（truthy 才动缓存：v1 备份/字段缺失=不动 my-radio.txt，缓存亦不动）：磁盘确定
    // 就是它（postMy 刚落盘成功），先写 _myKeep——紧随的 reloadMain 若遇 my-radio.txt 瞬态拉取失败，按缓存兜底
    // 重并，刚恢复的个人台仍即时入列而非退回恢复前的旧个人层（AIbot PR#33 P1）
    if (myLines) this._myKeep = this.parse(myLines.join('\r\n'));
    this.applyServerStore();
    await this.reloadMain();
  },
  postMyRadio(lines) { // my-radio.txt 全量替换（备份恢复/歌单合并写共用）：返回是否成功；file:// 无后端恒 false
    if (!location.protocol.startsWith('http')) return Promise.resolve(false);
    return fetch('/api/myradio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }) })
      .then(r => r.json()).then(r => !!(r && r.ok)).catch(() => false);
  },

  /* —— 歌单多格式导入（r4/B4，PlaylistImport 解析 + 四桶预览 + my-radio 合并写）：新增/已知/重复/非法四桶；
     已知台（库内或已在个人列表）不重复入库——收藏恢复走既有 header「导入列表」的 #VRADIO:FAV 通道；
     新台按分类合并进 my-radio.txt（读-改-写：GET 文本 → 内存查重合并 → POST /api/myradio 全量替换）；
     file:// 无后端时明确提示不可批量入库。取消 = 零副作用 —— */
  async importPlaylist(text, fname) {
    const list = PlaylistImport.parse(text, { format: fname });
    const inv = list.invalid, dup = list.dups, fmt = list.format;
    if (!list.length && !inv && !dup) { $('status').textContent = `导入失败：未解析到任何电台（识别为 ${fmt} 格式）`; return; }
    const known = new Set();
    for (const s of this.state.stations) for (const u of s.u) known.add(u);
    const http = location.protocol.startsWith('http');
    let myLines = [];
    if (http) {
      // 拉取失败必须中止（null ≠ 空文件）：合并写是全量替换，拿不到现有行就贸然 POST 会清掉既有个人电台
      const t = await fetch('my-radio.txt?t=' + Date.now()).then(r => r.ok ? r.text() : '').catch(() => null);
      if (t === null) { $('status').textContent = '导入失败：无法读取当前个人电台列表，请重试'; return; }
      myLines = t.split(/\r?\n/).filter(l => l.trim());
    }
    for (const l of myLines) { const u = l.slice(l.lastIndexOf(',') + 1).trim(); if (/^https?:\/\//.test(u)) known.add(u); }
    const fresh = list.filter(e => !known.has(e.url));
    const knownN = list.length - fresh.length;
    if (!fresh.length) { $('status').textContent = `导入完成：${list.length} 条均为已知电台（重复 ${dup}、地址不合法 ${inv}），未写入`; return; }
    const cats = [...new Set(fresh.map(e => e.category))].slice(0, 3).join('/');
    const sample = fresh.slice(0, 3).map(e => e.name).join('、') + (fresh.length > 3 ? ' 等' : '');
    if (!confirm(`识别为 ${fmt} 格式，共解析 ${list.length} 条：\n新增 ${fresh.length}（${sample}）· 已知 ${knownN} · 文件内重复 ${dup} · 地址不合法 ${inv}\n\n新增电台将按「${cats}」分类写入个人列表 my-radio.txt（同步不覆盖），已知电台不重复入库；导入后建议跑一次「体检」验证可用性。继续？`)) return;
    if (!http) { $('status').textContent = 'file:// 降级模式无后端，无法写入个人列表——npm start 后再导入'; return; }
    const merged = this.mergeMyRadio(myLines, fresh);
    if (!await this.postMyRadio(merged.lines)) { $('status').textContent = '导入失败：个人列表写入失败（my-radio.txt）'; return; }
    await this.reloadMain(); // 重拉重并：新台入列表（个人层常驻）
    $('status').textContent = `已导入 ${merged.added} 台到个人列表（${fmt}：新增 ${merged.added}、已知 ${knownN}、重复 ${dup}、不合法 ${inv}）——可跑「体检」验证可用性`;
  },
  mergeMyRadio(lines, entries) { // 内存合并（server.js myStationWrite 同款插入算法）：分类节内插入/尾部开节，URL 查重，500 行/64KB 封顶
    const out = lines.slice();
    let added = 0;
    for (const e of entries) {
      if (out.length >= 500 || out.join('\r\n').length >= 65536) break; // 封顶后剩余丢弃（与 /api/myradio 同护栏）
      if (out.some(l => l.trim().endsWith(',' + e.url))) continue; // 同 URL 换名也不双开（装配按键合并会出两行）
      const head = e.category + ',#genre#';
      const at = out.findIndex(l => l.trim() === head);
      if (at >= 0) out.splice(at + 1, 0, `${e.name},${e.url}`); // 已有该分类节：节内插入
      else out.push('', head, `${e.name},${e.url}`); // 新分类：尾部开节（空行分隔）
      added++;
    }
    return { lines: out, added };
  },

  boot() {
    // 桌面新版壳总开关（ui-redesign P2/§6.6）：FEATURES.uiRefresh 默认关——类不挂，页面与旧版完全一致。
    // 开启后 ≥1024px 走 dashboard 壳（样式全在 html.ui-refresh + @media 内），断点内随窗口宽度换排布不重建状态
    document.documentElement.classList.toggle('ui-refresh', !!(window.FEATURES && window.FEATURES.uiRefresh));
    Store.init(); // 存储收敛层（方案二）：BC 监听 + 关页 flush 兜底，须在 Player.init 读记忆之前
    QualityStore.init(); // 质量侧车（B2）：BC('quality') 他页重拉 + 关页 flush；load() 异步随行
    // B3 曲讯管线（元数据事件唯一通路，sink 二选一）：metaV2 装载时定格——发布配置非用户数据，切页不重读。
    // dedup30s 随 flag（AIbot P1-2）：关 = B2 前入史语义（换歌一律入史，无 30s 窗）；开 = 契约 30s 窗去重
    this.metaV2 = !!(window.FEATURES && FEATURES.metadataV2);
    this.metaPipe = Metadata.mpCreate({ dedup30s: this.metaV2 });
    this.metaLast = null;
    // B3-B 收听统计：开关开才 init（装载快照 + 定时/隐藏/关页 flush + 多标签重拉）；关 = 不消费不 flush、不清已有数据
    if (FEATURES.listenStats) ListenStats.init().catch(() => {});
    this.loadStore();
    this.loadRevives(); // B3：「最近恢复」运行时缓存（discovery.revives，非 radio.*，7 天过期）
    this.qualityKeep(); // trim 保护集（收藏+最近身份 URL ≤64；rebind 随行刷新）
    localStorage.removeItem('radio.epg'); // 节目单（EPG）功能已移除：顺手清掉旧版留下的缓存（不存在则 no-op）
    // 音量持久化（读取夹取 0-100，坏值回退 90）
    const savedVol = Store.get('radio.vol'), vol0 = +savedVol;
    const vol = savedVol !== null && Number.isFinite(vol0) && vol0 >= 0 && vol0 <= 100 ? vol0 : 90;
    $('vol').value = vol;
    Player.init($('audio'), vol / 100);

    // Player 状态回调：full=true 需整表重渲（行高亮/连接中变化），否则只轻量更新底部。
    // renderHero 随行（P2）：pause 走 full=false 不整表重渲，续听卡按钮文案也要跟上（签名未变时零开销）
    Player.onstate = full => { this.playerNow(); this.renderHero(); if (full) this.render(); if (FEATURES.listenStats) this.lsState(); };
    // 真实播放阶段通知（P3/§6.10）：Player 只发布只读 phase（固定枚举），app 投影唱片旋转/续听卡按钮——
    // 与 onstate/onqos 各走各的回调互不覆盖；页面可见性/系统减动效变化时旋转类就地重算（§6.10）
    Player.onphase = (ph, s) => this.onPhase(ph, s);
    document.addEventListener('visibilitychange', () => this.syncVinyl());
    this.reduceMq = matchMedia('(prefers-reduced-motion: reduce)');
    if (this.reduceMq.addEventListener) this.reduceMq.addEventListener('change', () => this.syncVinyl());
    else if (this.reduceMq.addListener) this.reduceMq.addListener(() => this.syncVinyl()); // 旧实现兜底（uiPlaceTheme 同款）
    Player.onstatus = t => { $('status').textContent = t; };
    Player.onfail = () => { this.showLast(); if (FEATURES.listenStats) ListenStats.onState('FAILED'); }; // 全部源失败：曲讯/统计一并收口
    Player.onlogo = s => Logos.get(s); // 锁屏 artwork 台标（r2 ⑩）：同步窥探绝不发请求，无台标回空数组静默缺省
    Player.onstepfav = d => this.stepFav(d); // 锁屏/媒体键 ⏮⏭ = 收藏间切台（r2 ①）：无收藏时 stepFav 自身走状态栏提示
    Player.onqos = ev => { // 播放质量样本（B2）：Player 只发状态机原始转换，trigger 映射在此完成；
      this.qosMap(ev); //  B3-B：phase='playing'（新建流到达）= 收听统计 session 建立（诊断成功不算收听）
      if (FEATURES.listenStats && ev.phase === 'playing') ListenStats.enterPlaying(ev.station, ev.station && ev.station.u[ev.si]);
    };
    // 质量侧车装载（异步，不阻塞首屏）：详情中心质量摘要/发现侧数据源；装载后补渲染一次打开中的详情
    QualityStore.load().then(() => { this.qualityKeep(); if (!$('detail').hidden) this.renderDetail(); }).catch(() => {});
    if (location.protocol.startsWith('http')) fetch('/api/boot').then(r => r.json()).then(b => { // 启动资产状态（§13.3）：不完整不静默混态
      if (b && b.ok === false) this.toast('数据资产不完整（' + (b.missing || []).join('、') + '），请运行 npm run sync', { ms: 8000 });
    }).catch(() => {});
    // 睡眠定时（E2 + UI 审计 P3-7）：菜单一次点选 15/30/60（循环模式要点三下才到 60）；进行中点击按钮直接取消
    $('sleepBtn').onclick = () => {
      if (Player.sleepId) { Player.sleep(0); return; }
      const m = $('sleepMenu');
      m.hidden = !m.hidden;
      if (!m.hidden) m.querySelector('button')?.focus();
    };
    $('sleepMenu').onclick = e => {
      const b = e.target.closest('[data-min]'); if (!b) return;
      $('sleepMenu').hidden = true; Player.sleep(+b.dataset.min);
    };
    document.addEventListener('click', e => { if (!e.target.closest('#sleepWrap')) $('sleepMenu').hidden = true; });
    // footer 选源浮层（②a）：正在听的多源台一键切源（一律立即起播，暂停态同）；行点击 = 用此源播放，底部 = 恢复默认
    $('srcBtn').onclick = () => {
      if (!$('srcMenu').hidden) { this.srcPopClose(); return; }
      this.renderSrcPop();
    };
    $('srcMenu').onclick = e => {
      const row = e.target.closest('[data-i]');
      if (row) { const s = Player.station; this.srcPopClose(); if (s) this.startPlay(s, +row.dataset.i); return; }
      if (e.target.closest('[data-act="srcreset"]')) { this.srcPopClose(); this.srcReset(); }
    };
    document.addEventListener('click', e => { if (!e.target.closest('#srcWrap')) this.srcPopClose(); });
    // 详情中心（B1，plan-expansion-r4 §5.3）：footer ⓘ 按钮 = 正在播台的详情入口（台名行保留「回到正在播」
    // 既有语义 N5/r2 ⑦，不抢点）；浮层内动作统一委托（Esc/点遮罩关闭在全局键盘与下方 onclick）
    $('detailBtn').onclick = () => { if (Player.station) this.openDetail(Player.station); };
    $('detail').onclick = e => {
      if (e.target === $('detail')) return this.mDepart(() => { this.mEditorEnd(); this.closeDetail(); }); // 点遮罩关闭（有待保存草稿先三选）
      const b = e.target.closest('[data-act]'); if (!b) return;
      const s = this.detailStation(); if (!s) return;
      const i = +b.dataset.i, act = b.dataset.act; // i 是 dSrcRows 行序（草稿集合空间，review-r2 P1）
      const u = this.dSrcRows(s).urls[i];
      if (act === 'dCopy') { if (u) this.copySource(u); }
      else if (act === 'dPlay') { // 试听=立即动作；有待保存源先三选（§6.9）。播放/诊断按 URL 回落 s.u 装配下标
        const si = u ? s.u.indexOf(u) : -1; // 待保存追加未入 s.u：行内本就无 ▶，此处兜底
        if (si >= 0) this.mDepart(() => this.playSource(s, si));
      }
      else if (act === 'dRecheck') { const si = u ? s.u.indexOf(u) : -1; if (si >= 0) this.recheckSource(s, si); }
      else if (act === 'dAll') this.checkStationSources(s);
      else if (act === 'dDis' || act === 'dUndis') this.mSrcDetailOp(s, i, act === 'dDis' ? 'dis' : 'undis'); // 启停 → 本台源草稿（§6.9 共用编辑器）
      else if (act === 'dUp') this.mSrcDetailOp(s, i, 'up');
      else if (act === 'dDown') this.mSrcDetailOp(s, i, 'down');
      else if (act === 'dLabel') this.mSrcDetailOp(s, i, 'label');
      else if (act === 'dResetMem') this.resetSrcDefaults(s); // 立即动作（只清源记忆）不变
      else if (act === 'dClearOrder') this.mSrcDetailOp(s, -1, 'clrorder'); // 撤销人工排序 → 草稿（§6.9 草稿化裁量）
    };
    $('dClose').onclick = () => this.mDepart(() => { this.mEditorEnd(); this.closeDetail(); });
    // 发现页（B3-C）：header「发现」入口（features.discovery 关时隐藏——发布配置非用户数据）；行点击统一 startPlay→Player.play
    $('discBtn').hidden = !FEATURES.discovery;
    $('discBtn').onclick = () => this.openDiscovery();
    $('discClose').onclick = () => this.closeDiscovery();
    $('discovery').onclick = e => {
      if (e.target === $('discovery')) return this.closeDiscovery(); // 点遮罩关闭
      const b = e.target.closest('[data-k]'); if (!b) return;
      this.closeDiscovery();
      const s = this.state.stations.find(x => keyOf(x) === b.dataset.k);
      if (s) this.startPlay(s);
    };
    Player.ontick = ms => {
      const b = $('sleepBtn'), lab = $('sleepLab');
      if (ms > 0) { const s = Math.ceil(ms / 1000); lab.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); b.title = '睡眠定时进行中，点击取消'; }
      else { lab.textContent = ''; b.title = '睡眠定时：点击选择时长'; }
    };

    // 曲讯轮询（B-6）：15s 常驻轮（条件不满足时空转不发包）；页面重新可见时立刻补一轮
    setInterval(() => this.tickSong(), 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.tickSong(); });
    // toast 悬停/焦点延长（§5.4）：撤销按钮区域停留时暂停倒计时，离开按剩余时限恢复
    for (const ev of ['mouseenter', 'focusin']) $('toast').addEventListener(ev, () => this.toastPause());
    for (const ev of ['mouseleave', 'focusout']) $('toast').addEventListener(ev, () => this.toastResume());
    // 歌曲历史浮层（B-7）：点曲名行开关；点别处收起
    $('song').onclick = () => this.toggleSongHist();
    // 快捷键帮助（N8/r2 ⑧）：? 呼出，Esc/点外关闭，焦点归还呼出点；与歌曲历史浮层互斥（AIbot P3-3）
    const keysOpen = () => { this.kOpener = document.activeElement; $('songhist').hidden = true; $('keys').hidden = false; $('keys').focus(); };
    const keysClose = () => {
      if ($('keys').hidden) return;
      $('keys').hidden = true;
      const b = this.kOpener && this.kOpener.isConnected ? this.kOpener : null;
      if (b && b.focus) b.focus();
    };
    document.addEventListener('click', e => { if (!e.target.closest('#songhist,#song,#keys')) { $('songhist').hidden = true; keysClose(); } });
    // footer 台名可点（N5/r2 ⑦）：回到正在播行并高亮一闪
    $('nowline').onclick = () => this.locatePlaying();
    // 键盘可达（audit-r2 P3-2）：#nowline/#song 是可点 div（index.html 已补 role=button+tabindex），Enter/Space 接同款动作
    const keyAct = (id, fn) => $(id).addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
    keyAct('nowline', () => this.locatePlaying());
    keyAct('song', () => this.toggleSongHist());

    // 搜索：120ms 防抖，避免 1600+ 行列表每键整表重渲；Esc 清空；任意位置按 / 聚焦；↓ 接力列表首行（P2-5）
    let timer = 0;
    $('q').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { this.state.keyword = e.target.value.trim(); this.render(); }, 120); };
    $('q').onkeydown = e => {
      if (e.key === 'Escape') { e.target.value = ''; clearTimeout(timer); this.state.keyword = ''; this.render(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.focusRow(0); }
    };
    document.addEventListener('keydown', e => { // 全局快捷键（A-5）：/ 聚焦搜索、空格 播放/暂停、←/→ 收藏间切台
      if (e.ctrlKey || e.altKey || e.metaKey) return; // 不抢组合键（Ctrl+/ 等）
      const t = e.target, tag = t && t.tagName;
      // 焦点在交互件/列表行/维护面板/歌曲浮层/快捷键浮层/footer 两可点行上：让位原生行为（行内 Enter/Space 已有处理、面板有自己的 Esc 语义、按钮空格原生触发 click）。
      // #keys 进让位（AIbot P3-4）：dialog 持焦点时空格/←/→ 不再直控播放（与 songhist 口径一致）；关浮层走 Esc/点外（cheatsheet 自述）；
      // #nowline/#song 进让位（audit-r2 P3-2）：焦点移入后空格触发自身动作（回到正在播/歌曲历史），不再直控播放
      if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag) || t.isContentEditable || (t.closest && t.closest('#list,#manage,#songhist,#keys,#nowline,#song'))) return;
      if (e.key === '/') { e.preventDefault(); $('q').focus(); return; }
      if (e.key === '?') { e.preventDefault(); $('keys').hidden ? keysOpen() : keysClose(); return; } // cheatsheet（N8）
      if (e.key === ' ') { e.preventDefault(); $('pp').click(); return; }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); this.doRefresh(); return; } // 刷新回直播头（plan-refresh-live §3.2）
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); this.stepFav(e.key === 'ArrowRight' ? 1 : -1); }
    });

    // 分类与列表（行/卡片可用键盘操作：Enter/Space 播放；收藏按钮由原生 button 处理）
    $('cats').addEventListener('scroll', () => this.updateCatsFade(), { passive:true }); // 分类条渐隐随滚动切换（P3-5）
    addEventListener('resize', () => this.updateCatsFade());
    // 分类条点击（§3.2 单一筛选状态统一入口）：★收藏/最近/全部 哨兵 chip 转 scope（绝不写进 cat），真实分类只改 cat
    $('cats').onclick = e => {
      const c = e.target.closest('.chip'); if (!c) return;
      const v = c.dataset.c;
      if (v === '★收藏') this.setScope('favorites');
      else if (v === '最近') this.setScope('recent');
      else if (v === '全部') this.setScope('all');
      else this.setCategory(v);
    };
    $('list').onclick = e => {
      if (this._lpSup) { this._lpSup = false; return; } // 长按触发后的合成 click 吞一次（review P3-3）：「长按只收藏不播放」从依赖目标脱离的未规范行为变为显式保证
      if (e.detail > 1) return; // 双击的第二次 click 跳过（audit-r2 四-2）：否则「点播→再点暂停」，由 ondblclick 统一收口收藏
      const act = e.target.closest('[data-act]'); // 空态动作（§6.2）：qclear 清词保 scope/cat、qall 解除范围保词
      if (act && act.dataset.act === 'qclear') { this.state.keyword = ''; $('q').value = ''; this.render(); return; }
      if (act && act.dataset.act === 'qall') return this.searchEverywhere();
      const fav = e.target.closest('.fav');
      if (fav && !fav.classList.contains('dmore')) {
        const s = this.state.stations.find(x => keyOf(x) === fav.dataset.fav);
        if (s) this.toggleFav(s);
        return;
      }
      const more = e.target.closest('.dmore'); // 详情入口（B1）：行/卡「ⓘ」按钮，先于行点播判定
      if (more) {
        const s = this.state.stations.find(x => keyOf(x) === more.dataset.more);
        if (s) this.openDetail(s);
        return;
      }
      const row = e.target.closest('.row,.card');
      if (row) { this._clickK = row.dataset.k; this.togglePlay(row.dataset.k); } // 记首击对象（review P2-A）：「最近」视图首击即 remember 重排队首+整表重渲，第二次击的坐标已换台——双击收藏锚定首击 key，对重排免疫
    };
    // 双击行收藏（audit-r2 拍板四-2）：单击已起播、双击补收藏 = 「播放并收藏」——刻意不做单击延迟消歧（伤点播主路径）；
    // 收藏钮自身不参与（它的 click 有独立处理）；cheatsheet/README 已同步该手势。
    // 双击必以 detail=1 的首击为前提、首击必已记 _clickK——收藏按首击 key 解析而非坐标 hit-test（review P2-A：
    // 「最近」首击重排后同坐标已是别台行，按坐标会把收藏落在别的台上）
    $('list').ondblclick = e => {
      if (e.target.closest('.fav, .dmore')) return; // dmore 是按钮不参与双击收藏（B1）
      if (!this._clickK) return;
      const s = this.state.stations.find(x => keyOf(x) === this._clickK);
      if (s) this.toggleFav(s);
    };
    // 移动端长按行收藏（audit-r2 拍板四-2）：500ms 计时，位移超 10px（滚动/手势）或抬手即取消；
    // touch-action:manipulation 已关双击缩放（index.html），双击/长按两手势互不抢。
    // stamp 作废（review P2-B）：按压窗口内穿插过任何整表重渲（台标落库/体检回调/他标签对账）即放弃本次长按——
    // 重渲后旧行节点脱离文档，touch 事件 target 已锁定旧节点、冒泡不到 list，touchend 的 lpOff 会漏取消、计时器带出误收藏
    {
      let lpT = 0, lpx = 0, lpy = 0;
      const lpOff = () => { if (lpT) { clearTimeout(lpT); lpT = 0; } };
      $('list').addEventListener('touchstart', e => {
        lpOff();
        if (e.target.closest('.fav, .dmore')) return; // 行内按钮（收藏/详情）自带点击语义，不进长按手势（B1 补 dmore）
        const row = e.target.closest('.row,.card'); if (!row) return;
        const t = e.touches[0], stamp = this.state.stamp;
        lpx = t.clientX; lpy = t.clientY;
        lpT = setTimeout(() => {
          lpT = 0;
          if (stamp !== this.state.stamp) return; // 窗口内发生过重渲：目标行已被替换/位移，放弃（保守侧，误放弃好过误收藏）
          this._lpSup = true; setTimeout(() => { this._lpSup = false; }, 300); // 吞随后的合成 click，300ms 自清防误吞下一次正常点按（review P3-3）
          const s = this.state.stations.find(x => keyOf(x) === row.dataset.k);
          if (s) this.toggleFav(s);
        }, 500);
      }, { passive: true });
      $('list').addEventListener('touchmove', e => { // 位移超阈值视为手势，取消长按
        if (!lpT) return;
        const t = e.touches[0];
        if (Math.hypot(t.clientX - lpx, t.clientY - lpy) > 10) lpOff();
      }, { passive: true });
      $('list').addEventListener('touchend', lpOff);
      $('list').addEventListener('touchcancel', lpOff);
    }
    $('list').onkeydown = e => { // Enter/Space 播放 + ↑↓/Home/End 方向键导航（UI 审计 P2-5）
      const row = e.target.closest && e.target.closest('.row,.card');
      if (!row || e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.togglePlay(row.dataset.k); return; }
      const n = this.visible().length, cur = +row.dataset.i; let to = -1;
      if (e.key === 'ArrowDown') to = Math.min(n - 1, cur + 1);
      else if (e.key === 'ArrowUp') to = Math.max(0, cur - 1);
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = n - 1;
      if (to < 0 || to === cur) return;
      e.preventDefault(); this.focusRow(to);
    };

    // 视图切换（网格=精简卡片 / 列表=两行详情）与无效源显隐/主题，均持久化到 localStorage——
    // 读取与 DOM 同步统一走 loadUi3（与他页 Store 对账联动共用，audit C4），交互入口只改 state 再点对刷新
    const setView = v => { if (this.state.view === v) return; this.state.view = v; Store.set('radio.view', v); this.syncViewUI(); this.swapRender(); };
    $('gridBtn').onclick = () => setView('grid');
    $('listBtn').onclick = () => setView('list');
    $('deadBtn').onclick = () => { this.state.showDead = !this.state.showDead; Store.set('radio.showdead', this.state.showDead ? '1' : '0'); this.syncDeadUI(); this.render(); };
    // 主题：三选菜单（§6.11/Q25 拍板，替代旧循环切换）——点选写 radio.theme + syncThemeUI，Esc/点外关闭；
    // 生效值写 <html data-theme>，浅色变量只认它（auto 由 matchMedia 实时换算，系统切换即时跟随）
    this.mq = matchMedia('(prefers-color-scheme: light)');
    $('themeBtn').onclick = () => {
      const m = $('themeMenu');
      m.hidden = !m.hidden;
      $('themeBtn').setAttribute('aria-expanded', String(!m.hidden));
      if (!m.hidden) m.querySelector('button')?.focus();
    };
    $('themeMenu').onclick = e => {
      const b = e.target.closest('[data-theme-v]'); if (!b) return;
      this.themeMenuClose();
      this.state.theme = b.dataset.themeV; Store.set('radio.theme', this.state.theme); this.syncThemeUI();
    };
    document.addEventListener('click', e => { if (!e.target.closest('#themeWrap')) this.themeMenuClose(); }); // 点外收起（themeWrap 内点选不双关）
    // 主题入口断点收纳（§6.11）：≤640px 收进 lowfreq（「⋯ 更多」内、显示「主题：xx」文字）、更宽回顶栏原锚点；
    // 同一节点搬家不复制 id；销毁函数留底（P2 桌面壳接管时用）
    this._placeThemeOff = uiPlaceTheme($('themeWrap'), document.querySelector('header'), $('file'), $('lowfreq'));
    this.mq.addEventListener('change', () => { if (this.state.theme === 'auto') this.syncThemeUI(); });
    this.loadUi3();

    // 维护面板（⚙）：个人分类/电台调整，全部落 radio.cfg（localStorage），同步重跑后按 URL 回绑自动复用
    this.loadCfg();
    // file:// 降级模式（reloadMain 必失败）下 stations 停留在 STARTER、不走 applySources 的留底循环——
    // 此处补快照，否则维护面板「电台」页读 s.dName 直接抛错（渲染处另有 || 兜底双保险）；srcLife 同补（B1）
    for (const s of this.state.stations) { if (s.dCat === undefined) { s.dCat = s.c; s.dName = s.n; s.dU = s.u.slice(); this.srcLife(s); } }
    // 逐对象编辑器（P4 §6.8 接线）：io 全显式注入；render 适配器 = renderEditor；草稿只在内存不持久化
    this.mEditor = uiCreateEditor({
      resolve: (id, kind, hintKey) => kind === 'cat' ? this.mCatResolve(id) : uiResolveUnique(this.state.stations, id, hintKey),
      readCfg: () => this.cfg,
      project: (cfg, subj, kind) => kind === 'cat' ? uiCatProjection(cfg, subj) : kind === 'src' ? uiSrcProjection(cfg, subj) : uiStationProjection(cfg, subj),
      newPatch: kind => kind === 'src' ? { manual: null, disabled: null, labels: {}, appends: [], removes: [] } : {},
      dirtyOf: (p, base) => 'manual' in p // src 补丁是结构化对象；st/cat 补丁以「有无键」论脏
        ? p.manual !== null || p.disabled !== null || Object.keys(p.labels).some(u => (base.labels[u] || '') !== p.labels[u]) || p.appends.length > 0 || p.removes.length > 0
        : Object.keys(p).length > 0,
      fields: kind => kind === 'st' ? ['name', 'category', 'hidden'] : kind === 'cat' ? ['name', 'hidden'] : [],
      validate: (subj, patch, latest, kind) => this.mValidate(subj, patch, latest, kind),
      buildNext: (latest, subj, patch, base, force, kind) => kind === 'cat' ? uiBuildCatNext(latest, subj.orig, patch, base, force, name => this.mCatOptions().includes(name))
        : kind === 'src' ? uiBuildSrcNext(latest, subj, patch, base, force)
        : uiBuildStationNext(latest, subj, patch, base, force),
      beforeCommit: (subj, draft, latest) => this.mBeforeCommit(subj, draft, latest),
      commit: (next, draft, subj) => this.mCommit(next, draft, subj),
      hint: subj => (subj && subj.u && subj.n && subj.c !== undefined) ? keyOf(subj) : '', // 保存后重算锚点（改名跟随）
      render: (d, saving) => this.mEditorPaint(d, saving), // 重绘出口统一走 mEditorPaint（AIbot P2：详情源行随草稿实时重绘）
      confirmLeave: draft => this.mDialogLeave(draft),
      confirmConflict: draft => this.mDialogConflict(draft),
    });
    // 编辑区事件委托（#mEdit/#dEdit 共用一套）：字段 input/change → editor.change；保存/取消/重载；
    // 源草稿动作（data-sact）与源标签输入（data-lu）→ 草稿 mutate；追加输入 Enter 触发探活
    for (const hostId of ['mEdit', 'dEdit']) {
      const h = $(hostId);
      h.addEventListener('input', e => {
        const el = e.target;
        if (el.dataset && el.dataset.lu != null) return void this.mSrcLabelInput(el.dataset.lu, el.value); // 源标签逐键入草稿
        if (el.matches && el.matches('.msrc-add input')) { this.mSrcVal = el.value; return; } // 追加输入跨重渲保留（同 mq 做法）
        if (el.dataset && el.dataset.f && el.type !== 'checkbox') this.mEditor.change(el.dataset.f, el.value); // 逐键入补丁（值回基线自动撤键）
      });
      h.addEventListener('change', e => {
        const el = e.target;
        if (el.dataset && el.dataset.f && (el.type === 'checkbox' || el.tagName === 'SELECT')) this.mEditor.change(el.dataset.f, el.type === 'checkbox' ? el.checked : el.value);
      });
      h.addEventListener('keydown', e => { // 追加输入 Enter 直接触发探活（与添加电台表单同口径）
        if (e.key === 'Enter' && e.target.matches && e.target.matches('.msrc-add input')) {
          e.preventDefault();
          const b2 = e.target.closest('.msrc-add').querySelector('[data-sact="srcadd"]');
          if (b2 && !b2.disabled) b2.click();
        }
      });
      h.onclick = e => {
        const eb = e.target.closest('[data-eact]');
        if (eb) {
          const a = eb.dataset.eact;
          if (a === 'save') this.mEditor.save();
          else if (a === 'cancel') this.mEditorEnd(); // 取消 = 丢弃本对象草稿回浏览（§5.3，显式取消不再确认）
          else if (a === 'reload') { const d = this.mEditor.getDraft(); try { this.mEditor.begin(d.identityUrl, d.kind, d.hintKey); } catch (err) { $('status').textContent = err.message; } }
          else if (a === 'srcmemclr') { const s = this.mEditorStation(); if (s) this.resetSrcDefaults(s); } // 立即动作（只清源记忆，不入草稿）
          else if (a === 'strestore') { // §5.4「恢复名称与分类」：独立恢复动作，先过草稿门（当前草稿可能同名冲突）
            const d = this.mEditor.getDraft();
            try { const st = uiResolveUnique(this.state.stations, d.identityUrl, d.hintKey); this.mDepart(() => this.mRestoreNameCat(st)); }
            catch (err) { $('status').textContent = err.message; }
          }
          return;
        }
        const sb = e.target.closest('[data-sact]');
        if (!sb) return;
        const s = this.mEditorStation(); if (!s) return;
        const op = sb.dataset.sact;
        if (op === 'up') this.mSrcMove(s, +sb.dataset.i, -1);
        else if (op === 'down') this.mSrcMove(s, +sb.dataset.i, 1);
        else if (op === 'dis' || op === 'undis') this.mSrcToggleDis(s, +sb.dataset.i);
        else if (op === 'rm') this.mSrcRemoveAppend(s, sb.dataset.u);
        else if (op === 'srcadd') this.mSrcProbe(s, sb);
        else if (op === 'play') { // 试听=立即动作；有待保存源先三选（§5.2/§6.9）。data-i 是草稿集合下标，
          const u = this.mSrcEffective(s, this.mEditor.getDraft().patch).urls[+sb.dataset.i]; // 待保存追加未入 s.u：行内本就无 ▶，
          const si = u ? s.u.indexOf(u) : -1; // 有 ▶ 的行按 URL 回落装配下标（草稿序与 s.u 下标不同空间，review-r2 P1）
          if (si >= 0) this.mDepart(() => this.playSource(s, si));
        }
      };
    }
    $('manageBtn').onclick = () => this.manageOpen();
    $('mClose').onclick = () => this.manageClose(); // 离开流程内嵌（dirty 三选）
    $('manage').onclick = e => { if (e.target === $('manage')) this.manageClose(); }; // 点遮罩关闭
    document.addEventListener('keydown', e => { // Esc 关面板（焦点在输入框/下拉里时不抢，让它们先清自身）+ 收起浮层菜单。
      // Esc 链（ui-redesign §5.1/P4）：确认弹窗（editorConfirm，自身 Esc=继续编辑/取消，capture 已 stopPropagation）
      // → 快捷键浮层 → #detail → #discover → #manage → 浮层菜单——确认层开着时一律不下传，嵌套确认不误关父面板
      if (e.key === 'Escape') {
        if (!$('editorConfirm').hidden) return; // 最上层是确认弹窗：由 uiChooseDialog 的 capture 分支收口
        keysClose(); // 快捷键浮层（N8）
        // 编辑区内 Esc = 进入离开确认（§2.3/§5.3：未保存草稿时 Esc → 三选，stay 回原输入）；mq 搜索框自清不在此列
        const ae = document.activeElement;
        const inDetailEdit = !!(ae && $('dEdit').contains(ae)), inManageEdit = !!(ae && $('mEdit').contains(ae));
        if (!$('detail').hidden && (inDetailEdit || !/^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName))) this.mDepart(() => { this.mEditorEnd(); this.closeDetail(); }); // 详情中心（B1 + P4 草稿门）
        if (!$('discovery').hidden && !/^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) this.closeDiscovery(); // 发现页（B3）
        if (!$('manage').hidden && (inManageEdit || !/^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName))) this.manageClose();
        $('lowfreq').classList.remove('open'); $('moreBtn').setAttribute('aria-expanded', 'false');
        $('sleepMenu').hidden = true;
        this.themeMenuClose(); // 主题三选菜单（§6.11）：Esc 收起 + 焦点归还
        this.srcPopClose(); // 选源浮层（AIbot P2-1）：Esc 收起 + 焦点归还，与 ? 帮助的 Esc 自述一致
        this.sideToolsClose(); // 更多工具 popover（P2 桌面壳）：Esc 收起 + 焦点归还
        $('namett').hidden = true; // 长名提示单例（P3/§4.2）：Esc 可关
      }
      if (e.key === 'Tab' && (!$('editorConfirm').hidden || !$('manage').hidden || !$('detail').hidden || !$('discovery').hidden)) { // 焦点困在最上层弹窗内（UI 审计 P2-7）：确认弹窗优先（最上层只困确认层）
        const dlg = !$('editorConfirm').hidden ? $('editorConfirm') : !$('manage').hidden ? $('manage') : !$('detail').hidden ? $('detail') : $('discovery');
        const f = [...dlg.querySelectorAll('button,input,select')].filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    // 更多菜单（UI 审计 P2-6）：≤640px 收纳低频操作；桌面由 CSS display:contents 原样排布，按钮不可见
    $('moreBtn').onclick = e => {
      e.stopPropagation();
      const on = $('lowfreq').classList.toggle('open');
      $('moreBtn').setAttribute('aria-expanded', String(on));
    };
    $('lowfreq').addEventListener('click', e => { // 点操作项后收起（themeWrap 除外：它弹自己的三选菜单，面板收起会把菜单藏没）
      if (e.target.closest('#themeWrap')) return;
      if (e.target.closest('.btn')) { $('lowfreq').classList.remove('open'); $('moreBtn').setAttribute('aria-expanded', 'false'); }
    });
    document.addEventListener('click', e => {
      if ($('lowfreq').classList.contains('open') && !e.target.closest('#lowfreq,#moreBtn')) { $('lowfreq').classList.remove('open'); $('moreBtn').setAttribute('aria-expanded', 'false'); }
    });

    // —— 桌面壳接线（ui-redesign P2/§6.6，开关开才装配；全部绑定一次，render 不重复挂）——
    // ≥1024px：#lowfreq 搬进侧栏 #sideTools popover（同步/体检/导入/导出/发现行为不变，只是宿主变了）、
    // 侧栏接管范围导航与维护入口、--dock-h 实测 footer 占位。开关关：整块跳过，紧凑布局原样
    if (document.documentElement.classList.contains('ui-refresh')) {
      $('scopeTitle').hidden = false; // 显隐改由 CSS 断点接管（紧凑态 display:none，§6.5 骨架）
      $('sideTools').hidden = false;  // popover 宿主此后由 .open 类控显隐（首屏 hidden 仅防未装配闪现）
      this._placeToolsOff = uiPlaceTools($('lowfreq'), $('sideTools'), $('moreBtn')); // ≥1024 收纳 #lowfreq（节点唯一，监听随节点走）
      this._dockOff = uiWatchDock(document.querySelector('footer')); // 实际 footer 高度 → --dock-h（main 占位/scroll-padding）
      addEventListener('pagehide', () => { if (this._dockOff) this._dockOff(); if (this._placeToolsOff) this._placeToolsOff(); });
      document.querySelector('.desktop-sidebar').addEventListener('click', e => { // 范围/维护入口（容器级委托，单绑）
        const b = e.target.closest('[data-scope]');
        if (b) { this.setScope(b.dataset.scope); return; }
        if (e.target.closest('#sideManage')) this.manageOpen();
      });
      $('sideMore').onclick = () => this.sideToolsToggle();
      $('sideTools').addEventListener('click', e => { if (e.target.closest('.btn')) this.sideToolsClose(); }); // 点操作项即收（动作照常执行）；themeWrap 断点收纳后不进 sideTools，无特例
      document.addEventListener('click', e => { if (!e.target.closest('#sideTools,#sideMore')) this.sideToolsClose(); }); // 点外收起（compact 的 lowfreq closer 不覆盖侧栏态，补此条）
      $('resumeHero').addEventListener('click', e => { // 续听卡委托（§3.3）：点击时按 URL 锚点重新解析最新对象
        const b = e.target.closest('[data-act]');
        if (!b) return;
        if (b.dataset.act === 'herolib') { this.focusRow(0); return; } // 「打开电台库」：聚焦列表首行
        if (b.dataset.act !== 'heroplay') return;
        const s = this.state.stations.find(x => x.u[0] === this.heroK);
        if (s) this.togglePlay(keyOf(s)); // 当前台 → 暂停/继续（不重记最近）；非当前 → startPlay 记最近（只有点播放才记）
      });
      // 长名完整提示（P3/§4.2/§9.3）：单例 #namett + focusin/focusout 委托填充——行/卡读 data-fn 全名快照，
      // 底栏 #nowline/#song 读自身文本；定位在触发元素下方、左右夹回视口内。桌面限定（硬约束），悬停提示
      // 仍由既有 title 承担不重复造；Esc 收起在全局 Esc 块、滚动即收（位置失效不飘）
      const ttShow = el => {
        const t = (el.dataset && el.dataset.fn) || (el.id === 'nowline' || el.id === 'song' ? el.textContent : '');
        const tip = $('namett');
        if (!t) { tip.hidden = true; return; }
        tip.textContent = t; tip.hidden = false;
        const r = el.getBoundingClientRect(), b = tip.getBoundingClientRect();
        tip.style.left = Math.max(12, Math.min(r.left, innerWidth - b.width - 12)) + 'px';
        tip.style.top = Math.min(r.bottom + 6, Math.max(12, innerHeight - b.height - 12)) + 'px';
      };
      document.addEventListener('focusin', e => { // 桌面断点内才出提示（增强面约束）；焦点挪走即收
        const el = e.target && e.target.closest && e.target.closest('[data-fn],#nowline,#song');
        if (el && document.documentElement.classList.contains('ui-refresh') && matchMedia('(min-width:1024px)').matches) ttShow(el);
        else $('namett').hidden = true;
      });
      document.addEventListener('focusout', () => { $('namett').hidden = true; });
      addEventListener('scroll', () => { $('namett').hidden = true; }, { passive: true, capture: true }); // 列表/文档滚动都收（capture 兜 #list 内滚）
    }
    // 三分区切换（§5.1）：切分区 = 离开编辑上下文，先过草稿门再收编辑区
    const mTabGo = tab => () => this.mDepart(() => { this.mEditorEnd(); this.mTab = tab; this.renderManage(); });
    $('mTabC').onclick = mTabGo('cats');
    $('mTabS').onclick = mTabGo('st');
    $('mTabD').onclick = mTabGo('data');
    let mtimer = 0;
    $('mq').oninput = e => { clearTimeout(mtimer); mtimer = setTimeout(() => { this.mKw = e.target.value.trim(); this.renderMStations(); }, 120); };
    $('mq').onkeydown = e => { if (e.key === 'Escape') { e.target.value = ''; clearTimeout(mtimer); this.mKw = ''; this.renderMStations(); } }; // Esc 清搜索（焦点在输入框时不关面板）
    $('mCats').onclick = e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'new') return this.mDepart(() => this.catNew()); // 独立操作先处理现有草稿（§5.2）
      const c = b.dataset.cat || (b.closest('.mrow') || {}).dataset.cat; if (!c) return;
      if (b.dataset.act === 'edit') this.mBeginEditor('cat', c); // 分类对象编辑（草稿化，§5.2；解析走 mCatResolve，锚点=原名）
      else if (b.dataset.act === 'del') this.mDepart(() => this.catDel(c)); // 独立提交语义不变
    };
    $('mlist').onclick = e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const s = this.state.stations.find(x => keyOf(x) === b.closest('.mrow').dataset.k); if (!s) return;
      const act = b.dataset.act;
      if (act === 'edit') this.mBeginEditor('st', s.u[0], keyOf(s)); // 电台对象编辑：名称/分类/隐藏草稿（hintKey=键优先回绑）
      else if (act === 'reset') this.mDepart(() => this.confirmResetStation(s)); // ↺ 撤回全部个人调整：预览清单确认后提交（§5.4）
      else if (act === 'srcs') this.mBeginEditor('src', s.u[0], keyOf(s)); // 备选源管理 = 本台源草稿（§6.9）
    };
    $('mMiss').onclick = e => {
      if (!e.target.closest('[data-act="missclear"]')) return;
      this.mDepart(() => this.missClear()); // 清失配项是 cfg 独立操作：先处理现有草稿（§5.2）；键集随 missList 扩容（含生命周期三字段）
    };
    // 数据分区（§5.5 P4 骨架）：导入/重置/恢复/歌单是 cfg 独立操作先过草稿门；导出/备份只读不拦
    $('mExport').onclick = () => this.exportCfg();
    $('mImport').onclick = () => this.mDepart(() => $('mfile').click());
    $('mfile').onchange = e => { const f = e.target.files[0]; if (!f) return; if (f.size > 2 * 1024 * 1024) { $('status').textContent = '导入失败：文件超过 2MB 上限'; e.target.value = ''; return; } const r = new FileReader(); r.onload = () => this.importCfg(String(r.result)); r.readAsText(f, 'utf-8'); e.target.value = ''; };
    $('mReset').onclick = () => this.mDepart(() => this.resetCfg());
    $('mBackup').onclick = () => this.exportAll();
    $('mRestore').onclick = () => this.mDepart(() => $('mfile2').click());
    $('mfile2').onchange = e => { const f = e.target.files[0]; if (!f) return; if (f.size > 2 * 1024 * 1024) { $('status').textContent = '导入失败：备份文件超过 2MB 上限'; e.target.value = ''; return; } const r = new FileReader(); r.onload = () => this.importAll(String(r.result)); r.readAsText(f, 'utf-8'); e.target.value = ''; };
    // 歌单多格式导入（r4/B4）：文件（m3u/pls/xspf/asx/txt）+ 纯 URL 文本粘贴两入口，四桶预览后合并入 my-radio
    $('mPlaylist').onclick = () => this.mDepart(() => $('mfile3').click());
    $('mfile3').onchange = e => { const f = e.target.files[0]; if (!f) return; if (f.size > 2 * 1024 * 1024) { $('status').textContent = '导入失败：文件超过 2MB 上限'; e.target.value = ''; return; } const r = new FileReader(); r.onload = () => this.importPlaylist(String(r.result), f.name); r.readAsText(f, 'utf-8'); e.target.value = ''; };
    $('mPaste').onclick = () => this.mDepart(() => {
      let v = null; try { v = prompt('粘贴流地址（每行一个 http(s) 链接，最多 500 条）：'); } catch (_) { return; }
      if (v == null) return;
      this.importPlaylist(v, '');
    });

    // 添加自定义电台（A-2）：面板内表单 → /api/mystation（服务端先探活拒绝假流/死链，再原子写 my-radio.txt；
    // 与 cfg 的分工 = cfg 调整既有台的显示层（localStorage），这里新增列表里不存在的台（数据层文件，跨浏览器持久））
    const addOk = location.protocol.startsWith('http');
    $('mAddBtn').disabled = !addOk;
    $('mAddBtn').title = addOk ? '先探活（拒绝假流/死链），可用才写入个人列表 my-radio.txt' : 'file:// 降级模式无后端，npm start 后可用';
    $('mAddBtn').onclick = async () => {
      const n = $('mAName').value.trim().replace(/[,\r\n|]/g, ' ').slice(0, 40);
      const u = $('mAUrl').value.trim();
      if (!n) { $('status').textContent = '请填写电台名'; return; }
      if (!/^https?:\/\//.test(u)) { $('status').textContent = '流地址需以 http(s):// 开头'; return; }
      const c = $('mACat').value;
      $('mAddBtn').disabled = true; $('mAddBtn').querySelector('span').textContent = '探活中…';
      try {
        const r = await fetch('/api/mystation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n, u, c }) }).then(x => x.json());
        if (r.ok) {
          $('mAName').value = $('mAUrl').value = '';
          await this.reloadMain(); // 重拉重并（个人层常驻），列表与面板同步出现新台
          this.renderManage();
          $('status').textContent = `已添加「${n}」到「${c}」（持久于 my-radio.txt，同步不覆盖）`;
        } else $('status').textContent = '添加失败：' + (r.detail || r.error || '未知错误');
      } catch (e) { $('status').textContent = '添加失败：' + (e && e.message || e); }
      $('mAddBtn').disabled = false; $('mAddBtn').querySelector('span').textContent = '添加';
    };
    $('mAdd').addEventListener('keydown', e => { // Enter 提交（audit-r2 P3-3）：与备选源追加输入同口径，键盘流添台不被迫找按钮
      if (e.key === 'Enter' && e.target.matches('input') && !$('mAddBtn').disabled) { e.preventDefault(); $('mAddBtn').click(); }
    });

    // 台标：缓存 + 数据文件（http 下才有后端/代理）
    Logos.load();
    if (location.protocol.startsWith('http')) {
      fetch('logos.txt').then(r => r.ok ? r.text() : '').then(t => { Logos.loadFile(t); this.render(); this.logosEnsure(); }).catch(() => this.logosEnsure());
    }

    // 底部控制：未播放时 ▶ = 续播上次收听（按键或 URL 回绑解析）；播放中 = 暂停；暂停 = 继续
    const resumeLast = () => {
      const s = this.resolve(this.recents[0]);
      if (s) Player.play(s); else $('status').textContent = '上次收听的电台已不在列表中，请直接点播';
    };
    Player.onplaylast = resumeLast; // 锁屏/媒体键 play 空台时与 pp 按钮同语义（AIbot P3-1）
    $('pp').onclick = () => {
      if (!Player.station) return resumeLast();
      Player.isPaused() ? Player.resume() : Player.pause();
    };
    // 上一/下一收藏台（P3/G19 双端语义，§4.3）：与 ←/→ 键、锁屏媒体键同走 stepFav（无收藏时其内部走状态栏提示）；
    // boot 单次绑定，紧凑/桌面双端可见（布局只在 CSS 分叉）
    $('prevFav').onclick = () => this.stepFav(-1);
    $('nextFav').onclick = () => this.stepFav(1);
    $('refreshBtn').onclick = () => this.doRefresh(); // 手动刷新回直播头（plan-refresh-live §3.2）：当前源整链重开
    // 音量：静音键 + 拖动百分比反馈（UI 审计 P3-6）；每台音量记忆（A3/r2 ②语义①）——
    // 拖动经 rememberVol 分流（正在播写台记忆、台首调全局锚点随行、无台写全局），0 与静音同为瞬态不入记忆
    const syncMute = () => {
      const muted = !+$('vol').value;
      $('muteBtn').innerHTML = muted ? '<svg class="ic"><use href="#i-mute"/></svg>' : '<svg class="ic"><use href="#i-vol"/></svg>';
      $('muteBtn').setAttribute('aria-label', muted ? '取消静音' : '静音');
    };
    Player.onvol = v => { $('vol').value = Math.round(v * 100); syncMute(); }; // 点播套用每台音量后回写滑杆（r2 ②）
    $('muteBtn').onclick = () => {
      if (+$('vol').value > 0) { Player.setVolume(0); $('vol').value = 0; $('status').textContent = '已静音'; }
      else { const r = Player.restoreVol(); Player.setVolume(r); $('vol').value = Math.round(r * 100); $('status').textContent = '音量 ' + Math.round(r * 100) + '%'; }
      syncMute();
    };
    syncMute();
    $('vol').oninput = e => { const v = +e.target.value; Player.setVolume(v / 100); Player.rememberVol(v); $('status').textContent = '音量 ' + v + '%'; syncMute(); };

    // 导入列表：csv 风格 txt 与标准 m3u 双格式（P1-1）；本项目导出的收藏备份（#VRADIO:FAV 标记）另恢复收藏态（E4）
    $('importBtn').onclick = () => $('file').click();
    $('exportBtn').onclick = () => this.exportFavs();
    $('file').onchange = e => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 2 * 1024 * 1024) { $('status').textContent = '导入失败：文件超过 2MB 上限'; e.target.value = ''; return; } // AIbot 三轮 P2-2：读取前按 file.size 拒（对齐 Android readUri 2MB）
      const r = new FileReader();
      r.onload = async () => {
        const text = String(r.result);
        const isFavBackup = text.includes('#VRADIO:FAV');
        const list = this.parse(text);
        if (!list.length) { $('status').textContent = '导入失败：未解析到任何电台（支持 radio.txt / m3u）'; return; }
        if (isFavBackup) {
          // 收藏备份恢复：主列表不动（http 下重拉全量），只恢复收藏态——避免「导入备份后列表只剩收藏」的换机困惑
          for (const s of list) { const k = keyOf(s); if (!this.favs.some(f2 => f2.k === k)) this.favs.push({ k, u: s.u.slice(0, 6) }); }
          const ok = await this.reloadMain();
          if (!ok) { this.rebind(); this.render(); } // file:// 或拉取失败：在当前列表上回绑
          $('status').textContent = `已恢复收藏：${list.length} 个电台`;
        } else {
          let my = [];
          if (location.protocol.startsWith('http')) { // file:// 边界：无后端不拉 my-radio，导入后 = 精选 + 导入列表
            my = await fetch('my-radio.txt').then(r => r.ok ? r.text() : '').then(t => t ? this.parse(t) : []).catch(() => []);
          }
          this.applySources(list, my);
          $('status').textContent = `已导入 ${list.length} 台`;
        }
        $('hint').style.display = 'none';
      };
      r.readAsText(f, 'utf-8');
    };

    // 初始数据：radio.txt + my-radio.txt（http 下）；file:// 降级链（N1/r2 ③）：radio-data.js 全库直读
    // （同步产出的经典 script 全局，fetch 被拦但 script 加载不会）→ 再退内置精选；hint 只在两者皆无时提示
    Store.boot(); // 主源对账（异步，镜像先行渲染不阻塞首屏）：后端较新应用之/首次迁移回填/dirty 重推
    this.reloadMain().then(ok => {
      if (!ok) {
        if (window.RADIO_DATA) this.applySources(this.parse(window.RADIO_DATA), []); // 代理级 m3u8 台播不了，直流台照常
        else $('hint').style.display = 'block';
      }
      this.logosEnsure();
      // 开机后台编排（B-10 + R3/R4 拍板）：基线优先——未建基线（含确认过的中断续跑）不跑常规复测（基线是超集）
      if (ok) setTimeout(() => Sync.bootQuiet(), 4000);
    });
    this.render(); this.showLast(); // file:// 降级模式下也补齐「上次收听」提示
  },
};

/* B3 双兼容出口：浏览器经典 script 照常 boot（document 恒在）；Node 侧（test/discovery.js require 纯函数）
   不 boot 只导出——app.js 顶层无 DOM 访问，方法体内的 DOM/Player/Store 引用只在调用时触达 */
if (typeof document !== 'undefined') App.boot();
if (typeof module !== 'undefined') module.exports = { App, STARTER, buildDiscovery };
