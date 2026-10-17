package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.Store
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.After
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory

/* Store：白名单 round-trip / 缺键 remove / 坏 JSON 容错 / 重启（重新 init）数据仍在 */
class StoreTest {
  private lateinit var dir: File

  @Before fun setup() { dir = createTempDirectory("vradio-store").toFile(); Store.init(dir) }
  @After fun teardown() { dir.deleteRecursively() }

  @Test fun roundTrip() {
    Store.set(C.K_FAVS, "[{\"k\":\"华语音乐|台A\"}]")
    Store.set(C.K_THEME, "dark")
    assertEquals("[{\"k\":\"华语音乐|台A\"}]", Store.get(C.K_FAVS))
    assertEquals("dark", Store.get(C.K_THEME))
    assertTrue(File(dir, "store.json").exists()) // set 即落盘（tmp+rename）
    assertFalse(File(dir, "store.json.tmp").exists()) // 临时文件已改名收走
  }

  @Test fun restartPersists() { // 模拟进程重启：重新 init（换目录重载）后数据仍在
    Store.set(C.K_SONGS, "{\"http://a/1\":[{\"t\":\"歌\",\"at\":1}]}")
    Store.set(C.K_VOL, "90")
    Store.init(dir)
    assertEquals("{\"http://a/1\":[{\"t\":\"歌\",\"at\":1}]}", Store.get(C.K_SONGS))
    assertEquals("90", Store.get(C.K_VOL))
    Store.remove(C.K_VOL)
    Store.init(dir)
    assertNull(Store.get(C.K_VOL))
  }

  @Test fun snapshotFiltersWhitelist() { // 白名单内且存在的键；白名单外键不进快照
    Store.set(C.K_VIEW, "grid")
    Store.set("radio.junk", "x")
    val s = Store.snapshot()
    assertEquals("grid", s[C.K_VIEW])
    assertFalse(s.containsKey("radio.junk"))
  }

  @Test fun badJsonTolerated() { // 坏 store.json 视为空库，随后读写照常
    File(dir, "store.json").writeText("{{{not json")
    Store.init(dir)
    assertNull(Store.get(C.K_FAVS))
    Store.set(C.K_FAVS, "[]")
    assertEquals("[]", Store.get(C.K_FAVS))
    Store.init(dir)
    assertEquals("[]", Store.get(C.K_FAVS)) // 修复后可正常回读
  }

  @Test fun applyAllRemovesMissingKeys() { // 导入语义：白名单键有值写入/缺键 remove；白名单外键忽略
    Store.set(C.K_FAVS, "[\"x\"]")
    Store.set(C.K_THEME, "dark")
    Store.applyAll(mapOf(C.K_THEME to "light", "radio.junk" to "y"))
    assertEquals("light", Store.get(C.K_THEME))
    assertNull(Store.get(C.K_FAVS)) // 缺键被 remove
    assertNull(Store.get("radio.junk"))
    Store.init(dir)
    assertNull(Store.get(C.K_FAVS)) // remove 已落盘
  }
}
