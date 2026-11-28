package io.github.vjoy233.vradio.sync

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer

class GenerationManifestCodecTest {
  private fun id(n: Int) = "00000000-0000-0000-0000-%012x".format(n)
  private val hashA = "a".repeat(64)
  private fun record() = GenerationRecord(id(1), hashA, listOf(
    TaskBatch(id(2), listOf(TaskItem(id(3), "同名"), TaskItem(id(4), "同名"))),
    TaskBatch(id(5), listOf(TaskItem(id(3), "同名")))
  ))
  private fun bad(block: () -> Unit) {
    try { block(); fail("应拒绝") } catch (_: IllegalArgumentException) { }
  }

  @Test fun roundTripPreservesOrderAndCompositeIdentity() {
    val original = record()
    val encoded = GenerationManifestCodec.encode(original)
    assertEquals(original, GenerationManifestCodec.decode(encoded))
    assertArrayEquals(encoded, GenerationManifestCodec.encode(GenerationManifestCodec.decode(encoded)))
    assertNotEquals(encoded.toList(), GenerationManifestCodec.encode(original.copy(batches = original.batches.reversed())).toList())
    assertNotEquals(encoded.toList(), GenerationManifestCodec.encode(original.copy(batches = listOf(original.batches[0].copy(items = original.batches[0].items.reversed()), original.batches[1]))).toList())
  }

  @Test fun rejectsInvalidAndDuplicateIds() {
    val r = record()
    bad { GenerationManifestCodec.encode(r.copy(generationId = "../x")) }
    bad { GenerationManifestCodec.encode(r.copy(radioSha256 = "A".repeat(64))) }
    bad { GenerationManifestCodec.encode(r.copy(batches = listOf(r.batches[0], r.batches[0]))) }
    bad { GenerationManifestCodec.encode(r.copy(batches = listOf(r.batches[0].copy(items = listOf(r.batches[0].items[0], r.batches[0].items[0]))))) }
    bad { GenerationManifestCodec.encode(r.copy(batches = listOf(TaskBatch(id(2), listOf(TaskItem(id(3), "")))))) }
    bad { GenerationManifestCodec.encode(r.copy(batches = listOf(TaskBatch(id(2), listOf(TaskItem(id(3), "\ud800")))))) }
  }

  @Test fun retainsMoreThan500WithoutTruncation() {
    val r = GenerationRecord(id(1), hashA, listOf(TaskBatch(id(2), (0..600).map { TaskItem(id(it + 10), "台$it") })))
    assertEquals(r, GenerationManifestCodec.decode(GenerationManifestCodec.encode(r)))
  }

  @Test fun malformedAndUnknownVersionsFailClosed() {
    val bytes = GenerationManifestCodec.encode(record())
    for (i in bytes.indices) bad { GenerationManifestCodec.decode(bytes.copyOf(i)) }
    bad { GenerationManifestCodec.decode(bytes + byteArrayOf(0)) }
    bad { GenerationManifestCodec.decode(bytes.copyOf().also { ByteBuffer.wrap(it).putInt(4, 2) }) }
    bad { GenerationManifestCodec.decode(bytes.copyOf().also { ByteBuffer.wrap(it).putInt(8, Int.MAX_VALUE) }) }
    bad { GenerationManifestCodec.decode(bytes.copyOf().also { it[12] = 0xff.toByte() }) }
    bad { GenerationManifestCodec.decode(bytes.copyOf().also { it[0] = 0 }) }
  }

  @Test fun equalContentDoesNotImplyEqualGenerationOrCommit() {
    val a = record(); val b = a.copy(generationId = id(9), radioSha256 = "b".repeat(64))
    val a2 = a.copy(generationId = id(10))
    assertEquals(a.radioSha256, a2.radioSha256)
    assertNotEquals(a.generationId, a2.generationId)
    assertNotEquals(GenerationManifestCodec.encode(a).toList(), GenerationManifestCodec.encode(a2).toList())
    assertNotEquals(b.radioSha256, a2.radioSha256)
    assertEquals(a2, GenerationManifestCodec.decode(GenerationManifestCodec.encode(a2)))
  }
}
