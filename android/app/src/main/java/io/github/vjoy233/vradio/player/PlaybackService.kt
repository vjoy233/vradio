package io.github.vjoy233.vradio.player

import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/* 通知栏/锁屏/耳机线控承载服务（CONTRACTS.md「Agent B」：单行壳）。
   会话与播放器由 PlayerHolder 持有（app 级单例，VRadioApp.onCreate ensure 建立）；
   这里只回话，通知布局/前台生命周期由 Media3 自动管理（PlayerHolder 自连控制器把会话挂进本服务）。 */
class PlaybackService : MediaSessionService() {
  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = PlayerHolder.session
}
