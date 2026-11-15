package io.github.vjoy233.vradio

/* B3 发布开关（plan-expansion-r4 §7）：三个独立发布单元，默认全关——B3 门槛（§7.4 双端黄金样本
   全绿）过后由版本发布配置翻 true，开发构建可临时改true自测。
   纪律：开关不新增 radio.* 持久键；关闭 = 对应能力不可见/不消费，但绝不清除已有数据、
   不影响主列表/播放/健康/QualityStore/备份 v3 主流程；metadataV2 关闭时 LegacyMetadataSink
   保留现状曲讯（icy-br/MediaSession/radio.songs 行为不变）。 */
object FeatureFlags {
  /** B3-A 元数据管线：true = MetadataV2Sink（规范化事件消费），false = LegacyMetadataSink（现状行为）。 */
  const val METADATA_V2 = false

  /** B3-B 收听统计：true = 消费播放状态事件 + listen-stats.json sidecar flush；false = 不消费不 flush（数据保留）。 */
  const val LISTEN_STATS = false

  /** B3-C 本地发现页：true = 列表页「发现」入口 + 派生计算可见；false = 入口隐藏不派生。 */
  const val DISCOVERY = false
}
