package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.stats.ListenSidecar
import io.github.vjoy233.vradio.stats.ListenStats
import io.github.vjoy233.vradio.stats.ListenStatsCodec
import io.github.vjoy233.vradio.stats.ListenTracker
import io.github.vjoy233.vradio.stats.StatsDay
import io.github.vjoy233.vradio.stats.StatsState
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlin.io.path.createTempDirectory
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/* 收听统计（B3-B，plan-expansion-r4 §7.2）：fake clock 全矩阵——播放/暂停/连接中/失败/切源/切台/
   跨午夜/回拨（mono/wall 各自）/90 天裁剪/512KB 超限/幂等 flush/写失败不影响/坏件恢复/编解码往返/summary。 */
class ListenStatsTest {

  private class Fake(var mono: Long = 0L, var wall: Long = WALL0)
  private fun tracker(c: Fake, init: StatsState = StatsState()) = ListenTracker({ c.mono }, { c.wall }, init)

  private val s1 = Station("华语音乐", "台A", mutableListOf("http://a/1", "http://a/2.mp3"))
  private val s2 = Station("欧美音乐", "台B", mutableListOf("http://b/1"))

  private lateinit var dir: File
  @Before fun setup() { dir = createTempDirectory("vradio-stats").toFile() }
  @After fun teardown() { dir.deleteRecursively() }

  /* ---------- 状态机矩阵 ---------- */

  @Test fun 播放累加暂停不计时() {
    val c = Fake(); val t = tracker(c)
    t.onState(PState.PLAYING, s1, "http://a/1")
    c.mono += 60_000; c.wall += 60_000
    t.onState(PState.PAUSED, s1, "http://a/1")   // 暂停即收口
    c.mono += 60_000; c.wall += 60_000
    t.settle()
    val d = t.state.days.values.single()
    assertEquals(60_000L, d.ms)
    assertEquals(60_000L, d.stations["http://a/1"])
    assertEquals(60_000L, d.categories["华语音乐"])
    assertEquals(1, d.sessions)
  }

  @Test fun 连接中与失败不计时() {
    val c = Fake(); val t = tracker(c)
    t.onState(PState.CONNECTING, s1, "http://a/1"); c.mono += 30_000; c.wall += 30_000
    t.onState(PState.IDLE, null, null); c.mono += 30_000; c.wall += 30_000   // FAILED 映射 = 全部源失败善后（IDLE+清台）
    t.onState(PState.PLAYING, s1, "http://a/1")
    c.mono += 10_000; c.wall += 10_000
    t.settle()
    val d = t.state.days.values.single()
    assertEquals(10_000L, d.ms)   // 只 PLAYING 段计入（诊断/连接不算收听）
    assertEquals(1, d.sessions)
  }

  @Test fun 切源结束旧会话按进入PLAYING计sessions() {
    val c = Fake(); val t = tracker(c)
    t.onState(PState.PLAYING, s1, "http://a/1"); c.mono += 30_000; c.wall += 30_000
    t.onState(PState.CONNECTING, s1, "http://a/2.mp3"); c.mono += 5_000; c.wall += 5_000   // 断流换源（旧会话收口）
    t.onState(PState.PLAYING, s1, "http://a/2.mp3"); c.mono += 30_000; c.wall += 30_000
    t.settle()
    val d = t.state.days.values.single()
    assertEquals(60_000L, d.ms)   // 同日连续切源累计到同一台
    assertEquals(2, d.sessions)   // 进入 PLAYING 两次
  }

  @Test fun 切台另起台账() {
    val c = Fake(); val t = tracker(c)
    t.onState(PState.PLAYING, s1, "http://a/1"); c.mono += 20_000; c.wall += 20_000
    t.onState(PState.PLAYING, s2, "http://b/1"); c.mono += 20_000; c.wall += 20_000
    t.settle()
    val d = t.state.days.values.single()
    assertEquals(20_000L, d.stations["http://a/1"])
    assertEquals(20_000L, d.stations["http://b/1"])
    assertEquals(20_000L, d.categories["华语音乐"])
    assertEquals(20_000L, d.categories["欧美音乐"])
    assertEquals(2, d.sessions)
  }

  @Test fun 同台同源持续播放无新会话() {
    val c = Fake(); val t = tracker(c)
    t.onState(PState.PLAYING, s1, "http://a/1")
    t.onState(PState.PLAYING, s1, "http://a/1"); c.mono += 30_000; c.wall += 30_000
    t.settle()
    assertEquals(1, t.state.days.values.single().sessions)
  }

  @Test fun 停止即收口() {
    val c = Fake(); val t = tracker(c)
    t.onState(PState.PLAYING, s1, "http://a/1"); c.mono += 15_000; c.wall += 15_000
    t.onState(PState.IDLE, null, null)
    assertEquals(15_000L, t.state.days.values.single().ms)
    c.mono += 60_000; c.wall += 60_000
    t.settle()
    assertEquals(15_000L, t.state.days.values.single().ms)   // 无会话不再增长
  }

  @Test fun 暂停续播重锚不开新会话() {   // Web 口径：resume 不经 enterPlaying、暂停时长不计
    val c = Fake(); val t = tracker(c)
    t.onState(PState.PLAYING, s1, "http://a/1"); c.mono += 30_000; c.wall += 30_000
    t.onState(PState.PAUSED, s1, "http://a/1")   // 暂停关账（30s 已入账）
    c.mono += 120_000; c.wall += 120_000         // 暂停 2 分钟
    t.settle()                                   // 暂停期 flush：无会话不入账
    t.onState(PState.PLAYING, s1, "http://a/1")  // resume：重锚、不开新 session
    c.mono += 30_000; c.wall += 30_000
    t.settle()
    val d = t.state.days.values.single()
    assertEquals(60_000L, d.ms)                  // 30s + 30s，暂停 2 分钟不计
    assertEquals(1, d.sessions)
  }

  @Test fun 暂停后换源重连开新会话() {   // resume 资格只对同台同源；换源重连 = 新建流到达
    val c = Fake(); val t = tracker(c)
    t.onState(PState.PLAYING, s1, "http://a/1"); c.mono += 30_000; c.wall += 30_000
    t.onState(PState.PAUSED, s1, "http://a/1")
    t.onState(PState.CONNECTING, s1, "http://a/2.mp3")
    t.onState(PState.PLAYING, s1, "http://a/2.mp3"); c.mono += 30_000; c.wall += 30_000
    t.settle()
    val d = t.state.days.values.single()
    assertEquals(60_000L, d.ms)
    assertEquals(2, d.sessions)
  }

  @Test fun 不足一秒不入账跨tick累计() {   // Web tickMin 同款：≥1s 才入账、不足不动锚
    val c = Fake(); val t = tracker(c)
    t.onState(PState.PLAYING, s1, "http://a/1")
    c.mono += 400; c.wall += 400; t.settle()
    c.mono += 400; c.wall += 400; t.settle()
    assertEquals(0L, t.state.days.values.sumOf { it.ms })   // 800ms 未过阈值（sessions 桶已建，ms=0）
    c.mono += 400; c.wall += 400; t.settle()
    assertEquals(1200L, t.state.days.values.single().ms)    // 累计 1200ms ≥1s 整段入账
  }

  /* ---------- 时钟回拨与跨午夜 ---------- */

  @Test fun mono回拨不产负值且锚点前移() {
    val c = Fake(); val t = tracker(c)
    t.onState(PState.PLAYING, s1, "http://a/1")
    c.mono += 30_000; c.wall += 30_000
    t.settle()
    c.mono -= 60_000   // 回拨到更早
    t.settle()         // delta=0 且锚点前移
    c.mono += 45_000; c.wall += 45_000
    t.settle()
    assertEquals(75_000L, t.state.days.values.single().ms)   // 30s + 45s（回拨段 0），无负值
  }

  @Test fun wall回拨整段记起点日() {
    val c = Fake(); val t = tracker(c)
    t.onState(PState.PLAYING, s1, "http://a/1")
    c.mono += 30_000
    c.wall -= 3600_000   // wall 回拨一小时
    t.settle()
    assertEquals(30_000L, t.state.days.values.single().ms)
    assertEquals(WALL0_DAY, t.state.days.keys.single())
  }

  @Test fun 跨午夜拆两日() {
    val c = Fake(wall = at(2026, 11, 14, 23, 30)); val t = tracker(c)
    t.onState(PState.PLAYING, s1, "http://a/1")
    c.mono += 60 * 60_000L; c.wall = at(2026, 11, 15, 0, 30)   // 23:30 → 00:30
    t.settle()
    assertEquals(2, t.state.days.size)
    assertEquals(30 * 60_000L, t.state.days["2026-11-14"]!!.ms)
    assertEquals(30 * 60_000L, t.state.days["2026-11-15"]!!.ms)
    assertEquals(30 * 60_000L, t.state.days["2026-11-14"]!!.stations["http://a/1"])
  }

  @Test fun wall大跳总量恒等mono() {   // wall 异常大跳（span 覆盖多日）：按占比拆、guard 收敛，总量不因 wall 多产
    val c = Fake(wall = at(2026, 11, 14, 23, 30)); val t = tracker(c)
    t.onState(PState.PLAYING, s1, "http://a/1")
    c.mono += 60_000L; c.wall = at(2026, 11, 18, 23, 30)
    t.settle()
    assertEquals(60_000L, t.state.days.values.sumOf { it.ms })
    assertTrue(t.state.days.size in 2..5)
  }

  /* ---------- 裁剪与上限 ---------- */

  private fun days(n: Int): StatsState {   // 2026-01-01 起连续 n 日
    val st = StatsState()
    for (i in 0 until n) {
      val cal = Calendar.getInstance(); cal.timeInMillis = at(2026, 1, 1, 0, 0); cal.add(Calendar.DAY_OF_MONTH, i)
      st.days[dayKeyOf(cal.timeInMillis)] = StatsDay(ms = 1000L)
    }
    return st
  }

  @Test fun 九十天裁剪保留最近() {
    val st = days(95)
    ListenStats.trim(st)
    assertEquals(90, st.days.size)
    assertNull(st.days[dayKeyOf(at(2026, 1, 1, 0, 0))])     // 最早 5 天被裁
    assertNotNull(st.days[dayKeyOf(at(2026, 4, 5, 0, 0))]) // 第 95 天（1/1 + 94 天）保留
  }

  @Test fun 五百一十二KB先删最早日() {
    val st = days(10)
    val full = ListenStatsCodec.toJson(st).toByteArray().size
    ListenStats.trim(st, keepDays = 90, maxBytes = full - 1)   // 差 1 字节 → 至少删 1 天
    assertTrue(st.days.size < 10)
    assertNull(st.days[dayKeyOf(at(2026, 1, 1, 0, 0))])        // 最早先走
  }

  /* ---------- 编解码与 sidecar ---------- */

  @Test fun 编解码往返与坏件空库() {
    val st = StatsState()
    st.days["2026-11-14"] = StatsDay(1820000L, linkedMapOf("https://main.example/live" to 1200000L),
      linkedMapOf("华语音乐" to 1200000L), 3)
    assertEquals(st, ListenStatsCodec.parse(ListenStatsCodec.toJson(st)))
    assertEquals(StatsState(), ListenStatsCodec.parse("not json{"))
    assertEquals(StatsState(), ListenStatsCodec.parse(null))
    assertEquals(StatsState(), ListenStatsCodec.parse("""{"v":2,"days":{}}"""))   // 版本门
  }

  @Test fun 契约样例形态() {   // plan §7.2 JSON 样例逐字段
    val st = StatsState()
    st.days["2026-11-14"] = StatsDay(1820000L, linkedMapOf("https://main.example/live" to 1200000L),
      linkedMapOf("华语音乐" to 1200000L), 3)
    val j = org.json.JSONObject(ListenStatsCodec.toJson(st))
    assertEquals(1, j.getInt("v"))
    val d = j.getJSONObject("days").getJSONObject("2026-11-14")
    assertEquals(1820000L, d.getLong("ms"))
    assertEquals(1200000L, d.getJSONObject("stations").getLong("https://main.example/live"))
    assertEquals(1200000L, d.getJSONObject("categories").getLong("华语音乐"))
    assertEquals(3, d.getInt("sessions"))
  }

  @Test fun sidecar持久往返与幂等flush() {
    val st = StatsState()
    st.days["2026-11-14"] = StatsDay(60000L, linkedMapOf("http://a/1" to 60000L), linkedMapOf("华语音乐" to 60000L), 1)
    val sc = ListenSidecar(dir)
    sc.save(st); sc.save(st); sc.save(st)   // 多次 flush 幂等（快照覆盖语义）
    assertEquals(st, ListenSidecar(dir).load())
  }

  @Test fun 坏文件按空库恢复() {
    File(dir, ListenSidecar.FILE).writeText("garbage{")
    assertEquals(StatsState(), ListenSidecar(dir).load())
  }

  @Test fun 写失败不影响统计不抛() {   // injectable store 模拟写盘失败：内存账保留、下次 flush 重试
    var fail = true
    val sc = ListenSidecar(dir) { t ->
      if (fail) throw java.io.IOException("disk full")
      io.github.vjoy233.vradio.data.writeTextAtomic(File(dir, ListenSidecar.FILE), t)
    }
    val st = StatsState()
    st.days["2026-11-14"] = StatsDay(60000L, linkedMapOf("http://a/1" to 60000L), linkedMapOf("华语音乐" to 60000L), 1)
    sc.save(st)   // 不抛
    assertEquals(StatsState(), ListenSidecar(dir).load())   // 盘上没有
    fail = false
    sc.save(st)   // 重试成功（恢复正常写路径）
    assertEquals(st, ListenSidecar(dir).load())
  }

  /* ---------- summary ---------- */

  @Test fun summary七天窗口聚合() {
    val st = days(10)
    for (d in st.days.values) { d.stations["http://a/1"] = 1000L; d.categories["华语音乐"] = 1000L; d.sessions = 1 }
    val s = ListenStats.summary(st, days = 7)
    assertEquals(7, s.days)
    assertEquals(7000L, s.totalMs)
    assertEquals(7, s.sessions)
    assertEquals(7000L, s.stations["http://a/1"])
  }

  /* ---------- 工具 ---------- */

  private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int): Long = Calendar.getInstance().apply {
    clear(); set(y, mo - 1, d, h, mi, 0)
  }.timeInMillis

  private fun dayKeyOf(wallMs: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(wallMs))

  private companion object {
    val WALL0 = Calendar.getInstance().apply { clear(); set(2026, Calendar.NOVEMBER, 14, 12, 0, 0) }.timeInMillis
    val WALL0_DAY = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(WALL0))
  }
}
