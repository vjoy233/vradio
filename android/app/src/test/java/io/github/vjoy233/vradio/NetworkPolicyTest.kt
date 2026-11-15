package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.network.NetProbe
import io.github.vjoy233.vradio.network.NetworkPolicy
import io.github.vjoy233.vradio.network.NetworkPolicy.CellularRule
import io.github.vjoy233.vradio.network.NetworkPolicy.Kind
import io.github.vjoy233.vradio.network.NetworkPolicy.Op
import io.github.vjoy233.vradio.network.NetworkPolicy.Rules
import io.github.vjoy233.vradio.network.NetworkPolicy.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/* 网络策略矩阵（plan-expansion-r4 §9.2 表逐格）：Wi-Fi 全允许、移动数据各 op 默认决策、
   override 与三态规则效果、离线全拒（播放除外——播放永远不被静默阻断）、UNKNOWN 宽松、Widget 恒拒。 */
class NetworkPolicyTest {

  private fun probe(online: Boolean?, metered: Boolean?) = object : NetProbe {
    override fun online() = online
    override fun metered() = metered
  }

  private val wifi = NetworkPolicy(probe(true, false))
  private val cell = NetworkPolicy(probe(true, true))
  private val offline = NetworkPolicy(probe(false, true))    // 无网时系统常报计量=true（AppVm 同坑注释）
  private val unknown = NetworkPolicy(probe(null, null))

  @Test fun 状态分档() {
    assertEquals(State.WIFI, wifi.state())
    assertEquals(State.CELLULAR, cell.state())
    assertEquals(State.OFFLINE, offline.state())
    assertEquals(State.UNKNOWN, unknown.state())
    assertEquals(State.UNKNOWN, NetworkPolicy(probe(true, null)).state())   // 在线但计量未知
  }

  @Test fun WiFi全允许() {
    for (op in Op.values()) {
      val d = wifi.allow(op, Rules())
      if (op == Op.WIDGET) assertEquals(Kind.DENY, d.kind)   // Widget 两列同值：不主动联网
      else assertEquals(Kind.ALLOW, d.kind)
    }
  }

  @Test fun 移动数据默认矩阵() {
    assertEquals(Kind.ALLOW, cell.allow(Op.PLAY, Rules()).kind)                    // 播放两网都允许
    val sc = cell.allow(Op.SINGLE_CHECK, Rules())                                   // 单台探活：允许但提示
    assertEquals(Kind.ALLOW, sc.kind); assertTrue(sc.why.isNotEmpty())
    assertEquals(Kind.CONFIRM, cell.allow(Op.FULL_CHECK, Rules()).kind)             // 全量体检默认需确认
    assertEquals(Kind.CONFIRM, cell.allow(Op.SYNC, Rules()).kind)                   // 主库同步默认需确认
    assertEquals(Kind.DENY, cell.allow(Op.LOGO_PREFETCH, Rules()).kind)             // 台标补全 Wi-Fi 优先
    assertEquals(Kind.DENY, cell.allow(Op.WIDGET, Rules()).kind)
  }

  @Test fun 移动数据三态规则与override() {
    assertEquals(Kind.ALLOW, cell.allow(Op.FULL_CHECK, Rules(cellFullCheck = CellularRule.ALLOW)).kind)
    assertEquals(Kind.DENY, cell.allow(Op.FULL_CHECK, Rules(cellFullCheck = CellularRule.DENY)).kind)
    assertEquals(Kind.ALLOW, cell.allow(Op.SYNC, Rules(cellSync = CellularRule.ALLOW)).kind)
    assertEquals(Kind.DENY, cell.allow(Op.SYNC, Rules(cellSync = CellularRule.DENY)).kind)
    // overrideCellular（简式签名）：总开关覆盖默认确认/跳过
    assertEquals(Kind.ALLOW, cell.allow(Op.FULL_CHECK, true).kind)
    assertEquals(Kind.ALLOW, cell.allow(Op.SYNC, true).kind)
    assertEquals(Kind.ALLOW, cell.allow(Op.LOGO_PREFETCH, true).kind)
    // 台标开关关掉 = 移动数据也补
    assertEquals(Kind.ALLOW, cell.allow(Op.LOGO_PREFETCH, Rules(logoWifiOnly = false)).kind)
    // 规则文案：DENY 带设置指路、CONFIRM 带流量提示
    assertTrue(cell.allow(Op.FULL_CHECK, Rules(cellFullCheck = CellularRule.DENY)).why.contains("设置"))
    assertTrue(cell.allow(Op.SYNC, Rules()).why.contains("流量"))
  }

  @Test fun 离线全拒播放除外() {
    assertEquals(Kind.ALLOW, offline.allow(Op.PLAY, Rules()).kind)    // 播放不被策略静默阻断（让流层自然失败）
    assertTrue(offline.allow(Op.PLAY, Rules()).why.contains("离线"))
    for (op in listOf(Op.SINGLE_CHECK, Op.FULL_CHECK, Op.SYNC, Op.LOGO_PREFETCH, Op.WIDGET)) {
      assertEquals(Kind.DENY, offline.allow(op, Rules()).kind)
    }
  }

  @Test fun UNKNOWN宽松() {   // 探测失败不误拦（宁可多放不可静默断功能；播放/大流量默认确认仍按矩阵）
    for (op in Op.values()) {
      val d = unknown.allow(op, Rules())
      if (op == Op.WIDGET) assertEquals(Kind.DENY, d.kind)
      else assertEquals(Kind.ALLOW, d.kind)
    }
    assertEquals(Kind.ALLOW, unknown.allow(Op.PLAY, true).kind)
  }

  @Test fun 决策便捷字段() {
    val d = cell.allow(Op.FULL_CHECK, Rules())
    assertTrue(d.confirm); assertFalse(d.ok)
    val a = wifi.allow(Op.PLAY, Rules())
    assertTrue(a.ok); assertFalse(a.confirm)
  }
}
