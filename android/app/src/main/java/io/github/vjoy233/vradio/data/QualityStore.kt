package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.model.DiagnosticResult
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/* 源质量 sidecar（B2，plan-expansion-r4 §6.1 / contracts/quality-summary.json）：
   filesDir/quality.json —— 不进 radio.* 主 Store、不占 /api/store 2MB 配额、与 radio.health
   （死台/停运）永不合并。样本来源固定四类：手动逐源诊断 / boot·sync·manual 体检通道 = diagnostic；
   真实播放成功·断流·重连·切源·失败 = playback（自动体检绝不产 playback——接线层 AppVm 保证）。
   存储形态分层（AIbot P1-2 修正：内层同构、包装各异，契约 quality-summary.json files 节冻结）：
   本文件 = {v,stations}（纯本机）；Web 服务端 data/quality.json = {v,rev,ops,data}（rev/ops 是
   Web 服务端并发机器）。**共享的是台/源内层聚合形态**：每台（键 = 身份 URL s.u[0]）→ 每源聚合值 +
   最近一次诊断 + 最近一次播放失败（不留 5 条完整历史，字节上限是最终约束）。写失败只丢样本不影响播放。
   ⚠ 与 Web 侧聚合口径的三个拍板（CONTRACTS.md B2 节留底）：
   ① 累计计数 + 最近观察过期近似——存储只有聚合值（无逐样本时间戳），成功率/样本数使用全量累计计数器；
     lastObservedAt 仅作新鲜度门控（lastObservedAt > 0 且距当前 ≥30 天 → unknown；为 0 时不触发该门），不代表滚动 30 天窗口；
   ② 连续失败 = 台级 cf 计数器（任一源 ok 清零、fail +1），非逐源；
   ③ metadata(icy|none|mixed) 由观测 modes 派生（op 事件无 icy 字段）：纯 direct → icy、
     纯 hls → none、混合 → mixed。 */
class QualityStore(private val dir: File, private val clock: () -> Long = System::currentTimeMillis,
                   private val capBytes: Int = C.QUALITY_MAX_BYTES,
                   private val saver: (String) -> Boolean = { t ->
                     runCatching { writeTextAtomic(File(dir, FILE), t); true }.getOrDefault(false)
                   }) {

  companion object {
    const val FILE = "quality.json"
    // opEvent.trigger 值域（契约）：diagnostic 用 manual|boot|sync，playback 用 play|watchdog|switch|error
    val TRIGGERS = listOf("manual", "boot", "sync", "play", "watchdog", "switch", "error")
    private val RE_HLS = Regex("\\.m3u8?(\\?|$)", RegexOption.IGNORE_CASE)   // 直流形态判定（CheckStream RE_HLS 同款）
  }

  /** 契约 QualityAggregate 形态（quality-summary.json aggregate 节逐字段）；lastObservedAt 是派生字段，发现侧只用它。 */
  data class QualityAggregate(
    val identityUrl: String,
    val sourceCount: Int, val directCount: Int,
    val okCount: Int, val failCount: Int,
    val lastOkAt: Long, val lastFailAt: Long, val lastPlaybackAt: Long, val lastObservedAt: Long,
    val avgLatencyMs: Long, val disconnects: Int, val metadata: String, val stability: String,
  ) {
    val samples: Int get() = okCount + failCount
    fun rate(): Double = if (samples > 0) okCount.toDouble() / samples else 0.0
  }

  /** trim 的收藏+最近保护集（身份 URL 集；AppVm 在 Main 线程快照后回填，@Volatile 防可见性滞后）。 */
  @Volatile var keepHint: Set<String> = emptySet()

  private val stations = LinkedHashMap<String, QStation>()

  /* ---------- 装载/落盘 ---------- */

  @Synchronized
  fun load() { // 坏文件按空库恢复（契约：sidecar 损坏只清空自身，不碰 radio.health）
    stations.clear()
    val f = File(dir, FILE)
    val o = runCatching { JSONObject(f.readText()) }.getOrNull() ?: return
    parseDiskForm(o)
  }

  /** 磁盘形态 {v:1, stations:{…}} 解析进内存（load 与 B4 备份回滚 restore 共用）。 */
  private fun parseDiskForm(o: JSONObject) {
    val ss = o.optJSONObject("stations") ?: return
    for (id in ss.keys()) {
      val st = ss.optJSONObject(id) ?: continue
      parseStation(id, st)?.let { stations[id] = it }
    }
  }

  /** 单台解析（磁盘形态与 B4 sidecar 导入形态同款字段）；无有效源返回 null（台丢弃）。 */
  private fun parseStation(id: String, st: JSONObject): QStation? {
    val q = QStation(id, st.optInt("cf", 0))
    val srcs = st.optJSONObject("sources") ?: return null
    for (su in srcs.keys()) {
      val s = srcs.optJSONObject(su) ?: continue
      val qss = QSource()
      qss.okCount = s.optInt("okCount", 0); qss.failCount = s.optInt("failCount", 0)
      qss.lastOkAt = s.optLong("lastOkAt", 0L); qss.lastFailAt = s.optLong("lastFailAt", 0L)
      qss.lastPlaybackAt = s.optLong("lastPlaybackAt", 0L)
      qss.latSum = s.optLong("latSum", 0L); qss.latN = s.optLong("latN", 0L)
      qss.disconnects = s.optInt("disconnects", 0)
      val ms = s.optJSONArray("modes")
      if (ms != null) for (i in 0 until ms.length()) (ms.opt(i) as? String)?.let { qss.modes.add(it) }
      qss.lastDiag = qEvent(s.optJSONObject("lastDiag"))
      qss.lastPlayFail = qEvent(s.optJSONObject("lastPlayFail"))
      q.sources[su] = qss
    }
    return if (q.sources.isNotEmpty()) q else null
  }

  @Synchronized
  fun save() { // tmp+rename 原子写；失败只打日志（丢样本不丢播放）
    if (!saver(toJsonString())) println("[vradio] quality.json 落盘失败（丢本样本，不影响播放）")
  }

  /* ---------- B4 备份 sidecar 事务式覆盖导入（plan-expansion-r4 §13.2-5/6 + AIbot review P1-1）：
     导入语义 = 明确覆盖（非合并）。capture/replaceImport/restore 三件套供 AppVm.applyConfirmed 组装
     「快照 → 写入 → 任一步失败恢复旧快照」的事务；replaceImport 原地换内存 stations（= 质量缓存即时重载，
     本类自身即缓存，无独立副本），trim/落盘纪律与样本写入同款。 ---------- */

  /** 导入前全量快照（磁盘同构文本）——回滚凭据。 */
  @Synchronized fun capture(): String = toJsonString()

  /** 整体覆盖为已裁剪导入数据（Backup.qualityTrim 产物，嵌套形态 {id:{cf,sources:{…}}}）+ trim + 落盘；
   *  落盘失败自动恢复导入前内存态并返回 false（不留半导入状态）。 */
  @Synchronized fun replaceImport(data: JSONObject): Boolean {
    val snap = toJsonString()
    stations.clear()
    for (id in data.keys().asSequence().toList()) {
      val st = data.optJSONObject(id) ?: continue
      parseStation(id, st)?.let { stations[id] = it }
    }
    trim(keepHint)
    if (saver(toJsonString())) return true
    stations.clear(); parseDiskForm(JSONObject(snap)); saver(toJsonString())   // 恢复导入前态（盘尽力回写）
    return false
  }

  /** 从 capture() 快照恢复（内存 + 盘）——applyConfirmed 整体回滚用；返回是否落盘成功（内存已恢复，盘失败由调用方文案如实点名）。 */
  @Synchronized fun restore(snap: String): Boolean {
    stations.clear()
    runCatching { JSONObject(snap) }.getOrNull()?.let { parseDiskForm(it) }
    return saver(toJsonString())
  }

  private fun qEvent(o: JSONObject?): QEvent? =
    o?.let { QEvent(it.optString("t"), it.optBoolean("ok", false), it.optLong("at", 0L), it.optLong("lat", 0L)) }

  private fun toJsonString(): String {
    val root = JSONObject().put("v", 1)
    val ss = JSONObject()
    for ((id, q) in stations) {
      val srcs = JSONObject()
      for ((su, s) in q.sources) {
        val o = JSONObject()
          .put("okCount", s.okCount).put("failCount", s.failCount)
          .put("lastOkAt", s.lastOkAt).put("lastFailAt", s.lastFailAt).put("lastPlaybackAt", s.lastPlaybackAt)
          .put("latSum", s.latSum).put("latN", s.latN).put("disconnects", s.disconnects)
          .put("modes", JSONArray(s.modes))
        s.lastDiag?.let { o.put("lastDiag", it.toJson()) }
        s.lastPlayFail?.let { o.put("lastPlayFail", it.toJson()) }
        srcs.put(su, o)
      }
      ss.put(id, JSONObject().put("cf", q.cf).put("sources", srcs))
    }
    return root.put("stations", ss).toString()
  }

  /* ---------- 样本记录 ---------- */

  /** mode 归一（AIbot P1-1，契约 opEvent.mode 必填枚举 direct|hls|proxy）：缺失/非法按实际尝试过的
   *  variant URL 形态兜底（m3u8 → hls、其余 → direct——耗尽/断流等空 mode 路径也尝试过具体 variant）；
   *  连 URL 都没有返回 null（调用方丢弃该事件——契约无 unknown 值，不发不造假）。与 Web qNormMode 镜像。 */
  private fun normMode(mode: String, url: String): String? = when (mode) {
    "direct", "hls", "proxy" -> mode
    else -> when {
      url.isEmpty() -> null
      RE_HLS.containsMatchIn(url) -> "hls"
      else -> "direct"
    }
  }

  /** 体检/逐源诊断样本（trigger = manual|boot|sync）。at 用 DiagnosticResult.checkedAt（真实采样时刻）。
   *  mode 归一永不为空（AIbot P1-1：诊断结果缺 mode 按源 URL 形态兜底，归不出即丢事件不造假）。 */
  @Synchronized
  fun recordDiagnostic(identityUrl: String, r: DiagnosticResult, trigger: String) {
    if (identityUrl.isEmpty() || r.url.isEmpty()) return
    val mode = normMode(r.mode, r.url) ?: return
    val (q, s) = sourceOf(identityUrl, r.url) ?: return
    apply(q, s, trigger, r.ok, r.latencyMs, mode, r.checkedAt, diagnostic = true)
    s.lastDiag = QEvent(trigger, r.ok, r.checkedAt, r.latencyMs)
    trim(keepHint); save()
  }

  /** 真实播放样本（trigger = play|watchdog|switch|error）。断流类（error/watchdog）计 disconnects。
   *  自动体检绝不走这里（接线层约束，样本分流测试兜底）。latencyMs≤0 不进延迟均值。
   *  mode 归一永不为空（AIbot P1-1：AppVm 旧状态/Media3 事件回流等空 mode 路径按源 URL 形态兜底）。 */
  @Synchronized
  fun recordPlayback(identityUrl: String, sourceUrl: String, ok: Boolean, latencyMs: Long,
                     mode: String, trigger: String) {
    if (identityUrl.isEmpty() || sourceUrl.isEmpty()) return
    val m = normMode(mode, sourceUrl) ?: return
    val (q, s) = sourceOf(identityUrl, sourceUrl) ?: return
    val at = clock()
    apply(q, s, trigger, ok, latencyMs, m, at, diagnostic = false)
    if (!ok) s.lastPlayFail = QEvent(trigger, ok, at, latencyMs)
    trim(keepHint); save()
  }

  private fun apply(q: QStation, s: QSource, trigger: String, ok: Boolean, lat: Long, mode: String,
                    at: Long, diagnostic: Boolean) {
    if (ok) {
      s.okCount++; s.lastOkAt = maxOf(s.lastOkAt, at); q.cf = 0
      if (lat > 0) { s.latSum += lat; s.latN++ }
    } else {
      s.failCount++; s.lastFailAt = maxOf(s.lastFailAt, at); q.cf++
    }
    if (!diagnostic) s.lastPlaybackAt = maxOf(s.lastPlaybackAt, at)
    if (!diagnostic && !ok && (trigger == "error" || trigger == "watchdog")) s.disconnects++
    if (mode.isNotEmpty()) s.modes.add(mode)
  }

  private fun sourceOf(identityUrl: String, sourceUrl: String): Pair<QStation, QSource>? {
    val q = stations.getOrPut(identityUrl) { QStation(identityUrl, 0) }
    val ex = q.sources[sourceUrl]
    if (ex != null) return q to ex
    if (q.sources.size >= C.QUALITY_SOURCES_PER_ST) {   // 每台 6 源封顶（caps.sourcesPerStation）：超出丢样本
      if (q.sources.isEmpty()) stations.remove(identityUrl)
      return null
    }
    val s = QSource()
    q.sources[sourceUrl] = s
    return q to s
  }

  /* ---------- 聚合摘要 ---------- */

  /** 契约聚合形态；sources 传入台源表（发现/详情页口径）时 sourceCount/directCount 按它算
   *  （directCount = 直流形态源数，m3u8 形态判定），否则按已观测源。无记录返回 null（UI 不渲染行）。 */
  @Synchronized
  fun summary(identityUrl: String, sources: List<String> = emptyList()): QualityAggregate? {
    val q = stations[identityUrl] ?: return null
    var ok = 0; var fail = 0; var dsc = 0
    var lo = 0L; var lf = 0L; var lp = 0L; var latSum = 0L; var latN = 0L
    val modes = LinkedHashSet<String>()
    var obsDirect = 0
    for (s in q.sources.values) {
      ok += s.okCount; fail += s.failCount; dsc += s.disconnects
      lo = maxOf(lo, s.lastOkAt); lf = maxOf(lf, s.lastFailAt); lp = maxOf(lp, s.lastPlaybackAt)
      latSum += s.latSum; latN += s.latN
      modes.addAll(s.modes)
      if ("direct" in s.modes) obsDirect++
    }
    val srcCount = if (sources.isNotEmpty()) sources.size else q.sources.size
    val direct = if (sources.isNotEmpty()) sources.count { !RE_HLS.containsMatchIn(it) } else obsDirect
    val metadata = when {
      modes.isEmpty() -> "none"
      modes.contains("direct") && modes.contains("hls") -> "mixed"   // proxy 并入非 icy 侧（安卓不产 proxy）
      modes.contains("direct") -> "icy"
      else -> "none"
    }
    val now = clock()
    return QualityAggregate(
      identityUrl, srcCount, direct, ok, fail, lo, lf, lp, maxOf(lo, lf, lp),
      if (latN > 0) latSum / latN else 0L, dsc, metadata,
      stability(ok, fail, latSum, latN, q.cf, maxOf(lo, lf, lp), now))
  }

  /** 四档规则（quality-summary.json stabilityRules 逐字）：unknown(<3 样本或超 30 天窗无观察) >
   *  poor(成功率<0.5 或连续失败≥3) > good(≥0.8 且 avg<2500 且连续失败<3；无延迟样本不拦 good) > fair。 */
  private fun stability(okCount: Int, failCount: Int, latSum: Long, latN: Long, cf: Int,
                        lastObservedAt: Long, now: Long): String {
    val samples = okCount + failCount
    if (samples < C.QUALITY_MIN_SAMPLES) return "unknown"
    if (lastObservedAt > 0 && now - lastObservedAt >= C.QUALITY_WINDOW_MS) return "unknown"   // 30 天窗内无样本
    val rate = okCount.toDouble() / samples
    if (rate < C.QUALITY_FAIR_RATE || cf >= C.QUALITY_GOOD_CF) return "poor"
    if (rate >= C.QUALITY_GOOD_RATE && cf < C.QUALITY_GOOD_CF &&
      (latN == 0L || latSum / latN < C.QUALITY_GOOD_LAT_MS)) return "good"
    return "fair"
  }

  /* ---------- 容量裁剪（契约 trimOrder） ---------- */

  /** 2MB 硬上限 + 契约淘汰序：非收藏且非最近台 → 最久未访问台（同刻按 identityUrl 字典序）→
   *  源历史较多者 → 最旧诊断。实现拍板（CONTRACTS.md 留档）：逐层下钻——先整台清非保护集，
   *  耗尽后对最久未访问台先清诊断对（旧者先）、再丢源历史最多的源、台空才整台丢。 */
  @Synchronized
  fun trim(keep: Set<String>) {
    var checkIn = 0
    var guard = 0
    while (guard++ < 100000) {
      if (checkIn <= 0) {
        if (sizeBytes() <= capBytes || stations.isEmpty()) return
        checkIn = 2   // 每 2 个淘汰步做一次全量字节复核（渐进写入下每次只裁 2-3 步，不过冲）
      }
      checkIn--
      val victim = stations.values
        .sortedWith(compareBy({ if (keep.contains(it.id)) 1 else 0 }, { it.lastAccess }, { it.id }))
        .firstOrNull() ?: return
      val src = victim.sources.entries.maxWithOrNull(compareBy({ hist(it.value) }, { it.key }))
      when {
        src == null -> stations.remove(victim.id)
        src.value.lastDiag != null || src.value.lastPlayFail != null -> {
          // 最旧诊断先丢：两者都在时丢 at 较小者，再轮到另一条
          val d = src.value.lastDiag; val p = src.value.lastPlayFail
          if (d != null && (p == null || d.at <= p.at)) src.value.lastDiag = null else src.value.lastPlayFail = null
        }
        else -> victim.sources.remove(src.key)
      }
      if (victim.sources.isEmpty()) stations.remove(victim.id)
    }
  }

  private fun hist(s: QSource) = s.okCount + s.failCount + s.disconnects

  @Synchronized
  fun sizeBytes(): Int = runCatching { toJsonString().toByteArray().size }.getOrDefault(0)

  /* ---------- 内部记录 ---------- */

  private class QStation(val id: String, var cf: Int) {
    val sources = LinkedHashMap<String, QSource>()
    val lastAccess: Long get() = sources.values.maxOfOrNull { maxOf(it.lastOkAt, it.lastFailAt, it.lastPlaybackAt) } ?: 0L
  }

  private class QSource {
    var okCount = 0; var failCount = 0
    var lastOkAt = 0L; var lastFailAt = 0L; var lastPlaybackAt = 0L
    var latSum = 0L; var latN = 0L
    var disconnects = 0
    val modes = LinkedHashSet<String>()
    var lastDiag: QEvent? = null
    var lastPlayFail: QEvent? = null
  }

  private class QEvent(val trigger: String, val ok: Boolean, val at: Long, val lat: Long) {
    fun toJson() = JSONObject().put("t", trigger).put("ok", ok).put("at", at).put("lat", lat)
  }
}
