package io.github.vjoy233.vradio.metadata

import io.github.vjoy233.vradio.model.Confidence
import io.github.vjoy233.vradio.model.MetadataEvent

/* 曲讯规范化 + 管线纯函数（B3-A，纯 JVM——plan-expansion-r4 §7.1 / contracts/metadata-event.json）：
   黄金样本 contracts/fixtures/metadata-golden.json 已冻结，normalizeMetadata 必须逐字段一致（双端硬验收）。
   播放层只产事件（PlayerHolder ICY → onMetadata 回调注入），消费（当前曲讯/历史/统计）在 AppVm 侧
   Legacy/MetadataV2 两 sink——模块边界：本包不碰 UI、不碰 radio.songs。 */

object MetadataNormalizer {

  /* 空白类对齐 JS \s（Java \s 是 ASCII-only 不含全角空格 U+3000——中文 ICY 曲讯常见，折叠口径须双端一致） */
  private const val SP = "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"

  /** 半/全角连接号（- － — –）前后带空格均视为 artist/track 分隔（黄金样本 description 口径）。 */
  private val SEP = Regex("$SP+[-\\uFF0D\\u2014\\u2013]$SP+")
  private val WS = Regex("$SP+")

  /** 同曲去重窗口：同名 30s 内 = 重复，不重复入史（契约 normalizeRules「短时间重复曲名」）。 */
  const val DEDUP_MS = 30_000L

  data class IcyParts(val title: String, val artist: String, val track: String)

  /** ICY title 清洗 + 拆分：空白清理（trim + 连续空白折叠）→ 重复台名前缀只剥一层（ctx.stationName，
   *  无重复不误删）→ 首个「连接号+空格」分隔拆 artist/track；无分隔整段为曲名（artist=''、track=title）。 */
  fun parseIcyTitle(rawTitle: String?, stationName: String = ""): IcyParts {
    val text = (rawTitle ?: "").trim().replace(WS, " ")
    if (text.isEmpty()) return IcyParts("", "", "")
    val cleaned = stripDupStationPrefix(text, stationName.trim())
    val m = SEP.find(cleaned)
    return if (m != null && m.range.first > 0)   // 贴边分隔（首尾）不拆，与 Web indexOf(' - ')>0 同口径
      IcyParts(cleaned, cleaned.substring(0, m.range.first).trim(), cleaned.substring(m.range.last + 1).trim())
    else IcyParts(cleaned, "", cleaned)
  }

  /** 重复台名前缀去除：头段恰为台名、且剥掉后仍是「台名+分隔」开头（重复形态）才剥，只剥一层。 */
  private fun stripDupStationPrefix(text: String, name: String): String {
    if (name.isEmpty()) return text
    val m = SEP.find(text) ?: return text
    if (m.range.first == 0 || m.range.first != name.length || !text.startsWith(name)) return text
    val rest = text.substring(m.range.last + 1)
    val m2 = SEP.find(rest) ?: return text
    return if (m2.range.first == name.length && rest.startsWith(name)) rest else text
  }

  /** 同曲去重：与上一事件同名且在窗口内（30s）= 重复，不入史不刷屏。 */
  fun isDuplicate(prev: MetadataEvent?, next: MetadataEvent, windowMs: Long = DEDUP_MS): Boolean =
    prev != null && prev.title == next.title && next.at - prev.at <= windowMs

  /* ---------- 事件构造（黄金样本 in.raw/in.ctx 形态） ---------- */

  data class IcyRaw(
    val title: String = "",
    val program: String = "",
    val bitrateKbps: Int = 0,
    val source: String = "none",   // icy|none|…
    val at: Long = 0,              // 0 = 缺省用 now（Web raw.at || Date.now() 同语义）
  )

  data class IcyCtx(
    val identityUrl: String = "",
    val stationName: String = "",
  )

  fun normalize(raw: IcyRaw, ctx: IcyCtx, now: Long = System.currentTimeMillis()): MetadataEvent {
    val p = parseIcyTitle(raw.title, ctx.stationName)
    return MetadataEvent(
      stationIdentityUrl = ctx.identityUrl,
      title = p.title,
      artist = p.artist,
      track = p.track,
      program = raw.program.trim().replace(WS, " "),   // 与 Web metaClean(program) 同口径（空串保持空）
      bitrateKbps = raw.bitrateKbps.coerceAtLeast(0),
      source = raw.source.ifEmpty { "none" },
      at = if (raw.at > 0) raw.at else now,
      confidence = if (p.artist.isNotEmpty()) Confidence.PARSED else Confidence.STREAM,
    )
  }
}

/* 曲讯管线（B3-A，eventOrder 固定序——contracts/metadata-event.json）：
   校验 identityUrl/世代 → 空曲讯不覆盖 → 丢弃过旧（迟到）事件 → 同曲去重 → 更新当前曲讯 →
   与上一曲比较（被替换的旧曲入史）。切台/刷新/全部失败先 reset 再接受新世代事件（防旧连接串台）；
   消费侧（AppVm 两 sink）据 Decision 调 PlayerHolder.setSong / Library.pushSong。 */
object MetadataPipeline {

  data class State(
    val station: String? = null,     // 当前接受事件的台身份 URL（null = 无台/已清空）
    val last: MetadataEvent? = null, // 上一接受的曲讯（同曲/迟到判定基准）
    val display: String = "",        // 当前显示曲名（被替换时入史）
    val hist: Map<String, Long> = emptyMap(),   // 入史窗口簿记（v2）：title → 入史时刻（A-B-A 抖动防重复刷史）
  )

  /** 单事件处置：show = 刷当前曲讯+MediaSession；archive = 被替换旧曲入史（u0+title）。 */
  data class Decision(val show: String?, val archiveU0: String?, val archiveTitle: String?) {
    val dropped: Boolean get() = show == null && archiveU0 == null
  }

  private val DROP = Decision(null, null, null)

  /** 切台/刷新/全部失败：清空旧曲讯（显示清理由 PlayerHolder 的 ui 承担，这里清管线簿记）。 */
  fun reset(s: State, station: String?): State = State(station, null, "")

  /** dedup30s：v2 sink 用契约 30s 窗（含 display 等价的连续同名 + 入史窗口簿记）；legacy sink 按现状口径。 */
  fun accept(s: State, ev: MetadataEvent, dedup30s: Boolean): Pair<State, Decision> {
    if (ev.title.isEmpty()) return s to DROP                                  // 空曲讯不覆盖有效曲名（HLS 不猜歌名）
    if (s.station != null && ev.stationIdentityUrl != s.station) return s to DROP   // 串台/旧世代事件丢弃
    if (s.last != null && ev.at < s.last.at) return s to DROP                 // 迟到（过旧）事件丢弃
    val dup = if (dedup30s) MetadataNormalizer.isDuplicate(s.last, ev) || s.display == ev.title
              else s.display == ev.title
    if (dup) return s.copy(station = ev.stationIdentityUrl, last = ev) to DROP   // 同曲：不刷屏不入史
    // 入史判定（v2，Web mpHistDecide 同语义）：被替换旧曲 30s 窗内已入史过则不再入（抖动 A-B-A-B 不重复刷史）；
    // 窗口外条目顺手回收，兜底封顶 16（正常进不来：窗口内条目天然有限）
    var hist = s.hist
    var arch: String? = s.display.ifEmpty { null }
    if (arch != null && dedup30s) {
      val prevAt = s.hist[arch]
      if (prevAt != null && ev.at - prevAt < MetadataNormalizer.DEDUP_MS) arch = null
      else {
        val nh = LinkedHashMap<String, Long>()
        for ((k, v) in s.hist) if (ev.at - v < MetadataNormalizer.DEDUP_MS) nh[k] = v
        nh[arch!!] = ev.at
        while (nh.size > 16) { val old = nh.entries.minByOrNull { it.value }?.key ?: break; nh.remove(old) }
        hist = nh
      }
    }
    val st = State(ev.stationIdentityUrl, ev, ev.title, hist)
    return st to Decision(ev.title, if (arch != null) ev.stationIdentityUrl else null, arch)
  }
}
