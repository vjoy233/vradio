package io.github.vjoy233.vradio.stats

import io.github.vjoy233.vradio.data.writeTextAtomic
import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.Station
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/* 本地收听统计（B3-B，plan-expansion-r4 §7.2，纯 JVM）：只记真实播放（诊断成功不算收听）、
   只 PLAYING 累加；mono 时钟（SystemClock.elapsedRealtime 语义）算增量 + wall 时钟做日桶
   （clock 双注入供测试）；回拨不产负值；跨午夜拆两日；90 天裁剪；512KB 先删最早日；
   sessions 口径（§7.2 双端冻结措辞）：session = 从非 PLAYING 进入 PLAYING 且不属于「同一台同一源」的
   暂停恢复（play/切台/切源/断流重连首达 PLAYING 均计一次；resume 重锚不开新 session、暂停时长不计）；
   日期键历法严格校验（AIbot P1-1：validDay，坏键编解码入口丢弃）；flush 幂等（快照覆盖语义）。
   sidecar = filesDir/listen-stats.json（不进 radio.* 主 Store、不占配额、不进备份；坏文件按空库恢复，
   写失败只保留内存增量下次 flush/启动重试——绝不暂停或中断播放）。
   状态机映射（AppVm 接线）：IDLE/CONNECTING/PLAYING/PAUSED 直接对应 PState；FAILED = 全部源失败善后
   （IDLE + 台清空的形态）——四者一律不累加（只收口当前会话）。 */

/** 单日桶（键 = yyyy-MM-dd 本地时区）。 */
data class StatsDay(
  var ms: Long = 0L,
  val stations: MutableMap<String, Long> = LinkedHashMap(),   // 身份 URL → ms
  val categories: MutableMap<String, Long> = LinkedHashMap(), // 分类名 → ms
  var sessions: Int = 0,
)

/** 统计状态（sidecar 全量形态）。 */
data class StatsState(val v: Int = 1, val days: LinkedHashMap<String, StatsDay> = LinkedHashMap())

/** 近 N 天汇总（发现/设置页展示口径）。 */
data class StatsSummary(
  val days: Int, val totalMs: Long, val sessions: Int,
  val stations: Map<String, Long>, val categories: Map<String, Long>,
)

/** 进行中会话锚点：monoAt/wallAt = 会话起点（或上次结算点，settle 后前移）。 */
data class ListeningSession(val u0: String, val cat: String, val source: String,
                            val monoAt: Long, val wallAt: Long)

object ListenStats {

  const val KEEP_DAYS = 90
  const val MAX_BYTES = 512 * 1024
  private val DAY_RE = Regex("^\\d{4}-\\d{2}-\\d{2}$")

  internal fun dayKey(wallMs: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(wallMs))

  /** 日期键历法校验（AIbot P1-1，与 Web lsDayKeyOk 同规则双端黄金）：YYYY-MM-DD 且月/日真实存在——
   *  02-31、13-01、00 月/日、非闰年 02-29 一律拒绝（2024-02-29 闰年放行）。损坏 sidecar 注入的
   *  任意 key 在编解码入口丢弃，只影响统计自身（90 天裁剪/summary 排序不失真）。 */
  fun validDay(k: String?): Boolean {
    if (k == null || !DAY_RE.matches(k)) return false
    val p = k.split("-")
    val y = p[0].toInt(); val m = p[1].toInt(); val d = p[2].toInt()
    if (m !in 1..12 || d < 1) return false
    val leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
    val dim = intArrayOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    return d <= dim[m - 1]
  }

  /** 下一本地午夜（wall 段拆日边界；DST 由 Calendar 处理）。 */
  private fun endOfDay(wallMs: Long): Long = Calendar.getInstance().apply {
    timeInMillis = wallMs
    set(Calendar.HOUR_OF_DAY, 24); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
  }.timeInMillis

  /** 进入 PLAYING 计数（§7.2 冻结口径）：新建流到达 PLAYING 才 +1——暂停后同台同源 resume 重锚不开新
   *  （ListenTracker 侧把关），切台/切源/断流重连首达均算新 session。 */
  fun enter(state: StatsState, u0: String, cat: String, wallNow: Long) {
    state.days.getOrPut(dayKey(wallNow)) { StatsDay() }.sessions++
  }

  /** 一段增量入账：delta = max(0, nowMono - 锚点)（回拨钳 0）；跨午夜按 wall 时长占比拆到两个自然日。 */
  fun add(state: StatsState, session: ListeningSession, nowMono: Long, nowWall: Long): StatsState {
    val delta = nowMono - session.monoAt
    if (delta <= 0) return state
    if (nowWall <= session.wallAt) { bucket(state, dayKey(session.wallAt), session, delta); return state }  // wall 回拨/停摆：整段记起点日
    val span = nowWall - session.wallAt
    var from = session.wallAt
    var remain = delta
    var guard = 0
    while (guard++ < 400) {   // 每轮至少推进一个自然日（wall 大跳时也能收敛）
      val dayEnd = endOfDay(from)
      if (dayEnd <= from || dayEnd >= nowWall) { bucket(state, dayKey(from), session, remain); break }
      val part = remain * (dayEnd - from) / span   // 按墙钟占比拆（mono/wall 独立回拨互不产负段）
      if (part > 0) bucket(state, dayKey(from), session, part)
      remain -= part
      from = dayEnd
      if (remain <= 0) break
    }
    return state
  }

  private fun bucket(state: StatsState, day: String, s: ListeningSession, ms: Long) {
    if (ms <= 0 || !validDay(day)) return
    val d = state.days.getOrPut(day) { StatsDay() }
    d.ms += ms
    d.stations[s.u0] = (d.stations[s.u0] ?: 0L) + ms
    d.categories[s.cat] = (d.categories[s.cat] ?: 0L) + ms
  }

  /** 90 天裁剪 + 512KB 硬上限（超限先删最早日期）。measure 注入序列化器（测试可量字节）。 */
  fun trim(state: StatsState, keepDays: Int = KEEP_DAYS, maxBytes: Int = MAX_BYTES,
           measure: (StatsState) -> Int = { ListenStatsCodec.toJson(it).toByteArray().size }): StatsState {
    while (state.days.size > keepDays) state.days.remove(state.days.keys.min()!!)
    while (state.days.isNotEmpty() && measure(state) > maxBytes) state.days.remove(state.days.keys.min()!!)
    return state
  }

  /** 最近 N 个自然日汇总（按日键降序取 N）。 */
  fun summary(state: StatsState, days: Int = 7): StatsSummary {
    val ks = state.days.keys.sortedDescending().take(days)
    var ms = 0L; var ses = 0
    val st = LinkedHashMap<String, Long>(); val cg = LinkedHashMap<String, Long>()
    for (k in ks) {
      val d = state.days[k] ?: continue
      ms += d.ms; ses += d.sessions
      for ((u, v) in d.stations) st[u] = (st[u] ?: 0L) + v
      for ((c, v) in d.categories) cg[c] = (cg[c] ?: 0L) + v
    }
    return StatsSummary(ks.size, ms, ses, st, cg)
  }
}

/** sidecar 编解码（{v:1, days:{…}} 与 Web data/listen-stats.json 同构）。 */
object ListenStatsCodec {

  fun parse(text: String?): StatsState {
    val out = StatsState()
    if (text.isNullOrBlank()) return out
    val o = runCatching { JSONObject(text) }.getOrNull() ?: return out
    if (o.optInt("v", 0) != 1) return out
    val ds = o.optJSONObject("days") ?: return out
    for (k in ds.keys()) {
      if (!ListenStats.validDay(k)) continue   // 非法日期键丢弃（AIbot P1-1：坏键不入 days，裁剪/summary 排序不失真）
      val d = ds.optJSONObject(k) ?: continue
      val day = StatsDay(d.optLong("ms", 0L), mapOf(d.optJSONObject("stations")), mapOf(d.optJSONObject("categories")), d.optInt("sessions", 0))
      if (day.ms > 0 || day.sessions > 0) out.days[k] = day
    }
    return out
  }

  private fun mapOf(o: JSONObject?): MutableMap<String, Long> {
    val out = LinkedHashMap<String, Long>()
    o ?: return out
    for (k in o.keys()) out[k] = o.optLong(k, 0L)
    return out
  }

  fun toJson(state: StatsState): String {
    val days = JSONObject()
    for ((k, d) in state.days) days.put(k, JSONObject()
      .put("ms", d.ms)
      .put("stations", JSONObject(d.stations.toMap()))
      .put("categories", JSONObject(d.categories.toMap()))
      .put("sessions", d.sessions))
    return JSONObject().put("v", state.v).put("days", days).toString()
  }
}

/** sidecar IO：filesDir/listen-stats.json（tmp+rename；坏文件按空库恢复；写失败静默——内存增量下次重试）。
 *  writeFn 注入供测试模拟写盘失败。 */
class ListenSidecar(
  private val dir: File,
  private val writeFn: (String) -> Unit = { t -> writeTextAtomic(File(dir, FILE), t) },
) {
  companion object { const val FILE = "listen-stats.json" }

  @Synchronized fun load(): StatsState =
    ListenStatsCodec.parse(runCatching { File(dir, FILE).takeIf { it.isFile }?.readText() }.getOrNull())

  @Synchronized fun save(state: StatsState) {
    runCatching { writeFn(ListenStatsCodec.toJson(state)) }
      .onFailure { println("[vradio] listen-stats.json 落盘失败（保留内存增量，下次 flush/启动重试）: $it") }
  }
}

/** 会话状态机（AppVm 从 PlayerUiState 流映射驱动；只 PLAYING 开会话，其余状态收口）。
 *  语义镜像 Web listen-stats.js（§7.2 拍板）：新建流到达 PLAYING（play/切台/切源/重连首达）才计 sessions；
 *  暂停关账但保留「resume 重锚资格」——续播同台同源不开新 session（暂停时长不计）；连接中/失败/停机彻底关。 */
class ListenTracker(
  private val mono: () -> Long,
  private val wall: () -> Long,
  initial: StatsState = StatsState(),
) {
  companion object { const val TICK_MIN_MS = 1000L }   // ≥1s 才入账（Web tickMin 同款；不足 1s 不动锚、跨 tick 累计）

  var state: StatsState = initial
    private set
  private var cur: ListeningSession? = null
  private var pendingResume: Pair<String, String>? = null   // PAUSED 时保留的 (u0, src)：续播重锚资格

  /** PState 流入口。FAILED 映射 = 全部源失败善后（IDLE+清台），与 IDLE 同路（关会话）。 */
  fun onState(st: PState, station: Station?, sourceUrl: String?) {
    if (st == PState.PLAYING && station != null && station.u.isNotEmpty()) {
      val src = sourceUrl ?: station.u0
      val c = cur
      when {
        c != null && c.u0 == station.u0 && c.source == src -> Unit     // 持续播放：无事件
        pendingResume != null && pendingResume!!.first == station.u0 && pendingResume!!.second == src -> {
          pendingResume = null                                         // resume 重锚：暂停时长不计、不开新 session
          cur = ListeningSession(station.u0, station.c, src, mono(), wall())
        }
        else -> {                                                      // 新建流到达：结算旧会话、开新（sessions+1）
          settle(); pendingResume = null
          val w = wall()
          cur = ListeningSession(station.u0, station.c, src, mono(), w)
          ListenStats.enter(state, station.u0, station.c, w)
        }
      }
    } else if (st == PState.PAUSED && cur != null) {
      val c = cur!!
      settle()
      pendingResume = c.u0 to c.source                                 // 暂停关账、保留 resume 资格
      cur = null
    } else {
      settle(); cur = null; pendingResume = null                       // 连接中/失败/停机：彻底关
    }
  }

  /** 收账：进行中会话增量入账（≥1s 才入，锚点随入账/回拨前移）；30s tick/flush 前调。 */
  fun settle(): Boolean {
    val c = cur ?: return false
    val m = mono(); val w = wall()
    if (m - c.monoAt >= TICK_MIN_MS) {
      state = ListenStats.add(state, c, m, w)
      cur = ListeningSession(c.u0, c.cat, c.source, m, w)
    } else if (m < c.monoAt) {   // 单钟回拨：重锚不产负值
      cur = ListeningSession(c.u0, c.cat, c.source, m, w)
    }
    return true
  }
}
