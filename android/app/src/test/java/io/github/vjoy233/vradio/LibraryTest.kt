package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.Library
import io.github.vjoy233.vradio.data.RadioTxt
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.model.Cfg
import io.github.vjoy233.vradio.model.FavEntry
import io.github.vjoy233.vradio.model.HealthEntry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory

/* Library：装配管线（STARTER 去重/追加源挂尾不动 u[0]/手动隐藏彻底消失/死台隐藏的正在播例外）、
   收藏 URL 回绑、pushSong 去重与 FIFO、最近队列、多词搜索、reapplyCfg 回滚 */
class LibraryTest {
  private lateinit var dir: File

  @Before fun setup() { dir = createTempDirectory("vradio-lib").toFile(); Store.init(dir) }
  @After fun teardown() { dir.deleteRecursively() }

  private fun lib(main: String = "", my: String = "", clock: () -> Long = { 1000L }): Library =
    Library(Store, dir, main, my, clock)

  // —— 装配管线 ——

  @Test fun starterDedupByExactName() { // 主列表已有同名台：精选层不再并入（http 模式下常听=纯重复）
    val l = lib("华语音乐,#genre#\nCNR 音乐之声,http://ngcdn003.cnr.cn/live/yyzs/index.m3u8")
    l.reload()
    assertEquals(1, l.stations.count { it.n == "CNR 音乐之声" })
  }

  @Test fun starterMergedWhenAbsent() { // 主列表缺位时并入精选台（含台标 l 与多源）
    val l = lib("华语音乐,#genre#\n台A,http://a/1")
    l.reload()
    val st = l.stations.firstOrNull { it.n == "Love Radio FM103.7 经典金曲" }
    assertNotNull(st)
    assertEquals(2, st!!.u.size)
    assertTrue(st.l.isNotEmpty())
    assertTrue(l.stations.any { it.n == "Nightwave Plaza" && it.c == "欧美音乐" })
  }

  @Test fun myLayerMerged() { // 个人层常驻并入：同键补源、新键追加
    val l = lib("华语音乐,#genre#\n台A,http://a/1", "华语音乐,#genre#\n台A,http://a/2\n台M,http://m/1")
    l.reload()
    assertEquals(listOf("http://a/1", "http://a/2"), l.stations.first { it.n == "台A" }.u)
    assertTrue(l.stations.any { it.n == "台M" })
  }

  @Test fun appendSrcsTailKeepU0() { // 追加备选源：只挂台尾不动身份键 s.u[0]；最终源集合统一封顶 6（B1 review P1：原生+追加合计）
    Store.set("radio.cfg", "{\"srcs\":{\"http://a/1\":[\"http://s/1\",\"http://s/2\",\"http://s/3\",\"http://s/4\",\"http://s/5\",\"http://s/6\",\"http://s/7\",\"http://s/1\"]}}")
    val l = lib("华语音乐,#genre#\n台A,http://a/1")
    l.reload()
    val st = l.stations.first { it.n == "台A" }
    assertEquals("http://a/1", st.u0)
    assertEquals(listOf("http://a/1", "http://s/1", "http://s/2", "http://s/3", "http://s/4", "http://s/5"), st.u) // 合计封顶 6 + 去重，主源首位
  }

  @Test fun manualHideTotallyGone() { // 手动隐藏 = 彻底消失：无正在播例外（与死台隐藏口径不同），搜索/可见均不可见
    Store.set("radio.cfg", "{\"hideS\":{\"http://a/1\":1}}")
    val l = lib("华语音乐,#genre#\n台A,http://a/1\n台B,http://b/1")
    l.reload()
    val key = "华语音乐|台A"
    assertFalse(l.visible(true, key, key).any { it.n == "台A" }) // showDead=true 且正在播也照样消失
    assertTrue(l.visible(true, null, null).any { it.n == "台B" })
    assertTrue(l.search("台A").isEmpty())
  }

  @Test fun deadHiddenWithPlayingException() { // 死台默认隐藏；正在播/连接中例外；showDead 显全部
    val l = lib("华语音乐,#genre#\n台A,http://a/1")
    l.reload()
    val key = l.stations[0].key
    l.healthMarks[key] = HealthEntry(listOf("http://a/1"), 1, 1, 1, 0)
    l.applyHealthToStations()
    assertFalse(l.visible(false, null, null).any { it.key == key })
    assertTrue(l.visible(false, key, null).any { it.key == key }) // 正在播例外
    assertTrue(l.visible(false, null, key).any { it.key == key }) // 连接中例外
    assertTrue(l.visible(true, null, null).any { it.key == key })
    assertTrue(l.search("台A").isEmpty()) // 搜索走默认隐藏口径
  }

  @Test fun reviveClearsDeadMark() { // 体检复活即回归列表（G P1-1）：onAlive 删 marks 后重挂须清行内 dead——否则当次会话仍被隐藏
    val l = lib("华语音乐,#genre#\n台A,http://a/1\n台B,http://b/1")
    l.reload()
    val ka = l.stations.first { it.n == "台A" }.key
    val kb = l.stations.first { it.n == "台B" }.key
    l.healthMarks[ka] = HealthEntry(listOf("http://a/1"), 1, 1, 1, 0)
    l.healthMarks[kb] = HealthEntry(listOf("http://b/1"), 1, 1, 1, 0)
    l.applyHealthToStations()
    assertFalse(l.visible(false, null, null).any { it.key == ka })
    l.healthMarks.remove(ka)                    // 复活撤销（Health.onAlive 同款 delete）
    l.applyHealthToStations()                    // persistHealth 的重挂路径
    assertTrue(l.visible(false, null, null).any { it.key == ka })   // 复活台回归
    assertNull(l.stations.first { it.n == "台A" }.health)           // 行内标已清
    assertFalse(l.visible(false, null, null).any { it.key == kb })  // 未复活的台照旧隐藏
  }

  @Test fun cfgMoveAndRename() { // 移动/改名按任一源 URL 命中；分类重命名最后映射
    Store.set("radio.cfg", "{\"moves\":{\"http://a/1\":\"自建\"},\"names\":{\"http://a/1\":\"新名\"},\"renames\":{\"华语音乐\":\"华语\"},\"cats\":[\"自建\"]}")
    val l = lib("华语音乐,#genre#\n台A,http://a/1\n台B,http://b/1")
    l.reload()
    assertEquals("自建|新名", l.stations.first { it.n == "新名" }.key)
    assertEquals("华语|台B", l.stations.first { it.n == "台B" }.key)
    assertEquals(listOf("华语", "欧美音乐", "自建", "常听", "亚洲·港台"), l.cats()) // 置顶分类（重命名跟随）+ 自建次之；常听/亚洲·港台/欧美音乐 = STARTER 并入台（applySources 必并，Web 同款）
  }

  @Test fun reapplyCfgRollback() { // 回滚默认口径再重套：撤除移动/追加源即刻生效
    val l = lib("华语音乐,#genre#\n台A,http://a/1")
    l.reload()
    l.cfg = Cfg(moves = mapOf("http://a/1" to "自建"), srcs = mapOf("http://a/1" to listOf("http://s/1")))
    l.reapplyCfg()
    val st = l.stations.first { it.u0 == "http://a/1" }
    assertEquals("自建", st.c)
    assertEquals(listOf("http://a/1", "http://s/1"), st.u)
    l.cfg = Cfg()
    l.reapplyCfg()
    assertEquals("华语音乐", st.c)
    assertEquals(listOf("http://a/1"), st.u) // 追加源随留底回滚移除
  }

  // —— 收藏/最近 ——

  @Test fun favRebindByUrl() { // 上游改名后收藏按 URL 回绑刷新键（身份公理）
    Store.set("radio.favs", "[{\"k\":\"华语音乐|旧名\",\"u\":[\"http://a/1\"]}]")
    val l = lib("华语音乐,#genre#\n新名,http://a/1")
    l.reload()
    assertEquals(listOf(FavEntry("华语音乐|新名", listOf("http://a/1"))), l.favs)
  }

  @Test fun favDormantKept() { // 带 URL 的休眠条目永不回收；旧名字键（无 URL）回绑失败即回收
    Store.set("radio.favs", "[{\"k\":\"X|消失台\",\"u\":[\"http://gone/1\"]},{\"k\":\"Y|名字键\",\"u\":[]}]")
    val l = lib("华语音乐,#genre#\n台A,http://a/1")
    l.reload()
    assertEquals(1, l.favs.size)
    assertEquals("X|消失台", l.favs[0].k)
  }

  @Test fun toggleFavAndKeys() {
    val l = lib("华语音乐,#genre#\n台A,http://a/1")
    l.reload()
    val s = l.stations[0]
    assertFalse(l.isFav(s))
    l.toggleFav(s)
    assertTrue(l.isFav(s))
    assertEquals(setOf("华语音乐|台A"), l.favKeys())
    l.toggleFav(s)
    assertFalse(l.isFav(s))
    assertEquals("[]", Store.get("radio.favs")) // 落盘实时
  }

  @Test fun recentsHeadDedupeAndCap() { // 队首去重 ≤20；队首即「上次收听」
    val l = lib((1..25).joinToString("\n") { "华语音乐,#genre#\n台$it,http://x/$it" }) // 25 节×1 台
    l.reload()
    for (s in l.stations) { l.recordRecent(s); l.recordRecent(s) } // 连播两次也只一条
    assertEquals(20, l.recents.size)
    l.recordRecent(l.stations.first { it.n == "台1" }) // 复播旧台 → 挪到队首
    assertEquals("台1", l.recents[0].let { r -> l.resolve(r.k)?.n })
    assertEquals(20, l.recents.size)
    assertTrue(Store.get("radio.recents")!!.contains("台1"))
  }

  // —— 歌史 ——

  @Test fun pushSongDedupeAndFifo() { // 队首同曲不入；每台 12；台数 50（按各台最新歌时间砍最旧）
    var t = 0L
    val l = lib("") { ++t } // 递增时钟：_FIFO 语义可断言
    l.reload()
    for (i in 1..13) l.pushSong("http://a/1", "歌$i")
    l.pushSong("http://a/1", "歌13") // 与队首同曲：不重复
    assertEquals(12, l.songsOf("http://a/1").size)
    assertEquals("歌13", l.songsOf("http://a/1")[0].t)
    assertEquals("歌2", l.songsOf("http://a/1").last().t) // 最旧的「歌1」被 FIFO 砍掉
    for (i in 1..55) l.pushSong("http://x/$i", "曲$i") // 台数超限：最久无活动的台被砍
    assertEquals(50, l.allSongs().size)
    assertTrue(l.allSongs().containsKey("http://x/55")) // 最近有歌活动的台保留
    assertNull(l.allSongs()["http://a/1"]) // a/1 最新歌早于全部 x/* → 最旧被砍
    assertNull(l.allSongs()["http://x/1"])
  }

  @Test fun pushSongEmptyTitleNoop() {
    val l = lib("")
    l.reload()
    l.pushSong("http://a/1", "")
    assertTrue(l.allSongs().isEmpty())
  }

  // —— 搜索/解析 ——

  @Test fun searchMultiWordAnd() { // 多词空格 AND（CONTRACTS 拍板口径）；台名避开 STARTER 精选（它们也会进搜索域）
    val l = lib("华语音乐,#genre#\n经典老歌台,http://a/1\n摇滚新歌台,http://b/1")
    l.reload()
    assertEquals(1, l.search("经典 老歌").size)   // 两词均命中（顺序无关）
    assertEquals(1, l.search("老歌 经典").size)   // 顺序无关
    assertEquals(0, l.search("老歌 摇滚台").size) // 摇滚台 ≠ 摇滚新歌台：一词不中即不中
    assertEquals(l.stations.size, l.search("  ").size)  // 空白词 = 不过滤（含 STARTER 并入台）
    assertEquals(2, l.search("歌").size)          // STARTER 台名均不含「歌」，恰好两台
    assertTrue(l.search("fm99").isEmpty())       // STARTER 无 fm99 形态台名（避免精选层内容耦合）
  }

  @Test fun resolveAndByUrl() {
    val l = lib("华语音乐,#genre#\n台A,http://a/1\n台B,http://b/1")
    l.reload()
    assertEquals("台A", l.resolve("华语音乐|台A")?.n)
    assertNull(l.resolve("不存在|键"))
    assertEquals("台B", l.resolveByUrl("http://b/1")?.n) // 任一源命中
    assertNull(l.resolveByUrl("http://gone/1"))
  }

  @Test fun reloadStoreAfterImport() { // 备份导入（applyAll）后内存态重载
    val l = lib("华语音乐,#genre#\n台A,http://a/1")
    l.reload()
    l.toggleFav(l.stations[0])
    Store.applyAll(mapOf("radio.favs" to "[{\"k\":\"别的|台\",\"u\":[\"http://z/1\"]}]"))
    l.reloadStore()
    assertEquals(1, l.favs.size)
    assertEquals("别的|台", l.favs[0].k)
    assertFalse(l.isFav(l.stations[0]))
  }

  @Test fun healthOrphanCleaned() { // 回绑失联的休眠孤儿 90 天清理；期限内保留
    val now = 1000L
    val l = lib("华语音乐,#genre#\n台A,http://a/1", "", clock = { now })
    l.reload()
    l.healthMarks["X|孤儿新"] = HealthEntry(listOf("http://gone/1"), now, now, 1, 0)
    l.healthMarks["Y|孤儿旧"] = HealthEntry(listOf("http://gone/2"), now, now - 91 * 86400000L, 1, 0)
    l.rebind()
    assertTrue(l.healthMarks.containsKey("X|孤儿新")) // t0 距今 0 天：保留
    assertFalse(l.healthMarks.containsKey("Y|孤儿旧")) // t0 距今 91 天：清理
  }

  @Test fun healthReboundToStation() { // 死标记按 URL 命中改名后的台：键刷新、台挂 dead 标
    Store.set("radio.health", "{\"华语音乐|旧名\":{\"u\":[\"http://a/1\"],\"t\":100,\"t0\":100,\"n\":1,\"perm\":0}}")
    val l = lib("华语音乐,#genre#\n新名,http://a/1")
    l.reload()
    assertEquals("dead", l.stations[0].health)
    assertTrue(l.healthMarks.containsKey("华语音乐|新名")) // 键随回绑刷新
    assertEquals(listOf("http://a/1"), l.healthMarks["华语音乐|新名"]!!.u)
  }

  // —— N2 m3u 泛导入分流（partitionImport；AIbot P1-1 修复回归锚：分流先于收藏变异，库外台不被遮蔽） ——

  @Test fun partitionImportKeyAndUrlHits() { // 键命中与 URL 兜底都归收藏恢复面；命中的是库内台对象（分类/键以库为准，
    // 不吃 m3u 的「未分类」）；同键多源条目任一 URL 命中即整条归收藏面，未知变体 URL 不单独入库
    val l = lib("华语音乐,#genre#\n台A,http://a/1\n台B,http://b/1")
    l.reload()
    val m3u = RadioTxt.parse("#EXTM3U\n#EXTINF:-1 group-title=\"华语音乐\",台A\nhttp://a/1\n" +
      "#EXTINF:-1 group-title=\"华语音乐\",台A\nhttp://a/9\n#EXTINF:-1,台B\nhttp://b/1")   // 台B 无 group-title → 键不同走 URL 兜底
    val (hits, extra) = l.partitionImport(m3u)
    assertEquals(listOf("台A", "台B"), hits.map { it.n })
    assertEquals(listOf("华语音乐", "华语音乐"), hits.map { it.c })
    assertTrue(extra.isEmpty())
  }

  @Test fun partitionImportExtraAndFallbackCat() { // 库外台入 extra；无 group-title（未分类）兜底「自定义」、有则保留
    val l = lib("华语音乐,#genre#\n台A,http://a/1")
    l.reload()
    val m3u = RadioTxt.parse("#EXTM3U\n#EXTINF:-1,台X\nhttp://x/1\n#EXTINF:-1 group-title=\"交通\",台Y\nhttp://y/1")
    val (hits, extra) = l.partitionImport(m3u)
    assertTrue(hits.isEmpty())
    assertEquals(listOf("自定义|台X" to "http://x/1", "交通|台Y" to "http://y/1"), extra.map { it.key to it.u0 })
  }

  @Test fun partitionImportSkipsKnownUrls() { // 休眠收藏 URL / my 层 URL 不重复入库；同 URL 多条去重
    Store.set("radio.favs", "[{\"k\":\"休眠|台\",\"u\":[\"http://d/1\"]}]")
    val l = lib("华语音乐,#genre#\n台A,http://a/1", "华语音乐,#genre#\n台M,http://m/1")
    l.reload()
    val m3u = RadioTxt.parse("#EXTM3U\n#EXTINF:-1,台D\nhttp://d/1\n#EXTINF:-1,台M2\nhttp://m/1\n" +
      "#EXTINF:-1,台Z\nhttp://z/1\n#EXTINF:-1,台Z2\nhttp://z/1")
    val (hits, extra) = l.partitionImport(m3u)
    assertEquals(listOf("台M"), hits.map { it.n })            // my 层并入 stations 后按 URL 命中
    assertEquals(listOf("自定义|台Z"), extra.map { it.key })  // 休眠收藏 d/1 跳过；z/1 去重一次
  }
}
