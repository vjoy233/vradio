package io.github.vjoy233.vradio

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.ViewModelProvider
import io.github.vjoy233.vradio.ui.AppRoot
import io.github.vjoy233.vradio.ui.AppVm

/* 单 Activity（契约）：edge-to-edge + Compose 全权绘制。
   POST_NOTIFICATIONS 运行时申请收在「首播」时机（AppVm.startPlay 经 reqNotif 钩子调进来），
   拒绝不阻断播放；SharedPreferences 本地标记只问一次（13- 以下系统无此权限直接跳过）。
   E3/E4 入口路由（singleTask 冷/热两路）：快捷方式 extra / ACTION_VIEW 流链接 → AppVm.handleIntent。 */
class MainActivity : ComponentActivity() {
  private val notifReq = registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* 拒绝即静默，不阻断 */ }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    preferHighRefreshRate()
    reqNotif = {
      val sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (Build.VERSION.SDK_INT >= 33 && !sp.getBoolean(PREF_ASKED, false)) {
        sp.edit().putBoolean(PREF_ASKED, true).apply()
        notifReq.launch(Manifest.permission.POST_NOTIFICATIONS)
      }
    }
    // 同一 ViewModelStore：AppRoot 里 ViewModelProvider 拿到的是同一实例（batch1 E3/E4 路由入口）。
    // savedInstanceState 非空 = 旋转/深浅色切换等重建：onCreate 拿到的还是当初的启动 intent，
    // 无条件路由会重放（快捷方式再点播一次整链重开/接流预填扔回添加页，AIbot P1-4）——
    // 热路径在 onNewIntent，process death 恢复也自然跳过。
    if (savedInstanceState == null) ViewModelProvider(this)[AppVm::class.java].handleIntent(intent)
    setContent { AppRoot() }
  }

  override fun onNewIntent(intent: Intent) {   // singleTask 热启动（app 在后台/桌面快捷方式二连点）
    super.onNewIntent(intent)
    ViewModelProvider(this)[AppVm::class.java].handleIntent(intent)
  }

  /* 高刷新率：不申请时国产 ROM 常对非白名单 app 限速 60Hz。取该屏 supportedModes
     实际最大值设 preferredRefreshRate hint（官方口径：只要更高频率优先 hint 而非
     preferredDisplayModeId，系统自适应降频照常）；≤60Hz 或取不到不设，等价无偏好。 */
  private fun preferHighRefreshRate() {
    val modes = if (Build.VERSION.SDK_INT >= 30) display?.supportedModes
                else @Suppress("DEPRECATION") windowManager.defaultDisplay?.supportedModes
    val hz = modes?.maxOfOrNull { it.refreshRate } ?: 0f
    if (hz > 60f) window.attributes = window.attributes.apply { preferredRefreshRate = hz }
  }

  override fun onDestroy() {
    super.onDestroy()
    reqNotif = null   // 旋转重建会紧随 onCreate 重挂；空窗期调用方已判空
  }

  companion object {
    private const val PREFS = "vradio"
    private const val PREF_ASKED = "notifAsked"
    @Volatile var reqNotif: (() -> Unit)? = null   // AppVm 首播时调用
  }
}
