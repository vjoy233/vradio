package io.github.vjoy233.vradio.player

import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import io.github.vjoy233.vradio.widget.WidgetPush
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/* 通知栏/锁屏/耳机线控承载服务（CONTRACTS.md「Agent B」：单行壳）。
   会话与播放器由 PlayerHolder 持有（app 级单例，VRadioApp.onCreate ensure 建立）；
   这里只回话，通知布局/前台生命周期由 Media3 自动管理（PlayerHolder 自连控制器把会话挂进本服务）。
   B5：服务存活期收集 PlayerHolder.ui → 推桌面 Widget（与 AppVm 侧收集生命周期互补——UI 进程死而后台
   在播时本服务仍在；AppVm.onUi 幂等去重，双收集不双刷）。 */
class PlaybackService : MediaSessionService() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

  override fun onCreate() {
    super.onCreate()
    scope.launch {
      PlayerHolder.ui.collect { WidgetPush.onUi(applicationContext, it) }
    }
    // 30s 兜底重评：曲讯在节流窗内被丢弃的帧由这里补推（shouldPush 内容未变仍不推，不空刷）
    scope.launch {
      while (true) {
        delay(30000)
        WidgetPush.onUi(applicationContext, PlayerHolder.ui.value)
      }
    }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = PlayerHolder.session

  override fun onDestroy() {
    scope.cancel()
    super.onDestroy()
  }
}
