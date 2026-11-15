package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.model.Cfg
import io.github.vjoy233.vradio.stats.ListenStats
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/* 导入导出五件套（对标 app.js exportFavs/exportSongs/exportCfg/exportAll/importAll）。
   备份 v3（r4/B4，契约 contracts/backup-v3.schema.json）：{format:"vradio-backup",version:3,createdAt,app,
   data:13键快照, myRadio:my-radio.txt 原始行, extensions:{sidecars:{quality,listenStats}}}；导出统一 v3；
   导入兼容 v1（无 my 不动 my-radio.txt）/v2（读 my 数组）/v3（读 myRadio + extensions.sidecars.quality/
   listenStats 经 qualityTrim/lsTrim 裁剪后由 QualityStore/ListenSidecar 事务式覆盖落盘——AIbot review P1-1：
   确认即真提交，任一步失败恢复旧快照，四件事务与 Web 同序）。
   版本映射与 Web backup.js（BackupV3.read）同构；黄金样本 contracts/fixtures/backup-v2.json、backup-v3.json 双端一致消费。 */
object Backup {

  /* 导入恢复载荷：data = 白名单过滤后的 13 键快照；my = null 表示该版本不带个人电台字段（v1，或 v2/v3 字段
     缺失）→ 不动 my-radio.txt；quality/listenStats = v3 extensions.sidecars.*（已裁剪，提交段经 QualityStore/
     ListenSidecar 事务式覆盖落盘） */
  data class ImportPayload(
    val ver: Int,                        // 1|2|3（预览文案用）
    val data: Map<String, String>,
    val my: List<String>?,
    val quality: JSONObject? = null,     // {v:1, data:{…迁移字段}}
    val listenStats: JSONObject? = null, // {v:1, data:{日桶 days}}（裁空 = null，与 Web「含 0 天无确认意义」同判）
  )

  fun exportAll(lib: Library, myText: String, at: Long, qualityExt: JSONObject? = null,
                listenExt: JSONObject? = null): String {
    val o = JSONObject()
    o.put("format", "vradio-backup")
    o.put("version", 3)
    o.put("createdAt", at)
    o.put("app", "android")
    val d = JSONObject()
    for ((k, v) in lib.store.snapshot()) d.put(k, v)
    o.put("data", d)
    o.put("myRadio", JSONArray(myLines(myText)))
    // 「包含本机 sidecar」勾选（AIbot 三轮 P1-3）：qualityExt/listenExt = {v:1, data:…Trim(捕获数据)}，
    // 由调用方在勾选时分别构建；双 null = extensions 恒空（与 Web mSidecar 复选同口径）
    val sc = JSONObject()
    if (qualityExt != null) sc.put("quality", qualityExt)
    if (listenExt != null) sc.put("listenStats", listenExt)
    o.put("extensions", if (sc.length() > 0) JSONObject().put("sidecars", sc) else JSONObject())
    return o.toString(2)
  }

  fun parseImport(text: String): ImportPayload? { // null = 非法文件（非 JSON / 无 data / 无有效白名单键）
    val j = runCatching { JSONObject(text) }.getOrNull() ?: return null
    val d = j.optJSONObject("data") ?: return null
    val data = LinkedHashMap<String, String>()
    for (k in d.keys()) {
      if (k !in C.KEYS) continue // 白名单外键静默丢弃（my 不在 13 键内）
      val v = d.opt(k)
      if (v is String) data[k] = v // typeof string 才收（app.js importAll 同判）
    }
    if (data.isEmpty()) return null // 备份中无有效数据
    // 版本映射固定（B0 契约）：v1 无 my；v2 读 my；v3 读 myRadio（app 字段忽略差异）；字段缺失按不动处理
    val ver = when {
      j.optInt("version", 0) == 3 || j.optInt("v", 0) == 3 -> 3
      j.optInt("v", 0) == 2 -> 2
      else -> 1
    }
    val src = when (ver) { 3 -> j.optJSONArray("myRadio"); 2 -> j.optJSONArray("my"); else -> null }
    val my = if (src == null) null else (0 until src.length()).mapNotNull { i -> src.opt(i) as? String }
    // v3 extensions.sidecars.*：qualityTrim/lsTrim 裁剪后交提交段落盘（AIbot P1-1）；未知扩展忽略不失败
    var quality: JSONObject? = null
    var listenStats: JSONObject? = null
    if (ver == 3) {
      val sc = j.optJSONObject("extensions")?.optJSONObject("sidecars")
      val qd = sc?.optJSONObject("quality")?.optJSONObject("data")
      if (qd != null) quality = JSONObject().put("v", 1).put("data", qualityTrim(qd))
      val ld = sc?.optJSONObject("listenStats")?.optJSONObject("data")
      if (ld != null) { val t = lsTrim(ld); if (t.length() > 0) listenStats = JSONObject().put("v", 1).put("data", t) }
    }
    return ImportPayload(ver, data, my, quality, listenStats)
  }

  /* 质量聚合迁移字段裁剪（与 Web backup.js qualityTrim 同款白名单，contracts/quality-summary.json aggregate 面
     ——全为计数/时间戳/延迟，无响应正文/DNS/IP；未列出字段两侧一律剔除）。条目 2000 封顶。 */
  private val Q_SRC_NUM = listOf("okCount", "failCount", "lastOkAt", "lastFailAt", "lastPlaybackAt", "latSum", "latN", "disconnects")

  private fun num(x: Any?): Long? {
    val d = (x as? Number)?.toDouble() ?: (x as? String)?.toDoubleOrNull() ?: return null
    if (!d.isFinite() || d < 0) return null
    return Math.min(d, 1e9).toLong()
  }

  private fun ev(x: Any?): JSONObject? {
    val o = x as? JSONObject ?: return null
    return JSONObject().put("t", (o.opt("t") as? String ?: "").take(16)).put("ok", o.opt("ok") == true)
      .put("at", num(o.opt("at")) ?: 0L).put("lat", num(o.opt("lat")) ?: 0L)
  }

  fun qualityTrim(data: JSONObject): JSONObject {
    val out = JSONObject()
    var n = 0
    for (k in data.keys().asSequence().toList()) {
      if (n >= 2000) break
      if (!Regex("^https?://").containsMatchIn(k) || k.length > 512) continue
      val v = data.optJSONObject(k) ?: continue
      val e = JSONObject().put("cf", num(v.opt("cf")) ?: 0L)
      val srcs = v.optJSONObject("sources") ?: JSONObject()
      val es = JSONObject()
      var sc = 0
      for (su in srcs.keys().asSequence().toList()) {
        if (sc >= 6) break
        if (!Regex("^https?://").containsMatchIn(su) || su.length > 512) continue
        val s = srcs.optJSONObject(su) ?: continue
        val x = JSONObject()
        for (f in Q_SRC_NUM) num(s.opt(f))?.let { x.put(f, it) }
        (s.opt("modes") as? org.json.JSONArray)?.let { arr ->
          val m = ArrayList<String>()
          for (i in 0 until arr.length()) {
            val mk = (arr.opt(i) as? String ?: "").take(16)
            if (mk in listOf("direct", "hls", "proxy") && !m.contains(mk)) m.add(mk)
            if (m.size >= 8) break
          }
          if (m.isNotEmpty()) x.put("modes", org.json.JSONArray(m))
        }
        ev(s.opt("lastDiag"))?.let { if (it.optLong("at") > 0 || it.optString("t").isNotEmpty()) x.put("lastDiag", it) }
        ev(s.opt("lastPlayFail"))?.let { if (it.optLong("at") > 0 || it.optString("t").isNotEmpty()) x.put("lastPlayFail", it) }
        if (x.length() > 0) { es.put(su, x); sc++ }
      }
      if (es.length() > 0 || e.optLong("cf") > 0) { e.put("sources", es); out.put(k, e); n++ }
    }
    return out
  }

  /* 收听统计迁移裁剪（与 Web backup.js lsTrim / server lsTrimImport 同语义白名单）：日键历法有效
     （ListenStats.validDay 双端同规则）、台键 http(s)≤512、分类 ≤24、数值非负封顶 1e9、日 90 封顶
     （sidecar 本体同款保留期）、每日台/分类 ≤64、总量 512KB 封顶（超限先删最早日）；空日丢弃。 */
  private val LS_DAYS_MAX = 90
  private val LS_MAP_MAX = 64
  private val LS_CAP = 512 * 1024

  private fun lnum(x: Any?): Long? {
    val d = (x as? Number)?.toDouble() ?: (x as? String)?.toDoubleOrNull() ?: return null
    if (!d.isFinite() || d < 0) return null
    return Math.min(d, 1e9).toLong()
  }

  fun lsTrim(data: JSONObject): JSONObject {
    fun mapTrim(o: JSONObject?, keyOk: (String) -> Boolean): JSONObject {
      val out = JSONObject()
      o ?: return out
      for (k in o.keys().asSequence().toList()) {
        if (out.length() >= LS_MAP_MAX) break
        if (!keyOk(k)) continue
        val v = lnum(o.opt(k)) ?: continue
        if (v > 0) out.put(k, v)
      }
      return out
    }
    val days = JSONObject()
    for (k in data.keys().asSequence().toList()) {
      if (!ListenStats.validDay(k)) continue
      val d = data.optJSONObject(k) ?: continue
      val e = JSONObject().put("ms", lnum(d.opt("ms")) ?: 0L)
        .put("sessions", Math.min(lnum(d.opt("sessions")) ?: 0L, 1_000_000L))
        .put("stations", mapTrim(d.optJSONObject("stations")) { (it.startsWith("http://") || it.startsWith("https://")) && it.length <= 512 })
        .put("categories", mapTrim(d.optJSONObject("categories")) { it.isNotEmpty() && it.length <= 24 })
      if (e.optLong("ms") > 0 || e.optLong("sessions") > 0 || e.optJSONObject("stations")!!.length() > 0 || e.optJSONObject("categories")!!.length() > 0)
        days.put(k, e)
    }
    // 保留最近 90 个自然日 + 512KB 封顶（超限先删最早日；ISO 日键字典序 = 时间序）
    val ks = ArrayList(days.keys().asSequence().toList()).sorted()
    for (k in ks.subList(0, Math.max(0, ks.size - LS_DAYS_MAX))) days.remove(k)
    while (days.length() > 0 && JSONObject().put("v", 1).put("days", days).toString().toByteArray().size > LS_CAP)
      days.remove(ArrayList(days.keys().asSequence().toList()).min()!!)
    return days
  }

  /* ---------- B4 导入提交段（applyConfirmed 抽离可 JVM 测试，AIbot review P1-1/P2-2）----------
     四步覆盖（Store → my-radio → 质量 sidecar → 收听统计 sidecar，与 Web BackupV3.commitImport 同序）+
     任一步失败整体回滚（§13.2-5：不允许 Store 已恢复而 sidecar 半恢复）。协作方函数注入：AppVm 传
     Store/MyRadio/QualityStore/ListenSidecar 真实现；JVM 测试传 fake（断言 sidecar 实际写入 / 失败触发
     四件回滚 / 回滚顺序）。返回 null = 成功，否则失败原因（调用方 toast 拼前缀「导入失败：…已回滚到导入前
     状态」）。快照四件由调用方在提交前自持。 */
  class ImportIO(
    val applyStore: () -> Boolean,       // Store.applyAllChecked(导入 data)——落盘失败可感知（AIbot 三轮 P1-2）
    val rollbackStore: () -> Boolean,    // Store.applyAllChecked(快照)；false = 回滚仅内存（重启可能残留导入数据，须如实报告）
    val applyMy: () -> Boolean,          // my 全量替换（my==null 时调用方给 { true } 不动文件）
    val rollbackMy: () -> Unit,          // my-radio 旧文本回写
    val applyQuality: () -> Boolean,     // QualityStore.replaceImport（quality==null 时给 { true }）
    val rollbackQuality: () -> Boolean,  // QualityStore.restore(旧快照)（同上给 { true }）
    val applyListenStats: () -> Boolean = { true },   // ListenSidecar.save(导入态)（listenStats==null 时不调用）
    val rollbackListenStats: () -> Boolean = { true }, // ListenSidecar.save(旧快照)（同上）
  )

  fun commitImport(data: Map<String, String>, my: List<String>?, qualityData: JSONObject?, io: ImportIO,
                   listenData: JSONObject? = null): String? {
    if (!io.applyStore()) { // Store 落盘失败必须中止（否则 Store 旧值 + my/sidecar 新值 = 跨层半导入）
      val rb = io.rollbackStore()
      return "主数据持久化失败（store.json 写入失败）" + if (rb) "" else "；回滚也仅写入内存，重启后请重新导入"
    }
    if (!io.applyMy()) {
      val rb = io.rollbackStore()
      io.rollbackMy()
      return "个人电台恢复超限（500 行/64KB）" + if (rb) "" else "；Store 回滚写失败，重启后请重新导入"
    }
    if (!io.applyQuality()) {
      val rb = io.rollbackStore()
      io.rollbackMy(); io.rollbackQuality()
      return "质量 sidecar 恢复失败" + if (rb) "" else "；Store 回滚写失败，重启后请重新导入"
    }
    if (listenData != null && !io.applyListenStats()) { // 四件事务收官（B4 补齐 listenStats sidecar）
      val rb = io.rollbackStore()
      io.rollbackMy(); io.rollbackQuality(); io.rollbackListenStats()
      return "收听统计 sidecar 恢复失败" + if (rb) "" else "；Store 回滚写失败，重启后请重新导入"
    }
    return null
  }

  /* 收藏导出 = 带 #VRADIO:FAV 标记的 m3u（通用播放器可读；导回同文件恢复收藏态）。无收藏返回空串（调用方提示） */
  fun m3uFavs(lib: Library): String {
    val favs = lib.favKeys()
    val list = lib.stations.filter { favs.contains(it.key) }
    if (list.isEmpty()) return ""
    val lines = ArrayList<String>()
    lines.add("#EXTM3U"); lines.add("#VRADIO:FAV")
    for (s in list) for (u in s.u) { // 纯文本只清分隔/换行符（R&B 不能腐蚀成 R&amp;B）
      val c = s.c.replace(Regex("[\"\\r\\n]"), "")
      val n = s.n.replace(Regex("[\\r\\n,]"), " ")
      lines.add("#EXTINF:-1 group-title=\"$c\",$n")
      lines.add(u)
    }
    return lines.joinToString("\n")
  }

  /* 歌曲历史导出：全台历史按时间倒序拼 txt；台名按台主 URL 反解，休眠台用 URL 截断兜底（app.js exportSongs 同款格式）。
     clock 为契约保留参数（导出内容不含当前时刻，暂未使用） */
  fun songsTxt(lib: Library, @Suppress("UNUSED_PARAMETER") clock: () -> Long): String {
    val fmt = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
    data class Row(val t: String, val at: Long, val nm: String)
    val rows = ArrayList<Row>()
    for ((u0, list) in lib.allSongs()) {
      val nm = lib.resolveByUrl(u0)?.n ?: u0.replace(Regex("^https?://"), "").take(40)
      for (it in list) rows.add(Row(it.t, it.at, nm))
    }
    if (rows.isEmpty()) return ""
    rows.sortByDescending { it.at }
    return rows.joinToString("\n") { r ->
      val d = LocalDateTime.ofInstant(Instant.ofEpochMilli(r.at), ZoneId.systemDefault())
      "${r.t}（${r.nm} · ${d.format(fmt)}）"
    }
  }

  fun cfgJson(cfg: Cfg): String {
    val o = JSONObject()
    o.put("v", 1)
    o.put("cfg", JSONObject(CfgCodec.toJson(cfg)))
    return o.toString(2)
  }

  private fun myLines(myText: String): List<String> { // 原始行，去尾部空行（v3 契约：不含结尾空行）
    val ls = myText.split(Regex("\\r?\\n")).toMutableList()
    while (ls.isNotEmpty() && ls.last().trim().isEmpty()) ls.removeAt(ls.size - 1)
    return ls
  }
}
