package io.github.vjoy233.vradio

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.vjoy233.vradio.MainActivity
import io.github.vjoy233.vradio.data.RadioTxt
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Android 关键路径 Smoke 骨架。
 *
 * 本批接入三条确定性断言：Activity 启动、共享资产生产解析器可解析（AIbot P2：首字节存在性
 * 不构成「可解析」，一个字节的坏文件同样通过）、radio-meta.json 契约形态。
 * 仍未实现（逐批接入，勿把当前绿灯当成更强保证）：装配就绪（AppVm.boot 业务就绪的有界等待）、
 * 共享 fixture 版本核对、固定流播放、音频焦点、进程回收、Widget、备份导入。
 * 测试输入统一走本地 Node fixture，禁止依赖公网。
 */
@RunWith(AndroidJUnit4::class)
class AndroidSmokeTest {
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
