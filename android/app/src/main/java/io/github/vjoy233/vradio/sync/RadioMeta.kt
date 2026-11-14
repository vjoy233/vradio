package io.github.vjoy233.vradio.sync

import org.json.JSONObject

/* radio-meta.json 消费端模型（B2，plan-expansion-r4 §6.3/§13.3——生成在 Web 同步侧，安卓只消费）：
   仓库根 → gradle 资产打包（缺文件跳过）→ GitHub D7 更新（下载时校验 v==1 与可解析性，失败保留旧 meta
   不阻断主库）。元数据缺失不影响播放；坏文件按空对象兜底（parse 返回 null，调用方 ?: EMPTY）。
   形态：{v:1, generatedAt, stations:{ 身份URL: {name, category, sources:[{url, upstream, upstreamId,
   kind, firstSeenAt}]}}}。Android 本轮不生成、不回写（SyncEngine 端内同步产出 radio.txt 后旧 meta
   照旧保留——契约允许，宁旧勿混）。 */

data class MetaSource(val url: String, val upstream: String, val upstreamId: String,
                      val kind: String, val firstSeenAt: Long)

/** B3-C 发现页消费：firstSeenAt 台级直挂字段容错（Web 侧生成挂 sources[]，个别形态台级直挂——两处都读、取最早）。 */
data class MetaStation(val name: String, val category: String, val sources: List<MetaSource>,
                       val firstSeenAt: Long = 0L)

class RadioMeta private constructor(val v: Int, val generatedAt: Long,
                                    val stations: Map<String, MetaStation>) {

  companion object {
    /** 空对象兜底（坏文件/缺文件的消费端形态：无任何元数据，一切照旧）。 */
    val EMPTY = RadioMeta(1, 0L, emptyMap())

    /** 解析 + 版本门（v==1 且 stations 为对象）。null = 非法/版本不认识——更新通道据此「保留旧 meta」。
     *  单台/单源字段级坏值按缺省容错（不因个别脏行废整份）。 */
    fun parse(text: String?): RadioMeta? {
      if (text.isNullOrBlank()) return null
      val o = runCatching { JSONObject(text) }.getOrNull() ?: return null
      if (o.optInt("v", 0) != 1) return null
      val ss = o.optJSONObject("stations") ?: return null
      val out = LinkedHashMap<String, MetaStation>()
      for (id in ss.keys()) {
        val st = ss.optJSONObject(id) ?: continue
        val srcs = ArrayList<MetaSource>()
        val sa = st.optJSONArray("sources")
        if (sa != null) for (i in 0 until sa.length()) {
          val s = sa.optJSONObject(i) ?: continue
          val url = s.optString("url")
          if (url.isEmpty()) continue
          srcs.add(MetaSource(url, s.optString("upstream"), s.optString("upstreamId"),
            s.optString("kind"), s.optLong("firstSeenAt", 0L)))
        }
        out[id] = MetaStation(st.optString("name"), st.optString("category"), srcs, st.optLong("firstSeenAt", 0L))
      }
      return RadioMeta(1, o.optLong("generatedAt", 0L), out)
    }
  }
}
