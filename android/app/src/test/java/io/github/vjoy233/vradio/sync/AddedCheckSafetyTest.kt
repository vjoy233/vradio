package io.github.vjoy233.vradio.sync

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class AddedCheckSafetyTest {
  @Test fun blockIsStableAcrossRestartAndDoesNotConsumeUnknownPending() {
    val dir = Files.createTempDirectory("addedcheck-block").toFile()
    try {
      val unknown = dir.resolve("health-candidate.pending")
      val full = dir.resolve("full-sync.pending")
      val light = dir.resolve("light-update.pending")
      listOf(unknown, full, light).forEach { it.writeText("unknown batch") }
      // 独立重复调用模拟冷启动重新判门；门不读取、不清理任何未知格式。
      assertEquals(AddedCheckSafety.BLOCK_REASON, AddedCheckSafety.blockReason())
      assertEquals(AddedCheckSafety.BLOCK_REASON, AddedCheckSafety.blockReason())
      listOf(unknown, full, light).forEach { assertEquals("unknown batch", it.readText()) }
    } finally { dir.deleteRecursively() }
  }
}
