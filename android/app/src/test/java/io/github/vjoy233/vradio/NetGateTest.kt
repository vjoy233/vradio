package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.network.NetGate
import io.github.vjoy233.vradio.network.NetProbe
import io.github.vjoy233.vradio.network.NetworkPolicy
import io.github.vjoy233.vradio.network.NetworkPolicy.CellularRule
import io.github.vjoy233.vradio.network.NetworkPolicy.Op
import io.github.vjoy233.vradio.network.NetworkPolicy.Rules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* 轻更新网络门·调用层测试（AIbot PR#21 P1 回执）：镜像 AppVm.checkUpdate 的门控接线
   （DENY→拒绝文案、CONFIRM→挂起、Run→直跑 runner；确认后 proceedGate 续跑），
   断言蜂窝 deny / 蜂窝 confirm 未确认 / 离线时 runner 不被调——
   runner 是 light.check/apply 的唯一调用路径（runCheckUpdate），fake light 计数必须为 0。 */
class NetGateTest {

  private fun probe(online: Boolean?, metered: Boolean?) = object : NetProbe {
    override fun online() = online
    override fun metered() = metered
  }
  private val wifi = NetGate(NetworkPolicy(probe(true, false)))
  private val cell = NetGate(NetworkPolicy(probe(true, true)))
  private val offline = NetGate(NetworkPolicy(probe(false, true)))   // 无网时系统常报计量=true（NetworkPolicyTest 同坑注释）

  /** fake light：与 LightUpdate.check/apply 同名计数靶（check 恒报「有新版」——跑起来 apply 必被链到） */
  private class FakeLight {
    var checks = 0; var applies = 0
    fun check(base: String): String? { checks++; return "2026-11-15T00:00:00Z" }
    fun apply(old: String): Any? { applies++; return null }
  }

  /** runner = runCheckUpdate 首段同构：check 发现新版才 apply（版本检查本身也发网络请求，同样在门内） */
  private fun runner(light: FakeLight) {
    val newer = light.check("")
    if (newer != null) light.apply("")
  }

  /** AppVm.checkUpdate 同构入口接线：DENY→文案、CONFIRM→挂起（不跑 runner）、Run→直跑 */
  private fun entry(g: NetGate, rules: Rules, light: FakeLight): Pair<String?, NetGate.Act?> {
    var msg: String? = null; var pending: NetGate.Act? = null
    when (val n = g.enter(Op.SYNC, NetGate.Act.LIGHT_UPDATE, rules)) {
      is NetGate.Next.Deny -> msg = "未开始：${n.why}"
      is NetGate.Next.Confirm -> pending = n.act
      NetGate.Next.Run -> runner(light)
    }
    return msg to pending
  }

  @Test fun 蜂窝deny拒绝不触碰light() {
    val light = FakeLight()
    val (msg, pending) = entry(cell, Rules(cellSync = CellularRule.DENY), light)
    assertTrue(msg!!.contains("未开始")); assertNull(pending)
    val d = cell.enter(Op.SYNC, NetGate.Act.SYNC, Rules(cellSync = CellularRule.DENY)) as NetGate.Next.Deny
    assertTrue(d.cellularPolicy)
    assertEquals(0, light.checks); assertEquals(0, light.applies)   // ← P1 断言：deny 不调 light.check/apply
  }

  @Test fun 蜂窝confirm未确认不触碰light() {
    val light = FakeLight()
    val (msg, pending) = entry(cell, Rules(), light)                // 默认 cellSync=confirm
    assertNull(msg); assertEquals(NetGate.Act.LIGHT_UPDATE, pending)
    assertEquals(0, light.checks); assertEquals(0, light.applies)   // ← P1 断言：挂起等确认，未确认不跑
  }

  @Test fun 离线拒绝不触碰light() {
    val light = FakeLight()
    val (msg, _) = entry(offline, Rules(), light)
    assertTrue(msg!!.contains("未开始"))
    val d = offline.enter(Op.SYNC, NetGate.Act.SYNC, Rules()) as NetGate.Next.Deny
    assertTrue(!d.cellularPolicy)
    assertEquals(0, light.checks); assertEquals(0, light.applies)
  }

  @Test fun WiFi与allow直跑_确认后续跑整链() {
    val w = FakeLight(); entry(wifi, Rules(), w)
    assertEquals(1, w.checks); assertEquals(1, w.applies)           // Wi-Fi：门放行直跑
    val a = FakeLight(); entry(cell, Rules(cellSync = CellularRule.ALLOW), a)
    assertEquals(1, a.checks); assertEquals(1, a.applies)           // 移动数据设为允许：直跑
    val c = FakeLight()                                             // confirm → 用户确认（proceedGate 按挂起动作分发）→ 续跑
    val (_, pending) = entry(cell, Rules(), c)
    assertEquals(NetGate.Act.LIGHT_UPDATE, pending)
    if (pending == NetGate.Act.LIGHT_UPDATE) runner(c)
    assertEquals(1, c.checks); assertEquals(1, c.applies)           // 确认后检查+下载+应用整链放行
  }
}
