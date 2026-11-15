package io.github.vjoy233.vradio.timeshift

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* B7 时移 Spike JVM 层验证：MP3 帧头表驱动解析/流式索引严格验证/坏数据与假同步跳过/
   环形淘汰一致性（含 60s 容量）/状态机全迁移/回退 15s 落合法帧边界/ICY 剥离。
   MP3 fixture 全部程序化构造（帧头 + 帧长表驱动填零），不引真实音频文件。 */

class TimeshiftIndexTest {

  /* —— fixture 构造 —— */

  /** 合成 4 字节帧头：ver 3=MPEG1 2=MPEG2 0=2.5；layer 1=III 2=II 3=I。 */
  private fun hdr(ver: Int, layer: Int, brIdx: Int, srIdx: Int, pad: Int = 0): ByteArray {
    val b1 = (0xE0 or (ver shl 3) or (layer shl 1) or 1).toByte()   // prot=1 无 CRC
    val b2 = ((brIdx shl 4) or (srIdx shl 2) or (pad shl 1)).toByte()
    return byteArrayOf(0xFF.toByte(), b1, b2, 0xC0.toByte())
  }

  /** 合成一整帧（头 + 帧长填零）；帧长由解析器自算（与被测代码同表，构造即自检）。 */
  private fun frame(brIdx: Int, srIdx: Int, ver: Int = 3): ByteArray {
    val h = hdr(ver, 1, brIdx, srIdx)
    val info = Mp3Header.parse(h, 0)!!
    return ByteArray(info.len).also { h.copyInto(it) }
  }

  private val f128 = { frame(9, 0) }    // MPEG1 L3 128kbps 44100 → 417B/帧、26.122ms
  private val f320 = { frame(14, 0) }   // MPEG1 L3 320kbps 44100 → 1044B/帧（索引 14）
  private fun concat(vararg parts: ByteArray): ByteArray {
    val out = ByteArray(parts.sumOf { it.size })
    var p = 0
    for (b in parts) { b.copyInto(out, p); p += b.size }
    return out
  }

  private fun feedAll(core: TimeshiftCore, url: String, bytes: ByteArray, chunk: Int = 8192) {
    var i = 0
    while (i < bytes.size) {
      val n = minOf(chunk, bytes.size - i)
      core.feed(url, bytes, i, n)
      i += n
    }
  }

  /* —— 1. 帧头解析（表驱动）—— */

  @Test fun 帧头表驱动() {
    // MPEG1 LayerIII 128k/44100：144×128000/44100=417、1152 采样
    val a = Mp3Header.parse(hdr(3, 1, 9, 0), 0)!!
    assertEquals(417, a.len); assertEquals(44100, a.sampleRate); assertEquals(1152, a.samples)
    // MPEG1 LayerIII 320k/32000：144×320000/32000=1440（索引 14）
    assertEquals(1440, Mp3Header.parse(hdr(3, 1, 14, 2), 0)!!.len)
    // MPEG1 LayerIII padding +1
    assertEquals(1441, Mp3Header.parse(hdr(3, 1, 14, 2, pad = 1), 0)!!.len)
    // MPEG1 LayerI 448k/44100：(12×448000/44100)×4=484、384 采样
    val l1 = Mp3Header.parse(hdr(3, 3, 14, 0), 0)!!
    assertEquals(484, l1.len); assertEquals(384, l1.samples)
    // MPEG2 LayerIII 64k/22050：72×64000/22050=208、576 采样
    val v2 = Mp3Header.parse(hdr(2, 1, 8, 0), 0)!!
    assertEquals(208, v2.len); assertEquals(576, v2.samples); assertEquals(22050, v2.sampleRate)
    // MPEG2.5 LayerIII 24k/11025：72×24000/11025=156（索引 3）
    assertEquals(156, Mp3Header.parse(hdr(0, 1, 3, 0), 0)!!.len)
    // 非法：保留 version / 保留 layer / bitrate 索引 0 与 15 / 采样率索引 3 / 同步字破
    assertNull(Mp3Header.parse(hdr(1, 1, 9, 0), 0))
    assertNull(Mp3Header.parse(hdr(3, 0, 9, 0), 0))
    assertNull(Mp3Header.parse(hdr(3, 1, 0, 0), 0))
    assertNull(Mp3Header.parse(hdr(3, 1, 15, 0), 0))
    assertNull(Mp3Header.parse(hdr(3, 1, 9, 3), 0))
    assertNull(Mp3Header.parse(byteArrayOf(0xFE.toByte(), 0xFB.toByte(), 0x90.toByte(), 0), 0))
    // 越界读安全
    assertNull(Mp3Header.parse(byteArrayOf(0xFF.toByte(), 0xFB.toByte()), 0))
  }

  /* —— 2. 索引扫描：严格验证（下一帧头可见才确认），尾帧晚一批 —— */

  @Test fun 索引扫描与严格验证() {
    val ix = Mp3Indexer()
    val fs = (1..5).map { f128() }
    val got1 = fs.flatMap { ix.feed(it, 0, it.size) }
    assertEquals(listOf(0L, 417L, 834L, 1251L), got1.map { it.offset })   // 第 5 帧等后继确认
    val got2 = ix.feed(f128(), 0, 417)
    assertEquals(listOf(1668L), got2.map { it.offset })                   // 第 5 帧此时确认
    assertEquals(417, got2[0].len)
  }

  @Test fun 坏数据跳过不炸() {
    val ix = Mp3Indexer()
    val junk = byteArrayOf(0, 0x11, 0xFF.toByte(), 0xE0.toByte(), 0, 0,   // 伪同步：bitrate 索引 0
      0xFF.toByte(), 0xFB.toByte(), 0x00.toByte(), 0xC0.toByte(),        // 伪帧头：bitrate 索引 0
      0x77, 0x88.toByte())
    assertTrue(ix.feed(junk, 0, junk.size).isEmpty())
    val fs = (1..3).map { f128() }
    val got = ix.feed(concat(*fs.toTypedArray()), 0, fs.size * 417)
    assertEquals(2, got.size)                                             // 帧后继未到：确认 2 帧
    assertEquals(junk.size.toLong(), got[0].offset)                       // 绝对偏移含前导垃圾
    assertEquals(junk.size + 417L, got[1].offset)
  }

  @Test fun 假同步右移重扫() {
    val ix = Mp3Indexer()
    // 假头：合法 MPEG2 L3 表头（len=192@24000Hz），帧尾落在零区（非帧头）→ 严格验证拒绝、右移一字节
    val falseHdr = hdr(2, 1, 8, 1)
    val junk = concat(ByteArray(2), falseHdr, ByteArray(204))
    val f1 = f128(); val f2 = f128(); val f3 = f128()
    val got = ix.feed(concat(junk, f1, f2, f3), 0, junk.size + 3 * 417)
    assertEquals(listOf(junk.size.toLong(), junk.size + 417L), got.map { it.offset })
  }

  /* —— 3. 环形缓冲 —— */

  @Test fun 环形读写淘汰与快照() {
    val rb = RingBuffer(16)
    rb.write("0123456789".toByteArray(), 0, 10)
    assertTrue(rb.alive(0)); assertEquals(10L, rb.size)
    rb.write("abcdefghij".toByteArray(), 0, 10)
    assertEquals(16L, rb.size); assertEquals(4L, rb.startOffset)          // 淘汰最旧 4 字节
    assertFalse(rb.alive(3))
    val out = ByteArray(16)
    assertTrue(rb.readAt(4, out, 0, 16))
    assertEquals("456789abcdefghij", String(out))
    assertEquals("456789abcdefghij", String(rb.snapshot(4)!!))
    assertNull(rb.snapshot(3))
    assertFalse(rb.readAt(3, out, 0, 1))
    assertFalse(rb.readAt(20, out, 0, 1))
    // 整段大于环：只留尾部
    val rb2 = RingBuffer(8)
    rb2.write("0123456789ABCDEFGHIJ".toByteArray(), 0, 20)
    assertEquals(8L, rb2.size); assertEquals(12L, rb2.startOffset)
    assertEquals("CDEFGHIJ", String(rb2.snapshot(12)!!))
    // 容量护栏
    try { RingBuffer(0); assertTrue(false) } catch (_: IllegalArgumentException) { }
  }

  /* —— 4. 捕获核心：环形淘汰后索引一致性 —— */

  @Test fun 环形淘汰后索引一致性() {
    val core = TimeshiftCore(capacityBytes = 50_000)                       // ≈3.1s@128kbps
    assertTrue(core.start("http://x/a.mp3", false))
    val bytes = concat(*(1..300).map { f128() }.toTypedArray())           // 125,100B ≈ 20.9s
    feedAll(core, "http://x/a.mp3", bytes)
    val ms = core.bufferedMs()
    assertTrue("buffered=$ms", ms in 2900..3400)                          // 只剩窗口内 ~118 帧
    assertEquals(bytes.size - 50_000, core.ring.startOffset.toInt())
    // 回退目标永远落在存活帧边界、快照必成功且首字节是合法帧头
    val t = core.rewindTarget(15_000)!!
    assertEquals(75_477L, t.offset)                                       // 181×417：最旧存活帧
    val snap = core.snapshot(t)!!
    assertEquals(bytes.size - 75_477, snap.size)
    assertNotNull(Mp3Header.parse(snap, 0))
  }

  @Test fun 六十秒容量淘汰() {
    val core = TimeshiftCore()                                            // 默认 2.4MB = 60s@320kbps
    assertTrue(core.start("http://x/a.mp3", false))
    val bytes = concat(*(1..2400).map { f320() }.toTypedArray())          // 2,505,600B ≈ 62.7s
    feedAll(core, "http://x/a.mp3", bytes)
    val ms = core.bufferedMs()
    assertTrue("buffered=$ms", ms in 59_000..61_000)                      // 淘汰到 60s 窗口
    assertTrue(core.ring.startOffset > 0)
    val t = core.rewindTarget(15_000)!!
    assertEquals(0L, t.offset % 1044)                                     // 无前导垃圾：帧界 = 1044 整数倍
    val snap = core.snapshot(t)!!
    assertTrue(snap.size in 500_000..2_400_000)
    assertNotNull(Mp3Header.parse(snap, 0))
  }

  /* —— 5. 回退 15 秒定位合法帧边界 —— */

  @Test fun 回退十五秒定位帧边界() {
    val core = TimeshiftCore()
    core.start("http://x/a.mp3", false)
    val n = 800                                                           // ≈20.9s，无淘汰
    val bytes = concat(*(1..n).map { f128() }.toTypedArray())
    feedAll(core, "http://x/a.mp3", bytes)
    val t = core.rewindTarget(15_000)!!
    assertEquals(0L, t.offset % 417)                                      // 帧边界（417 整数倍）
    // 自目标到最新确认帧的累计时长 ≥15s，且少一帧就 <15s（定位紧贴目标；第 n 帧未确认不入索引）
    val perFrame = 1152 * 1000.0 / 44100
    val lastIdx = n - 2                                                   // 最后确认帧下标（严格验证留尾）
    val idx = (t.offset / 417).toInt()
    assertTrue((lastIdx - idx + 1) * perFrame >= 15_000)
    assertTrue((lastIdx - idx) * perFrame < 15_000)
    val snap = core.snapshot(t)!!
    assertEquals(0xFF, snap[0].toInt() and 0xFF)                          // 快照首字节 = 帧头同步字
    assertNotNull(Mp3Header.parse(snap, 0))
    // 缓冲不足 15s 时退到最旧存活帧（不越界、不 null）
    assertEquals(0L, core.rewindTarget(60_000)!!.offset)
  }

  /* —— 6. 状态机全迁移 + 范围判定 —— */

  @Test fun 状态机全迁移() {
    val m = TimeshiftStateMachine
    val (OFF, CAP, REP, CUP, FAIL) = listOf(
      TsState.OFF, TsState.CAPTURING, TsState.REPLAYING, TsState.CATCHING_UP, TsState.FAILED)
    assertEquals(CAP, m.next(OFF, TsEvent.START))
    assertEquals(REP, m.next(CAP, TsEvent.REWIND_OK))
    assertEquals(FAIL, m.next(CAP, TsEvent.REWIND_FAIL))
    assertEquals(CUP, m.next(REP, TsEvent.SNAPSHOT_END))
    assertEquals(CAP, m.next(CUP, TsEvent.LIVE_AIR))
    assertEquals(FAIL, m.next(REP, TsEvent.ERROR))
    assertEquals(FAIL, m.next(CUP, TsEvent.ERROR))
    assertEquals(CAP, m.next(FAIL, TsEvent.START))                        // 下一连接复活
    assertEquals(CUP, m.next(CUP, TsEvent.START))                         // 追赶中同源重连保状态
    // 切台/刷新/源切换/停播：任何态 RESET → OFF
    TsState.values().forEach { assertEquals(OFF, m.next(it, TsEvent.RESET)) }
    // 未定义组合保持原态
    assertEquals(OFF, m.next(OFF, TsEvent.SNAPSHOT_END))
    assertEquals(CAP, m.next(CAP, TsEvent.LIVE_AIR))
    assertEquals(OFF, m.next(OFF, TsEvent.REWIND_OK))
  }

  @Test fun 范围判定HLS与非直流拒绝() {
    val m = TimeshiftStateMachine
    assertEquals(m.REJECTED_NOT_SUPPORTED, m.classify("https://example.com/live/123.m3u8"))
    assertEquals(m.REJECTED_NOT_SUPPORTED, m.classify("http://x/a.m3u8?tok=1"))
    assertEquals(m.REJECTED_NOT_SUPPORTED, m.classify("https://x.com/stream.aac"))
    assertEquals(m.REJECTED_NOT_SUPPORTED, m.classify("https://x.com/listen"))   // 无扩展名旁路流
    assertNull(m.classify("http://lhttp.qingting.fm/live/1234/64k.mp3"))         // 蜻蜓换算直流
    assertNull(m.classify("https://x.com/stream.mp3?token=abc"))
    assertNull(m.classify("http://x/a.MP3"))
  }

  @Test fun 核心会话与keep语义() {
    val core = TimeshiftCore()
    // 拒绝：HLS → OFF 待命且不吞字节
    assertFalse(core.start("http://x/a.m3u8", false))
    assertEquals(TsState.OFF, core.state)
    assertEquals(TimeshiftStateMachine.REJECTED_NOT_SUPPORTED, core.reject)
    // 直流 → CAPTURING；URL 不匹配的 feed 不入环
    assertTrue(core.start("http://x/a.mp3", false))
    core.feed("http://x/other.mp3", f128(), 0, 417)
    assertEquals(0L, core.ring.endOffset)
    // OFF 态 feed 不入环
    core.start("http://x/a.m3u8", false)
    core.feed("http://x/a.m3u8", f128(), 0, 417)
    assertEquals(0L, core.ring.endOffset)
    // 追赶 keep：REPLAYING→SNAPSHOT_END→同源重连保 CATCHING_UP（环数据保留）→LIVE_AIR 收口
    core.start("http://x/a.mp3", false)
    feedAll(core, "http://x/a.mp3", concat(f128(), f128(), f128(), f128()))
    assertTrue(core.bufferedMs() > 70)
    core.apply(TsEvent.REWIND_OK)
    assertEquals(TsState.REPLAYING, core.state)
    core.apply(TsEvent.SNAPSHOT_END)
    assertEquals(TsState.CATCHING_UP, core.state)
    val endBefore = core.ring.endOffset
    core.start("http://x/a.mp3", keep = true)
    assertEquals(TsState.CATCHING_UP, core.state)
    assertEquals(endBefore, core.ring.endOffset)                          // 未 hardReset
    core.apply(TsEvent.LIVE_AIR)
    assertEquals(TsState.CAPTURING, core.state)
    // 切台语义：换 URL 全新会话
    core.apply(TsEvent.REWIND_OK)
    core.start("http://x/b.mp3", keep = false)
    assertEquals(TsState.CAPTURING, core.state)
    assertEquals(0L, core.ring.endOffset)
    assertNull(core.reject)
  }

  /* —— 7. ICY 元数据剥离 —— */

  @Test fun icy剥离跨chunk() {
    val meta16 = ByteArray(16) { 'M'.toByte() }
    val raw = concat(
      "aaaaaaaaaa".toByteArray(), byteArrayOf(1), meta16,      // metaint 音频 + 1+16 元数据
      "bbbbbbbbbb".toByteArray(), byteArrayOf(0),              // 空元数据（仅长度字节）
      "cccccccccc".toByteArray(),
    )
    val sb = StringBuilder()
    val st = IcyStripper(10)
    var i = 0
    while (i < raw.size) {                                     // 刁钻 chunk 切分：3/1/7 交替
      val n = if ((i / 3) % 2 == 0) minOf(3, raw.size - i) else minOf(7, raw.size - i)
      st.feed(raw, i, n) { b, o, l -> sb.append(String(b, o, l)) }
      i += n
    }
    assertEquals("aaaaaaaaaabbbbbbbbbbcccccccccc", sb.toString())
    // metaint<=0 纯透传
    val st2 = IcyStripper(0)
    st2.feed(raw, 0, raw.size) { b, o, l -> assertEquals(String(raw), String(b, o, l)) }
  }
}
