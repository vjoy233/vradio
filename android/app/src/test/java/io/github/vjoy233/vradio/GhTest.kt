package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.HttpText
import io.github.vjoy233.vradio.sync.Gh
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/* Gh 网络层重试语义（batch1 E15）：失败静默重试一次（镜像级联已驳回，仅此无信任面代价）。
   fake HttpText 按脚本逐次出值，断言请求次数与结果。 */
class GhTest {

  private class Fake(val script: List<String?>) : HttpText {
    var calls = 0
    val urls = ArrayList<String>()
    override suspend fun get(url: String, timeoutMs: Long, maxBytes: Long, headers: Map<String, String>): String? {
      urls.add(url)
      val v = script.getOrElse(calls) { null }
      calls++
      return v
    }
  }

  @Test
  fun `file 首次失败重试一次后成功`() = runBlocking {
    val f = Fake(listOf(null, "x".repeat(150)))   // >100 才过 body 闸
    val r = Gh(f, retryDelayMs = 0).file("a/b", "radio.txt")
    assertNotNull(r)
    assertEquals(2, f.calls)
  }

  @Test
  fun `file 两次都失败返回null`() = runBlocking {
    val f = Fake(listOf(null, null))
    assertNull(Gh(f, retryDelayMs = 0).file("a/b", "radio.txt"))
    assertEquals(2, f.calls)
  }

  @Test
  fun `file 短错误页视为失败并重试`() = runBlocking {
    val f = Fake(listOf("404 not found", "y".repeat(120)))
    assertEquals("y".repeat(120), Gh(f, retryDelayMs = 0).file("a/b", "radio.txt"))
    assertEquals(2, f.calls)
  }

  @Test
  fun `file 首次成功不重试`() = runBlocking {
    val f = Fake(listOf("z".repeat(200)))
    assertNotNull(Gh(f, retryDelayMs = 0).file("a/b", "radio.txt"))
    assertEquals(1, f.calls)
  }

  @Test
  fun `lastCommitIso 解析日期且失败重试`() = runBlocking {
    val json = """[{"sha":"abc","commit":{"committer":{"date":"2026-10-01T12:00:00Z"}}}]"""
    val f = Fake(listOf(null, json))
    assertEquals("2026-10-01T12:00:00Z", Gh(f, retryDelayMs = 0).lastCommitIso("a/b", "radio.txt"))
    assertEquals(2, f.calls)
  }

  @Test
  fun `lastCommitIso 坏JSON重试后仍失败返回null`() = runBlocking {
    val f = Fake(listOf("not json", "still not json"))
    assertNull(Gh(f, retryDelayMs = 0).lastCommitIso("a/b", "radio.txt"))
    assertEquals(2, f.calls)
  }
}
