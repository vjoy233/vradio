package io.github.vjoy233.vradio

import android.content.Context

/* 安卓本地设置（SharedPreferences，batch1 2026-10-18 拍板）：
   N4/E5 是安卓形态特有的开关，不入 radio.* 13 键三侧契约（契约表同轮拍板只开 radio.notes、
   留 Web 先行）；与 MainActivity 的 notifAsked 同文件（"vradio"）不同键，互不相扰。
   ——因此这两项不随 vradio-backup.json 迁移（设备本机行为，换机默认关，属预期）。 */
object Prefs {
  const val FILE = "vradio"
  const val RESUME = "resumeOnStart"   // N4 启动自动续播上次台（默认关）
  const val OFFLOAD = "audioOffload"   // E5 音频卸载省电（默认关，实验性；重启应用生效）
  // B3-C 发现页「最近恢复」运行时缓存（health dead→alive 转移记录，JSON {台key: 复活时刻}，7 天过期；
  // 派生数据不随备份迁移、不是 radio.* 契约键——发现页开关关闭时记录照常积累，不删已有数据）
  const val RECOVERED = "healthRecovered"

  fun get(ctx: Context, k: String, def: Boolean): Boolean =
    ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(k, def)

  fun set(ctx: Context, k: String, v: Boolean) =
    ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean(k, v).apply()

  fun getStr(ctx: Context, k: String, def: String): String =
    ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(k, def) ?: def

  fun setStr(ctx: Context, k: String, v: String) =
    ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(k, v).apply()
}
