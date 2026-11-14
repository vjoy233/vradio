package io.github.vjoy233.vradio.timeshift

/* Icecast ICY 元数据块剥离器（B7 时移 Spike，纯 JVM）。
   事实链（media3 1.11.1 字节码实证）：请求头带 Icy-MetaData:1 时，服务器在音频流里每 metaint
   字节插入「1 字节长度 N + N×16 字节元数据」；ExoPlayer 的剥离发生在 ProgressiveMediaPeriod
   $ExtractingLoadable 构造的 IcyDataSource——位于我们 tee 层之上。所以 tee 的 read 返回值
   （给 IcyDataSource 的）绝不能动字节，而旁路进环形缓冲的副本必须自己剥掉这些块，否则帧索引
   会被元数据字节打断、回放快照里夹带 ICY 块（解码器爆音）。 */
class IcyStripper(private val metaint: Int) {

  private var pending = metaint.coerceAtLeast(0)   // 距下一元数据块还有多少音频字节
  private var skip = 0                             // 待丢弃的元数据字节数（长度字节之后）

  /** 喂原始流字节，emit 回调纯音频段（可能 0~多段/次）；metaint<=0 纯透传。 */
  fun feed(b: ByteArray, off: Int, len: Int, emit: (ByteArray, Int, Int) -> Unit) {
    if (metaint <= 0) { emit(b, off, len); return }
    var i = off
    val end = off + len
    while (i < end) {
      when {
        skip > 0 -> { val n = minOf(skip, end - i); i += n; skip -= n }                 // 元数据体
        pending == 0 -> { skip = (b[i].toInt() and 0xFF) * 16; pending = metaint; i++ } // 长度字节（16B 单位）→ 下一轮音频计数重置
        else -> { val n = minOf(pending, end - i); emit(b, i, n); i += n; pending -= n } // 音频
      }
    }
  }
}
