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
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Android 关键路径 Smoke 骨架（启动 + 共享资产 + 本地固定流 fixture 接入协议）。
 *
 * 已接入确定性断言：Activity 启动、共享资产生产解析器可解析（AIbot P2：首字节存在性
 * 不构成「可解析」，一个字节的坏文件同样通过）、radio-meta.json 契约形态。
 * 仍未实现（逐批接入，勿把当前绿灯当成更强保证）：装配就绪（AppVm.boot 业务就绪的有界等待）、
 * 共享 fixture 版本核对、音频焦点、进程回收、Widget、备份导入。
 * 测试输入统一走本地 Node fixture，禁止依赖公网。
 * fixtureBaseUrl 注入协议（docs/testing-strategy-2026-11.md §3 L4）：宿主起
 * test/harness/android-fixture.js（监听 0.0.0.0 随机端口）→ workflow 把 127.0.0.1 换算 10.0.2.2 →
 * gradle -Pandroid.testInstrumentationRunnerArguments.fixtureBaseUrl= 注入 instrumentation；
 * 未注入（或哨兵值）时播放类用例经 [assumeFixture] Assume 跳过——没接 fixture 的手动 dispatch 骨架仍绿。
 * 测试输入统一走本地 Node fixture，禁止依赖公网；音频焦点/进程回收/Widget 属发布前设备层，不在本批。
>>>>>>> 49f44ff (test(android): P2 instrumented smoke 扩展——fixtureBaseUrl 注入协议 + 播放/备份导入用例 + workflow 接 fixture（草案，不进 PR 硬门）)
 */
@RunWith(AndroidJUnit4::class)
class AndroidSmokeTest {

  companion object {
    /** fixture 版本：与 test/harness/android-fixture.js 的 FIXTURE_VERSION 两处同步改（报告须记录在案） */
    const val FIXTURE_VERSION = "v1"

    /** 未传参约定缺省值：端口 0 不存在 → 播放类用例一律 skip */
    const val FIXTURE_BASE_NONE = "http://10.0.2.2:0"

    /** 读 instrumentation 参数 fixtureBaseUrl（am instrument -e 与 gradle -Pandroid.testInstrumentationRunnerArguments 同落此 Bundle）；null = 未接 fixture */
    fun fixtureBase(): String? = InstrumentationRegistry.getArguments().getString("fixtureBaseUrl")
      ?.trim()?.takeIf { it.isNotEmpty() && it != FIXTURE_BASE_NONE }

    /** 播放类用例门槛：未接 fixture 即 Assume 跳过（AssumptionViolated = 跳过不算失败）；接了则返回非空 baseUrl */
    fun assumeFixture(): String {
      val base = fixtureBase()
      Assume.assumeTrue("fixtureBaseUrl 未注入（缺省或哨兵 $FIXTURE_BASE_NONE），播放类 smoke 跳过", base != null)
      return base!!
    }

    /** fixture 版本/URL + 设备 API + APK 版本进 instrumentation 日志（L4 报告要求逐项在案；tag VRadioSmoke） */
    fun logFixtureEnv(tag: String) {
      val ctx = InstrumentationRegistry.getInstrumentation().targetContext
      val apk = runCatching {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName
      }.getOrDefault("?")
      Log.i(tag, "fixtureVersion=$FIXTURE_VERSION fixtureUrl=${fixtureBase() ?: "(未注入)"} " +
        "deviceApi=${Build.VERSION.SDK_INT} apkVersion=$apk")
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
    val logoLines = logos.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
    assertTrue("logos.txt 应非空", logoLines.isNotEmpty())
    assertTrue("logos.txt 行应含 '|' 与 ','（行协议形态）", logoLines.all { it.contains('|') && it.contains(',') })
    // radio-meta.json：契约形态（JSON 对象 + v 版本号 + generatedAt 时间戳）
    val meta = JSONObject(ctx.assets.open("radio-meta.json").bufferedReader().use { it.readText() })
    assertTrue("radio-meta.json 应带版本号 v", meta.has("v"))
    assertTrue("radio-meta.json 应带 generatedAt", meta.has("generatedAt"))
  }
}
