package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.sync.RadioMeta
import org.junit.Assert.*
import org.junit.Test

class RadioMetaTest {
  private fun source(json: String) = RadioMeta.parse("""{"v":1,"stations":{"id":{"sources":[$json]}}}""")!!
    .stations.getValue("id").sources.single()

  @Test fun 旧格式回退与新字段消费() {
    val old = source("""{"url":"https://example.test/a","firstSeenAt":123}""")
    assertEquals(123L, old.lastSeenAt)
    assertEquals(0L, old.lastVerifiedAt)
    assertEquals("unknown", old.verification)
    val fresh = source("""{"url":"https://example.test/a","firstSeenAt":123,"lastSeenAt":456,"lastVerifiedAt":400,"verification":"sync","futureField":true}""")
    assertEquals(456L, fresh.lastSeenAt)
    assertEquals(400L, fresh.lastVerifiedAt)
    assertEquals("sync", fresh.verification)
  }

  @Test fun 缺失或未知字段不伪造验证() {
    val missing = source("""{"url":"https://example.test/a"}""")
    assertEquals(0L, missing.lastSeenAt)
    assertEquals(0L, missing.lastVerifiedAt)
    assertEquals("unknown", missing.verification)
    assertEquals("unknown", source("""{"url":"x","verification":"manual"}""").verification)
    assertNull(RadioMeta.parse("""{"v":2,"stations":{}}"""))
  }
}
