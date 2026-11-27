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

  @Synchronized
  fun init(dir: File) { // VRadioApp.onCreate 调一次（重复 init = 换目录重载，测试用）
    dir.mkdirs()
    file = File(dir, "store.json")
    mem.clear()
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
  fun set(k: String, v: String) { mem[k] = v; persist() }

  @Synchronized
  fun remove(k: String) { mem.remove(k); persist() }

  /** 单键 copy-on-write：不改变 set/remove 旧语义，调用方可观察真实落盘结果。 */
  @Synchronized
  fun setChecked(k: String, v: String): Boolean {
    val had = mem.containsKey(k); val old = mem[k]
    mem[k] = v
    if (persist()) return true
    if (had) mem[k] = old!! else mem.remove(k)
    return false
  }

  @Synchronized
  fun removeChecked(k: String): Boolean {
    val had = mem.containsKey(k); val old = mem[k]
    mem.remove(k)
    if (persist()) return true
    if (had) mem[k] = old!!
    return false
  }

  @Synchronized
  fun snapshot(): Map<String, String> { // 白名单内且存在的键（exportAll / 备份导出用）
    val o = LinkedHashMap<String, String>()
    for (k in C.KEYS) mem[k]?.let { o[k] = it }
    return o
  }

  @Synchronized
  fun applyAll(data: Map<String, String>) { // 导入恢复（app.js importAll 同语义）：白名单键有值写入/缺键 remove
    for (k in C.KEYS) {
      val v = data[k]
      if (v != null) mem[k] = v else mem.remove(k)
    }
    persist()
  }

  @Synchronized
  fun applyAllChecked(data: Map<String, String>): Boolean { // 备份事务专用（AIbot 三轮 P1-2）：同 applyAll 但落盘失败可被调用方感知（false）——
    for (k in C.KEYS) {                                      // 吞失败的 persist 只适合普通 set/remove（内存态仍在下次重试），
      val v = data[k]                                        // 事务需要「任一步失败整体回滚」，不能不知情地继续替换 my-radio/quality
      if (v != null) mem[k] = v else mem.remove(k)
    }
    return persist()
  }

  private fun persist(): Boolean { // 全量落盘：tmp+rename 原子写，进程写一半被杀不丢收藏（A3 纪律）。
    val f = file ?: return true // 未 init：仅内存（正常流程不会走到；内存即全部，视为成功）
    return runCatching {        // 单进程低频写，不做 debounce（Web 的 300ms 攒批是音量条连写护栏，安卓侧同场景写入量毫秒级）
      writeTextAtomic(f, JSONObject(mem).toString())          // AIbot P2-6：统一原子写实现（含 rename 拒绝降级）
      true
    }.getOrElse {
      println("[vradio] store.json 落盘失败（内存态仍在，下次写入重试）: $it")
      false
    }
  }
}
