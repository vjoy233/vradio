package io.github.vjoy233.vradio.model

/* 数据模型 —— Web/安卓两侧共同契约的 Kotlin 侧形态（AGENTS.md 契约节）。
   JSON 持久格式（radio.* 各键的值）与 Web 完全一致：Store 存 JSON 字符串，
   本文件只定义内存态；序列化/解析在各数据层用 org.json 完成。 */

/** 电台。与 app.js 的 station 对象同构：u[0] = 身份键（srcmem/收藏/健康标记都按它回绑，cfg 不许动它）。 */
data class Station(
  var c: String,                    // 分类（applyCfg 后的当前口径）
  var n: String,                    // 台名
  var u: MutableList<String>,       // 源 URL 列表；追加源只挂台尾。var 仅为 reapplyCfg 回滚留底用（u[0] 身份键不许因 cfg 变动）
  var l: String = "",               // 台标 URL（STARTER 精选层自带；Logos 模块是台标数据唯一所有者）
  var hidden: Boolean = false,      // cfg 手动隐藏 = 彻底消失（无正在播例外，与死台隐藏口径不同）
  var health: String? = null,       // "dead"=体检死台（perm 信息在 Health 层）
  var dCat: String = c,             // 装配默认口径留底（cfg 回滚/撤回用，app.js applySources 同款）
  var dName: String = n,
  var dU: List<String> = emptyList(),
) {
  /* B1 源生命周期运行时字段（Library.applyCfg 在 u 定稿后计算；不持久化、不参与 equals/copy）：
     mo = 人工有效顺序（manual 序在前、未列按 u 原序追加；null = 无人工序即默认 [0..n-1]）；
     dis = 手动禁用索引集（播放与自动体检都跳过）；lbl = 源标签（键=源 URL）。
     三者都绝不物理重排 u[]——u[0] 是 srcmem/收藏/健康标记的身份键。 */
  var mo: List<Int>? = null
  var moManual: Boolean = false   // mo 来自 cfg.srcManualOrder（B1 review P1-6）：播放决策保留用户序压过启发式（player.js moManual 同款）
  var dis: Set<Int> = emptySet()
  var lbl: Map<String, String> = emptyMap()

  /* B3 发现页运行时字段（originMask 的 starter 位，plan-expansion-r4 §7.3；不持久化、不参与 equals）：
     Library.reload 装配 STARTER 与主列表按精确台名去重时打位——同名但 URL 已由主列表提供的精选台也带位。
     发现页「精选」分组按此位判定，不按 u[0] 与 STARTER URL 现场比对。 */
  var starter: Boolean = false

  val key: String get() = "$c|$n"   // keyOf 同款（显示/回绑用，URL 才是持久身份）
  val u0: String get() = u[0]

  /** 播放顺序（B1）：人工序（无则默认序）剔除禁用索引；空 = 全部源已手动禁用（NO_ENABLED_SOURCE）。 */
  fun effOrder(): List<Int> = (mo ?: u.indices.toList()).filter { it !in dis }
}

/** radio.cfg 清洗后的形态（normCfg 同语义：URL 键过滤 + 条数/长度封顶）。v2（B0）：新增源生命周期三字段
 *  ——人工顺序只生成运行时顺序不物理重排 u[]；禁用表语义在播放/体检层（B1 接线）；标签只改展示。 */
data class Cfg(
  val v: Int = 2,                                    // 配置版本（无 v = v1，迁移见 CfgCodec.parse）
  val moves: Map<String, String> = emptyMap(),        // URL → 移动到分类
  val names: Map<String, String> = emptyMap(),        // URL → 重命名
  val tag: Map<String, String> = emptyMap(),          // URL → 原名快照（失配清单用）
  val renames: Map<String, String> = emptyMap(),      // 分类名 → 分类名（撞名=合并）
  val hideS: Map<String, Boolean> = emptyMap(),       // URL → 手动隐藏电台
  val hideC: Map<String, Boolean> = emptyMap(),       // 分类名 → 隐藏分类
  val srcs: Map<String, List<String>> = emptyMap(),   // URL → 追加备选源（每台封顶 6 条）
  val srcManualOrder: Map<String, List<String>> = emptyMap(), // URL → 人工源顺序（元素同 srcs 清洗；不重排 u[]）
  val srcDisabled: Map<String, List<String>> = emptyMap(),   // URL → 被禁源列表（播放与自动探活都跳过）
  val srcLabels: Map<String, String> = emptyMap(),    // 源 URL → 展示标签
  val cats: List<String> = emptyList(),               // 自建分类
)

/** radio.health 单键值：{u:URL 快照, t:最近确认, t0:首死, n:连续确认数, perm:1=停运档}。 */
data class HealthEntry(
  val u: List<String>,
  val t: Long,
  val t0: Long,
  val n: Int,
  val perm: Int,
)

/** radio.favs 项：{k:键, u:源URL快照}——带 URL 的条目永不回收（身份公理）。 */
data class FavEntry(val k: String, val u: List<String>)

/** radio.recents 项：{k, n, u}，最近在前、≤20；队首即「上次收听」。 */
data class RecentEntry(val k: String, val n: String, val u: List<String>)

/** radio.songs[u0] 列表项：{t:歌名, at:时间}。 */
data class SongRec(val t: String, val at: Long)

/** radio.srcmem2 值：{i:源序号, t:时间}。 */
data class SrcMem(val i: Int, val t: Long)

/** 一次源探活的结构化结果（B1，contracts/source-diagnostic.json 双端契约形态）：code 是程序分支唯一依据
 *  （枚举名与契约 codes 数组一致），why 仅供人读——UI 不得按 why 文案反推状态；mode = direct|hls
 *  （安卓无 /proxy 级）。未建连时 httpStatus=0、contentType=空串。 */
data class DiagnosticResult(
  val url: String,
  val ok: Boolean,
  val code: String,
  val hls: Boolean,
  val mode: String,
  val httpStatus: Int,
  val contentType: String,
  val bytes: Long,
  val latencyMs: Long,
  val why: String,
  val checkedAt: Long,
)

/** 播放 UI 状态（PlayerHolder 唯一所有者，UI 只读）。 */
enum class PState { IDLE, CONNECTING, PLAYING, PAUSED }

data class PlayerUiState(
  val st: PState = PState.IDLE,
  val station: Station? = null,     // 当前台（含建流中）；null = 无台
  val status: String = "",          // 状态栏文案（"连接中… 源1/3"）
  val song: String = "",            // ICY 当前曲名（空 = 无曲讯；国内 m3u8 台协议限制显示为空不是 bug）
  val kbps: Int = 0,                // icy-br 码率（>0 才显示 "· Nkbps"）
  val srcIdx: Int = -1,             // 正在用的源序号（s.u 下标；-1 = 未建流）
  val mode: String = "",            // 正在用源的播放模式 direct/hls（空 = 未建流；源详情面板展示）
  val noSrc: Boolean = false,       // NO_ENABLED_SOURCE（B1）：该台所有源都已手动禁用——保持停播的可区分状态
  val sleepLeftMs: Long = 0L,       // 睡眠定时剩余（0 = 未设定）
  val volPct: Int = 90,             // 当前应用音量 0-100（滑杆 UI 联动）
)
