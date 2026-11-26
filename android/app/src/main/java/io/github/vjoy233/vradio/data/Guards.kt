package io.github.vjoy233.vradio.data

import java.io.File

/* 公网流地址校验（server.js / update-sources.js safeTarget 的接受域对齐——审计 B1 拍板严格对齐 Web）：
   Web 侧经 new URL 隐式完成的 userinfo 剥离与 WHATWG IPv4 归一在此显式实现（十/八/十六进制、短式、
   尾随点全按 url.spec.whatwg.org 口径）；拒回环/私网/链路本地段。添加自定义电台与库内 URL 复用。
   已知非对称（留档）：bracket 段全拒（Web 只拒私有 IPv6 段——公开 IPv6 字面量电台流实际不存在）；
   端口合法性不校验（Web 的 new URL 会拒坏端口——端上探活自然失败，无功能差）。 */
object SafeTarget {

  fun ok(url: String): Boolean {
    val u = url.trim()
    if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(u)) return false
    val hostPort = u.substringAfter("://").substringBefore('/')
    val host = hostPort.substringAfterLast('@').substringBefore(':').lowercase()  // 剥 userinfo（http://a@127.0.0.1/）
    if (host.isEmpty()) return false
    if (host.startsWith("[")) return false   // IPv6 字面量（如 [::1]/[fe80::]）全拒（复核轮 P2，见上留档）
    if (host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false  // WHATWG 把 *.localhost 归一成 localhost
    if (!endsInNumber(host)) return true   // 纯域名放行（.lan/.home/.internal 等不再额外拒——Web 收，NAS 自建台可加）
    val v = ipv4(host) ?: return false       // 数字形态但归一失败（999.1.1.1 / 1.2.3.4.5）：Web 侧 new URL 直接抛 → 同拒
    val top24 = v ushr 24; val top16 = v ushr 16
    if (top24 == 0L || top24 == 10L || top24 == 127L) return false   // 本网络/私网 A/回环
    if (top16 == (169L shl 8) or 254L) return false                  // 链路本地 169.254/16
    if (top16 == (192L shl 8) or 168L) return false                  // 私网 C 192.168/16
    if ((v ushr 20) == (172L shl 4) or 1L) return false              // 私网 B 172.16/12
    return true
  }

  /* —— WHATWG URL IPv4 解析移植（#ends-in-a-number / #ipv4-number-parser / #ipv4-parser）—— */
  private fun endsInNumber(host: String): Boolean {
    var parts = host.split(".")
    if (parts.size > 1 && parts.last().isEmpty()) parts = parts.dropLast(1)
    val last = parts.lastOrNull() ?: return false
    if (last.isNotEmpty() && last.all { it in '0'..'9' }) return true
    return num(last) != null
  }
  private fun ipv4(host: String): Long? {
    var parts = host.split(".")
    if (parts.size > 1 && parts.last().isEmpty()) parts = parts.dropLast(1)
    if (parts.isEmpty() || parts.size > 4) return null
    val nums = ArrayList<Long>()
    for (p in parts) nums.add(num(p) ?: return null)
    for (i in 0 until nums.size - 1) if (nums[i] > 255) return null
    val last = nums.last()
    if (last >= 1L shl (8 * (5 - nums.size))) return null
    var v = last
    for (i in 0 until nums.size - 1) v += nums[i] shl (24 - 8 * i)
    return v
  }
  private fun num(p: String): Long? {
    if (p.isEmpty()) return null
    var r = 10; var s = p
    if (s.length >= 2 && (s.startsWith("0x") || s.startsWith("0X"))) { r = 16; s = s.substring(2) }
    else if (s.length > 1 && s[0] == '0') { r = 8; s = s.substring(1) }
    if (s.isEmpty()) return 0L
    val v = s.toLongOrNull(r) ?: return null
    return if (v < 0) null else v
  }
}

/** Test-only seam; production leaves hooks null. */
internal object AtomicWriteTestHook { var rename: ((File, File) -> Boolean)? = null }
private fun rename(from: File, to: File): Boolean {
  AtomicWriteTestHook.rename?.let { return it(from, to) }
  return try {
    java.nio.file.Files.move(from.toPath(), to.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE,
      java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    true
  } catch (_: Exception) { false }
}
private val atomicLocks = java.util.concurrent.ConcurrentHashMap<String, Any>()

/* 统一原子写：同目标进程内串行，独立临时文件，rename 成功才提交；失败直接抛错，旧目标不触碰。
   仅保留既有 .tmp 路径作为故障注入兼容（目录存在时），生产正常路径使用唯一临时文件。 */
internal fun writeTextAtomic(f: File, text: String) {
  val lock = atomicLocks.computeIfAbsent(f.absolutePath) { Any() }
  synchronized(lock) {
    // Legacy .tmp is used only when an explicit test hook is active; production never reuses
    // crash leftovers or another writer's temporary file.
    val tmp = if (AtomicWriteTestHook.rename != null) File(f.parentFile, f.name + ".tmp")
      else File.createTempFile(f.name + ".", ".tmp", f.parentFile)
    try {
      tmp.writeText(text)
      if (!rename(tmp, f)) throw java.io.IOException("atomic rename failed: ${f.name}")
    } finally {
      if (tmp.exists() && tmp != f) tmp.delete()
    }
  }
}
