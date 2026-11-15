package io.github.vjoy233.vradio.timeshift

/* 时移捕获核心（B7 Spike，纯 JVM——ExoPlayer/线程在 Timeshift 控制器层，此层可全量单测）。
   组合 RingBuffer + Mp3Indexer + IcyStripper + 状态机：字节 → 剥 ICY → 入环 → 建帧索引 →
   随环形淘汰同步修剪索引；回退定位 = 自最新帧往回累计时长到目标秒数，起点必为合法帧边界。 */
internal class TimeshiftCore(val capacityBytes: Int = RingBuffer.DEFAULT_CAP_BYTES) {

  val ring = RingBuffer(capacityBytes)
  private val indexer = Mp3Indexer()
  private val frames = ArrayDeque<Mp3Frame>()     // 升序；全部存活（起点字节未被淘汰）
  private var aliveMs = 0.0
  private var stripper: IcyStripper? = null

  var state = TsState.OFF; private set
  var curUrl = ""; private set
  var reject: String? = null; private set        // 非 null = 拒绝码（REJECTED_NOT_SUPPORTED）

  fun hardReset() {
    ring.reset(); indexer.reset(); frames.clear()
    aliveMs = 0.0; stripper = null
    state = TsState.OFF; curUrl = ""; reject = null
  }

  /** 新装载（每条新连接）：keep=追赶中同源重连（保状态等 LIVE_AIR，旧环数据续用）。返回是否进入 CAPTURING。 */
  fun start(url: String, keep: Boolean): Boolean {
    if (!keep) hardReset()
    curUrl = url
    val r = TimeshiftStateMachine.classify(url)
    reject = r
    if (r != null) { state = TsState.OFF; return false }   // 范围外：OFF 待命（不捕获）
    state = TimeshiftStateMachine.next(state, TsEvent.START)
    return state == TsState.CAPTURING
  }

  /** DataSource.open 回调：按响应头 icy-metaint 绑剥离器（每条连接各一份，计数从连接起点归零）。 */
  fun onOpen(url: String, metaint: Int) {
    if (url == curUrl) stripper = if (metaint > 0) IcyStripper(metaint) else null
  }

  /** 字节旁路入口（loading 线程调，锁在控制器层）。 */
  fun feed(url: String, b: ByteArray, off: Int, len: Int) {
    if (state != TsState.CAPTURING || url != curUrl || len <= 0) return
    val st = stripper
    if (st != null) st.feed(b, off, len) { bb, o, l -> ingest(bb, o, l) }
    else ingest(b, off, len)
  }

  private fun ingest(b: ByteArray, off: Int, len: Int) {
    ring.write(b, off, len)
    val added = indexer.feed(b, off, len)
    for (f in added) { aliveMs += f.durationMs; frames.addLast(f) }
    // 环形淘汰 → 修剪索引：帧起点字节滚出存活窗即弃（部分淘汰的帧不能再作回退起点）
    while (frames.isNotEmpty() && frames.first().offset < ring.startOffset) {
      aliveMs -= frames.removeFirst().durationMs
    }
  }

  fun bufferedMs(): Long = aliveMs.toLong()

  /** 回退定位：自最新帧往回累计 backMs（缓冲不足则退到最旧存活帧）；null=还没有任何帧。 */
  fun rewindTarget(backMs: Long): Mp3Frame? {
    if (frames.isEmpty()) return null
    var acc = 0.0
    var target = frames.last()
    for (i in frames.indices.reversed()) {
      target = frames[i]
      acc += frames[i].durationMs
      if (acc >= backMs) break
    }
    return target
  }

  fun snapshot(target: Mp3Frame): ByteArray? = ring.snapshot(target.offset)

  fun apply(e: TsEvent) { state = TimeshiftStateMachine.next(state, e) }

  companion object { const val REWIND_MS = 15_000L }
}
