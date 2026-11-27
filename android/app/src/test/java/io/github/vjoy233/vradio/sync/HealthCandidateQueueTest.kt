package io.github.vjoy233.vradio.sync

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class HealthCandidateQueueTest {
  @Test fun retainsCompleteBatchesAndRejectsCorruption() {
    val dir = Files.createTempDirectory("health-queue").toFile()
    try {
      val old = "国内,#genre#\n旧,http://old\n"
      val next = "国内,#genre#\n" + (0..600).joinToString("\n") { "台$it,http://s/$it" } +
        "\n台0,http://backup\n欧美音乐,#genre#\n海外,http://eu\n"
      HealthCandidateQueue.record(dir, "device", old, next)
      HealthCandidateQueue.record(dir, "light", old, next)
      val file = dir.resolve("health-candidates.json")
      val batches = JSONObject(file.readText()).getJSONArray("batches")
      assertEquals(2, batches.length())
      assertEquals(602, batches.getJSONObject(0).getJSONArray("rows").length())
      assertEquals(hashText(next), batches.getJSONObject(0).getString("newHash"))
      val broken = file.readText().replace("台0", "篡改")
      file.writeText(broken)
      assertTrue(runCatching { HealthCandidateQueue.record(dir, "device", old, next) }.isFailure)
      assertEquals(broken, file.readText())
    } finally { dir.deleteRecursively() }
  }
}
