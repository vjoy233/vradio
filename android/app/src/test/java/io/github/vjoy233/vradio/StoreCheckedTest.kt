package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.data.AtomicWriteTestHook
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.io.path.createTempDirectory

class StoreCheckedTest {
  @Test fun setCheckedFailureRestoresOldMemory() {
    val d=createTempDirectory("checked").toFile(); try {
      Store.init(d); Store.set(C.K_VOL,"30")
      val f=File(d,"store.json"); f.delete(); f.mkdir()
      assertFalse(Store.setChecked(C.K_VOL,"90")); assertEquals("30",Store.get(C.K_VOL))
    } finally { d.deleteRecursively() }
  }
  @Test fun removeCheckedFailureRestoresOldMemory() {
    val d=createTempDirectory("checked-rm").toFile(); try {
      Store.init(d); Store.set(C.K_VOL,"30")
      val f=File(d,"store.json"); f.delete(); f.mkdir()
      assertFalse(Store.removeChecked(C.K_VOL)); assertEquals("30",Store.get(C.K_VOL))
    } finally { d.deleteRecursively() }
  }

  @Test fun checkedFailsClosedBeforeInit() {
    Store.resetForTest()
    try { assertFalse(Store.setChecked(C.K_VOL, "pre-init")); assertFalse(Store.removeChecked(C.K_VOL)) }
    finally { Store.resetForTest() }
  }

  @Test fun checkedFailurePreservesOldDiskAtEveryAtomicStage() {
    val d = createTempDirectory("checked-stages").toFile()
    try {
      Store.init(d); Store.set(C.K_VOL, "30")
      val f = File(d, "store.json"); val old = f.readBytes()
      for (stage in listOf("create", "write", "rename")) {
        try {
          when (stage) {
            "create" -> AtomicWriteTestHook.tempCreate = { throw java.io.IOException("create") }
            "write" -> AtomicWriteTestHook.tempWrite = { tmp, _ -> tmp.writeText("partial"); throw java.io.IOException("write") }
            else -> AtomicWriteTestHook.rename = { _, _ -> false }
          }
          assertFalse(stage, Store.setChecked(C.K_VOL, "90"))
          assertFalse(stage, Store.removeChecked(C.K_VOL))
          assertFalse(stage, Store.setChecked(C.K_THEME, "dark"))
          assertEquals("30", Store.get(C.K_VOL)); assertNull(Store.get(C.K_THEME)); assertArrayEquals(old, f.readBytes())
        } finally { AtomicWriteTestHook.tempCreate = null; AtomicWriteTestHook.tempWrite = null; AtomicWriteTestHook.rename = null }
      }
    } finally { d.deleteRecursively() }
  }

  @Test fun checkedSuccessSurvivesReload() {
    val d = createTempDirectory("checked-success").toFile()
    try {
      Store.init(d); assertTrue(Store.setChecked(C.K_VOL, "90")); Store.init(d)
      assertEquals("90", Store.get(C.K_VOL)); assertTrue(Store.removeChecked(C.K_VOL)); Store.init(d)
      assertNull(Store.get(C.K_VOL)); assertTrue(Store.removeChecked(C.K_VOL))
    } finally { d.deleteRecursively() }
  }

  @Test fun failedCheckedWriteSerializesCompetingOrdinaryWrite() {
    val d = createTempDirectory("checked-gate").toFile()
    val entered = CountDownLatch(1); val release = CountDownLatch(1)
    val started = CountDownLatch(1); val done = CountDownLatch(1)
    var result: Boolean? = null
    var a: Thread? = null; var b: Thread? = null
    try {
      Store.init(d); Store.set(C.K_VOL, "old")
      val old = File(d, "store.json").readBytes()
      AtomicWriteTestHook.tempWrite = { tmp, _ ->
        tmp.writeText("partial"); entered.countDown()
        check(release.await(5, TimeUnit.SECONDS)); throw java.io.IOException("injected")
      }
      a = Thread { result = Store.setChecked(C.K_VOL, "checked") }; a.start()
      assertTrue(entered.await(5, TimeUnit.SECONDS))
      b = Thread { started.countDown(); Store.set(C.K_THEME, "dark"); done.countDown() }; b.start()
      assertTrue(started.await(5, TimeUnit.SECONDS))
      assertFalse(done.await(100, TimeUnit.MILLISECONDS))
      assertArrayEquals(old, File(d, "store.json").readBytes())
      AtomicWriteTestHook.tempWrite = null
      release.countDown(); a.join(5000); b.join(5000)
      assertFalse(a.isAlive); assertFalse(b.isAlive); assertEquals(false, result)
      assertEquals("old", Store.get(C.K_VOL)); assertEquals("dark", Store.get(C.K_THEME))
      Store.init(d); assertEquals("old", Store.get(C.K_VOL)); assertEquals("dark", Store.get(C.K_THEME))
    } finally {
      release.countDown(); a?.join(5000); b?.join(5000)
      AtomicWriteTestHook.tempCreate = null; AtomicWriteTestHook.tempWrite = null; AtomicWriteTestHook.rename = null
      d.deleteRecursively()
    }
  }
}
