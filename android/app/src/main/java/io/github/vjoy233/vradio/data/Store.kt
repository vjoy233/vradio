package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.consts.C
import org.json.JSONObject
import java.io.File

/* 存储收敛层（对标 store.js，安卓单进程大幅简化）：无 rev 发号/脏标记/多标签广播——白名单 13 键 +
   tmp+rename 原子落盘即全部。get/set 值恒为 JSON 字符串（与 Web localStorage 镜像 / data/store.json 完全同格式），
   是 radio.* 持久键的唯一读写出口（player 层的 volperst/srcmem2 也走这里）。
   ⚠ 新增任何 radio.* 持久键必须同步扩 consts.C.KEYS 与 Web 侧 store.js KEYS / server.js STORE_KEYS（两侧契约）。 */
object Store {
  private var file: File? = null
  private val mem = HashMap<String, String>()
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
    dir.mkdirs()
    file = File(dir, "store.json")
    mem.clear()
    bumpVersion()
    val f = file ?: return
    if (!f.exists()) return
    val o = runCatching { JSONObject(f.readText()) }.getOrNull() ?: return // 坏 JSON 视为空库（Web 同款容错）
    for (k in o.keys()) {
      if (k !in C.KEYS) continue // 白名单外键不载入
      val v = o.opt(k)
      if (v is String) mem[k] = v
    }
  }

  @Synchronized
  fun get(k: String): String? = mem[k]

  @Synchronized
  fun set(k: String, v: String) { if (!canBump()) return; mem[k] = v; bumpVersion(); persist() }

  @Synchronized
  fun remove(k: String) { if (!canBump()) return; mem.remove(k); bumpVersion(); persist() }

  /** 单键 copy-on-write：不改变 set/remove 旧语义，调用方可观察真实落盘结果。 */
  @Synchronized
  fun setChecked(k: String, v: String): Boolean {
    if (file == null || !canBump()) return false
    val had = mem.containsKey(k); val old = mem[k]
    mem[k] = v
    bumpVersion()
    if (persist()) return true
    if (had) mem[k] = old!! else mem.remove(k)
    return false
  }

  @Synchronized
  fun removeChecked(k: String): Boolean {
    if (file == null || !canBump()) return false
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
