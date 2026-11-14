package io.github.vjoy233.vradio.model

/* 曲讯统一事件（B3-A，contracts/metadata-event.json 双端契约形态）：
   播放层（PlayerHolder ICY / Web nowplaying 轮询）始终发出本格式；feature flag metadataV2Enabled
   关闭时 LegacyMetadataSink 保留现状曲讯/icy-br/MediaSession/radio.songs，开启时 MetadataV2Sink
   消费规范化字段（统计/发现派生）——两者不得同时写历史。artist/track 只是可选拆分字段，
   拆分失败 artist=''、track=title；title 永远是清洗后的完整显示文本。 */

/** confidence 值域（契约）：artist 拆出 = parsed，否则 stream。 */
object Confidence {
  const val PARSED = "parsed"
  const val STREAM = "stream"
}

data class MetadataEvent(
  val stationIdentityUrl: String,   // 台身份键（u[0]，世代校验用——切台/刷新/全部失败的迟到事件按它丢弃）
  val title: String,                // 清洗后的完整显示文本
  val artist: String,               // 可选拆分；拆分失败为空串
  val track: String,                // 可选拆分；拆分失败 = title
  val program: String,              // 节目名（无则空串）
  val bitrateKbps: Int,             // icy-br；无 = 0
  val source: String,               // icy|none|… 曲讯来源
  val at: Long,                     // epoch ms
  val confidence: String,           // parsed|stream
)
