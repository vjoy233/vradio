package io.github.vjoy233.vradio.sync

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.writeTextAtomic   // AIbot P2-6：原子写收敛到 data 层单实现（本包原同款副本已删）
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.OffsetDateTime
import kotlinx.coroutines.sync.withLock

/* D7 轻更新通道：从本仓库 GitHub（GhRepos.SELF）拉成品 radio.txt/logos.txt 落 filesDir 副本 +
   stamp.json（已应用 commitIso）。判新旧 = Gh.lastCommitIso(SELF, path) vs 本地 stamp
   （assets 打包基线 = assets/data-stamp.txt，AppVm 读后传入 check）。
   diff 的台名集合口径 = keyOf（分类|台名，安卓契约拍板——与 Web update-sources 纯台名口径不同，
   分类挪动如实呈现 added/removed）；addedCheck = 新增国内台（欧美两节过滤，同步期已实测）封顶 500。
   所有失败返回 null 不抛，UI 层据 lastFailWhy 明示 toast 不静默。 */

class LightUpdate(private val gh: Gh, private val filesDir: File,
                  private val deleteFile: (File) -> Boolean = { it.delete() }) {

  enum class LogosStatus { WRITTEN, DOWNLOAD_FAILED, WRITE_FAILED }
  enum class FileState { UNCHANGED, ABSENT, CHANGED_OR_UNKNOWN }
  enum class MetaStatus { WRITTEN, DOWNLOAD_FAILED, INVALID, WRITE_FAILED }
  enum class CleanupStatus { NOT_NEEDED, ABSENT, DELETED, FAILED }

  data class Result(val commitIso: String, val radioChanged: Boolean, val logosChanged: Boolean,
                    val added: Int, val removed: Int, val addedCheck: List<String>,
                    val metaChanged: Boolean = false, val metaInvalid: Boolean = false,
                    val logosStatus: LogosStatus, val logosFileState: FileState, val metaStatus: MetaStatus,
                    val metaCleanup: CleanupStatus, val stampWritten: Boolean, val stampFileState: FileState,
                    val retryPending: Boolean)

  /** check/apply 的失败原因（""=无更新/成功）：契约返回 null 不抛，UI 据此区分「无更新」与「网络失败」。 */
  private var checkedGeneration: Long? = null
  private var checkedBase: String? = null
  var lastFailWhy = ""
    private set

  /** 有新版返回最新 commitIso（radio/logos 两路径取较新者），null=无更新/网络失败。 */
  suspend fun check(localStampIso: String): String? = SyncBarrier.mutex.withLock {
    checkLocked(localStampIso)
  }

  private suspend fun checkLocked(localStampIso: String): String? {
    checkedGeneration = null; checkedBase = null
    lastFailWhy = ""
    if (SyncBarrier.active(filesDir)) { lastFailWhy = "端内同步未完成，请重新执行端内同步后再检查轻更新"; return null }
    val generation = SyncBarrier.generation.get()
    val latest = latestIso() ?: run { lastFailWhy = "GitHub 不可达（api.github.com，检查网络或稍后再试）"; return null }
    val eligible = File(filesDir, "light-update.pending").exists() || iso(latest) > iso(localStampIso)
    checkedGeneration = if (eligible) generation else null
    checkedBase = if (eligible) localStampIso else null
    return if (eligible) latest else null
  }

  /** 下载两文件 → filesDir/radio.txt+logos.txt（tmp+rename）+ 落 stamp（批次提交标记，末位写：
   *  meta=true + radioHash/metaHash 内容哈希双见证，任一写失败即不记 meta 见证并删旧 meta——详见
   *  apply 内注释）。radio 拿不到/写失败即整体失败，logos 失败保旧，meta 失败尽力删除旧件；stamp 失败不回滚。
   *  oldRadioText = 当前生效全文（diff 旧侧）。 */
  suspend fun apply(oldRadioText: String): Result? = SyncBarrier.mutex.withLock {
    if (checkedGeneration == null) { lastFailWhy = "请先检查更新"; null }
    else applyLocked(oldRadioText)
  }

  internal suspend fun applyForTest(oldRadioText: String): Result? = SyncBarrier.mutex.withLock {
    applyLocked(oldRadioText)
  }

  private suspend fun applyLocked(oldRadioText: String): Result? {
    lastFailWhy = ""
    val checked = checkedGeneration
    val base = checkedBase
    checkedGeneration = null
    checkedBase = null
    if (checked != null && checked != SyncBarrier.generation.get()) {
      lastFailWhy = "端内同步已改变数据，请重新检查更新"; return null
    }
    if (SyncBarrier.active(filesDir)) { lastFailWhy = "端内同步未完成，请重新执行端内同步后再尝试轻更新"; return null }
    val commitIso = latestIso() ?: run { lastFailWhy = "GitHub 不可达（api.github.com，检查网络或稍后再试）"; return null }
    if (base != null && !File(filesDir, "light-update.pending").exists() &&
        iso(commitIso) <= iso(stamp() ?: base)) {
      lastFailWhy = "数据基线已变化，请重新检查更新"; return null
    }
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
    // 落盘（批次提交协议，AIbot 三轮 P1：radio/meta/stamp 三件套须同批，stamp 末位写 = 提交标记）：
    // radio 必写——落盘失败即返回 null（底层兜底写失败时不保证旧文件原样留存）；
    // logos 非关键件失败不阻断（可重建，按实际盘面报告）；meta 写失败（磁盘/权限）≠ 整体失败——radio 已新，
    // 旧 meta 留存即混态：删旧件 + 见证 false；stamp 只在全部写成功时记 meta=true + 双内容哈希
    // （radioHash/metaHash），boot 侧 stampHashOk 核对当前两文件内容与 stamp 记录一致才放行绑定——
    // 即便删件/stamp 写失败残留旧值，「新 radio + 旧 stamp」的内容哈希也对不上，RadioMeta.bound 仍判
    // 不绑定（发现页「最近新增」保守置空，不猜），且旧 stamp 使下次 check 重走 apply 自愈。
    // 在任何资产变更前持久化重试意图；进程中断或末位 stamp 写失败也能在同一 commit 重试。
    val pending = File(filesDir, "light-update.pending")
    if (!pending.isFile && runCatching { writeTextAtomic(pending, "pending") }.isFailure) {
      lastFailWhy = "更新重试标记写入失败，未开始写入资产"; return null
    }
    if (runCatching { writeTextAtomic(File(filesDir, "radio.txt"), radio) }.isFailure) {
      lastFailWhy = "radio.txt 落盘失败（磁盘/权限）"; return null
    }
    val logoFile = File(filesDir, "logos.txt")
    val logoBefore = runCatching { if (logoFile.isFile) logoFile.readBytes().toList() else null }
    val logosStatus = if (logos == null) LogosStatus.DOWNLOAD_FAILED
      else if (runCatching { writeTextAtomic(File(filesDir, "logos.txt"), logos) }.isSuccess) LogosStatus.WRITTEN
      else LogosStatus.WRITE_FAILED
    val logoAfter = runCatching { if (logoFile.isFile) logoFile.readBytes().toList() else null }
    val logosFileState = when {
      logoBefore.isFailure || logoAfter.isFailure -> FileState.CHANGED_OR_UNKNOWN
      logoAfter.getOrNull() == null -> FileState.ABSENT
      logoBefore.getOrNull() == logoAfter.getOrNull() -> FileState.UNCHANGED
      else -> FileState.CHANGED_OR_UNKNOWN
    }
    // B2 radio-meta.json 分开落盘（plan §6.3/§13.3）：主库与 meta 任一份失败不影响另一份。
    // 校验 = 版本门（v==1）+ 可解析性——GitHub contents 通道不带内容 hash（sync-manifest 侧 Web 生成后
    // 再挂，见 CONTRACTS.md B2 留档）。AIbot P1-4 混态拦截：meta 拿不到/非法时删除旧件——旧 meta 配
    // 新 radio 会让发现页「最近新增」指错台（宁缺勿混，删除只影响该分组不影响播放）；下载到但校验失败
    // （metaInvalid）仍由 UI 明示——防仓库尚未生成 meta 时每次更新都误报。
    val meta = gh.file(GhRepos.SELF, "radio-meta.json")
    val metaStatus = when {
      meta == null -> MetaStatus.DOWNLOAD_FAILED
      RadioMeta.parse(meta) == null -> MetaStatus.INVALID
      runCatching { writeTextAtomic(File(filesDir, "radio-meta.json"), meta) }.isSuccess -> MetaStatus.WRITTEN
      else -> MetaStatus.WRITE_FAILED
    }
    val metaChanged = metaStatus == MetaStatus.WRITTEN
    val metaFile = File(filesDir, "radio-meta.json")
    val cleanup = if (metaChanged) CleanupStatus.NOT_NEEDED else if (!metaFile.exists()) CleanupStatus.ABSENT
      else if (runCatching { deleteFile(metaFile) }.getOrDefault(false) && !metaFile.exists()) CleanupStatus.DELETED
      else CleanupStatus.FAILED
    val stampO = JSONObject().put("commitIso", commitIso).put("meta", metaChanged)
      .put("radioHash", hashText(radio))
    if (metaChanged) stampO.put("metaHash", hashText(meta!!))
    val stampFile = File(filesDir, "stamp.json")
    val stampBefore = runCatching { if (stampFile.isFile) stampFile.readBytes().toList() else null }
    val stampWritten = runCatching { writeTextAtomic(stampFile, stampO.toString()) }.isSuccess
    val stampAfter = runCatching { if (stampFile.isFile) stampFile.readBytes().toList() else null }
    val stampState = when {
      stampBefore.isFailure || stampAfter.isFailure -> FileState.CHANGED_OR_UNKNOWN
      stampAfter.getOrNull() == null -> FileState.ABSENT
      stampBefore.getOrNull() == stampAfter.getOrNull() -> FileState.UNCHANGED
      else -> FileState.CHANGED_OR_UNKNOWN
    }
    // 仅所有资产和 stamp 成功后清标；删除失败保守继续重试。
    if (logosStatus == LogosStatus.WRITTEN && metaChanged && stampWritten) runCatching { pending.delete() }
    val retryPending = pending.exists()
    return Result(commitIso, radio != oldRadioText, logosStatus == LogosStatus.WRITTEN, addedKeys.size, removedKeys.size,
      addedCheck, metaChanged, metaStatus == MetaStatus.INVALID, logosStatus, logosFileState, metaStatus, cleanup, stampWritten, stampState, retryPending)
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

  /** stamp 哈希见证核对（AIbot 三轮 P1，RadioMeta.bound 入参）：Pair(radioOk, metaOk)——true = 当前
   *  filesDir 副本内容哈希与 stamp 记录一致（同批）；false = 不一致（新 radio 配残留旧 stamp 等混态）；
   *  null = 无 stamp / 旧 stamp 无哈希字段（保守不绑定，与 stampMetaOk==null 同口径）。metaHash 仅
   *  meta=true 批次写入，缺失同样 null——三重见证任一不满足即混态。 */
  fun stampHashOk(): Pair<Boolean?, Boolean?> {
    val s = read(File(filesDir, "stamp.json"))?.let { runCatching { JSONObject(it) }.getOrNull() }
      ?: return null to null
    if (!s.has("radioHash")) return null to null
    val r = hashText(read(File(filesDir, "radio.txt")) ?: "") == s.optString("radioHash")
    val m = if (s.has("metaHash")) hashText(read(File(filesDir, "radio-meta.json")) ?: "") == s.optString("metaHash") else null
    return r to m
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

/** 内容哈希（SHA-256 十六进制，sync 包内 LightUpdate/SyncEngine 共用）：stamp 批次见证绑定
 *  radio.txt/radio-meta.json 内容——部分写失败留下的「新文件 + 旧 stamp」混态由 boot 核对拦下
 *  （AIbot 三轮 P1；GitHub contents 通道不带 hash，本地自算补位）。 */
internal fun hashText(t: String): String =
  java.security.MessageDigest.getInstance("SHA-256").digest(t.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }
