package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.model.Station
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/* 个人电台列表 my-radio.txt 唯一所有者（对标 server.js /api/mystation 写盘格式，行格式是 Web/安卓两侧契约）：
   节头「分类,#genre#」+ 行「台名,流URL」，CRLF，尾部带换行。数据更新永不覆盖本文件（装配时常驻重并）。 */
class MyRadio(private val dir: File) {
  private val file get() = File(dir, "my-radio.txt")

  fun readText(): String = if (file.exists()) runCatching { file.readText() }.getOrDefault("") else ""

  fun read(): List<Station> = RadioTxt.parse(readText())

  /* v2 备份导入恢复（全量覆盖）：行数 500/64KB 封顶内才收；统一 CRLF + 收尾换行 */
  @Synchronized
  fun replace(text: String): Boolean {
    val lines = text.split(Regex("\\r?\\n"))
    if (lines.size > C.MYRADIO_MAX_LINES || text.length > C.MYRADIO_MAX_BYTES) return false
    var out = lines.joinToString("\r\n")
    if (out.isNotEmpty() && !out.endsWith("\r\n")) out += "\r\n"
    return write(out)
  }

  /* 添加电台（探活由调用方先行）：csv 清洗护栏 + 封顶 + 查重 + tmp+rename 原子写（server.js 同款算法） */
  @Synchronized
  fun append(name: String, cat: String, url: String): Boolean {
    val n = name.replace(Regex("[,\\r\\n|]"), " ").trim().take(40)    // 台名去 csv 分隔符/换行
    val c0 = cat.replace(Regex("[,\\r\\n|#]"), " ").trim().take(24)   // 分类额外去 '|'（keyOf 分隔符）
    val u = url.trim().take(512)
    if (n.isEmpty() || c0.isEmpty()) return false
    if (!(u.startsWith("http://") || u.startsWith("https://"))) return false
    val txt = readText()
    val lines = if (txt.isEmpty()) ArrayList<String>() else ArrayList(txt.split(Regex("\\r?\\n")))
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
    val tmp = File(dir, file.name + ".tmp")
    tmp.writeText(out)
    Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE)
    true
  }.getOrDefault(false)
}
