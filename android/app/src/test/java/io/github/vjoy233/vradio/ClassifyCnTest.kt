package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.sync.ClassifyCn
import io.github.vjoy233.vradio.sync.Section
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/* classifyCn 移植验收（M4/A15）：金样 fixture（gen-classify-fixture.js 跑真实 radio.txt 产物）逐条平价
   + 手写边界用例 + classifySections 幂等（照抄 test/smoke.js [3] 样本）。 */
class ClassifyCnTest {

  @Test fun 金样全量平价() {
    val stream = javaClass.classLoader.getResourceAsStream("classifycn-golden.json")
      ?: error("缺 classifycn-golden.json——cd 仓库根跑 node android/tools/gen-classify-fixture.js")
    val golden = JSONObject(stream.bufferedReader(Charsets.UTF_8).use { it.readText() })
    var n = 0
    for (k in golden.keys()) {
      assertEquals("金样不平价：$k", golden.getString(k), ClassifyCn.classify(k))
      n++
    }
    assertTrue("金样覆盖异常（仅 $n 条，应 ≥1000）", n >= 1000)
  }

  @Test fun 规则优先级与兜底() {
    assertEquals("华语音乐", ClassifyCn.classify("上海动感101音乐广播"))   // 音乐优先
    assertEquals("华语音乐", ClassifyCn.classify("汽车音乐台"))            // 音乐规则在交通前——按内容归音乐
    assertEquals("交通广播", ClassifyCn.classify("北京交通广播"))
    assertEquals("财经", ClassifyCn.classify("第一财经"))
    assertEquals("新闻资讯", ClassifyCn.classify("XX新闻台"))
    assertEquals("文艺·生活", ClassifyCn.classify("XX戏曲之声"))
    assertEquals("文艺·生活", ClassifyCn.classify("某某城市台"))          // 「城市」命中文艺·生活（JS 真值探针复核）
    assertEquals("综合·其他", ClassifyCn.classify("某某台"))              // 兜底
  }

  @Test fun 国际台捞回() {
    assertEquals("国际新闻·谈话", ClassifyCn.classify("BBC World Service"))
    assertEquals("国际新闻·谈话", ClassifyCn.classify("BBC Radio 5"))      // INTL 规则在前（Radio 4|5）压过 BBC 音乐网
    assertEquals("欧美音乐", ClassifyCn.classify("BBC Radio 2"))           // Radio [1236] 音乐网捞回
    assertEquals("国际新闻·谈话", ClassifyCn.classify("NPR News"))
    assertEquals("国际新闻·谈话", ClassifyCn.classify("CGTNEnglish"))      // ^CGTN 前缀
    assertEquals("综合·其他", ClassifyCn.classify("北京-CGTNArabic"))      // ^ 锚定：前缀带城市名不捞（JS 同款，金样实存用例）
  }

  @Test fun 欧美系旧节捞回扫描与EU本体跳过() {
    val secs = listOf(Section("欧美音乐", arrayListOf(
      "Foo Radio [英国],http://e/5.mp3",     // 重建本体（带国名后缀）：跳过，不入任何分类
      "BBC Radio 2,http://f/6.mp3",          // 无后缀：音乐网捞回
      "BBC World Service,http://g/7.mp3",    // 无后缀：英文新闻台捞回
      "CNA 938 Live,http://h/8.mp3")))       // 无后缀且不匹配品牌正则：WORLD_NEWS 补捞
    val r = ClassifyCn.classifySections(secs)
    assertEquals(listOf("BBC Radio 2,http://f/6.mp3"), r.euExtra[ClassifyCn.EU_CAT])
    assertEquals(listOf("BBC World Service,http://g/7.mp3", "CNA 938 Live,http://h/8.mp3"),
      r.euExtra[ClassifyCn.INTL_CAT])
    assertTrue(r.out.values.all { it.isEmpty() })
  }

  @Test fun 世界拆分与新式节保留() {
    val r = ClassifyCn.classifySections(listOf(
      Section("世界", arrayListOf("CNA 938,http://c/3.mp3", "JJ FM,http://d/4.mp3")),
      Section("华语音乐", arrayListOf("动感101,http://a/1.mp3")),
      Section("某上游旧分类", arrayListOf("XX新闻台,http://b/2.m3u8"))))
    assertEquals(listOf("CNA 938,http://c/3.mp3"), r.euExtra[ClassifyCn.INTL_CAT])   // 新闻向拆走
    assertEquals(listOf("JJ FM,http://d/4.mp3"), r.out[ClassifyCn.ASIA_CAT])          // 其余进亚洲·港台
    assertEquals(listOf("动感101,http://a/1.mp3"), r.out["华语音乐"])                  // 新式节原样保留
    assertEquals(listOf("XX新闻台,http://b/2.m3u8"), r.out["新闻资讯"])                // 上游旧分类按台名重分
  }

  /** smoke.js [3] 同款样本：两轮分类输出稳定（自身产物再喂入不变形）。 */
  @Test fun 幂等() {
    val fixture = listOf(
      "华语音乐,#genre#", "动感101,http://a/1.mp3",
      "新闻资讯,#genre#", "XX新闻台,http://b/2.m3u8",
      "世界,#genre#", "CNA 938,http://c/3.mp3", "JJ FM,http://d/4.mp3",
      "欧美音乐,#genre#", "Foo Radio [英国],http://e/5.mp3", "BBC Radio 2,http://f/6.mp3").joinToString("\r\n")
    fun round(text: String): String {
      val r1 = ClassifyCn.classifySections(ClassifyCn.splitSections(text))
      val lines = ArrayList<String>()
      for (c in ClassifyCn.CAT_ORDER) {
        val body = if (c == ClassifyCn.EU_CAT || c == ClassifyCn.INTL_CAT) r1.euExtra[c].orEmpty() else r1.out[c].orEmpty()
        if (body.isNotEmpty()) { lines.add("$c,#genre#"); lines.addAll(body) }
      }
      return lines.joinToString("\r\n")
    }
    val once = round(fixture)
    val twice = round(once)
    assertEquals(once, twice)
  }
}
