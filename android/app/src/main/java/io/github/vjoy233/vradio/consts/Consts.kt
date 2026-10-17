package io.github.vjoy233.vradio.consts

/* 全部网络/分档/FIFO 常数字义集中一处（plan-android.md 5.2 A9：与 Web 侧常数注释对照，防双端漂移）。
   每条注 Web 侧出处，改任何一条都要两侧同步评审。 */

object C {
  // —— radio.* 持久键白名单（= store.js KEYS = server.js STORE_KEYS = 13 键，两侧契约）——
  const val K_FAVS = "radio.favs"
  const val K_RECENTS = "radio.recents"
  const val K_HEALTH = "radio.health"
  const val K_CFG = "radio.cfg"
  const val K_SONGS = "radio.songs"
  const val K_VOLPERST = "radio.volperst"
  const val K_SRCMEM = "radio.srcmem2"
  const val K_VOL = "radio.vol"
  const val K_VIEW = "radio.view"
  const val K_SHOWDEAD = "radio.showdead"
  const val K_THEME = "radio.theme"
  const val K_BASELINE = "radio.baseline"
  const val K_BASELINE_PROG = "radio.baselineProg"
  val KEYS = listOf(K_FAVS, K_RECENTS, K_HEALTH, K_CFG, K_SONGS, K_VOLPERST, K_SRCMEM,
    K_VOL, K_VIEW, K_SHOWDEAD, K_THEME, K_BASELINE, K_BASELINE_PROG)

  // —— 体检字节验收四常数（update-sources.js:128-145 同口径，A4）——
  const val CHECK_WINDOW_MS = 4500L       // 探活观察窗
  const val CHECK_MIN_BYTES = 8000        // 非 HLS 流：窗内累计字节 ≥ 阈值才认活
  const val CHECK_MIN_BYTES_HLS = 6000    // HLS：m3u8 可行但分片字节阈值另计
  const val MYSTATION_TIMEOUT_MS = 12000L // 添加电台探活（server.js 同款 12s）

  // —— 死台分档（app.js loadStore/saveHealth + plan-health-and-storage grill R1-R4）——
  const val DAY_MS = 86400000L
  const val HEALTH_TTL_SUSPECT = 180L * DAY_MS   // 疑似档兜底 TTL（半年没开页面即清理）
  const val HEALTH_UPGRADE_N = 3                 // 停运档升级：连续确认 ≥3 次
  const val HEALTH_UPGRADE_DAYS = 30L            // 且首死 ≥30 天
  const val HEALTH_SUSPECT_CAP = 1000            // FIFO 分额度：疑似 1000 + 停运 1000（停运档最后才挤）
  const val HEALTH_STOPPED_CAP = 1000
  const val ORPHAN_CLEAN_DAYS = 90L              // 休眠孤儿（回绑失联）90 天清理
  const val HEALTH_RECHECK_DAYS = 7L             // 停运档 boot 复测间隔
  const val BOOT_CHECK_CAP = 200                  // 开机静默复测每 boot 封顶（最旧优先轮转）
  const val BOOT_CHECK_COOLDOWN = 24L * 3600000L // 同台复测节流 t>24h
  const val ADDED_CHECK_CAP = 500                 // 同步后增量体检名单封顶

  // —— 播放决策链（player.js）——
  const val WATCHDOG_MS = 12000L         // stalled/watching 看门狗：12s 无进展按断流
  const val MEM_FIFO = 300               // volperst/srcmem2 各自 FIFO 封顶
  const val SRC_APPEND_CAP = 6           // 追加备选源每台封顶（对齐 mystation 护栏）
  const val DEFAULT_VOL = 90             // 无记忆时全局默认音量（%）

  // —— 歌曲历史（app.js pushSongHist）——
  const val SONGS_PER_ST = 12            // 每台 12 首
  const val SONGS_STATIONS = 50          // 台数 50 FIFO

  // —— 列表/装配（app.js）——
  const val RECENTS_CAP = 20             // 最近播放 ≤20
  const val LOGOS_NEG_MS = 7L * DAY_MS   // 台标负缓存 7 天
  const val LOGOS_CAP = 600              // 台标缓存条数上限（logos.js cap 同款）
  const val MYRADIO_MAX_LINES = 500      // my-radio.txt 行数封顶（server.js 护栏同款）
  const val MYRADIO_MAX_BYTES = 65536    // 64KB 封顶
  const val BACKUP_MAX_BYTES = 2097152   // 2MB（server.js /api/store 封顶同款，导入侧同限）

  // —— 同步/D7 轻更新（update-sources.js）——
  const val GH_TIMEOUT_MS = 15000L       // api.github.com 直连超时
  const val GH_MAX_BYTES = 4194304       // 4MB 单文件封顶
  const val RING_CHECK_CAP = 50          // diff 摘要名单封顶

  // —— UI 分类条顺序（华语/欧美置顶，其余 CAT_ORDER 序）——
  val CAT_TOP = listOf("华语音乐", "欧美音乐")
}
