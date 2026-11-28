package io.github.vjoy233.vradio.sync

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

// 实验性内存模型；ID 由调用方生成并保证永不复用，codec 不能证明这一点。
internal data class GenerationRecord(val generationId: String, val radioSha256: String, val batches: List<TaskBatch>)
internal data class TaskBatch(val batchId: String, val items: List<TaskItem>)
internal data class TaskItem(val itemId: String, val name: String)

/** 未接线的严格版本化 codec；没有 IO、发布、容量或恢复策略。 */
internal object GenerationManifestCodec {
  private const val MAGIC = 0x56474d46 // VGMF
  private const val VERSION = 1
  private val idPattern = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
  private val hashPattern = Regex("[0-9a-f]{64}")

  fun encode(record: GenerationRecord): ByteArray {
    validate(record)
    val bytes = ByteArrayOutputStream()
    DataOutputStream(bytes).use { out ->
      out.writeInt(MAGIC); out.writeInt(VERSION)
      out.text(record.generationId); out.text(record.radioSha256)
      out.writeInt(record.batches.size)
      record.batches.forEach { batch ->
        out.text(batch.batchId); out.writeInt(batch.items.size)
        batch.items.forEach { out.text(it.itemId); out.text(it.name) }
      }
    }
    return bytes.toByteArray()
  }

  fun decode(bytes: ByteArray): GenerationRecord {
    try {
      val input = DataInputStream(ByteArrayInputStream(bytes))
      require(input.readInt() == MAGIC && input.readInt() == VERSION)
      val generationId = input.text()
      val hash = input.text()
      val batches = ArrayList<TaskBatch>()
      repeat(input.count()) {
        val batchId = input.text()
        val items = ArrayList<TaskItem>()
        repeat(input.count()) { items.add(TaskItem(input.text(), input.text())) }
        batches.add(TaskBatch(batchId, items))
      }
      require(input.available() == 0)
      return GenerationRecord(generationId, hash, batches).also(::validate)
    } catch (e: Exception) {
      throw IllegalArgumentException("invalid generation manifest", e)
    }
  }

  private fun validate(record: GenerationRecord) {
    require(idPattern.matches(record.generationId) && hashPattern.matches(record.radioSha256))
    val batchIds = HashSet<String>()
    record.batches.forEach { batch ->
      require(idPattern.matches(batch.batchId) && batchIds.add(batch.batchId))
      val itemIds = HashSet<String>()
      batch.items.forEach { item ->
        require(idPattern.matches(item.itemId) && itemIds.add(item.itemId))
        require(item.name.isNotEmpty())
        // 拒绝无法无损转换的孤立 UTF-16 代理项。
        try { utf8(item.name) } catch (e: java.nio.charset.CharacterCodingException) {
          throw IllegalArgumentException("invalid name encoding", e)
        }
      }
    }
  }

  private fun utf8(value: String): ByteArray {
    val buffer = StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).encode(java.nio.CharBuffer.wrap(value))
    return ByteArray(buffer.remaining()).also { buffer.get(it) }
  }
  private fun DataOutputStream.text(value: String) {
    val data = utf8(value); writeInt(data.size); write(data)
  }
  private fun DataInputStream.text(): String {
    val size = readInt()
    require(size >= 0 && size <= available())
    val data = ByteArray(size); readFully(data)
    return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(data)).toString()
  }
  // 每个元素至少占一个长度前缀；只防格式导致的伪造循环，不定义业务容量。
  private fun DataInputStream.count(): Int = readInt().also { require(it >= 0 && it <= available() / 4) }
}
