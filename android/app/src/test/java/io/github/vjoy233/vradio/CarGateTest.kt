package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.media.CarGate
import io.github.vjoy233.vradio.media.MediaTree
import io.github.vjoy233.vradio.model.Station
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/* 车机点播安全门（B6 AIbot P1）：会话是 exported=true 的跨进程入口，外部 MediaController 提交的
   四类形态（任意 URI / 合法编码但库外 u: / 坏 base64 / 混合列表）一律拒绝——门拒绝 = onAddMediaItems
   回 failed future（media3 1.11.1 保证 player 侧任务不执行：播放器收不到任何 mediaItem、不建流）、
   Fwd.carPlay 返回 false 不透传。放行仅剩「合法 u: id 且命中本地库」一条路；应用内部 variant 装载
   直走 exo（不经会话门），回归不受影响。 */
class CarGateTest {

  private val a = Station("华语音乐", "台A", mutableListOf("http://a.example/1.mp3", "http://a2.example/1.mp3"))
  private val b = Station("新闻资讯", "台B", mutableListOf("http://b.example/live"))
  private val lib = mapOf("http://a.example/1.mp3" to a, "http://b.example/live" to b)
  private val lookup: (String) -> Station? = { lib[it] }
  private val unwired: (String) -> Station? = { null } // 解析器未接线面（onCarStation=null / 库未就绪）

  @Test fun 任意URI形态拒绝() { // 把流地址直接当 mediaId 提交（playFromUri 类客户端形态）
    assertNull(CarGate.resolve("http://evil.example/stream.mp3", lookup))
    assertNull(CarGate.resolve("https://evil.example/x.m3u8", lookup))
    assertNull(CarGate.resolve("rtsp://evil.example/live", lookup))
    assertNull(CarGate.resolve("file:///data/local/tmp/x.mp3", lookup))
    assertNull(CarGate.resolve("", lookup))                       // 空 id（MediaItem 默认 mediaId）
    assertNull(CarGate.resolve(null, lookup))                     // 无 item
    assertNull(CarGate.resolve("favorites", lookup))              // 目录节点 id 不可播
    assertNull(CarGate.resolve("u:http://evil.example/live", lookup)) // u: 前缀 + 原文 URL（: 不在 base64url 字母表）
  }

  @Test fun 合法编码但库外拒绝() { // u:<Base64URL> 格式合法、解码成功，但不在本地库（§10 硬约束）
    assertNull(CarGate.resolve(MediaTree.encId("http://evil.example/任意流"), lookup))
    assertNull(CarGate.resolve(MediaTree.encId("http://a.example/1.mp3/变体"), lookup)) // 库内台的变体 URL 也不行
  }

  @Test fun 坏base64拒绝() {
    assertNull(CarGate.resolve("u:***bad***", lookup))   // 非法字符
    assertNull(CarGate.resolve("u:aGVs\nbG8", lookup))   // 换行注入
    assertNull(CarGate.resolve("u:", lookup))            // 空载荷
    assertNull(CarGate.resolve("u:a=b=c", lookup))       // 带标准字母表 padding/非法符
  }

  @Test fun 混合列表整批拒绝() { // fail-closed：混入任一非法项即整批 null，不部分放行（防夹带）
    val good = MediaTree.encId(a.u0)
    assertNull(CarGate.resolveAll(listOf(good, "http://evil.example/x"), lookup))          // 混任意 URI
    assertNull(CarGate.resolveAll(listOf(good, MediaTree.encId("http://evil.example/x")), lookup)) // 混库外 u:
    assertNull(CarGate.resolveAll(listOf(good, null), lookup))                             // 混空项
    assertNull(CarGate.resolveAll(listOf(good, ""), lookup))                               // 混空 id
  }

  @Test fun 解析器未接线拒绝() { // onCarStation 未注入（App 兜底未装/库未就绪）视同库外：不放行
    assertNull(CarGate.resolve(MediaTree.encId(a.u0), unwired))
    assertNull(CarGate.resolveAll(listOf(MediaTree.encId(a.u0), MediaTree.encId(b.u0)), unwired))
  }

  @Test fun 库内命中放行_身份键口径() { // 唯一放行路：合法 u: id 命中 u0（备选源不算身份，MediaTree 同口径）
    assertSame(a, CarGate.resolve(MediaTree.encId("http://a.example/1.mp3"), lookup))
    assertSame(b, CarGate.resolve(MediaTree.encId(b.u0), lookup))
    assertNull(CarGate.resolve(MediaTree.encId("http://a2.example/1.mp3"), lookup)) // 备选源 ≠ 身份键
    val all = CarGate.resolveAll(listOf(MediaTree.encId(a.u0), MediaTree.encId(b.u0)), lookup)
    assertEquals(listOf(a, b), all)  // 放行序保序（onAddMediaItems 按位取 u0 改写 URI，消费此不变量）
    assertEquals(emptyList<Station>(), CarGate.resolveAll(emptyList(), lookup)) // 空批=空操作不拒
  }
}
