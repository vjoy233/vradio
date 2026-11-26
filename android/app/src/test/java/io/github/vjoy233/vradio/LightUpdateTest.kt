package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.sync.Gh
import io.github.vjoy233.vradio.data.HttpText
import io.github.vjoy233.vradio.data.AtomicWriteTestHook
import io.github.vjoy233.vradio.data.writeTextAtomic
import java.io.File
import io.github.vjoy233.vradio.sync.LightUpdate
import io.github.vjoy233.vradio.sync.RadioMeta
import io.github.vjoy233.vradio.sync.SyncBarrier
import io.github.vjoy233.vradio.sync.SyncEngine
import io.github.vjoy233.vradio.check.CheckStream
import io.github.vjoy233.vradio.check.RawHttp
import io.github.vjoy233.vradio.ui.lightUpdateMessage
import io.github.vjoy233.vradio.ui.syncFailureMessage
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/* D7 轻更新：判新旧（commits API vs stamp）→ 下载落盘（tmp+rename + stamp.json）→ keyOf 口径 diff
   + addedCheck（欧美两节过滤）。FakeHttp 按 URL 喂罐头，全程离线。 */
class LightUpdateTest {
  @After fun clearAtomicHook() { AtomicWriteTestHook.rename = null; AtomicWriteTestHook.tempCreate = null; AtomicWriteTestHook.tempWrite = null }

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
    val r = lu.applyForTest(radioV1)!!
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
    val again = LightUpdate(Gh(FakeHttp(fullMap()), 0), tmp.root).applyForTest(radioV2)!!
    assertFalse(again.radioChanged)
  }

  @Test fun apply缺logos不阻断() = runBlocking {
    val lu = LightUpdate(Gh(FakeHttp(fullMap(logos = null)), 0), tmp.newFolder())
    val r = lu.applyForTest(radioV1)!!
    assertEquals(LightUpdate.LogosStatus.DOWNLOAD_FAILED, r.logosStatus)
    assertEquals(LightUpdate.MetaStatus.DOWNLOAD_FAILED, r.metaStatus)
    assertEquals(LightUpdate.CleanupStatus.ABSENT, r.metaCleanup)
    assertTrue(r.stampWritten)
    assertFalse(r.logosChanged)      // logos 下载失败：保留旧（此处从未有 → 仍 null），radio 照常落盘
    assertEquals(radioV2, lu.radioText()); assertNull(lu.logosText())
  }

  @Test fun apply拿不到radio整体失败() = runBlocking {
    val m = fullMap().toMutableMap()
    m["https://api.github.com/repos/vjoy233/vradio/contents/radio.txt"] =
      "限流短错误页"   // body ≤100 → Gh.file 按失败处理
    val lu = LightUpdate(Gh(FakeHttp(m)), tmp.newFolder())
    assertNull(lu.applyForTest(radioV1))
    assertTrue(lu.lastFailWhy.isNotEmpty())
    assertNull(lu.radioText())   // 未落任何文件
  }

  @Test fun apply网络全挂失败明示() = runBlocking {
    val lu = LightUpdate(Gh(FakeHttp(emptyMap())), tmp.newFolder())
    assertNull(lu.applyForTest(radioV1))
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
    val r = lu.applyForTest(radioV1)!!
    assertTrue(r.metaChanged); assertFalse(r.metaInvalid)
    assertEquals(metaV1, lu.metaText())
    assertEquals(true, lu.stampMetaOk())                    // AIbot P1-4：stamp.meta 同批见证（bound 放行）
    // AIbot 三轮 P1：正常批次 → 内容哈希双见证在位且与盘上两文件一致 → 绑定（发现页「最近新增」放行）
    val h = lu.stampHashOk()
    assertEquals(true to true, h)
    assertTrue(RadioMeta.bound(true, true, lu.stampMetaOk(), h.first, h.second))
  }

  @Test fun meta校验失败删旧件不阻断主库() = runBlocking {
    val dir = tmp.newFolder()
    val lu1 = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
    lu1.applyForTest(radioV1)
    // 第二轮：仓库 meta 换成 v2（版本不认识）→ 删旧 meta（AIbot P1-4：新 radio 配旧 meta 是混态，宁缺勿混），
    // radio 照常更新；stamp.meta=false → RadioMeta.bound 拦下「最近新增」
    val lu2 = LightUpdate(Gh(FakeHttp(fullMap(radio = radioV2, logos = null, radioAt = "2026-10-11T00:00:00Z",
      logosAt = "2026-10-09T00:00:00Z", meta = metaV2Bad)), 0), dir)
    val r = lu2.applyForTest(radioV1)!!
    assertTrue(r.metaInvalid); assertFalse(r.metaChanged)
    assertEquals(LightUpdate.MetaStatus.INVALID, r.metaStatus)
    assertEquals(LightUpdate.CleanupStatus.DELETED, r.metaCleanup)
    assertTrue(lightUpdateMessage(r, false).contains("元数据校验失败，旧文件已删除"))
    assertNull(lu2.metaText())                              // 旧 meta 已删（混态拦截）
    assertEquals(radioV2, lu2.radioText())                  // 主库不受影响
    assertEquals(false, lu2.stampMetaOk())                  // 见证为 false：bound(files=true, files=true, false) = 不绑定
    val h2 = lu2.stampHashOk()                              // AIbot 三轮 P1：新 radio 哈希在位（stamp 正常落盘）、无 metaHash
    assertEquals(true to null, h2)
    assertFalse(RadioMeta.bound(true, lu2.metaText() != null, lu2.stampMetaOk(), h2.first, h2.second))
  }

  @Test fun 仓库未提供meta静默不误报且删旧件() = runBlocking {
    val dir = tmp.newFolder()
    val lu1 = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)   // 先落一份旧 meta
    lu1.applyForTest(radioV1)
    val lu2 = LightUpdate(Gh(FakeHttp(fullMap(radioAt = "2026-10-12T00:00:00Z",
      logosAt = "2026-10-09T00:00:00Z")), 0), dir)   // 第二轮 meta=null（404/网络失败同面）
    val r = lu2.applyForTest(radioV1)!!
    assertFalse(r.metaChanged); assertFalse(r.metaInvalid)  // 无「校验失败」误报（Web 侧生成落地前不吵）
    assertEquals(radioV2, lu2.radioText())
    assertNull(lu2.metaText())                              // AIbot P1-4：旧 meta 删除（新库不留旧 meta）
    assertEquals(false, lu2.stampMetaOk())
  }

  /* ---------- AIbot P1-4 + 三轮 P1：RadioMeta 与当前 radio 资产同批绑定校验（发现页「最近新增」消费门） ---------- */

  @Test fun meta绑定矩阵() {
    // assets 对（同为打包基线）→ 绑定（哈希不参与：gradle 打包天然同批）
    assertTrue(RadioMeta.bound(radioFromFiles = false, metaFromFiles = false, stampMetaOk = null))
    assertTrue(RadioMeta.bound(false, false, true))
    // filesDir 对 + stamp 三重见证（meta=true + 双哈希一致）→ 绑定
    assertTrue(RadioMeta.bound(true, true, true, true, true))
    // 哈希不一致（新 radio 配残留旧 stamp 等）→ 不绑定（AIbot 三轮 P1 核心拦截）
    assertFalse(RadioMeta.bound(true, true, true, false, true))
    assertFalse(RadioMeta.bound(true, true, true, true, false))
    // 哈希缺位（旧 stamp 无字段/null）→ 保守不绑定
    assertFalse(RadioMeta.bound(true, true, true, null, true))
    assertFalse(RadioMeta.bound(true, true, true, true, null))
    // 混态：filesDir radio + assets meta（meta 下载从未成功）→ 不绑定（最近新增置空）
    assertFalse(RadioMeta.bound(true, false, null))
    assertFalse(RadioMeta.bound(true, false, true))
    // 反向混态：assets radio + filesDir meta（理论上不会出现，防御）
    assertFalse(RadioMeta.bound(false, true, true))
    // B2 时代旧 stamp（无 meta 字段）配 filesDir 对 → 无法证明同批 → 不绑定（保守，下次成功更新恢复）
    assertFalse(RadioMeta.bound(true, true, null))
    // 见证 false（本批未随行 meta）→ 不绑定
    assertFalse(RadioMeta.bound(true, true, false))
  }

  /* ---------- AIbot 三轮 P1：D7 批次提交协议回归（部分写失败不得误绑） ---------- */

  /** 指定目标的原子替换失败；其他目标沿用真实原子替换。 */
  private fun injectRenameFail(name: String) {
    AtomicWriteTestHook.rename = { from, to ->
      if (to.name == name) false else runCatching {
        java.nio.file.Files.move(from.toPath(), to.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE,
          java.nio.file.StandardCopyOption.REPLACE_EXISTING); true
      }.getOrDefault(false)
    }
  }

  @Test fun meta写失败失效见证与旧件不误报整体失败() = runBlocking {
    val dir = tmp.newFolder()
    val lu1 = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
    lu1.applyForTest(radioV1) // 先写旧批次
    injectRenameFail("radio-meta.json") // 第二批模拟替换失败
    val lu2 = LightUpdate(Gh(FakeHttp(fullMap(radioAt = "2026-10-11T00:00:00Z",
      logosAt = "2026-10-09T00:00:00Z", meta = metaV1)), 0), dir)
    val r = lu2.applyForTest(radioV1)!!
    // radio 已更新、apply 不整体失败（≠ 抛异常/返回 null——UI 不会误报「已保留原数据」）
    assertEquals(radioV2, lu2.radioText())
    assertFalse(r.metaChanged); assertFalse(r.metaInvalid)
    assertEquals(LightUpdate.MetaStatus.WRITE_FAILED, r.metaStatus)
    assertEquals(LightUpdate.CleanupStatus.DELETED, r.metaCleanup)
    assertTrue(lightUpdateMessage(r, false).contains("元数据写入失败，旧文件已删除"))
    assertNull(lu2.metaText())                             // 旧 meta 已删（新 radio 不留旧 meta——宁缺勿混）
    assertEquals(false, lu2.stampMetaOk())                 // 见证失效：本批未落成 meta
    val h = lu2.stampHashOk()
    assertEquals(true to null, h)                          // 新 radio 哈希在位、无 metaHash
    assertFalse(RadioMeta.bound(true, lu2.metaText() != null, lu2.stampMetaOk(), h.first, h.second))   // 最近新增置空
  }

  @Test fun radio新内容配残留旧stamp哈希拦截() {
    // 复现评审场景（最坏残留）：批次一全量成功后，批次二 radio 写成功、meta 写失败且删件/新 stamp 均失败
    // ——盘上 = 新 radio + 旧 meta + 旧 stamp(meta=true)。哈希核对是最后的拦截线。
    val dir = tmp.newFolder()
    runBlocking {
      val lu1 = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
      lu1.applyForTest(radioV1)
      assertTrue(lu1.stampMetaOk()!!)
      // 注入「radio.txt 被换成新内容而 stamp/meta 未动」（= 上述部分写失败后的等价盘面）
      java.io.File(dir, "radio.txt").writeText(radioV2 + "台D,http://d/1.mp3\r\n")
      val lu2 = LightUpdate(Gh(FakeHttp(emptyMap())), dir)
      assertEquals(true, lu2.stampMetaOk())                // 旧 stamp 见证仍是 meta=true（残留）
      assertEquals(metaV1, lu2.metaText())                 // 旧 meta 文件仍在
      val h = lu2.stampHashOk()
      assertEquals(false to true, h)                       // radio 哈希对不上、meta 哈希碰巧一致——任一不一致即混态
      assertFalse(RadioMeta.bound(true, true, lu2.stampMetaOk(), h.first, h.second))   // 三重见证缺一 → 不绑定
    }
  }

  @Test fun radio写失败保留旧批次() = runBlocking {
    val dir = tmp.newFolder()
    val lu = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
    assertNotNull(lu.applyForTest(radioV1))
    val before = listOf("radio.txt", "logos.txt", "radio-meta.json", "stamp.json")
      .associateWith { java.io.File(dir, it).readText() }
    injectRenameFail("radio.txt")
    val next = LightUpdate(Gh(FakeHttp(fullMap(radio = radioV2 + "新台,http://new/1.mp3\r\n",
      radioAt = "2026-10-11T00:00:00Z", meta = metaV1)), 0), dir)
    assertNull(next.applyForTest(radioV2))
    assertTrue(next.lastFailWhy.contains("落盘失败"))
    before.forEach { (name, text) -> assertEquals(text, java.io.File(dir, name).readText()) }
  }

  @Test fun logos写失败不回滚且结果只表示已下载() = runBlocking {
    val dir = tmp.newFolder()
    val lu = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
    assertNotNull(lu.applyForTest(radioV1))
    val oldLogo = lu.logosText()
    injectRenameFail("logos.txt")
    val newRadio = radioV2 + "新台,http://new/1.mp3\r\n"
    val next = LightUpdate(Gh(FakeHttp(fullMap(radio = newRadio, logos = logosV2 + "新标志",
      radioAt = "2026-10-11T00:00:00Z", meta = metaV1)), 0), dir)
    val result = next.applyForTest(radioV2)!!
    assertFalse(result.logosChanged)
    assertEquals(LightUpdate.LogosStatus.WRITE_FAILED, result.logosStatus)
    assertTrue(lightUpdateMessage(result, false).contains("台标写入失败"))
    assertEquals(oldLogo, next.logosText())
    assertEquals(newRadio, next.radioText())
    assertEquals(true to true, next.stampHashOk())
  }

  @Test fun stamp写失败不回滚并由哈希拒绝旧见证() = runBlocking {
    val dir = tmp.newFolder()
    val lu = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
    assertNotNull(lu.applyForTest(radioV1))
    val oldStamp = lu.stamp()
    injectRenameFail("stamp.json")
    val newRadio = radioV2 + "新台,http://new/1.mp3\r\n"
    val next = LightUpdate(Gh(FakeHttp(fullMap(radio = newRadio,
      radioAt = "2026-10-11T00:00:00Z", meta = metaV1)), 0), dir)
    val result = next.applyForTest(radioV2)!!
    assertFalse(result.stampWritten)
    assertTrue(lightUpdateMessage(result, false).contains("更新标记写入失败"))
    assertEquals(newRadio, next.radioText())
    assertEquals(oldStamp, next.stamp())
    val h = next.stampHashOk()
    assertEquals(false to true, h)
    val bound = RadioMeta.bound(true, true, next.stampMetaOk(), h.first, h.second)
    assertFalse(bound)
    assertTrue(lightUpdateMessage(result, bound).contains("元数据未通过同批见证"))
    assertEquals("2026-10-11T00:00:00Z", next.check(next.stamp()!!))
  }

  @Test fun rename失败保留旧文件并恢复() {
    val dir = tmp.newFolder(); val target = File(dir, "radio.txt")
    target.writeText("旧内容")
    var attemptedTemp: File? = null
    AtomicWriteTestHook.rename = { from, to ->
      assertEquals(target, to); attemptedTemp = from; false
    } // tmp→target 拒绝覆盖：旧目标必须原样保留
    try {
      var failed = false
      try { writeTextAtomic(target, "新内容") } catch (_: java.io.IOException) { failed = true }
      assertTrue(failed)
      assertEquals("旧内容", target.readText())
      assertFalse(File(dir, "radio.txt.bak.atomic").exists())
      val temp = attemptedTemp
      assertNotNull(temp)
      assertFalse(temp!!.exists())
      assertEquals(listOf("radio.txt"), dir.listFiles()!!.map { it.name }.sorted())
    } finally { AtomicWriteTestHook.rename = null }
  }

  @Test fun 既有调用成功路径保持兼容() {
    val dir = tmp.newFolder(); val target = File(dir, "radio.txt")
    target.writeText("旧")
    try { writeTextAtomic(target, "新") } finally { AtomicWriteTestHook.rename = null }
    assertEquals("新", target.readText())
  }

  @Test fun temp创建失败安全失败() {
    val dir = tmp.newFolder(); val target = File(dir, "x.txt")
    target.writeText("old-bytes")
    AtomicWriteTestHook.tempCreate = { throw java.io.IOException("temp create injected") }
    try { writeTextAtomic(target, "x") ; throw AssertionError("expected failure") }
    catch (_: java.io.IOException) { assertEquals("old-bytes", target.readText()) }
    assertEquals(listOf("x.txt"), dir.listFiles()!!.map { it.name }.sorted())
  }

  @Test fun temp写失败安全失败() {
    val dir = tmp.newFolder(); val target = File(dir, "x.txt")
    target.writeText("old-bytes")
    var actual: File? = null
    AtomicWriteTestHook.tempCreate = { f -> File.createTempFile(f.name + ".", ".tmp", f.parentFile).also { actual = it } }
    AtomicWriteTestHook.tempWrite = { f, text -> f.writeText(text.take(1)); throw java.io.IOException("temp write injected") }
    try { writeTextAtomic(target, "new") ; throw AssertionError("expected failure") }
    catch (_: java.io.IOException) { assertEquals("old-bytes", target.readText()) }
    assertNotNull(actual)
    assertFalse(actual!!.exists())
    assertEquals(listOf("x.txt"), dir.listFiles()!!.map { it.name }.sorted())
  }

  @Test fun 旧stamp无哈希字段保守不绑定() {
    // B2/B3 早期 stamp（无 radioHash/metaHash 字段）：无法证明与当前文件同批 → 保守不绑定（沿用既有拍板）
    val dir = tmp.newFolder()
    runBlocking {
      val lu1 = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
      lu1.applyForTest(radioV1)
      // 手工降级 stamp 为旧形态（meta=true 无哈希）
      java.io.File(dir, "stamp.json").writeText("""{"commitIso":"2026-10-10T00:00:00Z","meta":true}""")
      val lu2 = LightUpdate(Gh(FakeHttp(emptyMap())), dir)
      assertEquals(true, lu2.stampMetaOk())
      assertEquals(null to null, lu2.stampHashOk())        // 无哈希字段 → null（保守）
      assertFalse(RadioMeta.bound(true, true, true, null, null))
    }
  }
  @Test fun 删除旧meta失败如实报告并禁止绑定() = runBlocking {
    val dir = tmp.newFolder()
    val first = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
    first.applyForTest(radioV1)!!
    val next = LightUpdate(Gh(FakeHttp(fullMap(radio = radioV2 + "新台,http://new/1.mp3\r\n", meta = metaV2Bad)), 0), dir) { false }
    val r = next.applyForTest(radioV2)!!
    assertEquals(LightUpdate.MetaStatus.INVALID, r.metaStatus)
    assertEquals(LightUpdate.CleanupStatus.FAILED, r.metaCleanup)
    assertEquals(metaV1, next.metaText())
    assertTrue(lightUpdateMessage(r, false).contains("旧文件删除失败"))
    val h = next.stampHashOk()
    assertFalse(RadioMeta.bound(true, true, next.stampMetaOk(), h.first, h.second))
  }

  @Test fun 同提交部分失败持久重试并恢复() = runBlocking {
    for (failure in listOf("logos", "meta", "stamp")) {
      val dir = tmp.newFolder()
      val broken = fullMap(logos = if (failure == "logos") null else logosV2,
        meta = if (failure == "meta") null else metaV1)
      if (failure == "stamp") injectRenameFail("stamp.json")
      val first = LightUpdate(Gh(FakeHttp(broken), 0), dir)
      val result = first.applyForTest(radioV1)!!
      assertTrue(result.retryPending)
      assertEquals(radioV2, first.radioText())
      if (failure == "stamp") AtomicWriteTestHook.rename = null
      val restarted = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
      assertEquals("2026-10-10T00:00:00Z", restarted.check("2026-10-10T00:00:00Z"))
      val recovered = restarted.applyForTest(radioV2)!!
      assertFalse(recovered.retryPending)
      assertEquals(logosV2, restarted.logosText())
      assertEquals(metaV1, restarted.metaText())
      assertEquals(true to true, restarted.stampHashOk())
      assertNull(restarted.check("2026-10-10T00:00:00Z"))
    }
  }

  @Test fun 旧stamp恰好匹配时按见证而非写入结果显示绑定() = runBlocking {
    val dir = tmp.newFolder()
    val lu = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
    lu.applyForTest(radioV1)!!
    injectRenameFail("stamp.json")
    val r = lu.applyForTest(radioV2)!!
    assertFalse(r.stampWritten)
    val h = lu.stampHashOk()
    val bound = RadioMeta.bound(true, true, lu.stampMetaOk(), h.first, h.second)
    assertTrue(bound)
    assertTrue(lightUpdateMessage(r, bound).contains("元数据同批见证通过"))
    assertTrue(r.retryPending)
  }

  @Test fun 端内同步屏障跨重启禁止旧轻更新覆盖() = runBlocking {
    for (stage in listOf("beforeRadio", "sameRadio", "newRadio", "afterStamp")) {
      val dir = tmp.newFolder()
      val old = LightUpdate(Gh(FakeHttp(fullMap(meta = null)), 0), dir)
      assertTrue(old.applyForTest(radioV1)!!.retryPending)
      SyncBarrier.begin(dir)
      if (stage == "sameRadio") java.io.File(dir, "radio.txt").writeText(radioV2)
      if (stage == "newRadio" || stage == "afterStamp") java.io.File(dir, "radio.txt").writeText(radioV2 + "本机同步,http://local/1.mp3\r\n")
      if (stage == "afterStamp") java.io.File(dir, "stamp.json").writeText("{\"commitIso\":\"2026-10-20T00:00:00Z\",\"meta\":false}")
      val before = java.io.File(dir, "radio.txt").readText()
      val next = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
      assertNull(next.check("2026-10-10T00:00:00Z"))
      assertTrue(next.lastFailWhy.contains("端内同步未完成"))
      assertNull(next.applyForTest(before))
      assertEquals(before, java.io.File(dir, "radio.txt").readText())
      SyncBarrier.finish(dir)
      assertFalse(SyncBarrier.active(dir))
      assertFalse(java.io.File(dir, "light-update.pending").exists())
    }
  }

  @Test fun 端内同步屏障清理故障保守阻断() = runBlocking {
    val dir = tmp.newFolder()
    java.io.File(dir, "light-update.pending").writeText("pending")
    SyncBarrier.begin(dir)
    assertTrue(runCatching { SyncBarrier.finish(dir) { false } }.isFailure)
    assertTrue(SyncBarrier.active(dir))
    assertTrue(java.io.File(dir, "light-update.pending").exists())
    SyncBarrier.finish(dir)
    assertFalse(SyncBarrier.active(dir))
  }

  @Test fun 轻更新重试期间远端前进使用新版本() = runBlocking {
    val dir = tmp.newFolder()
    val first = LightUpdate(Gh(FakeHttp(fullMap(meta = null)), 0), dir)
    assertTrue(first.applyForTest(radioV1)!!.retryPending)
    val freshRadio = radioV2 + "更新台,http://fresh/1.mp3\r\n"
    val next = LightUpdate(Gh(FakeHttp(fullMap(radio = freshRadio, radioAt = "2026-10-11T00:00:00Z", meta = metaV1)), 0), dir)
    assertEquals("2026-10-11T00:00:00Z", next.check("2026-10-10T00:00:00Z"))
    assertFalse(next.applyForTest(radioV2)!!.retryPending)
    assertEquals(freshRadio, next.radioText())
  }

  @Test fun 检查后端内同步完成旧检查不能覆盖() = runBlocking {
    val dir = tmp.newFolder()
    val lu = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
    assertNotNull(lu.check("2026-10-01T00:00:00Z"))
    SyncBarrier.begin(dir)
    val synced = radioV2 + "本机同步,http://local/1.mp3\r\n"
    java.io.File(dir, "radio.txt").writeText(synced)
    java.io.File(dir, "stamp.json").writeText("{\"commitIso\":\"2026-10-20T00:00:00Z\",\"meta\":false}")
    SyncBarrier.finish(dir)
    assertNull(lu.apply(synced))
    assertTrue(lu.lastFailWhy.contains("重新检查"))
    assertEquals(synced, lu.radioText())
  }

  @Test fun 未检查不得直接应用() = runBlocking {
    val dir = tmp.newFolder()
    val lu = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
    assertNull(lu.apply(radioV1))
    assertTrue(lu.lastFailWhy.contains("先检查"))
    assertNull(lu.radioText())
  }

  @Test fun 检查挂起期间同步等待且旧凭证失效() = runBlocking {
    val dir = tmp.newFolder()
    val entered = CompletableDeferred<Unit>()
    val resume = CompletableDeferred<Unit>()
    val data = fullMap(meta = metaV1)
    val http = object : HttpText {
      override suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String>): String? {
        if (url.contains("commits?path=radio.txt")) { entered.complete(Unit); resume.await() }
        return data[url]
      }
    }
    val lu = LightUpdate(Gh(http, 0), dir)
    val checking = async { lu.check("2026-10-01T00:00:00Z") }
    entered.await()
    val sync = async { SyncBarrier.mutex.lock(); try { SyncBarrier.begin(dir); SyncBarrier.finish(dir) } finally { SyncBarrier.mutex.unlock() } }
    yield()
    assertFalse(sync.isCompleted)
    resume.complete(Unit)
    assertNotNull(checking.await())
    sync.await()
    assertNull(lu.apply(radioV1))
    assertTrue(lu.lastFailWhy.contains("重新检查"))
    assertNull(lu.radioText())
  }

  @Test fun 同步排队时使用轻更新后的实际主库() = runBlocking {
    val dir = tmp.newFolder()
    val large = "华语音乐,#genre#\r\n" + (1..810).joinToString("\r\n") { "台$it,http://radio/$it.mp3" } + "\r\n"
    val entered = CompletableDeferred<Unit>(); val resume = CompletableDeferred<Unit>()
    val map = fullMap(radio = large, meta = metaV1)
    val http = object : HttpText {
      override suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String>): String? {
        if (url.endsWith("contents/radio.txt")) { entered.complete(Unit); resume.await() }
        return map[url]
      }
    }
    val lu = LightUpdate(Gh(http, 0), dir)
    assertNotNull(lu.check("2026-10-01T00:00:00Z"))
    val update = async { lu.apply(radioV1) }
    entered.await()
    val raw = object : RawHttp {
      override suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String>): RawHttp.Resp? = null
    }
    val engine = SyncEngine(Gh(FakeHttp(emptyMap()), 0), CheckStream(raw), dir)
    val sync = async { engine.run(radioV1) }
    yield(); assertFalse(sync.isCompleted)
    resume.complete(Unit)
    assertNotNull(update.await())
    val result = sync.await()
    assertTrue(result.ok)
    assertTrue(lu.radioText()!!.contains("台810,http://radio/810.mp3"))
  }

  @Test fun 失败检查会作废旧凭证() = runBlocking {
    val dir = tmp.newFolder()
    val lu = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
    assertNotNull(lu.check("2026-10-01T00:00:00Z"))
    SyncBarrier.begin(dir)
    assertNull(lu.check("2026-10-01T00:00:00Z"))
    SyncBarrier.finish(dir)
    assertNull(lu.apply(radioV1))
    assertTrue(lu.lastFailWhy.contains("先检查"))
  }

  @Test fun 同步异常只在屏障存在时提示重启恢复() {
    assertTrue(syncFailureMessage("磁盘故障", true).contains("重启应用"))
    assertTrue(syncFailureMessage("磁盘故障", true).contains("重新执行端内同步"))
    assertFalse(syncFailureMessage("网络故障", false).contains("重启应用"))
  }

  @Test fun 屏障创建与最终清除故障保守处理() = runBlocking {
    val dir = tmp.newFolder()
    injectRenameFail("full-sync.pending")
    assertTrue(runCatching { SyncBarrier.begin(dir) }.isFailure)
    assertFalse(SyncBarrier.active(dir))
    AtomicWriteTestHook.rename = null
    SyncBarrier.begin(dir)
    assertTrue(runCatching { SyncBarrier.finish(dir) { false } }.isFailure)
    assertTrue(SyncBarrier.active(dir))
    val lu = LightUpdate(Gh(FakeHttp(fullMap(meta = metaV1)), 0), dir)
    assertNull(lu.check("2026-10-01T00:00:00Z"))
    SyncBarrier.finish(dir)
    assertFalse(SyncBarrier.active(dir))
  }

}
