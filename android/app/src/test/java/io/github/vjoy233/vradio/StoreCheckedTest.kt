package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.Store
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
    try { assertFalse(Store.setChecked(C.K_VOL, "pre-init")) }
    finally { Store.resetForTest() }
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
