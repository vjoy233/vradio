package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.check.Health
import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.model.Cfg
import io.github.vjoy233.vradio.model.FavEntry
import io.github.vjoy233.vradio.model.HealthEntry
import io.github.vjoy233.vradio.model.RecentEntry
import io.github.vjoy233.vradio.model.SongRec
import io.github.vjoy233.vradio.model.Station
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/* 数据装配管线 + 持久态唯一所有者（对标 app.js 的 App 数据面）：
   主列表 replace → STARTER 精选层按精确名去重并入 → my-radio 个人层常驻并入 → 维护层套用（cfg）
   → 收藏/最近/死台标记按 URL 回绑（身份公理：URL = 持久身份，名字 = 显示层）。
   分类/关键词视图态不在此层（UI 层组合 visible()/search()/cats()）。 */
@Suppress("unused") // filesDir：契约签名保留（AppVm 注入 filesDir），当前数据流全走 store/text 注入
class Library(
  val store: Store,
  private val filesDir: File,
  var mainText: String = "",        // radio.txt 全文（AppVm 从 assets/D7 副本装载）
  var myText: String = "",          // my-radio.txt 全文（AppVm 从 filesDir 装载）
  private val clock: () -> Long = System::currentTimeMillis,
) {
  var stations: List<Station> = emptyList()
    private set

  private var _cfg = CfgCodec.parse(store.get(C.K_CFG))
  var cfg: Cfg // 赋值即落盘（导入/维护面板入口）
    get() = _cfg
    set(value) { _cfg = value; store.set(C.K_CFG, CfgCodec.toJson(value)) }

  /* —— 持久态（boot 从 store 容错读 + 旧格式迁移，app.js loadStore 同款）—— */
  var favs: MutableList<FavEntry> = loadFavs(store.get(C.K_FAVS))       // 带 URL 的条目永不回收（休眠待回绑）
  var recents: MutableList<RecentEntry> = loadRecents(store.get(C.K_RECENTS)) // 最近在前、≤20；队首即「上次收听」
  var healthMarks: MutableMap<String, HealthEntry> = Health.normalize(store.get(C.K_HEALTH), clock()) // 容错读收敛单实现（G P3：与 check 层共用，防双份漂移）

  /* —— 分类条序（app.js buildCats 同序）：华语/欧美置顶（重命名跟随新名），自建分类次之，其余按数据序 —— */
  fun cats(): List<String> {
    val present = LinkedHashSet<String>()
    for (s in stations) if (!s.hidden && !cfg.hideC.containsKey(s.c)) present.add(s.c)
    val pins = C.CAT_TOP.map { cfg.renames[it] ?: it }.distinct()
    val out = LinkedHashSet<String>()
    for (p in pins) if (present.contains(p)) out.add(p)
    for (c in cfg.cats) if (present.contains(c) && !cfg.hideC.containsKey(c) && !pins.contains(c)) out.add(c)
    for (c in present) if (!pins.contains(c) && !cfg.cats.contains(c)) out.add(c)
    return out.toList()
  }

  fun reapplyCfg() { // 维护层改动后即时生效：回滚默认口径 → 重套 cfg → 重回绑（u 也随留底回滚，撤除追加源即刻生效）
    for (s in stations) if (s.dU.isNotEmpty()) { s.c = s.dCat; s.n = s.dName; s.u = s.dU.toMutableList() }
    applyCfg()
    rebind()
  }

  /* —— 收藏/最近 —— */
  fun favKeys(): Set<String> = favs.map { it.k }.toSet()
  fun isFav(s: Station) = favs.any { it.k == s.key }
  fun toggleFav(s: Station) {
    val k = s.key
    val i = favs.indexOfFirst { it.k == k }
    if (i >= 0) favs.removeAt(i) else favs.add(FavEntry(k, s.u.take(6))) // URL 快照 ≤6（护栏口径）
    saveFavs()
  }
  fun recordRecent(s: Station) { // 播放即记入最近（队首 = 上次收听）
    val k = s.key
    recents.removeAll { it.k == k }
    recents.add(0, RecentEntry(k, s.n, s.u.take(6)))
    while (recents.size > C.RECENTS_CAP) recents.removeAt(recents.size - 1)
    saveRecents()
  }
  fun saveFavs() { store.set(C.K_FAVS, JSONArray().apply { for (f in favs) put(JSONObject().put("k", f.k).put("u", JSONArray(f.u))) }.toString()) }
  fun saveRecents() { store.set(C.K_RECENTS, JSONArray().apply { for (r in recents) put(JSONObject().put("k", r.k).put("n", r.n).put("u", JSONArray(r.u))) }.toString()) }

  /* —— 健康标记承载（分档生命周期函数在 check 层 Health 对象，这里只管持久化与挂标）—— */
  fun saveHealth() { // FIFO 分额度裁剪（app.js saveHealth 同款）：疑似 1000 + 停运 1000，时间序扫描停运档最后才挤
    val ks = healthMarks.keys.sortedBy { healthMarks[it]?.t ?: 0L }
    var n1 = 0; var n2 = 0
    for (k in ks) {
      val e = healthMarks[k] ?: continue
      if (e.perm > 0) { n2++; if (n2 > C.HEALTH_STOPPED_CAP) healthMarks.remove(k) }
      else { n1++; if (n1 > C.HEALTH_SUSPECT_CAP) healthMarks.remove(k) }
    }
    val o = JSONObject()
    for ((k, e) in healthMarks) o.put(k, JSONObject().put("u", JSONArray(e.u)).put("t", e.t).put("t0", e.t0).put("n", e.n).put("perm", e.perm))
    store.set(C.K_HEALTH, o.toString())
  }
  fun applyHealthToStations() { // 先清后挂（G P1-1）：体检复活只删 marks，行内 health 残留 "dead" 会把台继续隐藏到
    // 下次 reload——app.js patchHealth 复活即回归列表；先清后挂对 boot（本就全 null）无害
    for (s in stations) s.health = null
    for ((k, e) in healthMarks) { resolveEntry(k, e.u)?.health = "dead" }
  }

  /* —— 歌曲历史（radio.songs，键 = 台主 URL——身份公理，改名/换分类不丢）—— */
  fun pushSong(u0: String, title: String) { // 换歌时旧歌入史：与队首同曲不重复入，每台 12 / 台数 50 FIFO
    if (title.isEmpty()) return
    val songs = songsMap()
    val list = songs.getOrPut(u0) { ArrayList() }
    if (list.isEmpty() || list[0].t != title) {
      list.add(0, SongRec(title, clock()))
      while (list.size > C.SONGS_PER_ST) list.removeAt(list.size - 1)
    }
    for (x in songs.keys.sortedByDescending { k -> songs[k]?.firstOrNull()?.at ?: 0L }.drop(C.SONGS_STATIONS)) songs.remove(x)
    val o = JSONObject()
    for ((k, l) in songs) { val a = JSONArray(); for (r in l) a.put(JSONObject().put("t", r.t).put("at", r.at)); o.put(k, a) }
    store.set(C.K_SONGS, o.toString())
  }
  fun songsOf(u0: String): List<SongRec> = songsMap()[u0] ?: emptyList()
  fun allSongs(): Map<String, List<SongRec>> = songsMap()

  /* —— 视图（可见性口径；分类/关键词过滤由 UI 层组合）—— */
  fun visible(showDead: Boolean, playingKey: String?, connectingKey: String?): List<Station> =
    stations.filter { s ->
      !s.hidden && !cfg.hideC.containsKey(s.c) && // 手动隐藏/藏分类 = 彻底消失（无正在播例外，owner 拍板）
        (showDead || s.health != "dead" || s.key == playingKey || s.key == connectingKey) // 死台隐藏的正在播/连接中例外只豁免自动标记
    }
  fun search(kw: String): List<Station> { // 多词空格 AND（CONTRACTS/AGENTS 拍板口径；单词语义与 Web 一致），只搜可见台（默认隐藏死台）
    val kws = kw.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (kws.isEmpty()) return visible(false, null, null)
    return visible(false, null, null).filter { s -> kws.all { s.n.lowercase().contains(it) } }
  }
  fun resolve(key: String): Station? = stations.firstOrNull { it.key == key }
  fun resolveByUrl(u0: String): Station? = stations.firstOrNull { u0 in it.u }

  /** N2 m3u 泛导入分流（纯决策不变异，AIbot P1-1 语义修复）：库内可解析台（键优先、任一源 URL 兜底，
   *  resolveEntry 同口径；任一 URL 命中即整条算命中）→ favHits 交调用方批量恢复收藏；
   *  库外台（URL 不在 stations/favs 快照/my 层行——休眠收藏与 my 层台勿重复入库）→ extra 待确认入
   *  my-radio。known 快照必须先于收藏变异，否则刚恢复的收藏把库外 URL 全部遮蔽、extra 恒空。 */
  fun partitionImport(list: List<Station>): Pair<List<Station>, List<Station>> {
    val known = HashSet<String>()
    for (s in stations) known.addAll(s.u)
    for (f in favs) known.addAll(f.u)
    val myRows = myText.split(Regex("\\r?\\n"))
    val favHits = ArrayList<Station>()
    val extra = ArrayList<Station>()
    val seen = HashSet<String>()
    for (s in list) {
      val hit = resolve(s.key) ?: stations.firstOrNull { st -> s.u.any { it in st.u } }
      if (hit != null) { favHits.add(hit); continue }
      for (u in s.u) {
        if (u in known || u in seen || myRows.any { it.trim().endsWith(",$u") }) continue
        seen.add(u)
        val c = s.c.takeIf { it.isNotEmpty() && it != "未分类" } ?: "自定义"   // m3u 无 group-title 的兜底分类
        extra.add(Station(c, s.n, mutableListOf(u)))
      }
    }
    return favHits to extra
  }

  /* —— 生命周期 —— */
  fun reload() { // parse(mainText/myText) → applySources → applyCfg → rebind → 挂死台标
    val byKey = LinkedHashMap<String, Station>(); val byName = HashSet<String>()
    for (s in RadioTxt.parse(mainText)) { byKey[s.key] = s; byName.add(s.n) }
    for (st in STARTER) if (!byName.contains(st.n)) { // 精确重名的精选台不再并入（主列表同台已代表它）
      byKey[st.key] = Station(st.c, st.n, st.u.toMutableList(), st.l); byName.add(st.n)
    }
    for (s in RadioTxt.parse(myText)) { // 个人层常驻并入（只补源不覆盖）；⚠ 大括号必须显式——裸写双 if 的话
      val cur = byKey[s.key]            // else 会悬挂绑到内层 if（新键台永不并入的隐形 bug，测试逮住）
      if (cur != null) {
        for (u in s.u) if (!cur.u.contains(u)) cur.u.add(u)
      } else { byKey[s.key] = s; byName.add(s.n) }
    }
    stations = byKey.values.toList()
    for (s in stations) { s.dCat = s.c; s.dName = s.n; s.dU = s.u.toList() } // 装配默认口径留底（↺恢复/撤回用）
    applyCfg()
    rebind()
    applyHealthToStations()
  }
  fun rebind() { // 收藏/最近/死台标记按任一源 URL 回绑刷新键与快照（app.js rebind 同款，含孤儿清理）
    val nf = ArrayList<FavEntry>()
    for (f in favs) {
      val st = resolveEntry(f.k, f.u)
      if (st != null) nf.add(FavEntry(st.key, st.u.take(6)))
      else if (f.u.isNotEmpty()) nf.add(f) // 带 URL 的休眠条目永不回收；旧名字键（无 URL）回绑失败即回收
    }
    favs = nf
    val seen = HashSet<String>(); val nr = ArrayList<RecentEntry>()
    for (r in recents) { // 回绑后按键去重：上游改名会让新旧两条解析到同一台
      val st = resolveEntry(r.k, r.u)
      val e = if (st != null) RecentEntry(st.key, st.n, st.u.take(6)) else r
      if (seen.add(e.k) && (e.u.isNotEmpty() || stations.any { it.key == e.k })) nr.add(e)
    }
    recents = ArrayList(nr.take(C.RECENTS_CAP))
    val now = clock(); val hm = LinkedHashMap<String, HealthEntry>()
    for ((k, e) in healthMarks) { // 死台标记按 URL 身份回绑（t0/n/perm 档位随行，t 保留——回绑不是复测）
      val st = resolveEntry(k, e.u)
      if (st != null) { st.health = "dead"; hm[st.key] = HealthEntry(st.u.take(6), e.t, e.t0, e.n, e.perm) }
      else if (now - e.t0 < C.ORPHAN_CLEAN_DAYS * C.DAY_MS) hm[k] = e // 休眠孤儿 90 天清理
    }
    healthMarks = hm
    saveHealth(); saveFavs(); saveRecents()
  }
  fun reloadStore() { // Store 被外部整体替换后（备份导入 applyAll）内存态全量重载：app.js applyServerStore 同款
    favs = loadFavs(store.get(C.K_FAVS))
    recents = loadRecents(store.get(C.K_RECENTS))
    healthMarks = Health.normalize(store.get(C.K_HEALTH), clock())
    _cfg = CfgCodec.parse(store.get(C.K_CFG))
    for (s in stations) s.health = null // 清旧标记由 rebind 按 healthMarks 重挂
    rebind()
  }

  /* 维护层套用（app.js applyCfg 同款）：移动/重命名/手藏/追加源按「任一源 URL 命中」（变体换序免疫）；
     追加源只挂台尾不动身份键（s.u[0] 是 srcmem/收藏/健康标记的键）；分类重命名最后映射 */
  private fun applyCfg() {
    val c = cfg
    for (s in stations) {
      s.hidden = false
      for (u in s.u) {
        if (c.hideS[u] == true) s.hidden = true
        c.moves[u]?.let { s.c = it }
        c.names[u]?.let { s.n = it }
      }
      val add = ArrayList<String>()
      for (u in s.u) for (x in c.srcs[u] ?: emptyList()) if (x !in s.u && x !in add) add.add(x)
      if (add.isNotEmpty()) s.u.addAll(add)
      c.renames[s.c]?.let { s.c = it }
    }
  }

  private fun resolveEntry(k: String, us: List<String>): Station? = // 键优先、URL 兜底（收藏/最近/健康标记共用）
    stations.firstOrNull { it.key == k } ?: if (us.isEmpty()) null else stations.firstOrNull { s -> s.u.any { it in us } }

  /* —— 持久态容错读 —— */
  private fun loadFavs(raw: String?): MutableList<FavEntry> {
    val out = ArrayList<FavEntry>()
    val a = raw?.let { runCatching { JSONArray(it) }.getOrNull() } ?: return out
    for (i in 0 until a.length()) {
      val e = a.opt(i)
      if (e is String) { out.add(FavEntry(e, ArrayList())); continue } // 旧格式：纯名字键条目
      if (e !is JSONObject) continue
      out.add(FavEntry(e.optString("k"), strList(e.optJSONArray("u"))))
    }
    return out
  }
  private fun loadRecents(raw: String?): MutableList<RecentEntry> {
    val out = ArrayList<RecentEntry>()
    val a = raw?.let { runCatching { JSONArray(it) }.getOrNull() } ?: return out
    for (i in 0 until a.length()) {
      val e = a.optJSONObject(i) ?: continue
      val k = e.optString("k")
      val n = e.optString("n").ifEmpty { k.substringAfterLast('|') } // 旧数据缺名：键尾兜底
      out.add(RecentEntry(k, n, strList(e.optJSONArray("u"))))
    }
    return ArrayList(out.take(C.RECENTS_CAP))
  }
  private fun songsMap(): MutableMap<String, MutableList<SongRec>> { // 每次现读（导入恢复后自动跟随，app.js pushSongHist 同款）
    val out = LinkedHashMap<String, MutableList<SongRec>>()
    val o = store.get(C.K_SONGS)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return out
    for (k in o.keys()) {
      val a = o.optJSONArray(k) ?: continue
      val list = ArrayList<SongRec>()
      for (i in 0 until a.length()) {
        val e = a.optJSONObject(i) ?: continue
        list.add(SongRec(e.optString("t"), e.optLong("at")))
      }
      if (list.isNotEmpty()) out[k] = list
    }
    return out
  }
  private fun strList(a: JSONArray?): MutableList<String> {
    val out = ArrayList<String>()
    if (a == null) return out
    for (i in 0 until a.length()) { val v = a.opt(i); if (v is String) out.add(v) }
    return out
  }
}
