package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.MyRadio
import io.github.vjoy233.vradio.data.SafeTarget
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory

/* MyRadio：写盘格式（server.js /api/mystation 同款算法）、清洗护栏、封顶、查重、SafeTarget 公网校验
   （AIbot review P3：此前零测试——恰是与 server.js 一致性最关键的文件） */
class MyRadioTest {
  private lateinit var dir: File
  private lateinit var mr: MyRadio

  @Before fun setup() { dir = createTempDirectory("vradio-myradio").toFile(); mr = MyRadio(dir) }
  @After fun teardown() { dir.deleteRecursively() }

  @Test fun appendNewCategoryOpensSection() { // 新分类：尾部空行分隔 + 节头 + 行（首写剥掉行首 \r\n），CRLF 收尾
    assertTrue(mr.append("台A", "自建", "http://a.example/live"))
    assertEquals("自建,#genre#\r\n台A,http://a.example/live\r\n", mr.readText())
    val st = mr.read()
    assertEquals(1, st.size)
    assertEquals("自建|台A", st[0].key)
    assertEquals("http://a.example/live", st[0].u0)
  }

  @Test fun appendIntoExistingCategoryInsertsUnderHead() { // 同分类节内插入：新行紧贴节头下（server.js splice(at+1) 同算法）
    assertTrue(mr.append("台A", "自建", "http://a.example/1"))
    assertTrue(mr.append("台B", "自建", "http://b.example/2"))
    assertEquals(listOf("台B", "台A"), mr.read().map { it.n })   // 后来者在节首（与 Web 平价，勿按 FIFO 想当然）
    assertTrue(mr.readText().contains("自建,#genre#\r\n台B,http://b.example/2\r\n"))
  }

  @Test fun dedupeSameUrlOrExactRow() { // 同 URL 换名 / 完全同台均不双开（applySources 按键合并会出重复行）
    assertTrue(mr.append("台A", "自建", "http://a.example/1"))
    assertFalse(mr.append("台A", "自建", "http://a.example/1"))
    assertFalse(mr.append("台A别名", "自建", "http://a.example/1"))
    assertEquals(1, mr.read().size)
  }

  @Test fun csvCleaningAndCaps() { // 台名/分类去 csv 分隔符与换行；40/24 截断
    assertTrue(mr.append("名字,带逗号|管道\n换行", "分,类", "http://a.example/x"))
    val st = mr.read()
    assertTrue(st[0].n.startsWith("名字"))                  // 清洗后不含 , | \n
    assertFalse(st[0].n.contains(',') || st[0].n.contains('|'))
    assertTrue(st[0].c.length <= 24)
    val long = "VeryLongName" + "x".repeat(60)              // >40 截断
    assertTrue(mr.append(long, "自建", "http://b.example/y"))
    assertTrue(mr.read().any { it.n.length <= 40 && it.n.startsWith("VeryLongName") })
  }

  @Test fun safeTargetGuards() { // 公网校验（AIbot P2-5 + 审计 B1 严格对齐 Web 接受域）：回环/私网/链路本地/IPv4 全形态变形拒，公网放行
    assertFalse(SafeTarget.ok("http://127.0.0.1:8080/x"))
    assertFalse(SafeTarget.ok("http://localhost/live"))
    assertFalse(SafeTarget.ok("http://10.1.2.3/live"))
    assertFalse(SafeTarget.ok("http://192.168.1.1/live"))
    assertFalse(SafeTarget.ok("http://172.20.3.4/live"))
    assertFalse(SafeTarget.ok("http://169.254.9.9/live"))
    assertFalse(SafeTarget.ok("http://0.0.0.1/live"))          // 0/8 本网络段
    assertFalse(SafeTarget.ok("http://2130706433/live"))     // 十进制 127.0.0.1 变形
    assertFalse(SafeTarget.ok("http://0x7f000001/live"))     // 十六进制变形
    assertFalse(SafeTarget.ok("http://a@127.0.0.1/live"))     // userinfo 剥离后判 host（B1）
    assertFalse(SafeTarget.ok("http://127.1/live"))            // 短式（WHATWG 归一 127.0.0.1）
    assertFalse(SafeTarget.ok("http://0177.0.0.1/live"))       // 八进制变形
    assertFalse(SafeTarget.ok("http://0x7f.1/live"))           // 十六进制+短式混合
    assertFalse(SafeTarget.ok("http://127.0.0.1./live"))       // 尾随点归一后仍拒
    assertFalse(SafeTarget.ok("http://999.1.1.1/live"))        // 非法 IPv4 形态（Web 侧 new URL 直接抛）
    assertFalse(SafeTarget.ok("http://1.2.3.4.5/live"))        // >4 段（同上）
    assertFalse(SafeTarget.ok("http://[::1]:8080/live"))      // IPv6 回环（bracket 段全拒，复核轮 P3）
    assertFalse(SafeTarget.ok("http://[fe80::1]/live"))       // IPv6 链路本地
    assertFalse(SafeTarget.ok("http://router.local/live"))
    assertFalse(SafeTarget.ok("ftp://a.example/x"))          // 非 http(s)
    assertFalse(mr.append("台", "自建", "http://192.168.1.1/live"))   // 写入侧同护栏
    assertTrue(SafeTarget.ok("http://lhttp.qingting.fm/live/273/64k.mp3"))
    assertTrue(SafeTarget.ok("https://example.com:8443/a/b.m3u8"))
    assertTrue(SafeTarget.ok("http://8.8.8.8/x"))             // 公网 IP 放行
    assertTrue(SafeTarget.ok("http://nas.lan:8000/live"))     // B1：.lan 不再额外拒（Web safeTarget 收——家庭 NAS 自建台）
  }

  @Test fun lineCap() { // 500 行封顶：判满在写之前（第 501 行拒绝）。尾部空行已由 splitLines 归一不计数
    //（本侧 append/replace 语义按实行口径；server.js 的 split 带尾空串怪癖仍在 Web 侧，两侧此点允许非逐字节一致）
    val full = ArrayList<String>()
    full.add("自建,#genre#")
    for (i in 1..499) full.add("满台$i,http://a.example/f$i")
    assertTrue(mr.replace(full.joinToString("\r\n") + "\r\n"))
    assertFalse(mr.append("新台", "自建", "http://a.example/new"))   // 已满 500 行
  }

  @Test fun replaceRoundTripAndLimits() { // v2 导入恢复：CRLF 统一 + 超限拒收
    assertTrue(mr.replace("自建,#genre#\r\n台A,http://a.example/1\r\n台B,http://a.example/2"))
    val txt = mr.readText()
    assertTrue(txt.endsWith("\r\n"))                          // 统一收尾换行（两侧行格式契约）
    assertEquals(2, mr.read().size)
    val huge = (1..501).joinToString("\r\n") { "台$it,http://a.example/$it" }
    assertFalse(mr.replace(huge))                             // 行数超限拒
    assertEquals(2, mr.read().size)                           // 拒后原文件不动
  }

  @Test fun missingFileReadsEmpty() {
    assertEquals("", mr.readText())
    assertTrue(mr.read().isEmpty())
  }
}
