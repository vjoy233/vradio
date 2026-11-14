package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.sync.Gh
import io.github.vjoy233.vradio.data.HttpText
import io.github.vjoy233.vradio.sync.LightUpdate
import io.github.vjoy233.vradio.sync.RadioMeta
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/* D7 轻更新：判新旧（commits API vs stamp）→ 下载落盘（tmp+rename + stamp.json）→ keyOf 口径 diff
   + addedCheck（欧美两节过滤）。FakeHttp 按 URL 喂罐头，全程离线。 */
class LightUpdateTest {

  @get:Rule val tmp = TemporaryFolder()

  private class FakeHttp(private val map: Map<String, String?>) : HttpText {
    override suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String>): String? = map[url]
  }

  private fun commits(date: String) = """[{"sha":"x","commit":{"committer":{"date":"$date"}}}]"""

  private val radioV2 = listOf(
    "华语音乐,#genre#", "台A,http://a/1.mp3", "台B,http://b/1.mp3",       // 台B 新增
    "欧美音乐,#genre#", "EU X [美国],http://e/1.mp3",                     // 新增但欧美节 → 不进 addedCheck
    "新闻资讯,#genre#", "台C,http://c/1.m3u8").joinToString("\r\n") + "\r\n"

  private val radioV1 = listOf("华语音乐,#genre#", "台A,http://a/1.mp3", "旧台,http://old/1.mp3").joinToString("\r\n") + "\r\n"

  private val logosV2 = ("# 由 npm run sync 自动生成：欧美系台标。手工编辑会被覆盖。\r\n"
    + "欧美音乐|EU X [美国],http://l/1.png\r\n" + "欧美音乐|EU X [美国],http://l/1.png\r\n"  // 凑 body>100
    + "欧美音乐|EU X [美国],http://l/1.png\r\n" + "欧美音乐|EU X [美国],http://l/1.png\r\n")

  // B2 radio-meta.json（plan §6.3 形态；凑 ghFile body>100 闸）
  private val metaV1 = ("{\"v\":1,\"generatedAt\":1731500000000,\"stations\":{"
    + "\"http://a/1.mp3\":{\"name\":\"台A\",\"category\":\"华语音乐\",\"sources\":["
    + "{\"url\":\"http://a/1.mp3\",\"upstream\":\"gao\",\"upstreamId\":\"\",\"kind\":\"main\",\"firstSeenAt\":1731400000000}]},"
    + "\"http://b/1.mp3\":{\"name\":\"台B\",\"category\":\"华语音乐\",\"sources\":["
    + "{\"url\":\"http://b/1.mp3\",\"upstream\":\"gao\",\"upstreamId\":\"g-42\",\"kind\":\"main\",\"firstSeenAt\":1731400000000}]}}}")

  private val metaV2Bad = ("{\"v\":2,\"generatedAt\":1731500000000,\"stations\":{"
    + "\"http://a/1.mp3\":{\"name\":\"台A\",\"category\":\"华语音乐\",\"sources\":["
    + "{\"url\":\"http://a/1.mp3\",\"upstream\":\"gao\",\"upstreamId\":\"\",\"kind\":\"main\",\"firstSeenAt\":1731400000000}]},"
    + "\"http://b/1.mp3\":{\"name\":\"台B\",\"category\":\"华语音乐\",\"sources\":["
    + "{\"url\":\"http://b/1.mp3\",\"upstream\":\"gao\",\"upstreamId\":\"\",\"kind\":\"main\",\"firstSeenAt\":1731400000000}]}}}")

  private fun fullMap(radio: String = radioV2, logos: String? = logosV2,
                      radioAt: String = "2026-10-10T00:00:00Z", logosAt: String = "2026-10-09T00:00:00Z",
                      meta: String? = null) =
    mapOf(
      "https://api.github.com/repos/vjoy233/vradio/commits?path=radio.txt&per_page=1" to commits(radioAt),
      "https://api.github.com/repos/vjoy233/vradio/commits?path=logos.txt&per_page=1" to commits(logosAt),
      "https://api.github.com/repos/vjoy233/vradio/contents/radio.txt" to radio,
      "https://api.github.com/repos/vjoy233/vradio/contents/logos.txt" to logos,
      "https://api.github.com/repos/vjoy233/vradio/contents/radio-meta.json" to meta)

  @Test fun 从未更新读数为null() {
    val lu = LightUpdate(Gh(FakeHttp(emptyMap())), tmp.newFolder())
    runBlocking {
      assertNull(lu.radioText()); assertNull(lu.logosText()); assertNull(lu.stamp())
    }
  }

  @Test fun check判新旧() = runBlocking {
    val gh = Gh(FakeHttp(fullMap()))
    val dir = tmp.newFolder()
    // 本地更旧（打包基线）→ 返回两路径较新者（radio 10-10 > logos 10-09）
    assertEquals("2026-10-10T00:00:00Z", LightUpdate(gh, dir).check("2026-10-01T00:00:00Z"))
    // 本地已含最新 → null 且非失败
    val lu2 = LightUpdate(gh, dir)
    assertNull(lu2.check("2026-10-10T00:00:00Z")); assertEquals("", lu2.lastFailWhy)
    // 本地超前（罕见：回滚包）→ null
    assertNull(LightUpdate(gh, dir).check("2026-10-20T00:00:00Z"))
    // git %cI 带时区偏移也能比
    assertEquals("2026-10-10T00:00:00Z", LightUpdate(gh, dir).check("2026-10-09T23:00:00+08:00"))
  }

  @Test fun check网络失败可区分() = runBlocking {
    val lu = LightUpdate(Gh(FakeHttp(emptyMap())), tmp.newFolder())
    assertNull(lu.check("2026-10-01T00:00:00Z"))
    assertTrue(lu.lastFailWhy.isNotEmpty())
  }

  @Test fun apply全流程() = runBlocking {
    val lu = LightUpdate(Gh(FakeHttp(fullMap()), 0), tmp.newFolder())
    val r = lu.apply(radioV1)!!
    assertEquals("2026-10-10T00:00:00Z", r.commitIso)
    assertTrue(r.radioChanged); assertTrue(r.logosChanged)
    // keyOf 口径：新增 华语音乐|台B、欧美音乐|EU X [美国]、新闻资讯|台C；消失 华语音乐|旧台
    assertEquals(3, r.added); assertEquals(1, r.removed)
    // addedCheck 只留国内台（欧美节过滤）
    assertEquals(listOf("台B", "台C"), r.addedCheck)
    // 落盘读回
    assertEquals(radioV2, lu.radioText()); assertEquals(logosV2, lu.logosText())
    assertEquals("2026-10-10T00:00:00Z", lu.stamp())
    // 内容未变时 radioChanged=false（stamp 变但文件同——logos-only 提交场景）
    val again = LightUpdate(Gh(FakeHttp(fullMap()), 0), tmp.root).apply(radioV2)!!
    assertFalse(again.radioChanged)
  }

  @Test fun apply缺logos不阻断() = runBlocking {
    val lu = LightUpdate(Gh(FakeHttp(fullMap(logos = null)), 0), tmp.newFolder())
    val r = lu.apply(radioV1)!!
    assertFalse(r.logosChanged)      // logos 下载失败：保留旧（此处从未有 → 仍 null），radio 照常落盘
    assertEquals(radioV2, lu.radioText()); assertNull(lu.logosText())
  }

  @Test fun apply拿不到radio整体失败() = runBlocking {
    val m = fullMap().toMutableMap()
    m["https://api.github.com/repos/vjoy233/vradio/contents/radio.txt"] =
      "限流短错误页"   // body ≤100 → Gh.file 按失败处理
    val lu = LightUpdate(Gh(FakeHttp(m)), tmp.newFolder())
    assertNull(lu.apply(radioV1))
    assertTrue(lu.lastFailWhy.isNotEmpty())
    assertNull(lu.radioText())   // 未落任何文件
  }

  @Test fun apply网络全挂失败明示() = runBlocking {
    val lu = LightUpdate(Gh(FakeHttp(emptyMap())), tmp.newFolder())
    assertNull(lu.apply(radioV1))
    assertTrue(lu.lastFailWhy.isNotEmpty())
  }

  /* ---------- B2 radio-meta.json 消费通道 ---------- */

  @Test fun meta解析容错() {
    assertNotNull(RadioMeta.parse(metaV1))
    val m = RadioMeta.parse(metaV1)!!
    assertEquals(1731500000000L, m.generatedAt)
    val st = m.stations["http://b/1.mp3"]!!
    assertEquals("台B", st.name); assertEquals("华语音乐", st.category)
    assertEquals("g-42", st.sources[0].upstreamId); assertEquals("gao", st.sources[0].upstream)
    assertNull(RadioMeta.parse(null)); assertNull(RadioMeta.parse("")); assertNull(RadioMeta.parse("not json{"))
    assertNull(RadioMeta.parse(metaV2Bad))   // v!=1 版本门
    assertNull(RadioMeta.parse("{\"v\":1,\"stations\":\"坏形状\"}"))   // stations 非对象 = 整份非法
    // 字段级坏行容错：坏台行跳过、好台行保留
    val m2 = RadioMeta.parse("{\"v\":1,\"stations\":{\"http://a/1\":\"坏行\",\"http://b/1\":{\"name\":\"台B\",\"category\":\"华语音乐\",\"sources\":[]}}}")!!
    assertEquals(1, m2.stations.size)
  }

  @Test fun apply写meta并随行落盘() = runBlocking {
    val lu = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), tmp.newFolder())
    val r = lu.apply(radioV1)!!
    assertTrue(r.metaChanged); assertFalse(r.metaInvalid)
    assertEquals(metaV1, lu.metaText())
  }

  @Test fun meta校验失败保留旧件不阻断主库() = runBlocking {
    val dir = tmp.newFolder()
    val lu1 = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
    lu1.apply(radioV1)
    // 第二轮：仓库 meta 换成 v2（版本不认识）→ 保留旧 meta，radio 照常更新
    val lu2 = LightUpdate(Gh(FakeHttp(fullMap(radio = radioV2, logos = null, radioAt = "2026-10-11T00:00:00Z",
      logosAt = "2026-10-09T00:00:00Z", meta = metaV2Bad)), 0), dir)
    val r = lu2.apply(radioV1)!!
    assertTrue(r.metaInvalid); assertFalse(r.metaChanged)
    assertEquals(metaV1, lu2.metaText())                    // 旧 meta 原样
    assertEquals(radioV2, lu2.radioText())                  // 主库不受影响
  }

  @Test fun 仓库未提供meta静默不误报() = runBlocking {
    val lu = LightUpdate(Gh(FakeHttp(fullMap()), 0), tmp.newFolder())   // meta=null（404/网络失败同面）
    val r = lu.apply(radioV1)!!
    assertFalse(r.metaChanged); assertFalse(r.metaInvalid)  // 无「校验失败」误报（Web 侧生成落地前不吵）
    assertEquals(radioV2, lu.radioText()); assertNull(lu.metaText())
  }
}
