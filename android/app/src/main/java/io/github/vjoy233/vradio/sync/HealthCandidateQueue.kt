package io.github.vjoy233.vradio.sync

import io.github.vjoy233.vradio.data.writeTextAtomic
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/* 持久化审查材料，不是可执行体检任务。调用方持有 SyncBarrier 锁；不删除历史批次。
   同名跨分类和多源均保留原行，不能把名字当作持久身份。损坏时拒绝覆盖。 */
internal object HealthCandidateQueue {
  internal fun record(dir: File, path: String, old: String, next: String) {
    val file = File(dir, "health-candidates.json")
    val root = if (file.exists()) JSONObject(file.readText()) else JSONObject().put("version", 1).put("batches", JSONArray())
    require(root.getInt("version") == 1)
    val batches = root.getJSONArray("batches")
    // 完整性封套：旧批次不得静默丢失或被损坏后覆盖。
    if (file.exists()) require(root.getString("hash") == hashText(batches.toString()))
    val oldSections = ClassifyCn.splitSections(old)
    val oldNames = oldSections.flatMap { it.lines }.map { it.substringBefore(',').trim() }.toSet()
    val oldKeys = oldSections.flatMap { s -> s.lines.map { s.cat + "|" + it.substringBefore(',').trim() } }.toSet()
    val rows = JSONArray()
    for (s in ClassifyCn.splitSections(next)) {
      if (s.cat == ClassifyCn.EU_CAT || s.cat == ClassifyCn.INTL_CAT) continue
      for (line in s.lines) {
        val name = line.substringBefore(',').trim()
        if (name.isEmpty()) continue
        val added = if (path == "light") s.cat + "|" + name !in oldKeys else name !in oldNames
        if (added) rows.put(JSONObject().put("category", s.cat).put("name", name).put("line", line))
      }
    }
    batches.put(JSONObject().put("id", UUID.randomUUID().toString()).put("path", path)
      .put("oldHash", hashText(old)).put("newHash", hashText(next)).put("rows", rows))
    root.put("hash", hashText(batches.toString()))
    writeTextAtomic(file, root.toString())
  }
}
