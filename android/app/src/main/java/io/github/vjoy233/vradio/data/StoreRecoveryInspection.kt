package io.github.vjoy233.vradio.data

import org.json.JSONObject
import java.io.File
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/**
 * Default-off, read-only inspection of store.json trust state.
 * This class never writes, repairs, or replaces the inspected bytes. It is
 * deliberately not wired into Store/AppVm/SyncEngine/LightUpdate.
 */
object StoreRecoveryInspection {
  // Reserved private metadata name; no existing radio.* key is reinterpreted.
  const val WITNESS_KEY = "__vradio_health_recovery_v1"
  // 检查器自身的资源预算，不代表现有 Store 的合法容量。
  const val MAX_BYTES = 1024 * 1024

  enum class State { MISSING, CORRUPT, LEGACY_NO_WITNESS, UNTRUSTED }

  data class Result(
    val state: State,
    /** 完整读取时的原字节；缺失、不可读或超过预算时为 null。 */
    val originalBytes: ByteArray?,
    val reason: String,
    val hasWitness: Boolean
  ) {
    init { originalBytes?.let { require(it.isNotEmpty() || state != State.MISSING) } }
  }

  fun inspect(file: File): Result {
    val bytes = try {
      file.inputStream().use { input ->
        val out = ByteArrayOutputStream(); val buf = ByteArray(8192)
        while (true) {
          val n = input.read(buf); if (n < 0) break
          if (n > MAX_BYTES - out.size()) return Result(State.UNTRUSTED, null, "store exceeds inspection budget", false)
          out.write(buf, 0, n)
        }
        out.toByteArray()
      }
    } catch (e: java.io.FileNotFoundException) {
      return if (!file.exists()) Result(State.MISSING, null, "store.json missing", false)
      else Result(State.UNTRUSTED, null, "store.json unreadable", false)
    } catch (e: java.io.IOException) {
      return Result(State.UNTRUSTED, null, "store.json unreadable", false)
    }
    val text = runCatching {
      Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes)).toString()
    }.getOrElse { return Result(State.CORRUPT, bytes, "invalid UTF-8", false) }
    val obj = runCatching { JSONObject(text) }.getOrElse {
      return Result(State.CORRUPT, bytes, "invalid JSON", false)
    }
    if (!obj.has(WITNESS_KEY)) {
      return Result(State.LEGACY_NO_WITNESS, bytes, "valid store without recovery witness", false)
    }
    // A witness is only an observed marker here. Verification and atomic
    // commit belong to a later phase; never call this trusted.
    val witness = obj.opt(WITNESS_KEY)
    if (witness !is JSONObject) {
      return Result(State.UNTRUSTED, bytes, "recovery witness has invalid shape", true)
    }
    return Result(State.UNTRUSTED, bytes, "recovery witness is not verified", true)
  }
}
