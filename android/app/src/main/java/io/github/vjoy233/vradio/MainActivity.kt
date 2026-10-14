package io.github.vjoy233.vradio

import android.Manifest
import android.content.Context
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import io.github.vjoy233.vradio.ui.AppRoot

/* 单 Activity（契约）：edge-to-edge + Compose 全权绘制。
   POST_NOTIFICATIONS 运行时申请收在「首播」时机（AppVm.startPlay 经 reqNotif 钩子调进来），
   拒绝不阻断播放；SharedPreferences 本地标记只问一次（13- 以下系统无此权限直接跳过）。 */
class MainActivity : ComponentActivity() {
  private val notifReq = registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* 拒绝即静默，不阻断 */ }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    reqNotif = {
      val sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (Build.VERSION.SDK_INT >= 33 && !sp.getBoolean(PREF_ASKED, false)) {
        sp.edit().putBoolean(PREF_ASKED, true).apply()
        notifReq.launch(Manifest.permission.POST_NOTIFICATIONS)
      }
    }
    setContent { AppRoot() }
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
