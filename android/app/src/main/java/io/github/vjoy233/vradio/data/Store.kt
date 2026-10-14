package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.consts.C
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

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

  private fun persist() { // 全量落盘：tmp+rename 原子写，进程写一半被杀不丢收藏（A3 纪律）。
    val f = file ?: return // 未 init：仅内存（正常流程不会走到）
    runCatching {           // 单进程低频写，不做 debounce（Web 的 300ms 攒批是音量条连写护栏，安卓侧同场景写入量毫秒级）
      val tmp = File(f.parentFile, f.name + ".tmp")
      tmp.writeText(JSONObject(mem).toString())
      Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.ATOMIC_MOVE)
    }
  }
}
