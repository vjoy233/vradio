package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.model.Cfg
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/* 导入导出五件套（对标 app.js exportFavs/exportSongs/exportCfg/exportAll/importAll）。
   备份 v3（r4/B4，契约 contracts/backup-v3.schema.json）：{format:"vradio-backup",version:3,createdAt,app,
   data:13键快照, myRadio:my-radio.txt 原始行, extensions:{}}；导出统一 v3；导入兼容 v1（无 my 不动 my-radio.txt）/
   v2（读 my 数组）/v3（读 myRadio + extensions.sidecars.quality 解析校验留存——B2 前无消费方，暂不落盘）。
   版本映射与 Web backup.js（BackupV3.read）同构；黄金样本 contracts/fixtures/backup-v2.json、backup-v3.json 双端一致消费。 */
object Backup {

  /* 导入恢复载荷：data = 白名单过滤后的 13 键快照；my = null 表示该版本不带个人电台字段（v1，或 v2/v3 字段
     缺失）→ 不动 my-radio.txt；quality = v3 extensions.sidecars.quality（已裁剪，B2 前仅校验留存） */
  data class ImportPayload(
    val ver: Int,                        // 1|2|3（预览文案用）
    val data: Map<String, String>,
    val my: List<String>?,
    val quality: JSONObject? = null,     // {v:1, data:{…迁移字段}}
  )

  fun exportAll(lib: Library, myText: String, at: Long): String {
    val o = JSONObject()
    o.put("format", "vradio-backup")
    o.put("version", 3)
    o.put("createdAt", at)
    o.put("app", "android")
    val d = JSONObject()
    for ((k, v) in lib.store.snapshot()) d.put(k, v)
    o.put("data", d)
    o.put("myRadio", JSONArray(myLines(myText)))
    o.put("extensions", JSONObject()) // 质量侧 Android 生产方在 B2（QualityStore）——落地前恒空，listenStats B3 同理
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
    // v3 extensions.sidecars.quality：解析校验留存（B2 前无消费方不落盘）；listenStats/未知扩展忽略不失败
    var quality: JSONObject? = null
    if (ver == 3) {
      val qd = j.optJSONObject("extensions")?.optJSONObject("sidecars")?.optJSONObject("quality")?.optJSONObject("data")
      if (qd != null) quality = JSONObject().put("v", 1).put("data", qualityTrim(qd))
    }
    return ImportPayload(ver, data, my, quality)
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
