package io.github.vjoy233.vradio.check

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.model.FavEntry
import io.github.vjoy233.vradio.model.HealthEntry
import io.github.vjoy233.vradio.model.RecentEntry
import io.github.vjoy233.vradio.model.Station
import org.json.JSONArray
import org.json.JSONObject

/* 死台标记分档生命周期纯函数（grill R1-R4 拍板；语义源 app.js loadStore/patchHealth/scopeDead
   + sync.js silentHealth 的合并范围）。承载与落盘在 Library（FIFO 分额度裁剪归它），这里只管规则。
   radio.health 单键值：键=分类|台名 → {u:URL 快照, t:最近确认, t0:首死, n:连续确认数, perm:1=停运档}。 */
object Health {

  /** 容错读 + 疑似档兜底 TTL 180 天过滤 + 旧数据兼容（无 t0/n/perm → 疑似档、n=1、t0=t），app.js:54-60 同款。 */
  fun normalize(raw: String?, now: Long = System.currentTimeMillis()): MutableMap<String, HealthEntry> {
    val out = LinkedHashMap<String, HealthEntry>()
    if (raw.isNullOrEmpty()) return out
    val hp = try { JSONObject(raw) } catch (_: Exception) { return out }
    for (k in hp.keys()) {
      val e = hp.optJSONObject(k) ?: continue
      val ua = e.optJSONArray("u") ?: continue          // JS !Array.isArray(e.u) 丢弃
      val u = ArrayList<String>(ua.length())
      for (i in 0 until ua.length()) ua.opt(i)?.let { u.add(it.toString()) }
      val perm = if (e.optInt("perm", 0) != 0) 1 else 0
      val t = e.optLong("t", 0L)
      if (perm == 0 && now - t >= C.HEALTH_TTL_SUSPECT) continue   // 疑似档半年没人复测即清；停运档永不过期
      val t0v = e.optLong("t0", 0L)                     // JS e.t0 || e.t || 0：0 值回退
      out[k] = HealthEntry(u, t, if (t0v != 0L) t0v else t, maxOf(1, e.optInt("n", 0)), perm)
    }
    return out
  }

  /** 首死入疑似；复测连续确认 n+1；n≥3 且首死 ≥30 天 → perm=1 停运档（已有 perm 粘性保留），app.js:461-468。 */
  fun onDead(marks: MutableMap<String, HealthEntry>, key: String, urls: List<String>, now: Long) {
    val old = marks[key]
    val t0 = old?.t0 ?: now
    val n = if (old != null) maxOf(1, old.n) + 1 else 1
    val perm = if ((old != null && old.perm == 1) ||
      (n >= C.HEALTH_UPGRADE_N && now - t0 >= C.HEALTH_UPGRADE_DAYS * C.DAY_MS)) 1 else 0
    marks[key] = HealthEntry(urls.take(6), now, t0, n, perm)
  }

  /** 复活撤销 = delete（从疑似档重来——复测可达即撤，停运档同理走这条保险通道）。 */
  fun onAlive(marks: MutableMap<String, HealthEntry>, key: String) { marks.remove(key) }

  /** 序列化（patchHealth 对象字面量的字段序 u,t,t0,n,perm）。 */
  fun toJson(marks: Map<String, HealthEntry>): String {
    val o = JSONObject()
    for ((k, e) in marks) o.put(k, JSONObject()
      .put("u", JSONArray(e.u)).put("t", e.t).put("t0", e.t0).put("n", e.n).put("perm", e.perm))
    return o.toString()
  }

  /**
   * 开机静默复测范围（B-10 + R4 节流拍板）：收藏+最近（≤30，scopeFavRecent）∪ 死标记台
   * （t 距今超档位间隔才入列：疑似 24h / 停运 7 天；最旧优先、每 boot 封顶 200 轮转——FIFO 顶格
   * 2000 时把最坏单次后台探活压回分钟级）。手动隐藏的台不测（隐藏是明确意图）；
   * 合并去重顺序照抄 sync.js silentHealth：收藏+最近在前、死标记补位。键或 URL 任一命中回绑。
   */
  fun bootScope(marks: Map<String, HealthEntry>, favs: List<FavEntry>, recents: List<RecentEntry>,
                stations: List<Station>, now: Long): List<Station> {
    fun find(k: String, u: List<String>): Station? =
      stations.firstOrNull { it.key == k } ?: stations.firstOrNull { s -> u.any { s.u.contains(it) } }
    val out = ArrayList<Station>()
    val seen = HashSet<String>()
    fun add(s: Station) { val k = s.key; if (!s.hidden && !seen.contains(k)) { seen.add(k); out.add(s) } }
    // ① 收藏+最近（≤30）
    val fr = ArrayList<Station>()
    val seenFr = HashSet<String>()
    for (f in favs) { val s = find(f.k, f.u) ?: continue; if (!s.hidden && !seenFr.contains(s.key)) { seenFr.add(s.key); fr.add(s) } }
    for (r in recents) { val s = find(r.k, r.u) ?: continue; if (!s.hidden && !seenFr.contains(s.key)) { seenFr.add(s.key); fr.add(s) } }
    // ② 死标记台（节流 + 最旧优先 + 封顶）
    val dead = ArrayList<Pair<Long, Station>>()
    for ((k, e) in marks) {
      val gap = if (e.perm != 0) C.HEALTH_RECHECK_DAYS * C.DAY_MS else C.BOOT_CHECK_COOLDOWN   // 疑似 24h / 停运 7 天（AIbot P3：常数去重）
      if (now - e.t < gap) continue
      val st = find(k, e.u) ?: continue
      if (st.hidden) continue
      dead.add(Pair(e.t, st))
    }
    dead.sortBy { it.first }
    fr.take(30).forEach { add(it) }
    dead.take(C.BOOT_CHECK_CAP).forEach { add(it.second) }
    return out
  }
}
