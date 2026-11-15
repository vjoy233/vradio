package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.PlaylistParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/* 歌单多格式解析（B4，plan-expansion-r4 §8.4）：contracts/fixtures 黄金样本 + 自构边界样本；
 * 与 Web test/playlist-import.js 对同批样本断言同款期望（Web↔Android 一致性：同输入同输出条目集）。
 * 零网络：PlaylistParser 不含任何网络代码路径（纯 JVM 单测无网络权限声明，意外请求即测试环境炸）；
 * XXE 样本断言不抛异常、实体不展开、不产生网络（XmlPullParser 显式关 DOCTYPE 处理，外部实体无由解析）。 */
class PlaylistParserTest {

  private fun res(name: String): String =
    javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText()

  @Test fun plsFixture() { // 3 条、缺 Title 用 URL host、format=pls
    val r = PlaylistParser.parse(res("fixtures/playlist-pls.txt"), "playlist-pls.txt")
    assertEquals("pls", r.format)
    assertEquals(3, r.entries.size)
    assertEquals("示例电台一", r.entries[0].name)
    assertEquals("https://music.example.test/live1.mp3", r.entries[0].url)
    assertEquals("自定义", r.entries[0].category)
    assertEquals("pls", r.entries[0].sourceFormat)
    assertEquals("News Radio", r.entries[1].name)
    assertEquals("jazz.example.test", r.entries[2].name) // File3 无 Title3 → host 兜底
    assertEquals(0, r.invalid); assertEquals(0, r.dups)
  }

  @Test fun plsCaseInsensitiveKeysAndHintOnlyCount() { // 键大小写不敏感；NumberOfEntries 只作提示
    val r = PlaylistParser.parse("NumberOfEntries=1\nFILE1=https://a.example/1\ntItLe1=台一\n", "x.pls")
    assertEquals(1, r.entries.size); assertEquals("台一", r.entries[0].name)
    val r2 = PlaylistParser.parse("NumberOfEntries=5\nFile1=https://a.example/1\n", "x.pls")
    assertEquals(1, r2.entries.size) // 错标 5 不产出幻影条目
  }

  @Test fun xspfFixtureRelativeAndImage() { // 相对 URL 按 baseUrl 解析、image→logo
    val r = PlaylistParser.parse(res("fixtures/playlist-xspf.xml"), null, "https://base.example/dir/")
    assertEquals("xspf", r.format)
    assertEquals(2, r.entries.size)
    assertEquals("示例电台一", r.entries[0].name)
    assertEquals("https://music.example.test/logo1.png", r.entries[0].logo)
    assertEquals("https://base.example/dir/live2.aac", r.entries[1].url)
    assertEquals("xspf", r.entries[1].sourceFormat)
  }

  @Test fun xspfRelativeWithoutBaseCountsInvalid() {
    val r = PlaylistParser.parse(res("fixtures/playlist-xspf.xml"))
    assertEquals(1, r.entries.size); assertEquals(1, r.invalid)
  }

  @Test fun xspfNamespaceInsensitive() { // localName 判定（命名空间前缀/默认 ns 均可）
    val x = """<?xml version="1.0"?><playlist xmlns="http://xspf.org/ns/0/"><trackList><track><title>台</title><location>https://a.example/1</location></track></trackList></playlist>"""
    val r = PlaylistParser.parse(x, "a.xspf")
    assertEquals(1, r.entries.size); assertEquals("台", r.entries[0].name)
  }

  @Test fun asxFixtureAndCase() { // ENTRY/TITLE/REF@HREF 大小写兼容
    val r = PlaylistParser.parse(res("fixtures/playlist-asx.xml"), "list.asx")
    assertEquals("asx", r.format)
    assertEquals(2, r.entries.size)
    assertEquals("示例电台一", r.entries[0].name)
    assertEquals("https://music.example.test/live1.mp3", r.entries[0].url)
    val low = PlaylistParser.parse("<asx version=\"3.0\"><entry><title>小写台</title><ref href=\"https://low.example/x\" /></entry></asx>")
    assertEquals(1, low.entries.size); assertEquals("小写台", low.entries[0].name)
  }

  @Test fun entryRefNotRecursed() { // ENTRYREF 不自动递归网络下载（解析器无网络代码路径，天然不递归）
    val x = "<ASX version=\"3.0\"><ENTRYREF HREF=\"https://never-fetch.example/other.asx\" /><ENTRY><TITLE>本台</TITLE><REF HREF=\"https://a.example/1\" /></ENTRY></ASX>"
    val r = PlaylistParser.parse(x)
    assertEquals(1, r.entries.size)
    assertEquals("https://a.example/1", r.entries[0].url)
    assertTrue(r.entries.none { it.url.contains("never-fetch") })
  }

  @Test fun malformedXmlNoThrow() { // 畸形 XML：API 不抛（内部已收条目保留，尽力收口径）
    val r1 = PlaylistParser.parse("<?xml version=\"1.0\"?><playlist><trackList><track><title>半截")
    assertTrue(r1.entries.size <= 1)
    val r2 = PlaylistParser.parse("<<<完全不是 xml>>>")
    assertEquals("url", r2.format) // 识别回退纯 URL，条目空
    assertEquals(0, r2.entries.size)
  }

  @Test fun xxeNotExpandedNoThrow() { // DOCTYPE 外部实体：不抛、不展开、不产生网络
    val x = "<?xml version=\"1.0\"?><!DOCTYPE playlist [<!ENTITY xxe SYSTEM \"http://attacker.invalid/x.dtd\">]>" +
      "<playlist xmlns=\"http://xspf.org/ns/0/\"><trackList><track><title>&xxe;</title><location>https://safe.example/1</location></track></trackList></playlist>"
    val r = PlaylistParser.parse(x) // KXmlParser 不取外部 DTD/实体；引用处即使中断也已 catch，不向上抛
    assertTrue(r.entries.size <= 1)
    assertTrue(r.entries.none { it.name.contains("attacker") || it.url.contains("attacker") })
  }

  @Test fun duplicateUrlsDeduped() { // 文件内重复 URL 去重（dups 计数，首个胜出）
    val pls = "[playlist]\nFile1=https://a.example/1\nTitle1=甲\nFile2=https://a.example/1\nTitle2=乙\n"
    val r = PlaylistParser.parse(pls)
    assertEquals(1, r.entries.size); assertEquals(1, r.dups)
    assertEquals("甲", r.entries[0].name)
  }

  @Test fun invalidUrlsFiltered() { // 非 http(s) 地址剔除进非法桶
    val pls = "[playlist]\nFile1=ftp://a.example/1\nFile2=javascript:alert(1)\nFile3=https://a.example/ok\n"
    val r = PlaylistParser.parse(pls)
    assertEquals(1, r.entries.size); assertEquals(2, r.invalid)
    assertEquals("https://a.example/ok", r.entries[0].url)
  }

  @Test fun fiveHundredCap() { // 条目封顶 500（PLS 与纯 URL 两口径）
    val big1 = "[playlist]\n" + (1..600).joinToString("\n") { "File$it=https://a.example/$it" }
    assertEquals(500, PlaylistParser.parse(big1).entries.size)
    val big2 = (1..600).joinToString("\n") { "https://a.example/$it" }
    val r2 = PlaylistParser.parse(big2)
    assertEquals(500, r2.entries.size); assertEquals("url", r2.format)
  }

  @Test fun pureUrlList() { // format=url、名字取 host、杂行计入非法
    val t = "https://music.example.com/live.mp3\n\n# 注释行\n不是链接的废行\nhttp://news.example.org/stream\n"
    val r = PlaylistParser.parse(t)
    assertEquals("url", r.format)
    assertEquals(2, r.entries.size)
    assertEquals("music.example.com", r.entries[0].name)
    assertEquals("news.example.org", r.entries[1].name)
    assertEquals(1, r.invalid)
  }

  @Test fun m3uDetect() { // EXTINF 台名/group-title 分类 + csv 行混排
    val t = "#EXTM3U\n#EXTINF:-1 group-title=\"爵士\",台X\nhttps://a.example/1\n台Y,https://b.example/2\n"
    val r = PlaylistParser.parse(t)
    assertEquals("m3u", r.format)
    assertEquals(2, r.entries.size)
    assertEquals("台X", r.entries[0].name); assertEquals("爵士", r.entries[0].category)
    assertEquals("台Y", r.entries[1].name); assertEquals("自定义", r.entries[1].category)
  }

  @Test fun explicitHintWins() { // 显式提示优先于内容（误标 .pls 的 m3u 按 pls 解析为空）
    val r = PlaylistParser.parse("#EXTM3U\n#EXTINF:-1,台\nhttps://a.example/1\n", "foo.pls")
    assertEquals("pls", r.format); assertEquals(0, r.entries.size)
  }

  @Test fun entryCleansing() { // 台名去换行/截 40 字、分类去分隔符截 24 字
    val pls = "[playlist]\nFile1=https://a.example/1\nTitle1=${"台".repeat(60)}\n"
    assertEquals(40, PlaylistParser.parse(pls).entries[0].name.length)
    val m = PlaylistParser.parse("#EXTM3U\n#EXTINF:-1 group-title=\"分类,带|分隔\",台\nhttps://a.example/9\n")
    assertTrue(!Regex("[,|]").containsMatchIn(m.entries[0].category))
    assertTrue(m.entries[0].category.length <= 24)
  }

  @Test fun detectPaths() { // 文件头与内容特征路径（Web detect 同序同果）
    assertEquals("pls", PlaylistParser.detect("[playlist]\nFile1=x", null))
    assertEquals("asx", PlaylistParser.detect("<?xml version=\"1.0\"?>\n<ASX version=\"3.0\">\n<ENTRY>", null))
    assertEquals("xspf", PlaylistParser.detect("<?xml version=\"1.0\"?>\n<playlist version=\"1\" xmlns=\"http://xspf.org/ns/0/\">", null))
    assertEquals("url", PlaylistParser.detect("随便什么文本", null))
    assertEquals("xspf", PlaylistParser.normHint("application/xspf+xml"))
    assertEquals("pls", PlaylistParser.normHint("audio/x-scpls"))
    assertEquals("asx", PlaylistParser.normHint("video/x-ms-asf"))
    assertEquals("m3u", PlaylistParser.normHint("audio/x-mpegurl"))
    assertEquals(null, PlaylistParser.normHint("playlist.txt"))
  }
}
