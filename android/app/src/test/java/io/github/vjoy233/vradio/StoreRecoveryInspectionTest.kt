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
    try {
      val f = File(dir, "store.json")
      if (content != null) f.writeBytes(content)
      block(f)
    } finally { dir.deleteRecursively() }
  }

  @Test fun byteBudgetAndInvalidUtf8NeverModifyFile() {
    val invalid = byteArrayOf(0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3.toByte(), 0x28, 0x22, 0x7d)
    withFile(invalid) { f ->
      val r = StoreRecoveryInspection.inspect(f)
      assertEquals(StoreRecoveryInspection.State.CORRUPT, r.state)
      assertArrayEquals(invalid, r.originalBytes); assertArrayEquals(invalid, f.readBytes())
    }
    val max = StoreRecoveryInspection.MAX_BYTES
    for (n in listOf(max, max + 1)) {
      val bytes = ByteArray(n) { 0x20 }; bytes[0] = '{'.code.toByte(); bytes[1] = '}'.code.toByte()
      withFile(bytes) { f ->
        val r = StoreRecoveryInspection.inspect(f)
        assertEquals(if (n == max) StoreRecoveryInspection.State.LEGACY_NO_WITNESS else StoreRecoveryInspection.State.UNTRUSTED, r.state)
        if (n == max) assertArrayEquals(bytes, r.originalBytes) else assertNull(r.originalBytes)
        assertArrayEquals(bytes, f.readBytes())
      }
    }
  }

  @Test fun missingIsExplicitAndHasNoBytes() = withFile(null) { f ->
    val r = StoreRecoveryInspection.inspect(f)
    assertEquals(StoreRecoveryInspection.State.MISSING, r.state)
    assertNull(r.originalBytes)
    assertEquals(false, r.hasWitness)
  }

  @Test fun corruptRetainsExactBytesAndIsUntrusted() = withFile("{bad".toByteArray()) { f ->
    val bytes = f.readBytes()
    val r = StoreRecoveryInspection.inspect(f)
    assertEquals(StoreRecoveryInspection.State.CORRUPT, r.state)
    assertArrayEquals(bytes, r.originalBytes)
    assertEquals(false, r.hasWitness)
  }

  @Test fun legacyValidStoreRetainsBytesAndIsExplicit() = withFile("{\"radio.theme\":\"dark\"}".toByteArray()) { f ->
    val bytes = f.readBytes()
    val r = StoreRecoveryInspection.inspect(f)
    assertEquals(StoreRecoveryInspection.State.LEGACY_NO_WITNESS, r.state)
    assertArrayEquals(bytes, r.originalBytes)
    assertEquals(false, r.hasWitness)
  }

  @Test fun witnessNeverBecomesTrusted() = withFile("{\"__vradio_health_recovery_v1\":{\"batchId\":\"x\"}}".toByteArray()) { f ->
    val bytes = f.readBytes()
    val r = StoreRecoveryInspection.inspect(f)
    assertEquals(StoreRecoveryInspection.State.UNTRUSTED, r.state)
    assertArrayEquals(bytes, r.originalBytes)
    assertEquals(true, r.hasWitness)
  }

  @Test fun invalidWitnessShapeIsUntrusted() = withFile("{\"__vradio_health_recovery_v1\":\"not-object\"}".toByteArray()) { f ->
    val r = StoreRecoveryInspection.inspect(f)
    assertEquals(StoreRecoveryInspection.State.UNTRUSTED, r.state)
    assertEquals(true, r.hasWitness)
  }
}
