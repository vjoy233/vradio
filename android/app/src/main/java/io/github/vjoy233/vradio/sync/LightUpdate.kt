package io.github.vjoy233.vradio.sync

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.writeTextAtomic   // AIbot P2-6：原子写收敛到 data 层单实现（本包原同款副本已删）
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.OffsetDateTime

/* D7 轻更新通道：从本仓库 GitHub（GhRepos.SELF）拉成品 radio.txt/logos.txt 落 filesDir 副本 +
   stamp.json（已应用 commitIso）。判新旧 = Gh.lastCommitIso(SELF, path) vs 本地 stamp
   （assets 打包基线 = assets/data-stamp.txt，AppVm 读后传入 check）。
   diff 的台名集合口径 = keyOf（分类|台名，安卓契约拍板——与 Web update-sources 纯台名口径不同，
   分类挪动如实呈现 added/removed）；addedCheck = 新增国内台（欧美两节过滤，同步期已实测）封顶 500。
   所有失败返回 null 不抛，UI 层据 lastFailWhy 明示 toast 不静默。 */

class LightUpdate(private val gh: Gh, private val filesDir: File) {

  data class Result(val commitIso: String, val radioChanged: Boolean, val logosChanged: Boolean,
                    val added: Int, val removed: Int, val addedCheck: List<String>)

  /** check/apply 的失败原因（""=无更新/成功）：契约返回 null 不抛，UI 据此区分「无更新」与「网络失败」。 */
  var lastFailWhy = ""
    private set

  /** 有新版返回最新 commitIso（radio/logos 两路径取较新者），null=无更新/网络失败。 */
  suspend fun check(localStampIso: String): String? {
    lastFailWhy = ""
    val latest = latestIso() ?: run { lastFailWhy = "GitHub 不可达（api.github.com，检查网络或稍后再试）"; return null }
    return if (iso(latest) > iso(localStampIso)) latest else null
  }

  /** 下载两文件 → filesDir/radio.txt+logos.txt（tmp+rename）+ 落 stamp；radio 拿不到即整体失败，
   *  logos 失败不阻断（可重建的非关键件，保留旧文件、logosChanged=false）。oldRadioText = 当前生效全文（diff 旧侧）。 */
  suspend fun apply(oldRadioText: String): Result? {
    lastFailWhy = ""
    val commitIso = latestIso() ?: run { lastFailWhy = "GitHub 不可达（api.github.com，检查网络或稍后再试）"; return null }
    val radio = gh.file(GhRepos.SELF, "radio.txt")
    if (radio == null) { lastFailWhy = "radio.txt 下载失败（网络/限流）"; return null }
    val logos = gh.file(GhRepos.SELF, "logos.txt")
    // diff：keyOf 台名集合（分类|台名）
    val oldKeys = keySet(oldRadioText); val newKeys = keySet(radio)
    val addedKeys = newKeys - oldKeys; val removedKeys = oldKeys - newKeys
    // addedCheck：新增国内台（欧美两节过滤、行序去重、500 封顶；按台名——增量体检按 s.n 匹配，update-sources 同口径）
    val addedNames = addedKeys.mapTo(HashSet()) { it.substringAfterLast('|') }
    val addedCheck = ArrayList<String>()
    var sec = ""
    for (raw in radio.lineSequence()) {
      val t = raw.trim()
      if (t.isEmpty()) continue
      if (t.endsWith("#genre#")) { sec = t.removeSuffix(",#genre#"); continue }
      if (sec == ClassifyCn.EU_CAT || sec == ClassifyCn.INTL_CAT) continue
      val nm = t.substringBefore(',').trim()
      if (nm.isNotEmpty() && nm in addedNames && !addedCheck.contains(nm)) addedCheck.add(nm)
    }
    if (addedCheck.size > C.ADDED_CHECK_CAP) addedCheck.subList(C.ADDED_CHECK_CAP, addedCheck.size).clear()
    // 落盘：radio 必写；logos 拿到才写；stamp 记已应用 commit
    writeTextAtomic(File(filesDir, "radio.txt"), radio)
    if (logos != null) writeTextAtomic(File(filesDir, "logos.txt"), logos)
    writeTextAtomic(File(filesDir, "stamp.json"), JSONObject().put("commitIso", commitIso).toString())
    return Result(commitIso, radio != oldRadioText, logos != null, addedKeys.size, removedKeys.size, addedCheck)
  }

  /** filesDir 副本读取；null=从未更新（用 assets 打包件）。 */
  fun radioText(): String? = read(File(filesDir, "radio.txt"))
  fun logosText(): String? = read(File(filesDir, "logos.txt"))
  fun stamp(): String? = read(File(filesDir, "stamp.json"))?.let {
    try { JSONObject(it).optString("commitIso") } catch (_: Exception) { "" }
  }?.takeIf { it.isNotEmpty() }

  private fun read(f: File): String? = if (f.isFile) try { f.readText() } catch (_: Exception) { null } else null

  private suspend fun latestIso(): String? =
    listOfNotNull(gh.lastCommitIso(GhRepos.SELF, "radio.txt"), gh.lastCommitIso(GhRepos.SELF, "logos.txt"))
      .maxByOrNull { iso(it) }

  /** git %cI 可带 +08:00 偏移、API 26 的 Instant.parse 只认 Z 后缀（Java 8 语义）——先 Instant 再 OffsetDateTime
   *  两道解析；坏/空 stamp 视为 EPOCH（必更新）。 */
  private fun iso(s: String): Instant = try { Instant.parse(s) } catch (_: Exception) {
    try { OffsetDateTime.parse(s).toInstant() } catch (_: Exception) { Instant.EPOCH }
  }

  /** keyOf 台名集合：跳过节头与 # 行，空名丢弃。 */
  private fun keySet(text: String): Set<String> =
    ClassifyCn.splitSections(text).flatMapTo(HashSet()) { sec ->
      sec.lines.map { sec.cat + "|" + it.substringBefore(',').trim() }.filter { it.substringAfterLast('|').isNotEmpty() }
    }
}
