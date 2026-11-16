package io.github.vjoy233.vradio.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/* 导航纯函数契约测试（docs/ui-android-redesign-plan-2026-11.md §8.1 硬门）：
   可见目的地 navDestinations / 目的地守卫 navigateGuard / 返回裁决 backTarget + Destination.title。
   FeatureFlags.DISCOVERY 是 const val=false，关闭态即默认构建口径——
   发现关时可见目的地只剩电台/收藏、不保留 DISCOVER 空位（Q14）；
   守卫把「去发现」回退电台（§6.1 navigate），普通目的地原样放行；
   次级页开着 Back 回当前顶层目的地（Q21 来源页），无次级页返回 null 不消费（root BackHandler 先序浮层另行消费）。 */
class NavigationStateTest {

  @Test fun 发现关闭时可见目的地只有电台与收藏() {
    val nav = navDestinations()
    assertEquals(listOf(Destination.LIBRARY, Destination.FAVORITES), nav)  // 顺序与内容精确一致
    assertEquals(2, nav.size)                                             // 数量=2，不保留 DISCOVER 空位
    assertFalse(nav.contains(Destination.DISCOVER))                        // 无发现空位（Q14）
  }

  @Test fun 发现关闭时守卫把发现回退到电台() {
    assertEquals(Destination.LIBRARY, navigateGuard(Destination.DISCOVER)) // DISCOVER + flag 关 → LIBRARY
  }

  @Test fun 守卫对普通目的地原样放行() {
    assertEquals(Destination.LIBRARY, navigateGuard(Destination.LIBRARY))
    assertEquals(Destination.FAVORITES, navigateGuard(Destination.FAVORITES))
  }

  @Test fun 次级页开着返回回到当前目的地() {
    assertEquals(Destination.LIBRARY, backTarget(SecondaryRoute.SETTINGS, Destination.LIBRARY))
    assertEquals(Destination.FAVORITES, backTarget(SecondaryRoute.ADD_STATION, Destination.FAVORITES))
  }

  @Test fun 无次级页返回不消费() {
    assertNull(backTarget(null, Destination.LIBRARY))
    assertNull(backTarget(null, Destination.FAVORITES))                    // destination 不影响 null 裁决
  }

  @Test fun 目的地标题三态() {
    assertEquals("电台", Destination.LIBRARY.title)
    assertEquals("发现", Destination.DISCOVER.title)                        // flag 关仍保留枚举常量与标题，只是不进导航
    assertEquals("收藏", Destination.FAVORITES.title)
  }
}
