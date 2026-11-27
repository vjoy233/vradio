package io.github.vjoy233.vradio

import android.os.Build
import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.vjoy233.vradio.MainActivity
import io.github.vjoy233.vradio.data.RadioTxt
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL

/**
 * Android 关键路径 Smoke 骨架（启动 + 共享资产 + 本地固定流 fixture 接入协议）。
 *
 * 已接入确定性断言：Activity 启动、共享资产生产解析器可解析（AIbot P2：首字节存在性
 * 不构成「可解析」，一个字节的坏文件同样通过）、radio-meta.json 契约形态。
 * 仍未实现（逐批接入，勿把当前绿灯当成更强保证）：装配就绪（AppVm.boot 业务就绪的有界等待）、
 * 音频焦点、进程回收、Widget、备份导入。共享 fixture 版本核对已接入（review#40-r2 P2）：
 * assumeFixtureReachable 解析 /__health 的 version 与 FIXTURE_VERSION 对账，漂移两模式都 fail。
 * 测试输入统一走本地 Node fixture，禁止依赖公网。
 * fixtureBaseUrl 注入协议（docs/testing-strategy-2026-11.md §3 L4）：宿主起
 * test/harness/android-fixture.js（监听 0.0.0.0 随机端口）→ workflow 把 127.0.0.1 换算 10.0.2.2 →
 * gradle -Pandroid.testInstrumentationRunnerArguments.fixtureBaseUrl= 注入 instrumentation；
 * 未注入（或哨兵值）时播放类用例经 [assumeFixture] Assume 跳过——没接 fixture 的手动 dispatch 骨架仍绿。
 * CI required 模式（review#40 P2-5）：workflow 同步注入 ciRequired=1——此时 fixture 未注入/端口不可达
 * 直接 fail（workflow 的目的就是验证启动/端口传递协议，参数链退化必须红脸，不许「全 skip 的绿 job」）；
 * 本地无该参数保持 Assume skip 不变。
 * 测试输入统一走本地 Node fixture，禁止依赖公网；音频焦点/进程回收/Widget 属发布前设备层，不在本批
 * （差异 diff 范围与挂账见 docs/testing-strategy-2026-11.md §10 附录）。
 */
@RunWith(AndroidJUnit4::class)
class AndroidSmokeTest {

  @get:Rule
  val guard = TestUtil.dataGuard() // review#40 P1：launchesMainActivity 会触发 AppVm boot 链（可能写用户数据），统一快照兜底

  companion object {
    /** fixture 版本：与 test/harness/android-fixture.js 的 FIXTURE_VERSION 两处同步改（报告须记录在案；
        设备端经 /__health 反查对账——assumeFixtureReachable，漂移即 fail） */
    const val FIXTURE_VERSION = "v1"

    /** 未传参约定缺省值：端口 0 不存在 → 播放类用例一律 skip */
    const val FIXTURE_BASE_NONE = "http://10.0.2.2:0"

    /** 读 instrumentation 参数 fixtureBaseUrl（am instrument -e 与 gradle -Pandroid.testInstrumentationRunnerArguments 同落此 Bundle）；null = 未接 fixture */
    fun fixtureBase(): String? = InstrumentationRegistry.getArguments().getString("fixtureBaseUrl")
      ?.trim()?.takeIf { it.isNotEmpty() && it != FIXTURE_BASE_NONE }

    /** CI required 模式开关（review#40 P2-5）：workflow 注入 ciRequired=1；缺省/其余值 = 本地手动档 */
    fun ciRequired(): Boolean = InstrumentationRegistry.getArguments().getString("ciRequired")
      ?.trim() == "1"

    /** 播放类用例门槛：未接 fixture 时——CI required 模式直接 fail（skip = 启动/端口传递协议退化），
        本地模式 Assume 跳过（AssumptionViolated = 跳过不算失败）；接了则返回非空 baseUrl */
    fun assumeFixture(): String {
      val base = fixtureBase()
      if (base == null) {
        if (ciRequired()) throw AssertionError(
          "CI required 模式：fixtureBaseUrl 未注入——fixture 启动/10.0.2.2 端口传递协议退化" +
          "（查 workflow 启动段是否 grep 到 FIXTURE_URL=），禁止以全 skip 假绿")
        Assume.assumeTrue("fixtureBaseUrl 未注入（缺省或哨兵 $FIXTURE_BASE_NONE），播放类 smoke 跳过", false)
      }
      return base!!
    }

    /** fixture 可达性 + 版本核对预检（review#40 P2-5 / r2 P2）：GET /__health 5s 超时，可达即解析 JSON
        的 version 字段与 [FIXTURE_VERSION] 对账——fixture 与 APK 同仓两处同步改，读到≠期望 = 协议漂移，
        两种模式都 fail（错版本 fixture 跑出的结果无意义，skip 只会掩盖漂移）；端口不通口径不变：
        ciRequired fail（比建流超时更早更明确的信号），本地模式 Assume 跳过（不开 fixture 的手动 dispatch 保持绿） */
    fun assumeFixtureReachable(base: String) {
      var served: String? = null // 非空 = /__health 有响应体（可达），值为设备侧读到的 version
      var detail = ""
      try {
        val c = URL(base + "/__health").openConnection() as HttpURLConnection
        c.connectTimeout = 5000; c.readTimeout = 5000
        val code = c.responseCode
        val body = if (code in 200..299) c.inputStream.bufferedReader().use { it.readText() } else null
        c.disconnect()
        if (body != null) served = try { JSONObject(body).optString("version", "(缺 version 字段)") }
          catch (t: Throwable) { "(JSON 不可解析:${t.message})" }
        else detail = "HTTP $code"
      } catch (t: Throwable) { detail = t.message ?: t.javaClass.simpleName }
      if (served != null) {
        if (served != FIXTURE_VERSION) throw AssertionError(
          "fixture 协议漂移：/__health 实际 version=$served，APK 侧期望 $FIXTURE_VERSION" +
          "（与 test/harness/android-fixture.js 的 FIXTURE_VERSION 两处同步改失配）——拒绝执行，先对齐两侧版本")
        return
      }
      val msg = "fixture 不可达（$base/__health，5s 超时${if (detail.isEmpty()) "" else "：$detail"}）" +
        "——模拟器 10.0.2.2 映射/宿主 fixture 进程异常"
      if (ciRequired()) throw AssertionError(msg)
      Assume.assumeTrue(msg, false)
    }

    /** fixture 版本/URL + 设备 API + APK 版本进 instrumentation 日志（L4 报告要求逐项在案；tag VRadioSmoke） */
    fun logFixtureEnv(tag: String) {
      val ctx = InstrumentationRegistry.getInstrumentation().targetContext
      val apk = runCatching {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName
      }.getOrDefault("?")
      Log.i(tag, "fixtureVersion=$FIXTURE_VERSION fixtureUrl=${fixtureBase() ?: "(未注入)"} " +
        "ciRequired=${if (ciRequired()) "1" else "0"} deviceApi=${Build.VERSION.SDK_INT} apkVersion=$apk")
    }
  }

  @Test
  fun launchesMainActivity() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      scenario.onActivity { activity -> assertTrue(activity.isFinishing.not()) }
    }
  }

  @Test
  fun sharedRadioAssetsAreParseable() {
    val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    // radio.txt 用生产解析器（RadioTxt.parse，app.js parse() 同款行协议）：至少一个分类、一台、台均有流地址
    val radio = ctx.assets.open("radio.txt").bufferedReader().use { it.readText() }
    val stations = RadioTxt.parse(radio)
    assertTrue("radio.txt 应解析出至少一台（生产解析器），实得 ${stations.size}", stations.isNotEmpty())
    assertTrue("radio.txt 应含至少两个分类", stations.map { it.c }.distinct().size >= 2)
    assertTrue("每台应有至少一个 http(s) 流地址", stations.all { it.u.isNotEmpty() && it.u[0].startsWith("http") })
    // logos.txt 行形态（「分类|台名,图片URL」两段式）：非空且行内含分隔符
    val logos = ctx.assets.open("logos.txt").bufferedReader().use { it.readText() }
    val logoLines = logos.split('\n').map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith('#') }
    assertTrue("logos.txt 应含至少一条数据行（允许首行 # 注释）", logoLines.isNotEmpty())
    assertTrue("logos.txt 行应含 '|' 与 ','（行协议形态）", logoLines.all { it.contains('|') && it.contains(',') })
    // radio-meta.json：契约形态（JSON 对象 + v 版本号 + generatedAt 时间戳）
    val meta = JSONObject(ctx.assets.open("radio-meta.json").bufferedReader().use { it.readText() })
    assertTrue("radio-meta.json 应带版本号 v", meta.has("v"))
    assertTrue("radio-meta.json 应带 generatedAt", meta.has("generatedAt"))
  }
}
