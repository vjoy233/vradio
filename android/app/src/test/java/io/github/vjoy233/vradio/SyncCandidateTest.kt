package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.sync.Candidates
import io.github.vjoy233.vradio.sync.SyncCandidate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* B2 同步候选管线纯函数（plan-expansion-r4 §6.2，Web 侧语义镜像）：
   normalizeUrl 保守归一化（只用于比对）/ dedupe 三层（精确 URL → 归一化 URL → 同分类同名多源合并）/
   来源字段保留 / fromLine 行协议与非法行过滤。 */
class SyncCandidateTest {

  private fun c(name: String, cat: String, url: String, up: String = "gao", upId: String = "", logo: String = "") =
    SyncCandidate(name, cat, url, up, upId, logo, Candidates.normalizeUrl(url) ?: "", "$cat|$name")

  /* ---------- normalizeUrl：保守归一化，只用于比对 ---------- */

  @Test fun 归一化大小写与默认端口() {
    assertEquals("http://example.com/live", Candidates.normalizeUrl(" HTTP://Example.COM:80/live "))
    assertEquals("https://a.com/x", Candidates.normalizeUrl("https://A.com:443/x"))
    assertEquals("https://a.com", Candidates.normalizeUrl("HTTPS://a.com:443"))
    assertEquals("http://a.com/x", Candidates.normalizeUrl("http://a.com:/x"))     // 空端口形态 = 默认端口
  }

  @Test fun 归一化保留端口路径查询尾斜杠() {
    assertEquals("http://a.com:8080/x", Candidates.normalizeUrl("http://a.com:8080/x"))   // 非默认端口保留
    assertEquals("http://a.com", Candidates.normalizeUrl("http://a.com"))                 // 不补尾斜杠
    assertEquals("http://a.com/", Candidates.normalizeUrl("http://a.com/"))               // 尾斜杠语义保留（与上行不等）
    assertEquals("http://a.com/p?q=1&B=2", Candidates.normalizeUrl("http://a.com/p?q=1&B=2"))   // query 不盲删
    assertEquals("http://a.com/p/", Candidates.normalizeUrl("http://a.com/p/"))
  }

  @Test fun 归一化非法输入null() {
    assertNull(Candidates.normalizeUrl("ftp://a.com"))
    assertNull(Candidates.normalizeUrl("http://"))
    assertNull(Candidates.normalizeUrl("不是地址"))
    assertNull(Candidates.normalizeUrl(""))
  }

  /* ---------- fromLine：行协议与格式过滤 ---------- */

  @Test fun fromLine解析与归一化随行() {
    val x = Candidates.fromLine("华语音乐", " 台A , http://A.com:80/1.mp3 ", "gao")!!
    assertEquals("台A", x.stationName); assertEquals("华语音乐", x.category)
    assertEquals("http://A.com:80/1.mp3", x.url)                    // 原 URL 不被归一化替换（只用于比对）
    assertEquals("http://a.com/1.mp3", x.normalizedUrl)
    assertEquals("华语音乐|台A", x.duplicateKey)
  }

  @Test fun fromLine非法行null() {
    assertNull(Candidates.fromLine("华语音乐", "台A,ftp://a/1", "gao"))   // URL 须 http(s)
    assertNull(Candidates.fromLine("华语音乐", "台A,http://a/1,extra", "gao"))   // 3+ 字段跳过（行协议同款）
    assertNull(Candidates.fromLine("华语音乐", ",http://a/1", "gao"))     // 空台名
    assertNull(Candidates.fromLine("华语音乐", "台A", "gao"))             // 无 URL
  }

  /* ---------- dedupe 三层 ---------- */

  @Test fun 精确URL去重首现保留() {
    val out = Candidates.dedupe(listOf(
      c("台A", "华语音乐", "http://a/1.mp3", up = "gao"),
      c("台B", "新闻资讯", "http://a/1.mp3", up = "gao")))            // 同 URL 换名换类 = 同流重复
    assertEquals(1, out.size)
    assertEquals("台A", out[0].stationName)                          // 首现保留
  }

  @Test fun 归一化URL去重() {
    val out = Candidates.dedupe(listOf(
      c("台A", "华语音乐", "http://a.com/live"),
      c("台B", "华语音乐", "HTTP://A.COM:80/live")))                  // 大写 + 默认端口变形
    assertEquals(1, out.size)
    assertEquals("台A", out[0].stationName)
  }

  @Test fun 同分类同名多源合并不丢行() {
    val out = Candidates.dedupe(listOf(
      c("台A", "华语音乐", "http://a/1.mp3"),
      c("台A", "华语音乐", "http://a/2.mp3")))                        // 同分类同名 = 同台两源
    assertEquals(2, out.size)                                        // 多源行全保留（下游同名行并源）
    assertEquals(out[0].duplicateKey, out[1].duplicateKey)           // 共享合并键
  }

  @Test fun 不同分类同名不强并() {
    val out = Candidates.dedupe(listOf(
      c("音乐台", "华语音乐", "http://a/1.mp3"),
      c("音乐台", "交通广播", "http://b/1.mp3")))
    assertEquals(2, out.size)
    assertTrue(out[0].duplicateKey != out[1].duplicateKey)           // 键不同 → 不并
  }

  @Test fun 去重不拦同源多行合并后的多源() {
    // 精确/归一化层先走：同 URL 重复丢；同名不同 URL 全保留（路径里的冒号不是端口，归一化后仍不同）
    val out = Candidates.dedupe(listOf(
      c("台A", "华语音乐", "http://a/1.mp3"),
      c("台A", "华语音乐", "http://a/1.mp3"),                         // 精确重复 → 丢
      c("台A", "华语音乐", "http://a/1:80/1.mp3"),                    // 归一化后 ≠ http://a/1.mp3 → 留
      c("台A", "华语音乐", "http://a/2.mp3")))
    assertEquals(3, out.size)
  }

  @Test fun 来源字段保留() {
    val out = Candidates.dedupe(listOf(
      c("台A", "华语音乐", "http://a/1.mp3", up = "gao", upId = "id-1", logo = "http://l/1.png"),
      c("台A", "华语音乐", "http://a/1.mp3", up = "other")))
    assertEquals(1, out.size)
    assertEquals("gao", out[0].upstream)                             // 胜者来源字段原样
    assertEquals("id-1", out[0].upstreamId)
    assertEquals("http://l/1.png", out[0].logoUrl)
    assertNull(out[0].validationResult)                              // 国内节不实测（预留字段）
  }

  @Test fun 行序稳定() {
    val out = Candidates.dedupe(listOf(
      c("台B", "华语音乐", "http://b/1"),
      c("台A", "华语音乐", "http://a/1"),
      c("台C", "华语音乐", "http://c/1")))
    assertEquals(listOf("台B", "台A", "台C"), out.map { it.stationName })   // 首现序不被重排
  }

  /* ---------- SyncEngine 国内节装配形态 ---------- */

  @Test fun 跨节全局URL去重后按类回归节() {
    val cands = listOf(
      Candidates.fromLine("华语音乐", "台A,http://a/1.mp3", "gao")!!,
      Candidates.fromLine("交通广播", "台B,http://a/1.mp3", "gao")!!,       // 跨节同 URL → 丢（首现分类胜）
      Candidates.fromLine("交通广播", "台C,http://c/1.mp3", "gao")!!,
      Candidates.fromLine("华语音乐", "台A,http://a/2.mp3", "gao")!!)       // 同节同名多源 → 留
    val by = LinkedHashMap<String, MutableList<String>>()
    for (x in Candidates.dedupe(cands)) by.getOrPut(x.category) { ArrayList() }.add(Candidates.toLine(x))
    assertEquals(listOf("台A,http://a/1.mp3", "台A,http://a/2.mp3"), by["华语音乐"])
    assertEquals(listOf("台C,http://c/1.mp3"), by["交通广播"])
  }
}
