package io.github.vjoy233.vradio.sync

import org.json.JSONObject

/* radio-meta.json 消费端模型（B2，plan-expansion-r4 §6.3/§13.3——生成在 Web 同步侧，安卓只消费）：
   仓库根 → gradle 资产打包（缺文件跳过）→ GitHub D7 更新（下载时校验 v==1 与可解析性；AIbot P1-4 起
   拿不到/非法即删旧件——旧 meta 配新 radio 是混态，宁缺勿混）。元数据缺失不影响播放；坏文件按空对象兜底
   （parse 返回 null，调用方 ?: EMPTY）。
   形态：{v:1, generatedAt, stations:{ 身份URL: {name, category, sources:[{url, upstream, upstreamId,
   kind, firstSeenAt}]}}}。Android 本轮不生成、不回写；发现页「最近新增」消费前须过 bound() 同批绑定校验
   （见下），混态该分组置空不猜。 */

data class MetaSource(val url: String, val upstream: String, val upstreamId: String,
                      val kind: String, val firstSeenAt: Long,
                      val lastSeenAt: Long = firstSeenAt, val lastVerifiedAt: Long = 0L,
                      val verification: String = "unknown")

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
          val firstSeenAt = s.optLong("firstSeenAt", 0L)
          val verification = s.optString("verification", "unknown").takeIf { it == "sync" } ?: "unknown"
          srcs.add(MetaSource(url, s.optString("upstream"), s.optString("upstreamId"),
            s.optString("kind"), firstSeenAt, s.optLong("lastSeenAt", firstSeenAt),
            s.optLong("lastVerifiedAt", 0L), verification))
        }
        out[id] = MetaStation(st.optString("name"), st.optString("category"), srcs, st.optLong("firstSeenAt", 0L))
      }
      return RadioMeta(1, o.optLong("generatedAt", 0L), out)
    }

    /** meta 与当前 radio 资产的同批绑定校验（AIbot P1-4；三轮 P1 升级内容哈希三重见证）：meta 与
     *  radio.txt 不同批时 firstSeenAt 指错台，「最近新增」不得展示（置空，不猜）。绑定判据（保守）：
     *  ① 两者来源必须同为 filesDir 或同为 assets（gradle 打包对天然同批；filesDir radio + assets meta
     *     即混态）；② 同为 filesDir 时还须 stamp.json 三重见证全过（LightUpdate.apply 批次末位写）：
     *     meta=true + radioHash 一致 + metaHash 一致——radio 写成功而 meta 写失败时即便旧 meta 文件与
     *     旧 stamp（meta=true）残留，新 radio 内容哈希 ≠ 旧 stamp 记录，仍判不绑定（不误绑）。
     *  radioFromFiles/metaFromFiles = 对应 filesDir 副本是否存在；stampMetaOk = stamp 的 meta 见证
     *  （null = 旧版 stamp 无字段）；radioHashOk/metaHashOk = LightUpdate.stampHashOk 的内容哈希核对
     *  （null = 旧 stamp 无哈希字段——B2/B3 早期 stamp 一律保守不绑定，直到下一次成功更新带回见证）。 */
    fun bound(radioFromFiles: Boolean, metaFromFiles: Boolean, stampMetaOk: Boolean?,
              radioHashOk: Boolean? = null, metaHashOk: Boolean? = null): Boolean =
      radioFromFiles == metaFromFiles &&
        (!radioFromFiles || (stampMetaOk == true && radioHashOk == true && metaHashOk == true))
  }
}
