package io.github.vjoy233.vradio.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/* 窗口档位纯函数测试（docs/ui-android-redesign-plan-2026-11.md §8.1）：
   断点口径 = 600dp（Q7）——>=600 展开（平板/横屏 rail），<600 紧凑（手机底栏），
   599/600 是唯一断点对，840 等经典平板档在单断点口径下同属展开。
   不同窗口档只改导航形态（底栏 ↔ rail），不改业务数据与目的地集合。 */
class WindowClassTest {

  @Test fun 紧凑档_手机宽含断点前一位() {
    assertEquals(VrWindow.COMPACT, windowClassOf(320))                     // 最小支持宽（ui-demo 浏览器矩阵同口径）
    assertEquals(VrWindow.COMPACT, windowClassOf(599))                     // 断点前一位必须仍是紧凑
  }

  @Test fun 展开档_断点即展开() {
    assertEquals(VrWindow.EXPANDED, windowClassOf(600))                    // >=600 含等号
    assertEquals(VrWindow.EXPANDED, windowClassOf(839))                    // 单断点口径：600 之上无二级分档
  }

  @Test fun 展开档_平板与大屏() {
    assertEquals(VrWindow.EXPANDED, windowClassOf(840))                    // 经典平板两栏档同属展开
    assertEquals(VrWindow.EXPANDED, windowClassOf(1920))                   // 桌面/大屏上限抽查
  }
}
