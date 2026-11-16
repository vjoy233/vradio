package io.github.vjoy233.vradio.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 设置页分组折叠契约测试（docs/ui-android-redesign-plan-2026-11.md §5.6/§7 P3/§8.1 硬门）。
 *
 * 分组折叠只影响 UI 展示，不改变 Prefs/Store 键——模型层只暴露纯值/纯函数
 * （[settingsGroups] / [defaultExpandedIds] / [toggleExpanded]），不触 AppVm/Store。
 * Q26：默认展开「播放」「数据与体检」，其余折叠；Q18 口径：折叠态只保旋转重建，进程被杀回默认。
 */
class SettingsSectionTest {

  /** 七组 id 唯一、顺序（= 渲染顺序）与方案 §5.6 一致 */
  @Test fun 七组id唯一且顺序与方案一致() {
    assertEquals(7, settingsGroups.size)                      // §5.6 固定七组
    val ids = settingsGroups.map { it.id }
    assertEquals(ids.size, ids.toSet().size)                  // id 唯一——折叠态记账以 id 为键
    assertTrue(settingsGroups.all { it.id.isNotBlank() && it.title.isNotBlank() })
    assertEquals(
      listOf("播放", "外观", "数据与体检", "网络与流量", "电台", "备份与导入", "关于与反馈"),
      settingsGroups.map { it.title },                        // 列表顺序即渲染顺序
    )
  }

  /** 默认展开集 == {播放, 数据与体检}（Q26） */
  @Test fun 默认展开集只有播放与数据与体检() {
    val byId = settingsGroups.associateBy { it.id }
    assertEquals(setOf("播放", "数据与体检"), defaultExpandedIds().map { byId.getValue(it).title }.toSet())
    assertEquals(2, defaultExpandedIds().size)
  }

  /** toggleExpanded 纯函数：无则加、有则去 */
  @Test fun toggleExpanded无则加有则去() {
    val cur = defaultExpandedIds()                            // 以默认展开集为起点
    val added = toggleExpanded(cur, "backup")
    assertEquals(cur + "backup", added)                       // 无则加
    assertEquals(cur, toggleExpanded(added, "backup"))        // 有则去（回到原集）
  }

  /** toggleExpanded 幂等：同 id 切两次回到原态、切三次 = 切一次 */
  @Test fun toggleExpanded幂等() {
    val cur = defaultExpandedIds()
    assertEquals(cur, toggleExpanded(toggleExpanded(cur, "about"), "about"))               // 切两次 = 原态（加了再去）
    assertEquals(toggleExpanded(cur, "about"), toggleExpanded(toggleExpanded(toggleExpanded(cur, "about"), "about"), "about"))   // 切三次 = 切一次
    assertEquals(cur, toggleExpanded(toggleExpanded(cur, "play"), "play"))                 // 对默认已展开组同理（去了再回）
  }

  /** 一致性：所有 defaultExpanded 的组都在 settingsGroups 内（展开集必为组集子集） */
  @Test fun 默认展开组都在七组之内() {
    val ids = settingsGroups.map { it.id }.toSet()
    assertTrue(defaultExpandedIds().isNotEmpty() && defaultExpandedIds().all { it in ids })
    assertTrue(settingsGroups.filter { it.defaultExpanded }.map { it.id }.all { it in ids })
  }
}
