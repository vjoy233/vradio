package io.github.vjoy233.vradio

import android.content.Context

/* 安卓本地设置（SharedPreferences，batch1 2026-10-18 拍板）：
   N4/E5 是安卓形态特有的开关，不入 radio.* 13 键三侧契约（契约表同轮拍板只开 radio.notes、
   留 Web 先行）；与 MainActivity 的 notifAsked 同文件（"vradio"）不同键，互不相扰。
   ——因此这些项不随 vradio-backup.json 迁移（设备本机行为，换机默认关，属预期）。
   B5 新增两类本地键（同样不进契约/备份）：
   - widget.*：桌面 Widget 快照（widget.snap，进程回收后渲染最近快照；Widget 不主动联网）
   - net.*：网络与流量策略（移动数据全量体检/同步三态、台标补全 Wi-Fi 优先） */
object Prefs {
  const val FILE = "vradio"
  const val RESUME = "resumeOnStart"   // N4 启动自动续播上次台（默认关）
  const val OFFLOAD = "audioOffload"   // E5 音频卸载省电（默认关，实验性；重启应用生效）

  // B5：Widget 快照（JSON 序列化见 widget/WidgetState.kt）
  const val WIDGET_SNAP = "widget.snap"

  // B5：网络策略（值域 allow/confirm/deny，对应 NetworkPolicy.CellularRule 小写）
  const val NET_FULL_CHECK = "net.fullCheck"   // 移动数据全量体检（默认 confirm）
  const val NET_SYNC = "net.sync"              // 移动数据主库同步（默认 confirm）
  const val NET_LOGO_WIFI = "net.logoWifi"     // 台标补全 Wi-Fi 优先（默认 true）

  fun get(ctx: Context, k: String, def: Boolean): Boolean =
    ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(k, def)

  fun set(ctx: Context, k: String, v: Boolean) =
    ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean(k, v).apply()

  fun get(ctx: Context, k: String, def: String): String =
    ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(k, def) ?: def

  fun set(ctx: Context, k: String, v: String) =
    ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(k, v).apply()
}
