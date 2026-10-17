package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.model.Station

/* 行协议解析（app.js parse() 同款）：radio.txt（「分类,#genre#」分节 + 「名字,地址」csv）与 m3u（#EXTINF + URL 行）
   双格式；同键（分类|台名）并源去重。返回的 Station 只填 c/n/u——dCat/dName/dU 装配默认口径留底由 Library 填。 */
object RadioTxt {

  private val GROUP = Regex("group-title=\"([^\"]*)\"")

  fun parse(text: String): List<Station> {
    val map = LinkedHashMap<String, Station>()
    var sec = "未分类"
    var pend: Pair<String, String>? = null // m3u 悬挂的 (分类, 台名)，URL 行到达时消费
    for (raw in text.split(Regex("\\r?\\n"))) {
      val line = raw.trim()
      if (line.isEmpty() || line.startsWith("#VRADIO")) continue // 本项目导出标记行，不影响导入
      if (line.endsWith("#genre#")) { sec = line.replace(Regex(",#genre#$"), ""); continue }
      if (line.startsWith("#EXTINF:", ignoreCase = true)) {
        // 属性值可含逗号（如 tvg-logo="http://a/b,c.png"）：引号外的第一个逗号才是「属性区,台名」分隔符
        var q = false; var sep = -1
        for (j in 8 until line.length) {
          val ch = line[j]
          if (ch == '"') q = !q else if (ch == ',' && !q) { sep = j; break }
        }
        val attrs = if (sep >= 0) line.substring(0, sep) else ""
        val name = if (sep >= 0) line.substring(sep + 1).trim() else ""
        val g = GROUP.find(attrs)?.groupValues?.get(1)?.trim().orEmpty()
        pend = Pair(g.ifEmpty { sec }, name) // group-title 缺省/空 → 当前节
        continue
      }
      if (line.startsWith("#")) continue
      if (line.startsWith("http://") || line.startsWith("https://")) { // m3u 的 URL 行
        pend?.let { add(map, it.first, it.second, line) }
        pend = null
        continue
      }
      // csv 风格。⚠ 与 Web 的差异点（plan-android.md 5.2/A2 契约）：安卓取前两字段、3+ 字段整行容错跳过
      // （Web 用 lastIndexOf 取末字段、容忍 URL 含逗号）；同步产物保证台名无逗号且实测全库无 3+ 字段行，
      // 两侧对正常数据解析一致，异常行安卓宁跳勿错
      val f = line.split(',')
      if (f.size != 2) continue
      add(map, sec, f[0].trim(), f[1].trim())
    }
    return map.values.toList()
  }

  private fun add(map: MutableMap<String, Station>, c: String, n: String, u: String) {
    if (n.isEmpty() || !(u.startsWith("http://") || u.startsWith("https://"))) return // URL 须 http(s)
    val k = "$c|$n"
    val st = map.getOrPut(k) { Station(c, n, mutableListOf()) }
    if (!st.u.contains(u)) st.u.add(u) // 同键并源去重
  }
}
