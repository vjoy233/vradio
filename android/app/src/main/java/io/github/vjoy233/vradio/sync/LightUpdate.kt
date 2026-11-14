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
                    val added: Int, val removed: Int, val addedCheck: List<String>,
                    val metaChanged: Boolean = false, val metaInvalid: Boolean = false)

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
    // 落盘：radio 必写；logos 拿到才写；stamp 记已应用 commit + meta 同批见证（AIbot P1-4：
    // stamp.meta=true 证明本批 radio 与 meta 同次落盘，RadioMeta.bound 据此放行发现页「最近新增」）
    writeTextAtomic(File(filesDir, "radio.txt"), radio)
    if (logos != null) writeTextAtomic(File(filesDir, "logos.txt"), logos)
    // B2 radio-meta.json 分开落盘（plan §6.3/§13.3）：主库与 meta 任一份失败不影响另一份。
    // 校验 = 版本门（v==1）+ 可解析性——GitHub contents 通道不带内容 hash（sync-manifest 侧 Web 生成后
    // 再挂，见 CONTRACTS.md B2 留档）。AIbot P1-4 混态拦截：meta 拿不到/非法时删除旧件——旧 meta 配
    // 新 radio 会让发现页「最近新增」指错台（宁缺勿混，删除只影响该分组不影响播放）；下载到但校验失败
    // （metaInvalid）仍由 UI 明示——防仓库尚未生成 meta 时每次更新都误报。
    var metaChanged = false; var metaInvalid = false
    val meta = gh.file(GhRepos.SELF, "radio-meta.json")
    if (meta != null) {
      if (RadioMeta.parse(meta) != null) {
        writeTextAtomic(File(filesDir, "radio-meta.json"), meta)
        metaChanged = true
      } else { metaInvalid = true; runCatching { File(filesDir, "radio-meta.json").delete() } }
    } else runCatching { File(filesDir, "radio-meta.json").delete() }   // 混态拦截：新 radio 不留旧 meta
    writeTextAtomic(File(filesDir, "stamp.json"),
      JSONObject().put("commitIso", commitIso).put("meta", metaChanged).toString())
    return Result(commitIso, radio != oldRadioText, logos != null, addedKeys.size, removedKeys.size,
      addedCheck, metaChanged, metaInvalid)
  }

  /** filesDir 副本读取；null=从未更新（用 assets 打包件）。 */
  fun radioText(): String? = read(File(filesDir, "radio.txt"))
  fun logosText(): String? = read(File(filesDir, "logos.txt"))
  fun metaText(): String? = read(File(filesDir, "radio-meta.json"))
  fun stamp(): String? = read(File(filesDir, "stamp.json"))?.let {
    try { JSONObject(it).optString("commitIso") } catch (_: Exception) { "" }
  }?.takeIf { it.isNotEmpty() }

  /** stamp 的 meta 同批见证（AIbot P1-4，RadioMeta.bound 入参）：true/false = 本批 apply 是否随行落了 meta；
   *  null = 旧版（B2 时代）stamp 无该字段——无法证明 filesDir radio/meta 同批，按混态处理。 */
  fun stampMetaOk(): Boolean? = read(File(filesDir, "stamp.json"))?.let {
    try { val o = JSONObject(it); if (o.has("meta")) o.optBoolean("meta") else null } catch (_: Exception) { null }
  }

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
