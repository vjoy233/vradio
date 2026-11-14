package io.github.vjoy233.vradio

import android.app.Application
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.media.CarBrowse
import io.github.vjoy233.vradio.player.PlayerHolder
import io.github.vjoy233.vradio.widget.WidgetCommands

/* 应用入口（契约 §Agent C）：Store 先就位（Player 读记忆之前，照抄 Web boot 顺序），再建播放器单例。
   B5：再装 Widget 兜底回调——进程被 Widget 点击冷启时 AppVm 尚不存在，⏮⏭/空台续播先走文件侧
   自建 Library 的兜底（WidgetCommands.wireFallback）；AppVm 创建时覆盖、销毁时回装（onCleared）。
   B6：车机点播解析同款兜底（CarBrowse.wireFallback——BootLib 文件侧库，与 Widget 共享实例）；
   车机浏览回调在 PlaybackService 侧（CarBrowse.live 未注入时同走 BootLib）。 */
class VRadioApp : Application() {
  override fun onCreate() {
    super.onCreate()
    Store.init(filesDir)
    PlayerHolder.ensure(this)
    WidgetCommands.wireFallback(this)
    CarBrowse.wireFallback(this)
  }
}
