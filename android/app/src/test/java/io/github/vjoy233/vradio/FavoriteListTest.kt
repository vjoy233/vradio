package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.model.Station
import io.github.vjoy233.vradio.ui.buildFavoriteListUi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** P1 §5.5 收藏页投影契约（JVM 纯函数 buildFavoriteListUi）：
 *  1) 过滤只作用于收藏集合内（query 多词空格 AND 大小写不敏感 / category 收藏内实际分类）；
 *  2) chips 首项「全部」+ 仅收藏内实际出现的分类与数量（顺序按 lib.cats() 传入序过滤）——
 *     范围哨兵（★收藏）绝不入 chips（收藏顶层页是收藏集合唯一主入口，外部 Review 修订）；
 *  3) Q16 最新收藏置顶（入参 = 收藏写入序旧→新，输出新→旧）；
 *  4) empty 两档：收藏全空引导语 / 过滤无命中提示；ver 透传 stamp（哨兵进值域防判等丢渲染）。 */
class FavoriteListTest {
  private fun st(c: String, n: String, u: String) = Station(c, n, mutableListOf(u))

  /* —— 空收藏 —— */

  @Test fun 空收藏_空态引导语chips仅全部() {
    val ui = buildFavoriteListUi(emptyList(), "", "全部", 7)
    assertEquals("还没有收藏电台，去电台页长按或点星标收藏吧", ui.empty)
    assertEquals(listOf("全部" to 0), ui.chips)
    assertTrue(ui.list.isEmpty())
  }

  /* —— Q16 最新收藏置顶 —— */

  @Test fun 收藏列表_最新收藏置顶() {   // 入参按 favorites 投影序（写入序旧→新），输出新→旧
    val ui = buildFavoriteListUi(listOf(st("华语音乐", "台A", "http://a/1"), st("欧美音乐", "台B", "http://b/1"),
      st("华语音乐", "台C", "http://c/1")), "", "全部", 0)
    assertEquals(listOf("台C", "台B", "台A"), ui.list.map { it.n })
  }

  /* —— query 过滤（同 listUi 关键词语义）—— */

  @Test fun 查询过滤_大小写不敏感命中() {
    val favs = listOf(st("欧美音乐", "CNR News", "http://a/1"), st("华语音乐", "音乐之声", "http://b/1"))
    assertEquals(listOf("CNR News"), buildFavoriteListUi(favs, "cnr", "全部", 0).list.map { it.n })
    assertEquals(listOf("音乐之声"), buildFavoriteListUi(favs, "之声", "全部", 0).list.map { it.n })
  }

  @Test fun 查询过滤_多词空格AND() {
    val favs = listOf(st("华语音乐", "CNR 新闻台", "http://a/1"), st("华语音乐", "CNR 音乐台", "http://b/1"))
    assertEquals(listOf("CNR 新闻台"), buildFavoriteListUi(favs, "cnr 新闻", "全部", 0).list.map { it.n })
  }

  @Test fun 查询不命中_给换词提示而非空收藏引导语() {   // favorites 非空但过滤后为空 = 第二档文案
    val favs = listOf(st("华语音乐", "台A", "http://a/1"))
    val ui = buildFavoriteListUi(favs, "不存在的台", "全部", 0)
    assertEquals("收藏中没有匹配的电台", ui.empty)
    assertTrue(ui.list.isEmpty())
  }

  /* —— category 过滤 + chips 计数与顺序 —— */

  @Test fun 分类过滤_只留该分类且chips按cats顺序() {
    val favs = listOf(st("华语音乐", "台A", "http://a/1"), st("欧美音乐", "台B", "http://b/1"),
      st("华语音乐", "台C", "http://c/1"))
    val ui = buildFavoriteListUi(favs, "", "欧美音乐", 0, listOf("欧美音乐", "华语音乐"))
    assertEquals(listOf("台B"), ui.list.map { it.n })   // 过滤结果仍最新置顶（单台无感）
    assertEquals(listOf("全部" to 3, "欧美音乐" to 1, "华语音乐" to 2), ui.chips)   // 计数=全量收藏集合；顺序按 cats 传入序
  }

  @Test fun chips_只含收藏内实际出现的分类() {   // cats 里有、收藏里没有的分类不进 chips
    val favs = listOf(st("华语音乐", "台A", "http://a/1"))
    val ui = buildFavoriteListUi(favs, "", "全部", 0, listOf("欧美音乐", "华语音乐", "国际新闻·谈话"))
    assertEquals(listOf("全部" to 1, "华语音乐" to 1), ui.chips)
  }

  @Test fun chips_无cats按收藏数据序兜底() {   // cats 缺省（JVM 直测）= 收藏数据序
    val favs = listOf(st("华语音乐", "台A", "http://a/1"), st("欧美音乐", "台B", "http://b/1"))
    assertEquals(listOf("全部" to 2, "华语音乐" to 1, "欧美音乐" to 1),
      buildFavoriteListUi(favs, "", "全部", 0).chips)
  }

  @Test fun 分类失效或为哨兵时回退不过滤() {   // 收藏内没有的分类/★收藏 哨兵 → 全量输出（不写 cat，独立状态防御）
    val favs = listOf(st("华语音乐", "台A", "http://a/1"), st("欧美音乐", "台B", "http://b/1"))
    for (cat in listOf("★收藏", "最近", "已消失分类")) {
      val ui = buildFavoriteListUi(favs, "", cat, 0)
      assertEquals(2, ui.list.size)
      assertNull(ui.empty)
    }
  }

  /* —— 哨兵与 ver —— */

  @Test fun 哨兵收藏范围不入chips() {   // §5.1：★收藏 不再出现在任何 chips（含收藏页投影自身）
    val favs = listOf(st("华语音乐", "台A", "http://a/1"), st("欧美音乐", "台B", "http://b/1"))
    val ui = buildFavoriteListUi(favs, "", "全部", 0, listOf("华语音乐", "欧美音乐"))
    assertTrue(ui.chips.none { it.first == "★收藏" })
    assertTrue(ui.chips.none { it.first == "最近" })
  }

  @Test fun ver透传stamp() {   // 哨兵进值域防 StateFlow 判等丢渲染（同 ListUi.ver）
    assertEquals(42, buildFavoriteListUi(emptyList(), "", "全部", 42).ver)
    assertEquals(43, buildFavoriteListUi(listOf(st("华语音乐", "台A", "http://a/1")), "x", "华语音乐", 43).ver)
  }
}
