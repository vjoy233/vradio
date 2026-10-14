package io.github.vjoy233.vradio.sync

/* 国内台重分类移植（update-sources.js 26-58 行语义逐行照抄）：无视上游分类头、纯按台名规则归类，
   对上游改版免疫。规则顺序 = 优先级（音乐最前）；兜底 = 综合·其他（城市综合台/人民台本就是「啥都播」）。
   正则与 JS 侧逐字符同文——\b/\d 两端默认均按 ASCII 语义，勿加 UNICODE_CHARACTER_CLASS；
   改任何一条两侧同步（金样 classifycn-golden.json 兜底，由 android/tools/gen-classify-fixture.js 再生）。 */

object ClassifyCn {
  const val EU_CAT = "欧美音乐"
  const val INTL_CAT = "国际新闻·谈话"  // 欧美拉取排除出的非音乐台 + 国内外表里捞出的英文新闻台
  const val ASIA_CAT = "亚洲·港台"      // 旧「世界」的非新闻部分（新马港台日 + 海外华语台）
  const val CN_FALLBACK = "综合·其他"

  // radio.txt 分类装配顺序 = 界面分类条默认顺序（华语音乐/欧美音乐由 UI 置顶，C.CAT_TOP）
  val CAT_ORDER = listOf("华语音乐", EU_CAT, ASIA_CAT, INTL_CAT, "新闻资讯", "交通广播", "文艺·生活", "财经", CN_FALLBACK)

  // 欧美系分类（SyncEngine 独占重建；国内重分类时遇到要跳过，防止旧文件行被误按国内规则分走）
  val EU_SYSTEM_CATS = listOf(EU_CAT, INTL_CAT)

  // 国际台捞回（藏在国内外表里的英文台）与 BBC 音乐网捞回——除进 CN_RULES 外，
  // 欧美系旧节的捞回扫描（classifySections 幂等路径）也复用这两条，勿重复定义（update-sources.js:38-39）
  private val RE_RESCUE_INTL = Regex(
    "^(NPR|CNN|Al ?Jazeera|BBC (News|World Service|Radio 4|Radio 5)|LBC News|News Radio UK|NBC News|Fox News|VOA|CNBC|Bloomberg|Sky News)\\b" +
      "|^(DW|ABC News|CBS|NHK World|France 24)\\b|^(CGTN|CRI NEWS)", RegexOption.IGNORE_CASE)
  private val RE_RESCUE_MUSIC = Regex("^BBC Radio [1236]")   // 无 i：与 JS 侧一致区分大小写

  // CN_RULES：顺序即优先级（汽车音乐台按内容归音乐——音乐规则在交通前）
  private val CN_RULES = listOf(
    INTL_CAT to RE_RESCUE_INTL,
    EU_CAT to RE_RESCUE_MUSIC,
    "华语音乐" to Regex("音乐|动感\\d|动听|经典947|经典FM|摩登|金曲|旋律|音悦|摇滚|古典|国乐|天籁|华语经典|好声音|Hit FM|轻松调频|怀旧|Love Radio|MY FM|Asia FM|Hot FM", RegexOption.IGNORE_CASE),
    "交通广播" to Regex("交通|汽车|车载|私家车|的士|高速|交警"),
    "财经" to Regex("经济|财经|第一财经|股市|金融|商贸|Money FM", RegexOption.IGNORE_CASE),
    "文艺·生活" to Regex("文艺|戏曲|曲艺|戏剧|京剧|豫剧|越剧|黄梅|评书|相声|小品|书场|小说|故事|评弹|大鼓|娱乐|有声|文摘|都市|生活|城市|旅游|美食|健康|女性|亲子|文化|青春|高校|休闲|体育|运动|球迷|少儿|儿童|教育|校园|成长|阅读|老年"),
    "新闻资讯" to Regex("新闻|资讯|NewsRadio|世界华声|中国之声|中华之声|神州之声|华夏之声|香港之声|湾区之声|乡村之声|南海之声|环球资讯|中文环球"),
  )

  // 旧「世界」拆分：新闻向 → 国际新闻·谈话，其余整体进亚洲·港台
  val RE_WORLD_NEWS = Regex("CNA|938|NHK|News|Channel News|百家|知识|Money", RegexOption.IGNORE_CASE)

  // 欧美国家白名单（update-sources.js EU_COUNTRIES 同序：RE_EU_TAG 的备选顺序依赖插入序，勿重排）
  val EU_COUNTRIES = linkedMapOf(
    "United States" to "美国", "United Kingdom" to "英国", "Ireland" to "爱尔兰", "Canada" to "加拿大",
    "Australia" to "澳大利亚", "New Zealand" to "新西兰", "Germany" to "德国", "France" to "法国",
    "Netherlands" to "荷兰", "Belgium" to "比利时", "Switzerland" to "瑞士", "Austria" to "奥地利",
    "Italy" to "意大利", "Spain" to "西班牙", "Portugal" to "葡萄牙", "Sweden" to "瑞典",
    "Norway" to "挪威", "Denmark" to "丹麦", "Finland" to "芬兰", "Poland" to "波兰")

  // EU 重建行的行尾国名后缀（`${名} [${国名}]` 模板）：区分「重建本体」（带后缀）与「国内捞回/世界拆分」行
  // （无后缀）——幂等路径里带后缀行跳过捞回扫描，实测淘汰的旧台不得借品牌正则复活（PR#8 review P2）
  val RE_EU_TAG = Regex(" \\[(" + EU_COUNTRIES.values.joinToString("|") + ")\\]$")

  /** 纯台名归类（全新上游行语义，= fixture 探针口径）：CN_RULES 顺序即优先级，兜底 综合·其他。 */
  fun classify(name: String): String =
    CN_RULES.firstOrNull { it.second.containsMatchIn(name) }?.first ?: CN_FALLBACK

  /** radio.txt 分节（splitSections 同款）：「分类,#genre#」分节 + 非空行，无头行归「未分类」。 */
  fun splitSections(text: String): List<Section> {
    val sections = ArrayList<Section>()
    var cur = Section("未分类", ArrayList())
    for (raw in text.split(Regex("\r?\n"))) {
      val line = raw.trim()
      if (line.endsWith("#genre#")) {
        if (cur.lines.isNotEmpty()) sections.add(cur)
        cur = Section(line.removeSuffix(",#genre#"), ArrayList())
      } else if (line.isNotEmpty()) cur.lines.add(line)
    }
    if (cur.lines.isNotEmpty()) sections.add(cur)
    return sections
  }

  /**
   * 国内重分类整编（update-sources.js classifyCn 全量移植，P1 幂等）：
   * ① 新式节（cat ∈ CAT_ORDER）整节原样保留——否则降级同步时「亚洲·港台」等会被台名规则重新打散；
   * ② 欧美系两新式节例外：行只做捞回扫描且只扫无国名后缀行（带后缀的重建本体生死全由欧美拉取决定）；
   * ③ 旧「世界」按 WORLD_NEWS 拆走新闻台。
   * @return out = 目标分类→行[]；euExtra = 欧美系两分类的捞回行（追加到欧美同步结果之后）
   */
  fun classifySections(sections: List<Section>): CnResult {
    val out = LinkedHashMap<String, MutableList<String>>()
    ClassifyCn.CAT_ORDER.forEach { out[it] = ArrayList() }
    val euExtra = LinkedHashMap<String, MutableList<String>>()
    euExtra[EU_CAT] = ArrayList(); euExtra[INTL_CAT] = ArrayList()
    for (sec in sections) {
      if (sec.cat in EU_SYSTEM_CATS) {                       // ② 欧美系旧节：只捞无后缀行
        for (line in sec.lines) {
          val nm = line.substringBefore(',')
          if (RE_EU_TAG.containsMatchIn(nm)) continue        // 重建本体：捞回扫描一律跳过
          when {
            RE_RESCUE_MUSIC.containsMatchIn(nm) -> euExtra.getValue(EU_CAT).add(line)
            RE_RESCUE_INTL.containsMatchIn(nm) -> euExtra.getValue(INTL_CAT).add(line)
            // 当年按 WORLD_NEWS 从旧「世界」拆入的世界系新闻台不匹配品牌正则，CN 失败 + EU 成功时
            // 会随旧节丢弃——补测 WORLD_NEWS 捞回（PR#5 二轮 review 残留）
            RE_WORLD_NEWS.containsMatchIn(nm) -> euExtra.getValue(INTL_CAT).add(line)
          }
        }
        continue
      }
      if (sec.cat in CAT_ORDER) { out.getValue(sec.cat).addAll(sec.lines); continue }   // ① 上轮产物原样保留
      for (line in sec.lines) {
        val nm = line.substringBefore(',')
        if (sec.cat == "世界") {                             // ③ 世界拆分
          (if (RE_WORLD_NEWS.containsMatchIn(nm)) euExtra.getValue(INTL_CAT) else out.getValue(ASIA_CAT)).add(line)
          continue
        }
        (euExtra[classify(nm)] ?: out.getValue(classify(nm))).add(line)   // euExtra 只有两个欧美系键
      }
    }
    return CnResult(out, euExtra)
  }
}

/** splitSections 的一节：cat = 节名（#genre# 行去尾），lines = 非空台行。 */
data class Section(val cat: String, val lines: MutableList<String>)

/** classifySections 产物：out = 分类→行[]（CAT_ORDER 全键），euExtra = 欧美系两分类的捞回行。 */
data class CnResult(val out: Map<String, List<String>>, val euExtra: Map<String, List<String>>)
