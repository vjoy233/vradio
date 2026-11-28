package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.Library
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.player.PlaybackLifecycle
import io.github.vjoy233.vradio.ui.BootArbitration
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory

/** 只组合真实纯组件，不模拟 AppVm/播放器，也不证明 UI 提示或设备冷启动。 */
class StartupSelectionComponentsTest {
  private lateinit var dir: File
  @Before fun setup() { dir = createTempDirectory("startup-selection").toFile(); Store.init(dir) }
  @After fun teardown() { dir.deleteRecursively() }

  @Test fun explicitInputsAreChosenBeforeRecentResolutionEvenWhenShortcutMissing() {
    Store.set("radio.recents", """[{"k":"分类|最近","n":"最近","u":["http://recent/1"]}]""")
    val lib = Library(Store, dir, "分类,#genre#\n最近,http://recent/1", "")
    lib.reload()
    assertNotNull(lib.resolveRecent(lib.recents.first()))
    val missing = "分类|已消失"
    assertNull(lib.stations.firstOrNull { it.key == missing })
    // 缺失快捷方式仍进入 SHORTCUT 分支；是否回退及提示由 AppVm 决定，非此处可验证。
    assertEquals(BootArbitration.Action.SHORTCUT, BootArbitration.decide(missing, true))
    assertEquals(BootArbitration.Action.PRESET, BootArbitration.decide(null, true))
    assertEquals(BootArbitration.Action.RESUME, BootArbitration.decide(null, false))
  }

  @Test fun exhaustedGenerationRejectsInFlightRecentSelection() {
    val lifecycle = PlaybackLifecycle<String, Any>()
    val playback = Any()
    lifecycle.selectionGeneration++
    lifecycle.station = "old"; lifecycle.pctx = playback; lifecycle.token = 7
    val bootToken = lifecycle.selectionGeneration
    assertEquals(BootArbitration.Action.RESUME, BootArbitration.decide(null, false))
    assertTrue(lifecycle.exhaustIfNeeded(playback, 7, 1, 1))
    assertNull(lifecycle.station)
    assertFalse(lifecycle.selectIfEmpty("old", bootToken))
    assertNull(lifecycle.station)
  }

  @Test fun unresolvedRecentDoesNotBindSameNameDifferentUrl() {
    Store.set("radio.recents", """[{"k":"分类|同名","n":"同名","u":["http://gone/1"]}]""")
    val lib = Library(Store, dir, "分类,#genre#\n同名,http://replacement/1", "")
    lib.reload()
    assertEquals(BootArbitration.Action.RESUME, BootArbitration.decide(null, false))
    assertNull(lib.resolveRecent(lib.recents.first()))
    // AppVm 的状态文案属于 Android 编排层，不在此 fixture 的验证范围内。
  }
}
