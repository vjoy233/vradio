package io.github.vjoy233.vradio.sync

import io.github.vjoy233.vradio.check.CheckStream
import io.github.vjoy233.vradio.data.writeTextAtomic
import io.github.vjoy233.vradio.consts.C
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.time.Instant
import kotlinx.coroutines.sync.withLock

/* M4 端内同步引擎（update-sources.js syncSources 全量移植，无降级）：
   1) 国内源：gaotianliuyun/gao radio.txt 拉取（内容可疑时保留本地）→ classifyCn 重分类整编进 CAT_ORDER；
   2) 欧美源：AlonDrilich/radio-playlists（Radio Browser 镜像）top-500 过滤欧美国家 → 逐台实测
      （CheckStream，只保留持续吐数据的流）→ 按类型榜（news/talk/sports/religious，UUID 优先/台名兜底
      双键关联 + EU_TALK_NAMES 榜外兜底）拆 欧美音乐 + 国际新闻·谈话；
   3) 合并写 filesDir/radio.txt（tmp+rename；欧美获取失败保留旧分类；合并低于下限中止写盘）
      + 台标随行重写 logos.txt；diff 摘要按台名集合（update-sources 同口径——分类变化不算）。
   与 Web 差异：无 gh CLI 回退（Gh 层已消化）、不产 radio-data.js（端上无 file:// 降级模式）、
   不写 radio.txt.bak（assets 打包件即回退底）。WiFi-only 由调用方（AppVm）把关。 */

private val EU_CAT = ClassifyCn.EU_CAT
private val INTL_CAT = ClassifyCn.INTL_CAT

class SyncEngine(private val gh: Gh, private val check: CheckStream, private val filesDir: File) {

  companion object {
    const val MIN_TOTAL = 800        // 合并结果条目数下限，低于视为异常中止写盘（update-sources.js:31）
    const val MIN_CN_ENTRIES = 500   // 国内上游内容条目数下限，低于视为上游异常（update-sources.js:32）
    const val EU_FILE = "top/top-500.m3u"                      // 全球票数前 500 = 最稳定
    val EU_GENRE_FILES = listOf("news", "talk", "sports", "religious")   // 镜像 genres/ 类型榜：非音乐排除集
    private const val REMOVED_URLS_CAP = 150   // 消失台 URL 名单封顶（update-sources.js:396）

    // 类型榜（每类封顶300、按票数）榜外漏网的非音乐品牌兜底（update-sources.js:26 逐字符同文）
    internal val RE_EU_TALK = Regex("^(LBC|CNN|NPR|Fox News|NBC News|BBC (World Service|News|Radio [45])|Infowars|News Radio|Talk Radio|Deutschlandfunk|WDR 5|France (Info|Inter|Culture)|Europe 1|RMC|Sud Radio|Cadena SER|esRadio|Radio Marca|TOK FM|NPO Radio [12]|ABC News|VOA |Al Jazeera|CNA|Channel News)\\b", RegexOption.IGNORE_CASE)
    // logos.txt 表头：与 Web 生成物逐字一致（行格式是 Web/安卓两侧契约）
    internal const val LOGOS_HEADER = "# 由 npm run sync 自动生成：欧美系台标（欧美音乐/国际新闻·谈话，源：Radio Browser 镜像 m3u 的 tvg-logo，按流 URL 匹配）。手工编辑会被覆盖。"
    private val RE_72FM = Regex("^# 72FM: https://72fm\\.com/station/([0-9a-f-]{36})")
    private val RE_EXTINF = Regex("^#EXTINF:.*group-title=\"([^\"]*)\"[^,]*,(.+)\$")
    private val RE_LOGO_ATTR = Regex("tvg-logo=\"([^\"]*)\"")
    private val RE_URL = Regex("^https?:")
  }

  /** 同步结果摘要（server.js /api/sync 响应体 + update-sources summary 同构）。 */
  data class SyncResult(
    val ok: Boolean,                 // false=合并低于下限中止（aborted，未动任何文件）
    val total: Int, val delta: Int,
    val added: Int, val removed: Int,
    val addedNames: List<String>,    // 封顶 C.RING_CHECK_CAP（收藏点名 favsGone 用）
    val removedNames: List<String>,  // 同上
    val removedUrls: List<String>,   // 消失台 URL 集合（收藏点名第二通道，≤150）
    val addedCheck: List<String>,    // 新增国内台（欧美两节过滤、500 封顶）——同步后增量体检名单
    val euKept: Int?, val euTotal: Int?,   // null=欧美获取失败保留旧分类
    val cnUpdated: Boolean,          // false=国内上游可疑/失败保留本地
    val logosCount: Int)             // logos.txt 重写条数；-1=未重写

  /** m3u 条目（parseM3u 产物）：country=group-title；uuid = 72FM 注释行的电台 UUID（类型榜关联稳定键，比 URL 可靠）。 */
  private data class M3u(val country: String, val name: String, val url: String, val logo: String,
                         val uuid: String, var talk: Boolean = false, var ok: Boolean = false)

  private data class EuBuild(val lines: List<String>, val logoLines: List<String>,
                             val newsLines: List<String>, val newsLogoLines: List<String>,
                             val kept: Int, val total: Int)

  /** 主流程。curText = 当前生效 radio.txt 全文（assets 或 filesDir 副本，AppVm 装配后传入）。 */
  suspend fun run(curText: String, log: (String) -> Unit = {}): SyncResult = SyncBarrier.mutex.withLock {
    // 调用方可能在等待锁前取得旧快照；锁内优先读取当前 filesDir 主库。
    val current = File(filesDir, "radio.txt").let { if (it.isFile) it.readText() else curText }
    runLocked(current, log)
  }

  private suspend fun runLocked(curText: String, log: (String) -> Unit): SyncResult {
    // 1) 欧美音乐（实测重建；失败时保留旧分类不清空）
    var eu: EuBuild? = null
    try { eu = buildEuLines(log) } catch (_: Exception) { }
    if (eu == null) log("欧美源获取失败，保留旧欧美音乐分类")
    // 2) 国内源（上游内容可疑时忽略）
    var cnText = gh.file(GhRepos.CN_UP, "radio.txt")
    if (cnText != null && countEntries(cnText) < MIN_CN_ENTRIES) {
      log("国内上游内容可疑（条目 < $MIN_CN_ENTRIES），保留本地"); cnText = null
    }
    val cnUpdated = cnText != null
    // 3) 合并：国内整体重分类进新体系；欧美成功 → 新结果 + 国内捞回行，失败 → 保留本地旧节（降级语义不变）
    val before = countEntries(curText)
    val oldSecs = ClassifyCn.splitSections(curText)
    val res = ClassifyCn.classifySections(ClassifyCn.splitSections(cnText ?: curText))
    val oldOf: (String) -> List<String> = { cat -> oldSecs.firstOrNull { it.cat == cat }?.lines ?: emptyList() }
    // B2 国内候选管线（Candidates 三层去重）：跨节全局精确/归一化 URL 去重 + 非法行过滤（fromLine），
    // 同分类同名多源行全部保留（下游同名行自然并源）、不同分类同名不强并——既有分类/装配口径不变
    val cnCands = ArrayList<SyncCandidate>()
    for (cat in ClassifyCn.CAT_ORDER) if (cat != EU_CAT && cat != INTL_CAT)
      for (l in res.out.getValue(cat)) Candidates.fromLine(cat, l, "gao")?.let { cnCands.add(it) }
    val cnLines = LinkedHashMap<String, MutableList<String>>()
    for (c in Candidates.dedupe(cnCands)) cnLines.getOrPut(c.category) { ArrayList() }.add(Candidates.toLine(c))
    // 欧美系拼装按 URL 去重（P1-3）：本体在前、捞回在后——同 URL 保留本体（带国名后缀的规范行）
    val euBody = dedupUrl((eu?.lines ?: oldOf(EU_CAT)) + res.euExtra.getValue(EU_CAT))
    val intlBody = dedupUrl((eu?.newsLines ?: oldOf(INTL_CAT)) + res.euExtra.getValue(INTL_CAT))
    val merged = ArrayList<String>()
    for (cat in ClassifyCn.CAT_ORDER) {
      val body = when (cat) { EU_CAT -> euBody; INTL_CAT -> intlBody; else -> cnLines[cat] ?: emptyList() }
      if (body.isNotEmpty()) { merged.add("$cat,#genre#"); merged.addAll(body) }
    }
    val after = countEntries(merged)
    // 4) 健全性检查 + 原子写盘
    if (after < MIN_TOTAL) {
      log("合并结果异常（仅 $after 台 < $MIN_TOTAL 下限），中止写盘，保留原文件")
      return SyncResult(false, before, 0, 0, 0, emptyList(), emptyList(), emptyList(), emptyList(), null, null, cnUpdated, -1)
    }
    val mergedText = merged.joinToString("\r\n") + "\r\n"
    // 写主库前立持久屏障；中断后轻更新不得用旧 pending 或旧 stamp 覆盖端内数据。
    SyncBarrier.begin(filesDir)
    writeTextAtomic(File(filesDir, "radio.txt"), mergedText)
    // stamp 随写（G P2-3）：不写的话 D7 check 会拿仓库既有提交判「有新版」，apply 用仓库数据覆盖刚同步出的
    // 列表来回跳；commitIso=当前时刻 = 本地内容不旧于仓库任何既有提交，repo 出更新提交前 D7 保持安静。
    // 已知边界留档（审计 P3）：设备时钟前跳（手动调未来时间）后 stamp 会掩蔽 D7 直到真实时间追上
    // （判新只错在「无更新」方向，无数据损坏）；radio 与 stamp 两步原子写之间被杀 → stamp 留旧值 →
    // 中断后持久屏障会阻止 D7 覆盖，须重新执行端内同步
    // AIbot P1-4 混态拦截：端内同步产出的 radio.txt 不带 radio-meta（Android 不生成 meta）——旧 meta 若
    // 留存即「新库配旧 meta」，发现页「最近新增」会指错台；删旧件 + stamp.meta=false（RadioMeta.bound
    // 据此把该分组置空，不猜）。AIbot 三轮 P1：radioHash 同随写入（与 LightUpdate.apply 同一 stamp 形态；
    // meta=false 本就不绑定，哈希只是形态一致——两写之间被杀残留旧 stamp 时哈希核对同样拦下）
    runCatching { File(filesDir, "radio-meta.json").delete() }
    val stamp = JSONObject().put("commitIso", Instant.now().toString()).put("meta", false)
      .put("radioHash", hashText(mergedText))
    if (cnUpdated && eu != null) stamp.put("freshnessProvenance", "device-full-sync").put("freshnessAt", System.currentTimeMillis())
    writeTextAtomic(File(filesDir, "stamp.json"), stamp.toString())
    // 4.5) diff 摘要（N4/r2 ⑥）：按台名集合对比——分类变化不算（重分类是常规操作），改名 = 消失+新增如实呈现
    val oldNames = entryNamesOf(oldSecs.flatMap { it.lines })
    val neuNames = entryNamesOf(merged)
    val addedNames = neuNames.filter { !oldNames.contains(it) }
    val removedNames = oldNames.filter { !neuNames.contains(it) }
    val addedSet = addedNames.toHashSet()
    // 体检测名单（D4/R4）：新增台里的国内台（欧美两节同步期已逐个实测，跳过）；行序去重、500 封顶
    val cnAdded = ArrayList<String>()
    var secCat = ""
    for (l in merged) {
      if (l.endsWith("#genre#")) { secCat = l.removeSuffix(",#genre#"); continue }
      if (secCat == EU_CAT || secCat == INTL_CAT) continue
      val nm = l.substringBefore(',').trim()
      if (nm.isNotEmpty() && addedSet.contains(nm) && !cnAdded.contains(nm)) cnAdded.add(nm)
    }
    if (cnAdded.size > C.ADDED_CHECK_CAP) cnAdded.subList(C.ADDED_CHECK_CAP, cnAdded.size).clear()
    // 消失台 URL 集合（收藏点名第二通道——URL 快照按身份公理仍对得上）；只收名单封顶内的台
    val oldUrlOf = HashMap<String, MutableList<String>>()
    for (l in oldSecs.flatMap { it.lines }) {
      val i = l.indexOf(','); if (i < 0) continue
      oldUrlOf.getOrPut(l.substring(0, i).trim()) { ArrayList() }.add(l.substring(i + 1).trim())
    }
    val removedUrls = LinkedHashSet<String>()
    for (n in removedNames.take(C.RING_CHECK_CAP)) oldUrlOf[n]?.let { removedUrls.addAll(it) }
    // 5) 台标（欧美成功重建时随行重写，双分类前缀；失败时保留旧文件不动）
    var logosCount = -1
    if (eu != null) {
      try {
        val lg = ArrayList<String>()
        lg.add(LOGOS_HEADER)
        eu.logoLines.forEach { lg.add("$EU_CAT|$it") }
        eu.newsLogoLines.forEach { lg.add("$INTL_CAT|$it") }
        writeTextAtomic(File(filesDir, "logos.txt"), lg.joinToString("\r\n") + "\r\n")
        logosCount = lg.size - 1
      } catch (_: Exception) { log("logos.txt 写入失败（不影响电台列表）") }
    }
    // 全部资产写入结束后废弃旧轻更新重试意图，最后移除屏障。
    SyncBarrier.prepareLogoRetry(filesDir, logosCount >= 0)
    SyncBarrier.finish(filesDir)
    val delta = after - before
    val diffTxt = if (addedNames.isNotEmpty() || removedNames.isNotEmpty()) "；新增 ${addedNames.size}、消失 ${removedNames.size}" else ""
    log("完成：共 $after 台（${if (delta >= 0) "+" else ""}$delta$diffTxt）")
    return SyncResult(true, after, delta, addedNames.size, removedNames.size,
      addedNames.take(C.RING_CHECK_CAP), removedNames.take(C.RING_CHECK_CAP),
      removedUrls.toList().take(REMOVED_URLS_CAP), cnAdded, eu?.kept, eu?.total, cnUpdated, logosCount)
  }

  /* ---------- 欧美重建（update-sources.js buildEuLines） ---------- */

  private suspend fun buildEuLines(log: (String) -> Unit): EuBuild? {
    val raw = gh.file(GhRepos.EU_UP, EU_FILE) ?: return null
    val all = parseM3u(raw, log)
    // 非音乐排除集（类型榜）：UUID 优先、台名小写兜底双键关联；单个类型榜失败只记警告不中断
    val badUuid = HashSet<String>(); val badName = HashSet<String>()
    for (g in EU_GENRE_FILES) {
      val t = gh.file(GhRepos.EU_UP, "genres/$g.m3u")
      if (t == null) { log("类型榜 $g 获取失败（国际新闻排除集不全）"); continue }
      for (s in parseM3u(t)) { if (s.uuid.isNotEmpty()) badUuid.add(s.uuid); badName.add(s.name.trim().lowercase()) }
    }
    val cand = ArrayList<M3u>(); val seenUrl = HashSet<String>()
    for (s in all) {
      if (!ClassifyCn.EU_COUNTRIES.containsKey(s.country) || !seenUrl.add(s.url)) continue
      s.talk = badUuid.contains(s.uuid) || badName.contains(s.name.trim().lowercase())
        || RE_EU_TALK.containsMatchIn(s.name.trim())
      cand.add(s)
    }
    log("欧美候选 ${cand.size} 个（非音乐 ${cand.count { it.talk }} 待拆出），开始实测（约40s）…")
    mapLimit(cand, 18) { s -> s.ok = check.check(s.url).ok }   // 并发 18（Web 同款）
    val ok = cand.filter { it.ok }
    val music = buildEu(ok.filter { !it.talk })
    val news = buildEu(ok.filter { it.talk })
    log("欧美实测通过 ${ok.size}/${cand.size}：音乐 ${music.first.size} + 国际新闻·谈话 ${news.first.size}，台标 ${music.second.size + news.second.size} 个")
    return EuBuild(music.first, music.second, news.first, news.second, ok.size, cand.size)
  }

  /** 按国家分组排序（组大在前、组内按名——JS localeCompare 近似为字典序，仅影响行序不影响集合），名字挂中文国名。 */
  private fun buildEu(list: List<M3u>): Pair<List<String>, List<String>> {
    val lines = ArrayList<String>(); val logos = ArrayList<String>()
    list.groupBy { it.country }.entries.sortedByDescending { it.value.size }.forEach { (_, ss) ->
      ss.sortedBy { it.name }.forEach { s ->
        val name = "${s.name.replace(",", " ")} [${ClassifyCn.EU_COUNTRIES[s.country]}]"
        lines.add("$name,${s.url}")
        if (s.logo.isNotEmpty()) logos.add("$name,${s.logo}")
      }
    }
    return lines to logos
  }

  /** m3u 解析（update-sources.js parseM3u 逐行照抄）：#EXTINF 的 group-title=国家、台名；tvg-logo 台标；
   *  前置 72FM 注释行 = 电台 UUID（用掉即清，防下一条误绑）；无 group-title/格式异常计警告。 */
  private fun parseM3u(text: String, log: (String) -> Unit = {}): List<M3u> {
    val out = ArrayList<M3u>()
    val lines = text.split(Regex("\r?\n"))
    var noGroup = 0
    var uuid = ""
    for (i in lines.indices) {
      val um = RE_72FM.find(lines[i])
      if (um != null) { uuid = um.groupValues[1]; continue }
      val m = RE_EXTINF.find(lines[i])
      if (m != null && i + 1 < lines.size && RE_URL.containsMatchIn(lines[i + 1].trim())) {
        val lg = RE_LOGO_ATTR.find(lines[i])
        out.add(M3u(m.groupValues[1].trim(), m.groupValues[2].trim(), lines[i + 1].trim(),
          lg?.groupValues?.get(1)?.trim() ?: "", uuid))
        uuid = ""
      } else if (lines[i].startsWith("#EXTINF:")) noGroup++
    }
    if (noGroup > 0) log("跳过 $noGroup 条无 group-title/格式异常的条目")
    return out
  }

  /** 并发限流（update-sources.js mapLimit 的 worker 池同款）：N 个 worker 共享队列顺序取活。 */
  private suspend fun <T> mapLimit(items: List<T>, limit: Int, fn: suspend (T) -> Unit) = coroutineScope {
    val q = ArrayDeque(items)
    repeat(limit) {
      launch {
        while (true) {
          val x = synchronized(q) { if (q.isEmpty()) null else q.removeFirst() } ?: break
          fn(x)
        }
      }
    }
  }

  /* ---------- 小工具（update-sources.js 同款口径） ---------- */

  private fun countEntries(text: String): Int =
    text.split(Regex("\r?\n")).count { it.isNotEmpty() && !it.endsWith("#genre#") }

  private fun countEntries(lines: List<String>): Int =
    lines.count { it.isNotEmpty() && !it.endsWith("#genre#") }

  /** 台名集合（split(',')[0].trim()、空名丢弃；节头不算）。 */
  private fun entryNamesOf(lines: List<String>): LinkedHashSet<String> {
    val s = LinkedHashSet<String>()
    for (l in lines) {
      if (l.isEmpty() || l.endsWith("#genre#")) continue
      val nm = l.substringBefore(',').trim()
      if (nm.isNotEmpty()) s.add(nm)
    }
    return s
  }

  /** 行按尾逗号后的 URL 去重（首现保留）。 */
  private fun dedupUrl(arr: List<String>): List<String> {
    val seen = HashSet<String>(); val out = ArrayList<String>()
    for (l in arr) {
      val u = if (l.contains(',')) l.substringAfterLast(',').trim() else l
      if (!seen.add(u)) continue
      out.add(l)
    }
    return out
  }
}
