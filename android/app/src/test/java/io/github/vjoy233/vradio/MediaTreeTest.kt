package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.media.MediaTree
import io.github.vjoy233.vradio.model.Station
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* 媒体树纯逻辑（B6，plan-expansion-r4 §10/§12.2）：层级构建、隐藏/dead 过滤、空分类不出现、
   mediaId 编解码 round-trip（含特殊字符 URL）、未知 id 拒收、分页边界。 */
class MediaTreeTest {

  private fun st(c: String, n: String, vararg us: String, hidden: Boolean = false, dead: Boolean = false) =
    Station(c, n, us.toMutableList()).apply {
      this.hidden = hidden
      if (dead) health = "dead"
    }

  private val a = st("华语音乐", "台A", "http://a.example/1.mp3", "http://a2.example/1.mp3")
  private val b = st("华语音乐", "台B", "http://b.example/live", hidden = true)             // cfg 手藏：彻底消失
  private val c = st("新闻资讯", "台C", "http://c.example/x.m3u8", dead = true)             // 死台：默认隐藏
  private val d = st("新闻资讯", "台D", "http://d.example/d")
  private val e = st("自定义", "我的台", "http://e.example/my")                              // 个人台（全个人分类）
  private val g = st("华语音乐", "个人华语台", "http://g.example/p")                          // 个人台混入标准分类

  private val all = listOf(a, b, c, d, e, g)
  private val myUrls = setOf("http://e.example/my", "http://g.example/p")
  private val cats = listOf("华语音乐", "新闻资讯", "自定义", "体育")                        // 体育=空分类

  private fun tree(playingKey: String? = null, hideCats: Set<String> = emptySet(), favs: List<String> = listOf(d.key, a.key), recents: List<String> = listOf(a.key, d.key)) =
    MediaTree.of(all, favs, recents, cats, myUrls, hideCats, playingKey, null)

  @Test fun mediaId编解码roundTrip特殊字符() {
    val urls = listOf(
      "http://a.example/1.mp3",
      "https://x.example/live?a=1&b=2%20q=z+plus/slash",
      "http://qingting.fm/live/1234/64k.mp3?token=AbC+/==",
      "http://非ascii.example/电台",   // UTF-8 多字节
    )
    for (u in urls) assertEquals(u, MediaTree.decId(MediaTree.encId(u)))
    // URL-safe 域：base64 标准字母表的 + / 被换掉，mediaId 里只有 [-_A-Za-z0-9]
    for (u in urls) assertTrue(MediaTree.encId(u).matches(Regex("u:[-_A-Za-z0-9]+")))
    assertNull(MediaTree.decId("favorites"))            // 非 u: 前缀
    assertNull(MediaTree.decId("u:"))                   // 空载荷
    assertNull(MediaTree.decId("u:***bad***"))          // 坏 base64 容错归 null
    assertNull(MediaTree.decId("u:aGVs\nbG8"))          // 换行注入归 null
  }

  @Test fun 根下固定节点() {
    val ids = tree().children(MediaTree.ID_ROOT, 0, 0).map { it.id }
    assertEquals(listOf(MediaTree.ID_FAVS, MediaTree.ID_RECENTS, MediaTree.ID_CATS, MediaTree.ID_CUSTOM), ids)
    assertEquals(listOf("★ 收藏", "最近播放", "分类", "自定义电台"),
      tree().children(MediaTree.ID_ROOT, 0, 0).map { it.title })
    // 无个人台：custom 不出现（favorites/recents/categories 恒为导航锚点）
    val noMy = MediaTree.of(listOf(a, d), listOf(), listOf(), listOf("华语音乐", "新闻资讯"), emptySet(), emptySet(), null, null)
    assertEquals(listOf(MediaTree.ID_FAVS, MediaTree.ID_RECENTS, MediaTree.ID_CATS),
      noMy.children(MediaTree.ID_ROOT, 0, 0).map { it.id })
  }

  @Test fun 收藏与最近按持久序_休眠条目跳过() {
    val favs = tree().children(MediaTree.ID_FAVS, 0, 0)
    assertEquals(listOf("台D", "台A"), favs.map { it.title })   // favsKeys 序，非台序
    assertEquals(listOf("台A", "台D"), tree().children(MediaTree.ID_RECENTS, 0, 0).map { it.title })   // recents 序
    // 休眠收藏（键解析不到）不炸不占位
    val dormant = MediaTree.of(all, listOf("不存在|孤儿", a.key), listOf(), cats, myUrls, emptySet(), null, null)
    assertEquals(listOf("台A"), dormant.children(MediaTree.ID_FAVS, 0, 0).map { it.title })
  }

  @Test fun 分类节点_空分类不出现_个人分类归custom() {
    val catNodes = tree().children(MediaTree.ID_CATS, 0, 0)
    assertEquals(listOf("c:华语音乐", "c:新闻资讯"), catNodes.map { it.id })   // 空分类「体育」不出现；「自定义」归 custom
    assertEquals(listOf("m:自定义"), tree().children(MediaTree.ID_CUSTOM, 0, 0).map { it.id })
    // 华语音乐混入个人台（g）仍归 categories——宁重复归类不藏标准分类；其下个人台照样可见
    assertEquals(listOf("台A", "个人华语台"), tree().children("c:华语音乐", 0, 0).map { it.title })
    assertEquals(listOf("我的台"), tree().children("m:自定义", 0, 0).map { it.title })
    assertEquals(listOf("台D"), tree().children("c:新闻资讯", 0, 0).map { it.title })   // 死台台C默认不入树（下例验例外）
  }

  @Test fun 隐藏台与死台不入树_正在播死台例外() {
    val names = tree().children("c:华语音乐", 0, 0).map { it.title }
    assertTrue("!hidden b", !names.contains("台B"))            // 手藏台：分类下不见
    assertEquals(listOf("台A", "个人华语台"), names)
    assertTrue("!dead c", tree().children("c:新闻资讯", 0, 0).map { it.title }.contains("台C").not())   // 死台默认隐藏
    // 死台的正在播例外（Library.visible 口径）：connectingKey 命中即豁免（自动标记独有豁免，手藏无例外）
    assertEquals(listOf("台C", "台D"), tree(playingKey = c.key).children("c:新闻资讯", 0, 0).map { it.title }.sorted())
    // 手藏在藏分类里也一样彻底消失：favs 里的台随分类消失
    val hidden = tree(hideCats = setOf("新闻资讯"))
    assertEquals(listOf("台A"), hidden.children(MediaTree.ID_FAVS, 0, 0).map { it.title })
  }

  @Test fun 未知id拒收() {   // 车机不接受任意 URL（§10 硬约束）
    val t = tree()
    assertNull(t.item("u:" + java.util.Base64.getUrlEncoder().withoutPadding()
      .encodeToString("http://evil.example/任意流".toByteArray())))   // 解码合法但不在库内
    assertNull(t.item("nonsense"))
    assertNull(t.item("c:体育"))            // 空分类节点查不到
    assertNull(t.item("m:华语音乐"))        // m: 前缀只认 custom 子树的分类
    assertEquals(0, t.children(MediaTree.encId("http://a.example/1.mp3"), 0, 0).size)   // 叶子无子项
    assertNull(t.stationOf("whatever"))
  }

  @Test fun 叶子字段与stationOf回链() {
    val t = tree()
    val leaf = t.children(MediaTree.ID_FAVS, 0, 0).first()   // 台D
    assertEquals("台D", leaf.title)
    assertEquals("新闻资讯", leaf.sub)                        // artist=分类
    assertEquals("http://d.example/d", leaf.uri)
    assertTrue(leaf.playable)
    assertEquals(d, t.stationOf(leaf.id))                    // mediaId → 库内台（播放联动校验口）
    assertEquals(a, t.stationByU0("http://a.example/1.mp3"))
    assertNull(t.stationByU0("http://a2.example/1.mp3"))     // 身份键=u0：备选源不算
    // item 按 id 查叶子
    assertEquals(leaf, t.item(leaf.id))
    assertEquals("VRadio", t.item(MediaTree.ID_ROOT)?.title)
    assertEquals("自定义", t.item("m:自定义")?.title)
  }

  @Test fun 分页边界() {
    val many = (1..5).map { st("华语音乐", "台$it", "http://p.example/$it") }
    val t = MediaTree.of(many, many.map { it.key }, listOf(), listOf("华语音乐"), emptySet(), emptySet(), null, null)
    fun favs(p: Int, ps: Int) = t.children(MediaTree.ID_FAVS, p, ps)
    assertEquals(5, favs(0, 0).size)          // pageSize<=0：全量
    assertEquals(5, favs(-1, 2).size)         // page<0 视为不分页
    assertEquals(listOf("台1", "台2"), favs(0, 2).map { it.title })
    assertEquals(listOf("台3", "台4"), favs(1, 2).map { it.title })
    assertEquals(listOf("台5"), favs(2, 2).map { it.title })
    assertEquals(0, favs(3, 2).size)          // 越界页空列表
    assertEquals(0, favs(99, 3).size)
  }
}
