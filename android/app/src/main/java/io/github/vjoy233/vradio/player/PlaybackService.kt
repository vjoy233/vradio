package io.github.vjoy233.vradio.player

import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import io.github.vjoy233.vradio.BootLib
import io.github.vjoy233.vradio.widget.WidgetPush
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/* 通知栏/锁屏/耳机线控承载服务 + 车机媒体库（B6，plan-expansion-r4 §10）。
   会话与播放器由 PlayerHolder 持有（app 级单例，VRadioApp.onCreate ensure 建立）；
   这里只回话，通知布局/前台生命周期由 Media3 自动管理（PlayerHolder 自连控制器把会话挂进本服务）。
   B5：服务存活期收集 PlayerHolder.ui → 推桌面 Widget（与 AppVm 侧收集生命周期互补——UI 进程死而后台
   在播时本服务仍在；AppVm.onUi 幂等去重，双收集不双刷）。
   B6：基类升 MediaLibraryService（MediaSessionService 的子类，通知/Widget/refresh 自定义命令链路全保留）。
   MediaLibrarySession.Builder 需服务实例（方案 §10 骨架），故会话在 onCreate 经 PlayerHolder.ensureSession
   落地；另预热 BootLib（车机冷连接时文件侧兜底库先在 IO 建好，首点播不在主线程同步解析）。 */
class PlaybackService : MediaLibraryService() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

  override fun onCreate() {
    super.onCreate()
    PlayerHolder.ensureSession(this) // 幂等：车机/自连控制器谁先到都只建一次
    scope.launch(Dispatchers.IO) { BootLib.get(applicationContext) } // 兜底库预热（UI 不在时的车机浏览/点播数据源）
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

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? =
    PlayerHolder.session as? MediaLibrarySession

  override fun onDestroy() {
    scope.cancel()
    super.onDestroy()
  }
}
