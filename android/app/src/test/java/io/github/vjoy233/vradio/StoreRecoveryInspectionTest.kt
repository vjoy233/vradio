package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.StoreRecoveryInspection
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory

class StoreRecoveryInspectionTest {
  private fun withFile(content: ByteArray?, block: (File) -> Unit) {
    val dir = createTempDirectory("vradio-inspect").toFile()
    try { val f = File(dir, "store.json"); if (content != null) f.writeBytes(content); block(f) }
    finally { dir.deleteRecursively() }
  }
  @Test fun allContentIsUntrustedAndDiskBytesRemainIntact() {
    val inputs = listOf("{bad", "{\"radio.theme\":\"dark\"}", "{\"__vradio_health_recovery_v1\":{}}", "{} trailing", "{\"x\":1,\"x\":2}")
    for (input in inputs) {
      val bytes = input.toByteArray()
      withFile(bytes) { f ->
        val r = StoreRecoveryInspection.inspect(f)
        assertEquals(StoreRecoveryInspection.Trust.UNTRUSTED, r.trust)
        assertEquals(StoreRecoveryInspection.Observation.CONTENT_UNKNOWN, r.observation)
        assertArrayEquals(bytes, r.originalBytes); assertArrayEquals(bytes, f.readBytes())
      }
    }
  }
  @Test fun missingAndInvalidUtf8AreUntrusted() {
    withFile(null) { f ->
      val r = StoreRecoveryInspection.inspect(f)
      assertEquals(StoreRecoveryInspection.Trust.UNTRUSTED, r.trust)
      assertEquals(StoreRecoveryInspection.Observation.MISSING, r.observation); assertNull(r.originalBytes)
    }
    val bytes = byteArrayOf(0x7b, 0xc3.toByte(), 0x28, 0x7d)
    withFile(bytes) { f ->
      val r = StoreRecoveryInspection.inspect(f)
      assertEquals(StoreRecoveryInspection.Trust.UNTRUSTED, r.trust)
      assertEquals(StoreRecoveryInspection.Observation.INVALID_UTF8, r.observation)
      assertArrayEquals(bytes, r.originalBytes); assertArrayEquals(bytes, f.readBytes())
    }
  }
  @Test fun budgetBoundaryDoesNotModifyDisk() {
    val max = StoreRecoveryInspection.MAX_BYTES
    for (n in listOf(max, max + 1)) {
      val bytes = ByteArray(n) { 0x20 }; bytes[0] = '{'.code.toByte(); bytes[1] = '}'.code.toByte()
      withFile(bytes) { f ->
        val r = StoreRecoveryInspection.inspect(f)
        assertEquals(StoreRecoveryInspection.Trust.UNTRUSTED, r.trust)
        assertEquals(if (n == max) StoreRecoveryInspection.Observation.CONTENT_UNKNOWN else StoreRecoveryInspection.Observation.OVER_BUDGET, r.observation)
        if (n == max) assertArrayEquals(bytes, r.originalBytes) else assertNull(r.originalBytes)
        assertArrayEquals(bytes, f.readBytes())
      }
    }
  }
}
