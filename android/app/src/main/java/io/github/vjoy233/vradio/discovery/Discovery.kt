package io.github.vjoy233.vradio.discovery

import io.github.vjoy233.vradio.model.Station

/* 本地发现页（B3-C，plan-expansion-r4 §7.3，纯 JVM）：本地字段派生视图——不联网、不改主列表排序、
   不创建第二套播放决策（点击统一走 AppVm 既有 play 通道）。分组规则与 Web App.buildDiscovery() 完全一致：
   ① 先过滤手动隐藏台（hidden/隐藏分类）+ dead（正在播/连接中例外口径，同 Library.visible）；
   ② QualityStore 无记录 → 暂无质量数据组（不得归入 poor，也不进质量派生组）；
   ③ 稳定直连 = stability good 且 directCount>0；有曲讯 = metadata==icy；
   ④ 最近新增 = radio-meta.firstSeenAt（无 meta 该组空）；最近恢复 = 明确 health dead→alive 转移记录
     （无记录不猜测，RecoveryLog 7 天窗）；未听过 = 不在 radio.recents；
   ⑤ 精选 = 装配层 originMask 的 starter 位（Library.reload STARTER 去重时打，不持久化、
     不按当前 u[0] 现场比对 URL）；
   ⑥ 排序：组内时间字段降序（新增用 firstSeenAt，其余统一 lastObservedAt = max(lastOk,lastFail,lastPlayback)，
     只用 lastObservedAt 不用别名）+ identityUrl 字典序稳定排序；每组 ≤20；同台可跨组、组内不重。 */

/** 质量摘要的最小消费面（QualityStore.QualityAggregate 的瘦身映射，发现层不耦合存储）。 */
data class QInfo(
  val stability: String = "unknown",
  val directCount: Int = 0,
  val metadata: String = "none",
  val lastObservedAt: Long = 0L,
)

data class DiscoveryInput(
  val stations: List<Station>,
  val playingKey: String? = null,
  val connectingKey: String? = null,
  val hiddenCats: Set<String> = emptySet(),        // 维护面板隐藏的分类（visible 同口径）
  val quality: Map<String, QInfo> = emptyMap(),    // 身份 URL → 摘要（无记录 = 不在 map）
  val firstSeenAt: Map<String, Long> = emptyMap(), // 身份 URL → radio-meta.firstSeenAt
  val recoveredAt: Map<String, Long> = emptyMap(), // 台 key → 复活时刻（7 天窗，调用侧已过期清理）
  val recentKeys: Set<String> = emptySet(),        // radio.recents 台键集（「未听过」判定）
)

/** 六分组 + 暂无质量数据兜底组。 */
data class Groups(
  val stableDirect: List<Station>,
  val recentlyAdded: List<Station>,
  val recentlyRecovered: List<Station>,
  val withMetadata: List<Station>,
  val unlistened: List<Station>,
  val featured: List<Station>,
  val noQualityData: List<Station>,
) {
  companion object { val EMPTY = Groups(emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList(), emptyList()) }
}

object Discovery {

  const val GROUP_CAP = 20

  fun build(input: DiscoveryInput): Groups {
    // ① 底过滤：手动隐藏/隐藏分类彻底消失；dead 默认过滤（正在播/连接中例外——visible 同口径）
    val base = input.stations.filter { s ->
      !s.hidden && !input.hiddenCats.contains(s.c) &&
        (s.health != "dead" || s.key == input.playingKey || s.key == input.connectingKey)
    }
    fun time(s: Station): Long = input.quality[s.u0]?.lastObservedAt ?: 0L   // 只用 lastObservedAt 不用别名
    fun <T> pick(cands: List<T>, timeOf: (T) -> Long, idOf: (T) -> String, extra: (T) -> String): List<T> =
      cands.sortedWith(compareByDescending(timeOf).thenBy(idOf).thenBy(extra)).take(GROUP_CAP)
    val added = base.filter { (input.firstSeenAt[it.u0] ?: 0L) > 0L }
    val recovered = base.filter { (input.recoveredAt[it.key] ?: 0L) > 0L }
    return Groups(
      stableDirect = pick(base.filter { val q = input.quality[it.u0]; q != null && q.stability == "good" && q.directCount > 0 },
        ::time, { it.u0 }, { it.key }),
      recentlyAdded = pick(added, { input.firstSeenAt[it.u0] ?: 0L }, { it.u0 }, { it.key }),
      recentlyRecovered = pick(recovered, ::time, { it.u0 }, { it.key }),
      withMetadata = pick(base.filter { input.quality[it.u0]?.metadata == "icy" }, ::time, { it.u0 }, { it.key }),
      unlistened = pick(base.filter { it.key !in input.recentKeys }, ::time, { it.u0 }, { it.key }),
      featured = pick(base.filter { it.starter }, ::time, { it.u0 }, { it.key }),
      noQualityData = pick(base.filter { !input.quality.containsKey(it.u0) }, ::time, { it.u0 }, { it.key }),
    )
  }
}

/** health dead→alive 复活记录的纯函数面（B3-C「最近恢复」）：Map 缓存 + 7 天过期；承载/持久化在
 *  AppVm（Prefs 运行时缓存，键非 radio.* 契约键——发现派生数据，不随备份迁移）。 */
object RecoveryLog {
  const val WINDOW_MS = 7L * 86400000L

  fun prune(map: Map<String, Long>, now: Long): Map<String, Long> = map.filterValues { now - it < WINDOW_MS }
}
