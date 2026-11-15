package io.github.vjoy233.vradio.timeshift

/* 固定容量字节环形缓冲（B7 时移 Spike，纯 JVM）。
   写入淘汰最旧、按「流绝对偏移」查询存活/读取/快照——绝对偏移与 Mp3Indexer 的帧偏移同一坐标。
   容量参数化 + 硬顶护栏（B7 范围 = 最近 60 秒，320kbps 上界 2.4MB）。 */
class RingBuffer(val capacity: Int) {

  init { require(capacity in 1..MAX_CAP_BYTES) { "capacity 1..$MAX_CAP_BYTES" } }

  private val buf = ByteArray(capacity)
  private var head = 0                     // 环内下标：endOffset 待写位置
  var startOffset = 0L; private set       // 最旧存活字节的绝对偏移
  var endOffset = 0L; private set         // 已写到的绝对偏移（开区间）
  val size: Long get() = endOffset - startOffset

  fun reset() { startOffset = 0L; endOffset = 0L; head = 0 }

  fun write(b: ByteArray, off: Int, len: Int) {
    if (len <= 0) return
    if (len >= capacity) {                 // 整段比环大：只留尾部
      System.arraycopy(b, off + len - capacity, buf, 0, capacity)
      head = 0
      startOffset = endOffset + len - capacity
      endOffset += len
      return
    }
    val free = capacity - size
    if (len > free) startOffset += len - free   // 淘汰最旧
    var src = off; var dst = head; var n = len
    while (n > 0) {
      val c = minOf(n, capacity - dst)
      System.arraycopy(b, src, buf, dst, c)
      dst = (dst + c) % capacity; src += c; n -= c
    }
    head = dst
    endOffset += len
  }

  fun alive(absOff: Long): Boolean = absOff in startOffset..endOffset

  /** 取 [absOff, absOff+len)；任一字节未写/已淘汰 → false 不写入 dest。 */
  fun readAt(absOff: Long, dest: ByteArray, destOff: Int, len: Int): Boolean {
    if (absOff < startOffset || absOff + len > endOffset) return false
    var idx = ((head - (endOffset - absOff)).toInt() % capacity + capacity) % capacity
    var d = destOff; var n = len
    while (n > 0) {
      val c = minOf(n, capacity - idx)
      System.arraycopy(buf, idx, dest, d, c)
      idx = (idx + c) % capacity; d += c; n -= c
    }
    return true
  }

  /** [from, endOffset) 一次性拷出；from 已淘汰返回 null。 */
  fun snapshot(from: Long): ByteArray? {
    if (from < startOffset || from > endOffset) return null
    val n = (endOffset - from).toInt()
    if (n == 0) return ByteArray(0)
    val out = ByteArray(n)
    return if (readAt(from, out, 0, n)) out else null
  }

  companion object {
    const val DEFAULT_CAP_BYTES = 2_400_000   // 60s × 320kbps ÷ 8（B7 范围上界）
    const val MAX_CAP_BYTES = 4_194_304       // 参数化硬顶（防误配出天量内存）
  }
}
