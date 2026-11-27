package io.github.vjoy233.vradio.data

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** 只读、默认不接线；不验证 JSON、见证或文件真实性。 */
internal object StoreRecoveryInspection {
  // 检查预算而非 Store 合法大小的上限。
  const val MAX_BYTES = 1024 * 1024
  enum class Trust { UNTRUSTED }
  enum class Observation { MISSING, UNREADABLE, OVER_BUDGET, INVALID_UTF8, CONTENT_UNKNOWN }
  data class Result(val trust: Trust, val observation: Observation, val originalBytes: ByteArray?)

  fun inspect(file: File): Result {
    fun result(observation: Observation, bytes: ByteArray? = null) = Result(Trust.UNTRUSTED, observation, bytes)
    val bytes = try {
      file.inputStream().use { input ->
        val out = ByteArrayOutputStream(); val buf = ByteArray(8192)
        while (true) {
          val n = input.read(buf); if (n < 0) break
          if (n > MAX_BYTES - out.size()) return result(Observation.OVER_BUDGET)
          out.write(buf, 0, n)
        }
        out.toByteArray()
      }
    } catch (e: java.io.FileNotFoundException) {
      return result(if (!file.exists()) Observation.MISSING else Observation.UNREADABLE)
    } catch (e: java.io.IOException) {
      return result(Observation.UNREADABLE)
    }
    val validUtf8 = runCatching {
      Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes))
    }.isSuccess
    // UTF-8 合法不表示 JSON 合法或见证可信，绝不推断旧版/损坏状态。
    return result(if (validUtf8) Observation.CONTENT_UNKNOWN else Observation.INVALID_UTF8, bytes)
  }
}
