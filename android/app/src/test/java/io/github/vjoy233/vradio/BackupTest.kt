package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.Backup
import io.github.vjoy233.vradio.data.CfgCodec
import io.github.vjoy233.vradio.data.Library
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.model.Cfg
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory

/* Backup：v2 导出→导入 round-trip；v1（无 my）兼容不炸；非法 JSON → null；my 不进 13 键白名单 */
class BackupTest {
  private lateinit var dir: File
  private lateinit var lib: Library
  private val mainText = "华语音乐,#genre#\n台A,http://a/1\n台B,http://b/1"
  private val myText = "我的,#genre#\r\n台C,http://c/1\r\n"

  @Before fun setup() {
    dir = createTempDirectory("vradio-backup").toFile()
    Store.init(dir)
    lib = Library(Store, dir, mainText, myText)
    lib.reload()
    lib.toggleFav(lib.stations.first { it.n == "台A" })
    lib.pushSong("http://a/1", "第一首歌")
    lib.pushSong("http://a/1", "第二首歌")
  }
  @After fun teardown() { dir.deleteRecursively() }

  @Test fun v2RoundTrip() {
    val out = Backup.exportAll(lib, myText, 123L)
    val p = Backup.parseImport(out)!!
    assertEquals(Store.snapshot(), p.data) // data = 13 键快照
    assertEquals(listOf("我的,#genre#", "台C,http://c/1"), p.my) // my = 原始行（去尾部空行）
    assertTrue(out.contains("\"v\"")) // 版本字段在
  }

  @Test fun v1Compatible() { // v1 无 my 字段：my = null，不炸
    val p = Backup.parseImport("{\"v\":1,\"at\":1,\"data\":{\"radio.favs\":\"[]\",\"radio.vol\":\"90\"}}")!!
    assertNull(p.my)
    assertEquals("90", p.data["radio.vol"])
  }

  @Test fun invalidReturnsNull() {
    assertNull(Backup.parseImport("不是json"))
    assertNull(Backup.parseImport("[1,2]"))
    assertNull(Backup.parseImport("{\"v\":2}")) // 无 data
    assertNull(Backup.parseImport("{\"data\":{}}")) // 无有效键
    assertNull(Backup.parseImport("{\"data\":{\"radio.junk\":\"x\"}}")) // 全是白名单外键
    assertNull(Backup.parseImport("{\"data\":{\"radio.vol\":123}}")) // 非 string 值不收
  }

  @Test fun whitelistFilter() { // data 内的 junk 键（含 my 字样）不进 13 键快照
    val p = Backup.parseImport("{\"v\":2,\"data\":{\"radio.vol\":\"80\",\"my\":\"[\\\"x\\\"]\",\"radio.junk\":\"1\"},\"my\":[\"行\"]}")!!
    assertEquals(setOf("radio.vol"), p.data.keys)
    assertEquals(listOf("行"), p.my)
  }

  @Test fun m3uFavs() {
    val m = Backup.m3uFavs(lib)
    assertTrue(m.startsWith("#EXTM3U\n#VRADIO:FAV\n"))
    assertTrue(m.contains("#EXTINF:-1 group-title=\"华语音乐\",台A"))
    assertTrue(m.contains("http://a/1"))
    lib.toggleFav(lib.stations.first { it.n == "台A" }) // 取消收藏后为空（调用方提示「先收藏」）
    assertEquals("", Backup.m3uFavs(lib))
  }

  @Test fun m3uFavsCleansing() { // 改名后含逗号的台名：导出时逗号换空格（m3u 纯文本不腐蚀）
    Store.set("radio.favs", "[]")
    val l2 = Library(Store, dir, "华语,#genre#\n台D,http://d/1", "")
    l2.reload()
    l2.cfg = Cfg(names = mapOf("http://d/1" to "R&B, 潮流"))
    l2.reapplyCfg()
    l2.toggleFav(l2.stations.first { it.n == "R&B, 潮流" })
    val inf = Backup.m3uFavs(l2).lineSequence().first { it.startsWith("#EXTINF") }
    assertEquals("#EXTINF:-1 group-title=\"华语\",R&B  潮流", inf) // 「, 」→「  」
  }

  @Test fun songsTxtSortedDesc() {
    val t = Backup.songsTxt(lib) { 0L }
    val lines = t.split('\n')
    assertEquals(2, lines.size)
    assertTrue(lines[0].startsWith("第二首歌（台A · 20")) // 最新在前；台名反解 + 本地时间格式
    assertTrue(lines[1].startsWith("第一首歌（台A · 20"))
    assertTrue(lines[0].contains("）"))
  }

  @Test fun songsTxtDormantStation() { // 休眠台（列表无此 URL）：台名用 URL 截断兜底
    val l2 = Library(Store, dir, mainText, "")
    l2.reload()
    Store.set("radio.songs", "{\"http://gone/1\":[{\"t\":\"老歌\",\"at\":1000}]}")
    val t = Backup.songsTxt(l2) { 0L }
    assertTrue(t.contains("老歌（gone/1 · "))
  }

  @Test fun cfgJsonWrapsV1() {
    val c = Cfg(moves = mapOf("http://a/1" to "华语"), cats = listOf("自建"))
    val o = JSONObject(Backup.cfgJson(c))
    assertEquals(1, o.getInt("v"))
    assertEquals(c, CfgCodec.parse(o.getJSONObject("cfg").toString())) // 内层 cfg 往返无损
  }
}
