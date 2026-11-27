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
          assertEquals("30", Store.get(C.K_VOL)); assertArrayEquals(old, f.readBytes())
        } finally { AtomicWriteTestHook.tempCreate = null; AtomicWriteTestHook.tempWrite = null; AtomicWriteTestHook.rename = null }
      }
    } finally { d.deleteRecursively() }
  }

  @Test fun checkedAndOrdinaryWritesSerializeDeterministically() {
    val d=createTempDirectory("checked-gate").toFile(); try {
      Store.init(d); Store.set(C.K_VOL,"0")
      val start=CountDownLatch(1); val done=CountDownLatch(2)
      val a=Thread { start.await(); Store.setChecked(C.K_VOL,"checked"); done.countDown() }
      val b=Thread { start.await(); Store.set(C.K_VOL,"ordinary"); done.countDown() }
      a.start(); b.start(); start.countDown()
      assertTrue(done.await(5, TimeUnit.SECONDS))
      val v=Store.get(C.K_VOL); assertTrue(v=="checked" || v=="ordinary")
      Store.init(d); assertEquals(v, Store.get(C.K_VOL))
    } finally { d.deleteRecursively() }
  }
}
