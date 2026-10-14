package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.model.Cfg
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/* 导入导出五件套（对标 app.js exportFavs/exportSongs/exportCfg/exportAll/importAll；备份 v2 = 13 键快照 + my-radio 行数组，D11）。
   v2 的 my 行 = my-radio.txt 原始行（不含结尾空行）；导入 v1（无 my 字段）不动 my-radio.txt。 */
object Backup {

  /* 导入恢复载荷：data = 白名单过滤后的 13 键快照；my = null 表示 v1 无 my 字段 */
  data class ImportPayload(val data: Map<String, String>, val my: List<String>?)

  fun exportAll(lib: Library, myText: String, at: Long): String {
    val o = JSONObject()
    o.put("v", 2)
    o.put("at", at)
    val d = JSONObject()
    for ((k, v) in lib.store.snapshot()) d.put(k, v)
    o.put("data", d)
    o.put("my", JSONArray(myLines(myText)))
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
    val m = j.optJSONArray("my")
    val my = if (m == null) null else (0 until m.length()).mapNotNull { i -> m.opt(i) as? String }
    return ImportPayload(data, my)
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

  private fun myLines(myText: String): List<String> { // 原始行，去尾部空行（v2 契约：不含结尾空行）
    val ls = myText.split(Regex("\\r?\\n")).toMutableList()
    while (ls.isNotEmpty() && ls.last().trim().isEmpty()) ls.removeAt(ls.size - 1)
    return ls
  }
}
