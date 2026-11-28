package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.consts.C
import org.json.JSONObject
import org.json.JSONArray
import java.io.File

/* 存储收敛层（对标 store.js，安卓单进程大幅简化）：无 rev 发号/脏标记/多标签广播——白名单 13 键 +
   tmp+rename 原子落盘即全部。get/set 值恒为 JSON 字符串（与 Web localStorage 镜像 / data/store.json 完全同格式），
   是 radio.* 持久键的唯一读写出口（player 层的 volperst/srcmem2 也走这里）。
   ⚠ 新增任何 radio.* 持久键必须同步扩 consts.C.KEYS 与 Web 侧 store.js KEYS / server.js STORE_KEYS（两侧契约）。 */
object Store {
  private var file: File? = null
  private val mem = HashMap<String, String>()
  private const val RECEIPTS = "_android.addedCheckReceipts"
  private var receiptsValid = true
  private const val RECEIPT_LIMIT = 4096
  private const val RECEIPT_LENGTH = 256
  enum class HealthCommit { SUCCESS, ALREADY_APPLIED, CONFLICT, WRITE_FAILED, NOT_INITIALIZED, INVALID_RECEIPTS, CAPACITY }
  data class HealthSnapshot(val health: String?, val receipts: Set<String>, val version: Long)

  private fun parseReceipts(raw: String?): Set<String>? {
    if (raw == null) return emptySet()
    return try {
      val a = JSONArray(raw); val out = LinkedHashSet<String>()
      if (a.length() > RECEIPT_LIMIT) return null
      for (i in 0 until a.length()) {
        val v = a.get(i)
        if (v !is String || v.isEmpty() || v.length > RECEIPT_LENGTH || !out.add(v)) return null
      }
      out
    } catch (_: Exception) { null }
  }

  @Synchronized
  fun healthSnapshot(): HealthSnapshot? {
    if (file == null || !receiptsValid) return null
    val receipts = parseReceipts(mem[RECEIPTS]) ?: return null
    return HealthSnapshot(mem[C.K_HEALTH], receipts, version)
  }

  /** 未接线事务基础：调用方必须验证身份及 Library 内存状态；不提供 receipt 回收。 */
  @Synchronized
  fun commitHealthWithReceipt(expectedVersion: Long, health: String, receipt: String): HealthCommit {
    if (file == null) return HealthCommit.NOT_INITIALIZED
    if (!receiptsValid) return HealthCommit.INVALID_RECEIPTS
    val receipts = parseReceipts(mem[RECEIPTS]) ?: return HealthCommit.INVALID_RECEIPTS
    if (receipt.isEmpty() || receipt.length > RECEIPT_LENGTH) return HealthCommit.INVALID_RECEIPTS
    if (receipt in receipts) return HealthCommit.ALREADY_APPLIED
    if (receipts.size >= RECEIPT_LIMIT) return HealthCommit.CAPACITY
    if (version != expectedVersion) return HealthCommit.CONFLICT
    if (!canBump()) return HealthCommit.WRITE_FAILED
    val old = HashMap(mem)
    mem[C.K_HEALTH] = health
    mem[RECEIPTS] = JSONArray(receipts + receipt).toString()
    bumpVersion()
    if (persist()) return HealthCommit.SUCCESS
    mem.clear(); mem.putAll(old)
    return HealthCommit.WRITE_FAILED
  }
  // Non-zero random-ish epoch avoids ABA across init()/directory switches; monotonic thereafter.
  private var version = System.nanoTime().let { if (it == Long.MAX_VALUE) 1L else it }
  private fun canBump() = version != Long.MAX_VALUE
  private fun bumpVersion() {
    if (!canBump()) throw IllegalStateException("store version exhausted")
    version++
  }

  data class VersionedSnapshot(val data: Map<String, String>, val version: Long)
  enum class ApplyOutcome { SUCCESS, CONFLICT, WRITE_FAILED, NOT_INITIALIZED }
  data class ApplyResult(val outcome: ApplyOutcome, val version: Long) { val ok get() = outcome == ApplyOutcome.SUCCESS }

  @Synchronized
  fun init(dir: File) { // VRadioApp.onCreate 调一次（重复 init = 换目录重载，测试用）
    if (!canBump()) return
    dir.mkdirs()
    file = File(dir, "store.json")
    mem.clear()
    receiptsValid = true
    bumpVersion()
    val f = file ?: return
    if (!f.exists()) return
    val o = runCatching { JSONObject(f.readText()) }.getOrNull() ?: run { receiptsValid = false; mem[RECEIPTS] = "invalid"; return }
    for (k in o.keys()) {
      if (k !in C.KEYS && k != RECEIPTS) continue
      val v = o.opt(k)
      if (v is String) mem[k] = v else if (k == RECEIPTS) { receiptsValid = false; mem[RECEIPTS] = "invalid" }
    }
    if (parseReceipts(mem[RECEIPTS]) == null) receiptsValid = false
  }

  @Synchronized
  fun get(k: String): String? = mem[k]

  @Synchronized
  fun set(k: String, v: String) { if (k == RECEIPTS || !canBump()) return; mem[k] = v; bumpVersion(); persist() }

  @Synchronized
  fun remove(k: String) { if (k == RECEIPTS || !canBump()) return; mem.remove(k); bumpVersion(); persist() }

  /** 单键 copy-on-write：不改变 set/remove 旧语义，调用方可观察真实落盘结果。 */
  @Synchronized
  fun setChecked(k: String, v: String): Boolean {
    if (k == RECEIPTS || file == null || !canBump()) return false
    val had = mem.containsKey(k); val old = mem[k]
    mem[k] = v
    bumpVersion()
    if (persist()) return true
    if (had) mem[k] = old!! else mem.remove(k)
    return false
  }

  @Synchronized
  fun removeChecked(k: String): Boolean {
    if (k == RECEIPTS || file == null || !canBump()) return false
    val had = mem.containsKey(k); val old = mem[k]
    mem.remove(k)
    bumpVersion()
    if (persist()) return true
    if (had) mem[k] = old!!
    return false
  }

  @Synchronized
  fun snapshot(): Map<String, String> { // 白名单内且存在的键（exportAll / 备份导出用）
    return snapshotLocked()
  }

  @Synchronized
  fun snapshotVersioned(): VersionedSnapshot = VersionedSnapshot(snapshotLocked(), version)

  @Synchronized
  fun versionIs(expected: Long): Boolean = version == expected

  private fun snapshotLocked(): Map<String, String> {
    val o = LinkedHashMap<String, String>()
    for (k in C.KEYS) mem[k]?.let { o[k] = it }
    return o
  }

  @Synchronized
  fun applyAllCheckedIfVersion(data: Map<String, String>, expectedVersion: Long): ApplyResult {
    if (file == null) return ApplyResult(ApplyOutcome.NOT_INITIALIZED, version)
    if (version != expectedVersion) return ApplyResult(ApplyOutcome.CONFLICT, version)
    if (version == Long.MAX_VALUE) return ApplyResult(ApplyOutcome.WRITE_FAILED, version)
    val old = HashMap(mem)
    for (k in C.KEYS) { val v = data[k]; if (v != null) mem[k] = v else mem.remove(k) }
    bumpVersion()
    if (persist()) return ApplyResult(ApplyOutcome.SUCCESS, version)
    mem.clear(); mem.putAll(old)
    return ApplyResult(ApplyOutcome.WRITE_FAILED, version)
  }

  @Synchronized
  fun restoreIfVersion(data: Map<String, String>, expectedVersion: Long): Boolean {
    if (version != expectedVersion || file == null || !canBump()) return false
    val old = HashMap(mem)
    for (k in C.KEYS) { val v = data[k]; if (v != null) mem[k] = v else mem.remove(k) }
    if (persist()) { bumpVersion(); return true }
    mem.clear(); mem.putAll(old)
    return false
  }

  @Synchronized
  fun applyAll(data: Map<String, String>) { // 导入恢复（app.js importAll 同语义）：白名单键有值写入/缺键 remove
    if (!canBump()) return
    for (k in C.KEYS) {
      val v = data[k]
      if (v != null) mem[k] = v else mem.remove(k)
    }
    bumpVersion()
    persist()
  }

  @Synchronized
  fun applyAllChecked(data: Map<String, String>): Boolean { // 备份事务专用：真实落盘失败时内存也回滚，避免假成功/半事务
    if (file == null || !canBump()) return false                    // 未 init 或版本耗尽不得修改内存
    val old = HashMap(mem)                                          // 锁内保存完整快照（含白名单外/其他既有键）
    for (k in C.KEYS) {
      val v = data[k]
      if (v != null) mem[k] = v else mem.remove(k)
    }
    bumpVersion()
    if (persist()) return true
    mem.clear(); mem.putAll(old)                                    // 原子写失败：恢复完整内存快照
    return false
  }

  private fun persist(): Boolean { // 全量落盘：tmp+rename 原子写，进程写一半被杀不丢收藏（A3 纪律）。
    val f = file ?: return true // 普通 set 旧语义：未 init 仅内存
    return runCatching {        // 单进程低频写，不做 debounce（Web 的 300ms 攒批是音量条连写护栏，安卓侧同场景写入量毫秒级）
      writeTextAtomic(f, JSONObject(mem).toString())          // AIbot P2-6：统一原子写实现（含 rename 拒绝降级）
      true
    }.getOrElse {
      println("[vradio] store.json 落盘失败（内存态仍在，下次写入重试）: $it")
      false
    }
  }
}
