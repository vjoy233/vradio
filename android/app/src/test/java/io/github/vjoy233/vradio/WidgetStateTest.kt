package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.model.PState
import io.github.vjoy233.vradio.widget.WidgetState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/* Widget 纯逻辑（plan-expansion-r4 §9.3）：空台/连接中/播放中/暂停的展示文案、
   stepFav 边界（收藏为空）、快照序列化 round-trip、曲讯推送节流（≥5s）。 */
class WidgetStateTest {

  private val T0 = 1_000_000L

  @Test fun 空台展示() {
    val s = WidgetState()
    assertEquals("VRadio", WidgetState.title(s))
    assertEquals("未在播放，点此打开", WidgetState.line2(s))
    assertEquals("?", WidgetState.letter(s))   // 无名可取
  }

  @Test fun 连接中展示() {   // 建流 5-10s 属正常，必须给「连接中」反馈防误判卡死
    val s = WidgetState("蜻蜓音乐台", "", PState.CONNECTING)
    assertEquals("蜻蜓音乐台", WidgetState.title(s))
    assertEquals("连接中…", WidgetState.line2(s))
  }

  @Test fun 播放中展示() {
    assertEquals("♪ 歌名", WidgetState.line2(WidgetState("台", "歌名", PState.PLAYING)))
    assertEquals("直播中", WidgetState.line2(WidgetState("台", "", PState.PLAYING)))   // 无曲讯（HLS 结构性无 ICY）
  }

  @Test fun 暂停展示() {
    assertEquals("⏸ 歌名", WidgetState.line2(WidgetState("台", "歌名", PState.PAUSED)))
    assertEquals("已暂停", WidgetState.line2(WidgetState("台", "", PState.PAUSED)))
  }

  @Test fun 首字母剥国别后缀() {   // ui/Common.kt phParams 同款口径
    assertEquals("M", WidgetState.letter(WidgetState("Metro FM [英国]")))
    assertEquals("电", WidgetState.letter(WidgetState("电台一号")))
  }

  @Test fun stepFav边界与环形() {
    assertEquals(-1, WidgetState.stepIdx(0, 0, 1))            // 收藏为空：no-op 哨兵
    assertEquals(-1, WidgetState.stepIdx(-1, 0, -1))
    assertEquals(0, WidgetState.stepIdx(-1, 3, 1))            // 未在收藏内：正向进首台
    assertEquals(2, WidgetState.stepIdx(-1, 3, -1))           // 反向进末台
    assertEquals(1, WidgetState.stepIdx(0, 3, 1))             // 环形步进
    assertEquals(0, WidgetState.stepIdx(2, 3, 1))             // 末尾正向回卷
    assertEquals(2, WidgetState.stepIdx(0, 3, -1))            // 首位反向回卷（app.js stepFav 同款）
  }

  @Test fun 快照序列化roundTrip() {
    val s = WidgetState("华语音乐|电台", "歌名A", PState.PLAYING, T0, "华语音乐|电台")
    assertEquals(s, WidgetState.parse(s.toJson()))
    val idle = WidgetState()
    assertEquals(idle, WidgetState.parse(idle.toJson()))
    assertNull(WidgetState.parse(null))
    assertNull(WidgetState.parse("not json{"))
    assertNull(WidgetState.parse(""))
  }

  @Test fun 快照容错坏字段() {   // 旧/坏快照：未知状态回退 IDLE、缺 hk 得空串（渲染不炸）
    val p = WidgetState.parse("""{"n":"台","song":"s","st":"WHATEVER","at":5}""")
    assertEquals(PState.IDLE, p!!.st)
    assertEquals("", p.hueKey)
  }

  @Test fun 推送节流() {
    val base = WidgetState("台", "歌", PState.PLAYING, T0)
    assertTrue(WidgetState.shouldPush(null, base, T0))                       // 首推
    assertFalse(WidgetState.shouldPush(base, base.copy(at = T0 + 1000), T0 + 1000))   // 内容未变（ui 抖动吸收）
    // 纯曲讯变化：5s 内不推、≥5s 才推
    val song2 = base.copy(song = "新歌")
    assertFalse(WidgetState.shouldPush(base, song2, T0 + 4999))
    assertTrue(WidgetState.shouldPush(base, song2, T0 + 5000))
    // 结构性变化（台名/播放态）立即推
    assertTrue(WidgetState.shouldPush(base, base.copy(st = PState.PAUSED), T0 + 100))
    assertTrue(WidgetState.shouldPush(base, base.copy(name = "台2"), T0 + 100))
  }
}
