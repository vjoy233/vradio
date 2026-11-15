package io.github.vjoy233.vradio.widget

import io.github.vjoy233.vradio.model.PState
import org.json.JSONObject

/* Widget 快照与纯逻辑（plan-expansion-r4 §9.1）：本文件纯 JVM 可测（不 import android.*）。
   - 快照落 Android 私有 SharedPreferences（键 widget.snap，widget.* 键域不进 radio.* 三侧契约、
     不进 v3 备份）；进程被回收时 onUpdate 用最近快照渲染。
   - WidgetCommands（控制）与渲染在 RadioWidgetProvider.kt；本文件只管「算什么」。 */

/** 桌面 Widget 展示快照：台名/曲讯/播放态/更新时刻（均展示层字段，无 URL 无可执行内容）。
 *  hueKey = 分类|台名（首字母色块色相 hash 输入，ui/Common.kt phParams 同款——同台同色），非身份键不入契约。 */
data class WidgetState(
  val name: String = "",
  val song: String = "",
  val st: PState = PState.IDLE,
  val at: Long = 0L,
  val hueKey: String = "",
) {
  fun toJson(): String = JSONObject()
    .put("n", name).put("song", song).put("st", st.name).put("at", at).put("hk", hueKey).toString()

  companion object {
    fun parse(raw: String?): WidgetState? = runCatching {
      val o = JSONObject(raw ?: return null)
      val st = runCatching { PState.valueOf(o.getString("st")) }.getOrDefault(PState.IDLE)
      WidgetState(o.optString("n"), o.optString("song"), st, o.optLong("at", 0L), o.optString("hk"))
    }.getOrNull()

    /** 推送判定（防每秒级高频刷 RemoteViews）：结构性变化（台名/播放态）立即推；
     *  纯曲讯变化节流 ≥5s；内容未变不推（音量条拖动等 ui 抖动在此被吸收）。 */
    fun shouldPush(prev: WidgetState?, next: WidgetState, now: Long, songGapMs: Long = SONG_GAP_MS): Boolean {
      if (prev == null) return true
      if (prev == next.copy(at = prev.at)) return false                     // 内容一致（at 除外）
      if (prev.name != next.name || prev.st != next.st) return true          // 结构性变化立即
      return now - prev.at >= songGapMs                                     // 仅曲讯变化：≥5s 才推
    }

    /** 收藏间切台下标（app.js stepFav 同款环形）：收藏空返回 -1（调用方 no-op）；
     *  当前不在收藏内 → 正向进首台、反向进末台；否则环形 (cur+d+size)%size。 */
    fun stepIdx(curIdx: Int, size: Int, dir: Int): Int {
      if (size <= 0) return -1
      if (curIdx < 0) return if (dir > 0) 0 else size - 1
      return (curIdx + dir + size) % size
    }

    /** 展示文案：标题行（空台显示应用名） */
    fun title(s: WidgetState): String = s.name.ifEmpty { "VRadio" }

    /** 展示文案：第二行——空台/连接中/暂停/曲讯优先级递进（连接中必须可见，蜻蜓建流 5-10s 防误判卡死） */
    fun line2(s: WidgetState): String = when {
      s.name.isEmpty() -> "未在播放，点此打开"
      s.st == PState.CONNECTING -> "连接中…"
      s.st == PState.PAUSED -> if (s.song.isNotEmpty()) "⏸ ${s.song}" else "已暂停"
      s.song.isNotEmpty() -> "♪ ${s.song}"
      s.st == PState.PLAYING -> "直播中"
      else -> ""
    }

    /** 首字母（ui/Common.kt phParams 同款剥 [国别] 后缀；色相 hash 复制小份见 Provider） */
    fun letter(s: WidgetState): String =
      s.name.replace(Regex("""\s*\[[^\]]+\]\s*$"""), "").trim().firstOrNull()?.toString()?.uppercase() ?: "?"

    const val SONG_GAP_MS = 5000L   // 曲讯推送最小间隔（§9.1「曲讯变化节流 ≥5s」）
  }
}
