package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.model.Station
import java.io.File

/* 个人电台列表 my-radio.txt 唯一所有者（对标 server.js /api/mystation 写盘格式，行格式是 Web/安卓两侧契约）：
   节头「分类,#genre#」+ 行「台名,流URL」，CRLF，尾部带换行。数据更新永不覆盖本文件（装配时常驻重并）。
   已知非对称留档（审计 B2 拍板不改）：Web 落盘写 safeTarget 归一化后的 u.href（大小写/尾点归一），
   本侧写原始 trim 串——同一地址两种拼写经备份互迁后按行尾精确匹配的查重互不识别，正常粘贴无感。 */
class MyRadio(private val dir: File) {
  private val file get() = File(dir, "my-radio.txt")

  // 行拆分统一归一尾部空行（split 的尾空串不计数——「500 行」按实行口径；server.js 的 split 带尾空串属同款小怪癖，
  // 端上 replace 是本侧新通道按诚实语义定，append 计数随行不受影响：内容产出与 Web 逐字节平价不变）
  private fun splitLines(txt: String): List<String> = txt.split(Regex("\\r?\\n")).dropLastWhile { it.isEmpty() }

  fun readText(): String = if (file.exists()) runCatching { file.readText() }.getOrDefault("") else ""

  fun read(): List<Station> = RadioTxt.parse(readText())

  /* v2 备份导入恢复（全量覆盖）：行数 500/64KB 封顶内才收；统一 CRLF + 收尾换行 */
  @Synchronized
  fun replace(text: String): Boolean {
    val lines = splitLines(text)
    if (lines.size > C.MYRADIO_MAX_LINES || text.length > C.MYRADIO_MAX_BYTES) return false
    var out = lines.joinToString("\r\n")
    if (out.isNotEmpty() && !out.endsWith("\r\n")) out += "\r\n"
    return write(out)
  }

  /* 添加电台（探活由调用方先行）：csv 清洗护栏 + 公网校验 + 封顶 + 查重 + 原子写（server.js 同款算法） */
  @Synchronized
  fun append(name: String, cat: String, url: String): Boolean {
    val n = name.replace(Regex("[,\\r\\n|]"), " ").trim().take(40)    // 台名去 csv 分隔符/换行
    val c0 = cat.replace(Regex("[,\\r\\n|#]"), " ").trim().take(24)   // 分类额外去 '|'（keyOf 分隔符）
    val u = url.trim().take(512)
    if (n.isEmpty() || c0.isEmpty()) return false
    if (!SafeTarget.ok(u)) return false                              // AIbot P2-5：拒内网/回环/变形 IP（server.js safeTarget 同口径腰下部）
    val txt = readText()
    val lines = ArrayList(splitLines(txt))
    if (lines.size >= C.MYRADIO_MAX_LINES || txt.length >= C.MYRADIO_MAX_BYTES) return false // 判满在写之前
    val row = "$n,$u"
    if (lines.any { it.trim() == row }) return false                        // 完全同台：拒绝双开
    if (lines.any { it.trim().endsWith(",$u") }) return false               // 同 URL 换名也不双开（applySources 按键合并，不同名会出两行）
    val head = "$c0,#genre#"
    val at = lines.indexOfFirst { it.trim() == head }
    if (at >= 0) lines.add(at + 1, row) // 已有该分类节：节内插入
    else { lines.add(""); lines.add(head); lines.add(row) } // 新分类：尾部开节（空行分隔）
    var out = lines.joinToString("\r\n")
    if (out.startsWith("\r\n")) out = out.substring(2)
    return write(out + "\r\n")
  }

  private fun write(out: String): Boolean = runCatching {
    dir.mkdirs()
    writeTextAtomic(file, out)                                       // AIbot P2-6：统一原子写（含降级链）
    true
  }.onFailure { println("[vradio] my-radio.txt 落盘失败: $it") }.getOrDefault(false)
}
