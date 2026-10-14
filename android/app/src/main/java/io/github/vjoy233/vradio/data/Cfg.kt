package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.model.Cfg
import org.json.JSONArray
import org.json.JSONObject

/* 维护配置 radio.cfg 的编解码（app.js:77-92 normCfg 同语义）：结构与持久化、导入 JSON 共用一套校验，
   坏形状回退空配置。键 = 源 URL（身份公理），同步重建后自动复用。 */

/* JSON 值的 JS 真值口径（hideS/hideC/perm 等用；JSON 类型只有 Boolean/数值/字符串/null） */
internal fun truthy(v: Any?): Boolean = when (v) {
  null -> false
  is Boolean -> v
  is Int -> v != 0
  is Long -> v != 0L
  is Double -> v != 0.0
  is String -> v.isNotEmpty()
  else -> true
}

object CfgCodec {
  private val URL_KEY = Regex("^https?://")

  fun parse(raw: String?): Cfg {
    val o = raw?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return Cfg() // 坏 JSON/数组/字面量 → 空配置
    val moves = strMap(o.optJSONObject("moves"), false)   // URL → 字符串
    val names = strMap(o.optJSONObject("names"), false)
    val tag = strMap(o.optJSONObject("tag"), false)       // 原名快照（失配清单显示用）
    val renames = strMap(o.optJSONObject("renames"), true) // 分类名 → 分类名（键非 URL 不过滤）
    val hideS = urlBoolMap(o.optJSONObject("hideS"))      // URL → 手藏电台
    val srcs = urlArrMap(o.optJSONObject("srcs"))         // URL → 追加备选源（条 6 × 512 封顶）
    val hideC = strBoolMap(o.optJSONObject("hideC"))      // 分类名 → 藏分类
    var cats = emptyList<String>()
    val ca = o.optJSONArray("cats")
    if (ca != null) {
      val seen = LinkedHashSet<String>()
      for (i in 0 until ca.length()) {
        val v = ca.opt(i)
        if (v !is String) continue
        val t = v.trim()
        if (t.isEmpty() || t.contains('|')) continue // '|' 是 keyOf 分隔符，防串台
        seen.add(t)
      }
      cats = seen.toList()
    }
    return Cfg(moves, names, tag, renames, hideS, hideC, srcs, cats)
  }

  fun toJson(c: Cfg): String {
    val o = JSONObject()
    o.put("moves", JSONObject(c.moves))
    o.put("names", JSONObject(c.names))
    o.put("tag", JSONObject(c.tag))
    o.put("renames", JSONObject(c.renames))
    val hs = JSONObject(); for ((k, v) in c.hideS) hs.put(k, v); o.put("hideS", hs)
    val hc = JSONObject(); for ((k, v) in c.hideC) hc.put(k, v); o.put("hideC", hc)
    val sp = JSONObject(); for ((k, v) in c.srcs) sp.put(k, JSONArray(v)); o.put("srcs", sp)
    o.put("cats", JSONArray(c.cats))
    return o.toString()
  }

  fun count(c: Cfg): Int = c.moves.size + c.names.size + c.hideS.size + c.renames.size + c.hideC.size + c.srcs.size + c.cats.size

  /* 字符串映射：值须非空字符串；anyKey=false 时键须 http(s)（存入前 trim，Web 同款） */
  private fun strMap(o: JSONObject?, anyKey: Boolean): Map<String, String> {
    if (o == null) return emptyMap()
    val out = LinkedHashMap<String, String>()
    for (k in o.keys()) {
      val v = o.opt(k)
      if (v !is String) continue
      val vt = v.trim()
      if (vt.isEmpty()) continue
      if (!anyKey && URL_KEY.find(k) == null) continue
      out[k.trim()] = vt
    }
    return out
  }

  /* hideS：键须 http(s)；值转真值（Web 的 urlKeys 只滤键、真值判定在使用点，此处收敛为 Boolean） */
  private fun urlBoolMap(o: JSONObject?): Map<String, Boolean> {
    if (o == null) return emptyMap()
    val out = LinkedHashMap<String, Boolean>()
    for (k in o.keys()) if (URL_KEY.find(k) != null) out[k.trim()] = truthy(o.opt(k))
    return out
  }

  /* hideC：键须非空字符串、值真值才收（Web strKeys 同判，AIbot P2-4：falsy 值 0/"" 在 Web=显示，
     此处若留键会被 containsKey 判成隐藏——导入通道能产生 falsy，语义必须对齐） */
  private fun strBoolMap(o: JSONObject?): Map<String, Boolean> {
    if (o == null) return emptyMap()
    val out = LinkedHashMap<String, Boolean>()
    for (k in o.keys()) {
      val kt = k.trim()
      if (kt.isEmpty()) continue
      val v = o.opt(k)
      if (v == null || !truthy(v)) continue
      out[kt] = true
    }
    return out
  }

  /* srcs：键须 http(s) 且值为数组；元素 trim/512 截断后须 http(s)，去重后取前 6；空数组整键丢弃 */
  private fun urlArrMap(o: JSONObject?): Map<String, List<String>> {
    if (o == null) return emptyMap()
    val out = LinkedHashMap<String, List<String>>()
    for (k in o.keys()) {
      if (URL_KEY.find(k) == null) continue
      val v = o.opt(k)
      if (v !is JSONArray) continue
      val seen = LinkedHashSet<String>()
      for (i in 0 until v.length()) {
        val xs = v.optString(i, "").trim().take(512)
        if (URL_KEY.find(xs) != null) seen.add(xs)
      }
      val a = seen.toList().take(6)
      if (a.isNotEmpty()) out[k.trim()] = a
    }
    return out
  }
}
