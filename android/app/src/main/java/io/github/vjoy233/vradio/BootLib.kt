package io.github.vjoy233.vradio

import android.content.Context
import io.github.vjoy233.vradio.data.Library
import io.github.vjoy233.vradio.data.MyRadio
import io.github.vjoy233.vradio.data.Store
import java.io.File

/* 文件侧兜底 Library（B5 WidgetCommands.lib 抽出共享，B6 车机浏览/点播同用）：
   UI/AppVm 不在时的只读装配——D7 filesDir 副本优先、assets 兜底（口径 ≈ AppVm.boot）。
   发布后只读（publish-after-build）：构建完成才挂引用，Widget/CarBrowse 两侧并发读安全；
   不写最近/收藏（与 AppVm 活实例双写互踩，widget 起播同款取舍）。构建失败不缓存（下次再试）。 */
object BootLib {
  @Volatile private var cached: Library? = null

  fun get(app: Context): Library? {
    cached?.let { return it }
    synchronized(this) {
      if (cached == null) cached = runCatching {
        val radio = File(app.filesDir, "radio.txt").takeIf { it.exists() }?.readText()
          ?: app.assets.open("radio.txt").bufferedReader().use { it.readText() }
        Library(Store, app.filesDir).apply { mainText = radio; myText = MyRadio(app.filesDir).readText(); reload() }
      }.getOrNull()
      return cached
    }
  }
}
