package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.network.TrafficEstimator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/* 流量估算公式（plan-expansion-r4 §9.2）：128kbps×1h、kbps<32 钳到 32、0/负时长、
   Long 溢出边界（超大时长饱和不出负数）、真实大时长不溢出、格式化与估算文案。 */
class TrafficEstimatorTest {

  @Test fun 公式正确性128k一小时() {   // 128kbps = 16000B/s × 3600s = 57,600,000B
    assertEquals(57_600_000L, TrafficEstimator.bytesFor(128, 3_600_000L))
    assertEquals(1_382_400_000L, TrafficEstimator.bytesFor(128, 86_400_000L))   // 24 小时
    assertEquals(960_000L, TrafficEstimator.bytesFor(64, 120_000L))             // 64kbps × 2 分钟 = 960,000B
  }

  @Test fun 低码率钳到32() {   // 防 0/负码率算出 0 流量误导（HLS 无 ICY 时按假设值估）
    assertEquals(4000L, TrafficEstimator.bytesFor(0, 1000L))
    assertEquals(4000L, TrafficEstimator.bytesFor(31, 1000L))
    assertEquals(4000L, TrafficEstimator.bytesFor(-5, 1000L))
    assertEquals(4000L, TrafficEstimator.bytesFor(32, 1000L))
  }

  @Test fun 零与负时长() {
    assertEquals(0L, TrafficEstimator.bytesFor(128, 0L))
    assertEquals(0L, TrafficEstimator.bytesFor(128, -1000L))
  }

  @Test fun 大时长不溢出() {   // 真实可遇上限：128kbps 连播 100 年 ≈ 5e16B，远离 Long 界
    val hundredYearsMs = 100L * 365 * 24 * 3600 * 1000
    val b = TrafficEstimator.bytesFor(128, hundredYearsMs)
    assertTrue(b > 0L)
    assertEquals(16_000L * 100L * 365 * 24 * 3600, b)
  }

  @Test fun 溢出边界饱和() {   // 极端入参（超大时长×超大码率）饱和 Long.MAX 不冒充负数
    assertEquals(Long.MAX_VALUE, TrafficEstimator.bytesFor(2_000_000, Long.MAX_VALUE))
    assertEquals(Long.MAX_VALUE, TrafficEstimator.bytesFor(Int.MAX_VALUE, Long.MAX_VALUE / 2))
    assertTrue(TrafficEstimator.bytesFor(10_000_000, 10_000_000_000_000L) > 0L)
  }

  @Test fun 字节数格式化() {
    assertEquals("512 B", TrafficEstimator.fmt(512))
    assertEquals("2 KB", TrafficEstimator.fmt(2048))
    assertEquals("54.9 MB", TrafficEstimator.fmt(57_600_000L))       // 128kbps×1h
    assertEquals("1.00 GB", TrafficEstimator.fmt(1_073_741_824L))
    assertEquals("0 B", TrafficEstimator.fmt(-1))
  }

  @Test fun 估算文案() {   // 有码率直接用；无码率按 128kbps 并明示「估算」不冒充精确计费
    val withBr = TrafficEstimator.estimateText(128, 3_600_000L, 60)
    assertTrue(withBr.contains("60 分钟")); assertTrue(withBr.contains("54.9 MB"))
    assertTrue(withBr.contains("估算值，非精确计费"))
    assertFalse(withBr.contains("128kbps"))
    val noBr = TrafficEstimator.estimateText(0, 3_600_000L, 60)
    assertTrue(noBr.contains("按 128kbps 估算"))
    assertTrue(noBr.contains("54.9 MB"))                              // 假设值与真实 128 一致
  }
}
