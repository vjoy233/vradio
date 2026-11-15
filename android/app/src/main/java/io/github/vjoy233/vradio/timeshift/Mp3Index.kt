package io.github.vjoy233.vradio.timeshift

/* MP3 帧边界索引器（B7 时移 Spike，纯 JVM）。
   直播流没有容器级索引，回听切入必须落在帧边界上（从字节中间切入 = 解码器丢首帧/爆音）：
   这里按 MPEG audio 帧头（同步字 0xFF 0xE0 + version/layer/bitrate/samplerate/padding 表）
   逐帧解析帧长，流式扫描产出帧偏移索引。offset 全部用「流绝对偏移」（跨 chunk 连续计数）。 */

/** 一帧的索引记录：offset = 帧头在流中的绝对偏移。 */
data class Mp3Frame(val offset: Long, val len: Int, val sampleRate: Int, val samples: Int) {
  val durationMs: Double get() = samples * 1000.0 / sampleRate
}

/** 帧头解析结果（内部形态）。 */
data class Mp3Hdr(val len: Int, val sampleRate: Int, val samples: Int)

object Mp3Header {

  /* kbps 表（索引 0/15 非法不收录下标位，0 占位即可）——行按 [MPEG1 | MPEG2/2.5] × Layer 分 */
  private val BR_V1_L1 = intArrayOf(0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448)
  private val BR_V1_L2 = intArrayOf(0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384)
  private val BR_V1_L3 = intArrayOf(0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)
  private val BR_V2_L1 = intArrayOf(0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256)
  private val BR_V2_L2 = intArrayOf(0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
  private val BR_V2_L3 = intArrayOf(0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
  private val SR_V1 = intArrayOf(44100, 48000, 32000)   // MPEG1
  private val SR_V2 = intArrayOf(22050, 24000, 16000)   // MPEG2
  private val SR_V25 = intArrayOf(11025, 12000, 8000)   // MPEG2.5

  const val MAX_FRAME_BYTES = 2881  // 72×320kbps/8kHz+pad，一切合法帧长上界（环形 carry 护栏用）

  /** 解析 off 处 4 字节帧头；null = 非法（含保留位/坏索引/出界帧长）。 */
  fun parse(b: ByteArray, off: Int): Mp3Hdr? {
    if (off + 4 > b.size) return null
    if (b[off].toInt() and 0xFF != 0xFF) return null
    val b1 = b[off + 1].toInt() and 0xFF
    if (b1 and 0xE0 != 0xE0) return null                    // 同步字后 3 位
    val ver = b1 shr 3 and 3                                // 0=MPEG2.5 1=保留 2=MPEG2 3=MPEG1
    if (ver == 1) return null
    val layer = b1 shr 1 and 3                              // 0=保留 1=LayerIII 2=LayerII 3=LayerI
    if (layer == 0) return null
    val b2 = b[off + 2].toInt() and 0xFF
    val brIdx = b2 shr 4 and 0xF
    if (brIdx == 0 || brIdx == 15) return null              // 0=自由码率 15=保留
    val srIdx = b2 shr 2 and 3
    if (srIdx == 3) return null
    val pad = b2 shr 1 and 1
    val br = (if (ver == 3) arrayOf(BR_V1_L1, BR_V1_L2, BR_V1_L3) else arrayOf(BR_V2_L1, BR_V2_L2, BR_V2_L3))
      .let { t -> t[when (layer) { 3 -> 0; 2 -> 1; else -> 2 }][brIdx] } * 1000
    val sr = (if (ver == 3) SR_V1 else if (ver == 2) SR_V2 else SR_V25)[srIdx]
    return when (layer) {
      3 -> (12 * br / sr + pad) * 4 to 384                  // Layer I
      2 -> 144 * br / sr + pad to 1152                      // Layer II
      else -> (if (ver == 3) 144 else 72) * br / sr + pad to if (ver == 3) 1152 else 576   // Layer III
    }.let { (len, samples) -> if (len < 8 || len > MAX_FRAME_BYTES) null else Mp3Hdr(len, sr, samples) }
  }
}

/**
 * 流式帧索引扫描器。feed 连续喂入流字节（顺序、不重叠），返回本次新「确认」的帧。
 * 确认规则 = 严格验证：候选帧的帧体到齐且下一帧头已可见且合法，才入索引——防流里随手
 * 可见的假同步字（歌词零头/ICY 边界噪声）污染回听切入点。代价是尾部最后一帧晚一批才确认，
 * 直播流持续到达无影响。
 */
class Mp3Indexer {

  private var carry = ByteArray(8192)  // 未确认窗口（≤ 帧长 + 下一帧头）
  private var carryLen = 0
  private var carryBase = 0L           // carry[0] 的流绝对偏移

  fun reset() { carryLen = 0; carryBase = 0L }

  fun feed(b: ByteArray, off: Int, len: Int): List<Mp3Frame> {
    if (len <= 0) return emptyList()
    if (carryLen + len > carry.size) {
      var cap = carry.size * 2
      while (cap < carryLen + len) cap *= 2
      carry = carry.copyOf(cap)
    }
    System.arraycopy(b, off, carry, carryLen, len)
    carryLen += len
    val out = ArrayList<Mp3Frame>(4)
    var pos = 0
    scan@ while (true) {
      if (pos + 4 > carryLen) break
      val h = Mp3Header.parse(carry, pos)
      if (h == null) { pos++; continue@scan }                              // 非帧头：右移一字节重找同步
      val end = pos + h.len
      if (end + 4 > carryLen) break                                        // 帧体/下一帧头未到齐：等下批
      if (Mp3Header.parse(carry, end) == null) { pos++; continue@scan }    // 假同步：下一帧头位不合法
      out.add(Mp3Frame(carryBase + pos, h.len, h.sampleRate, h.samples))
      pos = end
    }
    if (pos > 0) {                                                         // 丢弃已消费前缀（量 ≤ 2×帧长）
      System.arraycopy(carry, pos, carry, 0, carryLen - pos)
      carryLen -= pos; carryBase += pos
    }
    if (carryLen > 8192 + Mp3Header.MAX_FRAME_BYTES) {                     // 纯垃圾流护栏：只留尾部防无界增长
      val keep = 64
      System.arraycopy(carry, carryLen - keep, carry, 0, keep)
      carryBase += carryLen - keep; carryLen = keep
    }
    return out
  }
}
