package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.RadioTxt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/* 行协议解析：#genre#/csv/m3u 三形态、同键并源、3+ 字段跳过、URL 非法丢行、真实 radio.txt 首中尾抽查 */
class RadioTxtTest {

  @Test fun genreCsv() { // #genre# 分节 + csv 行
    val t = "华语音乐,#genre#\n台A,http://a/1\n台A,http://a/2\r\n台B,http://b/1"
    val l = RadioTxt.parse(t)
    assertEquals(2, l.size)
    val a = l.first { it.n == "台A" }
    assertEquals("华语音乐", a.c)
    assertEquals(listOf("http://a/1", "http://a/2"), a.u) // 同键并源去重
    assertEquals("华语音乐|台A", a.key)
  }

  @Test fun m3u() { // EXTINF 属性区可含逗号（引号外第一个逗号才是分隔）+ URL 行
    val t = "#EXTM3U\n#EXTINF:-1 tvg-logo=\"http://x/a,b.png\" group-title=\"欧美音乐\",Name X\nhttp://s/1\n" +
      "#EXTINF:-1,Plain Name\nhttp://s/2"
    val l = RadioTxt.parse(t)
    assertEquals(2, l.size)
    assertEquals("Name X", l[0].n)
    assertEquals("欧美音乐", l[0].c)
    assertEquals(listOf("http://s/1"), l[0].u)
    assertEquals("未分类", l[1].c) // 无 group-title 回落当前节（初始「未分类」）
  }

  @Test fun m3uGroupFallsToSection() { // group-title 缺省回落 #genre# 节
    val t = "综合,#genre#\n#EXTINF:-1 name-only,台C\nhttp://c/1"
    val l = RadioTxt.parse(t)
    assertEquals("综合", l[0].c)
    assertEquals("台C", l[0].n)
  }

  @Test fun sameNameDifferentCat() { // 同名不同分类 = 两台（key 含分类）
    val l = RadioTxt.parse("A,#genre#\n台X,http://a/1\nB,#genre#\n台X,http://b/1")
    assertEquals(2, l.size)
  }

  @Test fun threeFieldsSkipped() { // 3+ 字段整行容错跳过（plan 5.2/A2 与 Web lastIndexOf 的差异点）
    val l = RadioTxt.parse("综合,#genre#\n台Y,http://a/1,备注\n台Z,http://z/1")
    assertEquals(1, l.size)
    assertEquals("台Z", l[0].n)
  }

  @Test fun badUrlDropped() { // URL 须 http(s)；非 URL 行/无逗号行丢弃
    val l = RadioTxt.parse("综合,#genre#\n台,ftp://x/1\n台2,notaurl\n台3\n台4,http://ok/1")
    assertEquals(1, l.size)
    assertEquals("台4", l[0].n)
  }

  @Test fun vradioMarkerSkipped() { // 本项目导出标记行不影响解析
    val l = RadioTxt.parse("#EXTM3U\n#VRADIO:FAV\n综合,#genre#\n台W,http://w/1")
    assertEquals(1, l.size)
  }

  @Test fun realFileSpot() { // 真实 radio.txt 首中尾抽查（无文件环境自动跳过；1655 行解析秒级）
    val f = listOf(File("../../radio.txt"), File("../../../radio.txt"), File("radio.txt")).firstOrNull { it.exists() }
    assumeTrue(f != null)
    val l = RadioTxt.parse(f!!.readText())
    assertTrue("电台数应过千，实得 ${l.size}", l.size > 1000)
    assertEquals("华语音乐", l[0].c) // 文件首节
    assertTrue(l.any { it.n.contains("CNR") }) // 首部抽查
    assertTrue(l.any { it.c == "欧美音乐" || it.c == "国际新闻·谈话" }) // 中尾抽查（同步两分类）
    assertTrue(l.all { s -> s.u.isNotEmpty() && s.u.all { it.startsWith("http://") || it.startsWith("https://") } })
    assertTrue(l.all { s -> s.n.isNotEmpty() }) // 名空即被 add 拒收
  }
}
