package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.metadata.MetadataNormalizer
import io.github.vjoy233.vradio.model.Confidence
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/* MetadataNormalizer（B3-A）：contracts/fixtures/metadata-golden.json 黄金样本逐字段对齐（双端硬验收）
   + 清洗/连接号/台名前缀/同曲去重边界。 */
class MetadataNormalizerTest {

  private fun res(name: String): String =
    javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText()

  @Test fun 黄金样本逐字段对齐() {
    val cases = JSONObject(res("fixtures/metadata-golden.json")).getJSONArray("cases")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val raw = c.getJSONObject("in").getJSONObject("raw")
      val ctx = c.getJSONObject("in").getJSONObject("ctx")
      val out = c.getJSONObject("out")
      val ev = MetadataNormalizer.normalize(
        MetadataNormalizer.IcyRaw(
          title = raw.optString("title"),
          program = raw.optString("program", ""),
          bitrateKbps = raw.optInt("bitrateKbps", 0),
          source = raw.optString("source", "icy"),
          at = raw.optLong("at", 0L)),
        MetadataNormalizer.IcyCtx(ctx.optString("identityUrl"), ctx.optString("stationName", "")),
        now = 0L)   // 样本 at 均非 0，now 不参与
      val name = "case[${i}] ${c.getString("name")}"
      assertEquals(name, out.getString("stationIdentityUrl"), ev.stationIdentityUrl)
      assertEquals(name, out.getString("title"), ev.title)
      assertEquals(name, out.getString("artist"), ev.artist)
      assertEquals(name, out.getString("track"), ev.track)
      assertEquals(name, out.getString("program"), ev.program)
      assertEquals(name, out.optLong("bitrateKbps"), ev.bitrateKbps.toLong())
      assertEquals(name, out.getString("source"), ev.source)
      assertEquals(name, out.optLong("at"), ev.at)
      assertEquals(name, out.getString("confidence"), ev.confidence)
    }
  }

  /* ---------- parseIcyTitle 边界 ---------- */

  @Test fun 首个分隔拆分后续分隔保留在曲名() {
    val p = MetadataNormalizer.parseIcyTitle("A - B - C")
    assertEquals("A", p.artist); assertEquals("B - C", p.track); assertEquals("A - B - C", p.title)
  }

  @Test fun 无空格连接号不拆() {   // 契约：连接号前后带空格才是分隔
    val p = MetadataNormalizer.parseIcyTitle("周杰伦-晴天")
    assertEquals("", p.artist); assertEquals("周杰伦-晴天", p.track)
  }

  @Test fun 全角连接号与破折号形态() {
    for (d in listOf("—", "–", "－")) {
      val p = MetadataNormalizer.parseIcyTitle("A $d B")
      assertEquals("A", p.artist); assertEquals("B", p.track)
      assertEquals("A $d B", p.title)   // title 保留清洗后的原文（连接号不归一）
    }
  }

  @Test fun 全角空格折叠为单空格() {
    val p = MetadataNormalizer.parseIcyTitle("A\u3000-\u3000B")
    assertEquals("A - B", p.title); assertEquals("A", p.artist); assertEquals("B", p.track)
  }

  @Test fun 台名前缀无重复不误删() {
    val p = MetadataNormalizer.parseIcyTitle("动感101 - 歌名", "动感101")
    assertEquals("动感101 - 歌名", p.title); assertEquals("动感101", p.artist); assertEquals("歌名", p.track)
  }

  @Test fun 台名前缀重复剥一层且只剥一层() {
    val p = MetadataNormalizer.parseIcyTitle("动感101 － 动感101 － 歌名", "动感101")   // 全角分隔同口径
    assertEquals("动感101 － 歌名", p.title); assertEquals("动感101", p.artist); assertEquals("歌名", p.track)
  }

  @Test fun 空串与纯空白() {
    assertEquals(MetadataNormalizer.IcyParts("", "", ""), MetadataNormalizer.parseIcyTitle(""))
    assertEquals(MetadataNormalizer.IcyParts("", "", ""), MetadataNormalizer.parseIcyTitle("   \u3000 "))
    assertEquals(MetadataNormalizer.IcyParts("", "", ""), MetadataNormalizer.parseIcyTitle(null))
  }

  /* ---------- normalize 缺省/钳制 ---------- */

  @Test fun at零回退now与source缺省与负码率钳零() {
    val ev = MetadataNormalizer.normalize(
      MetadataNormalizer.IcyRaw(title = "A - B", bitrateKbps = -5, at = 0),
      MetadataNormalizer.IcyCtx("http://a/1"), now = 12345L)
    assertEquals(12345L, ev.at)
    assertEquals("none", ev.source)
    assertEquals(0, ev.bitrateKbps)
    assertEquals(Confidence.PARSED, ev.confidence)
  }

  @Test fun source严格枚举非法归一none() {   // AIbot P2-5：契约允许值全集仅 icy|none（与 Web 同一样本）
    assertEquals("icy", MetadataNormalizer.normalize(
      MetadataNormalizer.IcyRaw(title = "T", source = "icy"), MetadataNormalizer.IcyCtx("u")).source)
    assertEquals("none", MetadataNormalizer.normalize(
      MetadataNormalizer.IcyRaw(title = "T", source = "none"), MetadataNormalizer.IcyCtx("u")).source)
    for (s in listOf("shoutcast", "ICY", "Icecast", "radio-rocks", "icy|x", ""))
      assertEquals("source=$s 应归一 none", "none", MetadataNormalizer.normalize(
        MetadataNormalizer.IcyRaw(title = "T", source = s), MetadataNormalizer.IcyCtx("u")).source)
  }

  @Test fun confidence按artist拆出判定() {
    assertEquals(Confidence.PARSED, MetadataNormalizer.normalize(
      MetadataNormalizer.IcyRaw("X - Y"), MetadataNormalizer.IcyCtx("http://a/1")).confidence)
    assertEquals(Confidence.STREAM, MetadataNormalizer.normalize(
      MetadataNormalizer.IcyRaw("整段歌名"), MetadataNormalizer.IcyCtx("http://a/1")).confidence)
  }

  /* ---------- 同曲去重（30s 窗） ---------- */

  private fun ev(title: String, at: Long) = MetadataNormalizer.normalize(
    MetadataNormalizer.IcyRaw(title = title, at = at), MetadataNormalizer.IcyCtx("http://a/1"))

  @Test fun 同曲30秒内去重() {
    assertTrue(MetadataNormalizer.isDuplicate(ev("T", 1000L), ev("T", 1000L + 30_000L)))
    assertTrue(MetadataNormalizer.isDuplicate(ev("T", 1000L), ev("T", 1000L + 29_999L)))
    assertFalse(MetadataNormalizer.isDuplicate(ev("T", 1000L), ev("T", 1000L + 30_001L)))   // 超窗 = 新曲
    assertFalse(MetadataNormalizer.isDuplicate(ev("T", 1000L), ev("U", 1000L + 1000L)))    // 不同名
    assertFalse(MetadataNormalizer.isDuplicate(null, ev("T", 1000L)))                      // 无上一曲
  }
}
