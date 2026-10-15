package io.github.vjoy233.vradio.data

import java.io.File

/* 公网流地址校验（server.js safeTarget 的腰下部等价——AIbot P2-5）：Web 侧 SSRF 护栏服务的是
   服务端代理面，端上无监听端口不存在该攻击面，但「流地址 = 公网 http(s)」的口径保持一致：
   拒回环/私网/链路本地段与常见内网主机变体。添加自定义电台与库内 URL 复用。 */
object SafeTarget {
  private val RE_IP4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")
  private val RE_DEC_HOST = Regex("""^\d{1,10}$""")        // 十进制 IP 变形（2130706433 = 127.0.0.1）
  private val RE_HEX_HOST = Regex("""^0x[0-9a-fA-F]{1,8}$""")
  private val RE_LOCAL_SUFFIX = Regex("""\.(local|internal|localhost|home|lan)$""", RegexOption.IGNORE_CASE)

  fun ok(url: String): Boolean {
    val u = url.trim()
    if (!Regex("^https?://").containsMatchIn(u)) return false
    val hostPort = u.substringAfter("://").substringBefore('/')
    val host = hostPort.substringBefore(':').lowercase()
    if (host.isEmpty()) return false
    if (host.startsWith("[")) return false   // IPv6 字面量（如 [::1]/[fe80::]）无点分形态可判——回环/链路本地全拒（复核轮 P3：截断后成 "[" 会穿透，Web safeTarget 同拒 bracket 段）
    if (RE_LOCAL_SUFFIX.containsMatchIn(host)) return false
    if (host == "localhost" || host.endsWith(".localhost")) return false
    if (RE_DEC_HOST.matches(host) || RE_HEX_HOST.matches(host)) return false
    val m = RE_IP4.matchEntire(host) ?: return true          // 非点分 IPv4 的域名放行（DNS 解析后的私网面与 Web 同态度：不查）
    val o = m.groupValues.drop(1).map { it.toInt() }
    if (o.any { it > 255 }) return false                      // 非法 IPv4 形态按拒（变形意图）
    val (a, b, _, _) = o
    if (a == 0 || a == 10 || a == 127) return false           // 本网络/私网 A/回环
    if (a == 172 && b in 16..31) return false                 // 私网 B
    if (a == 192 && b == 168) return false                    // 私网 C
    if (a == 169 && b == 254) return false                    // 链路本地 169.254.x.x
    return true
  }
}

/* 统一原子写（AIbot P2-6）：Store/MyRadio/Logos/sync 四处 tmp+rename 合并为一份实现。
   rename 优先（G P2-2）：Android/Linux 的 renameTo 对已存在目标是原子替换，先 delete 反而留出
   「目标已删、tmp 未换」的进程被杀丢档窗口；delete+rename 只作 Windows 兜底（目标存在时 rename 拒），
   直写兜底殿后（内容完整优先）。纯 JVM（println 在 Android 落 logcat、单测落 stdout），失败可观测。 */
internal fun writeTextAtomic(f: File, text: String) {
  val tmp = File(f.parentFile, f.name + ".tmp")
  tmp.writeText(text)
  if (!tmp.renameTo(f)) {
    if (f.isFile) f.delete()
    if (!tmp.renameTo(f)) {
      tmp.delete()
      f.writeText(text)
      println("[vradio] atomic-rename fallback to direct write: ${f.name}")
    }
  }
}
