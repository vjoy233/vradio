package io.github.vjoy233.vradio

import android.app.Application
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.player.PlayerHolder

/* 应用入口（契约 §Agent C）：Store 先就位（Player 读记忆之前，照抄 Web boot 顺序），再建播放器单例 */
class VRadioApp : Application() {
  override fun onCreate() {
    super.onCreate()
    Store.init(filesDir)
    PlayerHolder.ensure(this)
  }
}
