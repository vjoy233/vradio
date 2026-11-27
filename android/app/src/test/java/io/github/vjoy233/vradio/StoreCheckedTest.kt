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
  @Test fun applyAllCheckedFailureRestoresFullMemorySnapshot() {
    val d = createTempDirectory("checked-all").toFile()
    try {
      Store.init(d); Store.set(C.K_VOL, "30"); Store.set(C.K_THEME, "dark")
      val oldDisk = File(d, "store.json").readBytes()
      AtomicWriteTestHook.rename = { _, _ -> false }
      assertFalse(Store.applyAllChecked(mapOf(C.K_VOL to "90")))
      assertEquals("30", Store.get(C.K_VOL)); assertEquals("dark", Store.get(C.K_THEME))
      assertArrayEquals(oldDisk, File(d, "store.json").readBytes())
    } finally { AtomicWriteTestHook.rename = null; d.deleteRecursively() }
  }
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

  @Test fun applyAllCheckedFailsClosedBeforeInit() {
    val d = createTempDirectory("checked-all-uninit").toFile()
    val fileField = Store::class.java.getDeclaredField("file").apply { isAccessible = true }
    val memField = Store::class.java.getDeclaredField("mem").apply { isAccessible = true }
    try {
      synchronized(Store) {
        val oldFile = fileField.get(Store)
        @Suppress("UNCHECKED_CAST") val mem = memField.get(Store) as MutableMap<String, String>
        val oldMem = HashMap(mem)
        try {
          Store.init(d); Store.set(C.K_VOL, "old")
          val oldDisk = File(d, "store.json").readBytes()
          fileField.set(Store, null)
          assertFalse(Store.applyAllChecked(mapOf(C.K_VOL to "new")))
          assertEquals("old", Store.get(C.K_VOL))
          assertArrayEquals(oldDisk, File(d, "store.json").readBytes())
        } finally {
          fileField.set(Store, oldFile); mem.clear(); mem.putAll(oldMem)
        }
      }
    } finally { d.deleteRecursively() }
  }

  @Test fun checkedFailsClosedBeforeInit() {
    val d = createTempDirectory("checked-uninit").toFile()
    val fileField = Store::class.java.getDeclaredField("file").apply { isAccessible = true }
    val memField = Store::class.java.getDeclaredField("mem").apply { isAccessible = true }
    try {
      synchronized(Store) {
        val oldFile = fileField.get(Store)
        @Suppress("UNCHECKED_CAST") val mem = memField.get(Store) as MutableMap<String, String>
        val oldMem = HashMap(mem)
        try {
          Store.init(d); Store.set(C.K_VOL, "old")
          fileField.set(Store, null)
          assertFalse(Store.setChecked(C.K_VOL, "new")); assertFalse(Store.removeChecked(C.K_VOL))
          assertEquals("old", Store.get(C.K_VOL))
        } finally { fileField.set(Store, oldFile); mem.clear(); mem.putAll(oldMem) }
      }
    } finally { d.deleteRecursively() }
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

  @Test fun exhaustedVersionDoesNotMutateMemoryOrDisk() {
    val d = createTempDirectory("store-exhausted").toFile()
    val field = Store::class.java.getDeclaredField("version").apply { isAccessible = true }
    try {
      Store.init(d); Store.set(C.K_VOL, "old")
      val disk = File(d, "store.json").readBytes()
      synchronized(Store) {
        val previous = field.getLong(Store)
        try {
          field.setLong(Store, Long.MAX_VALUE)
          val snap = Store.snapshotVersioned()
          val other = File(d, "other")
          Store.init(other)
          assertFalse(other.exists()); assertEquals("old", Store.get(C.K_VOL))
          Store.set(C.K_VOL, "new"); Store.remove(C.K_VOL)
          assertFalse(Store.setChecked(C.K_VOL, "new")); assertFalse(Store.removeChecked(C.K_VOL))
          Store.applyAll(mapOf(C.K_VOL to "new")); assertFalse(Store.applyAllChecked(mapOf(C.K_VOL to "new")))
          assertEquals(Store.ApplyOutcome.WRITE_FAILED, Store.applyAllCheckedIfVersion(mapOf(C.K_VOL to "new"), snap.version).outcome)
          assertFalse(Store.restoreIfVersion(mapOf(C.K_VOL to "new"), snap.version))
          assertEquals("old", Store.get(C.K_VOL)); assertArrayEquals(disk, File(d, "store.json").readBytes())
        } finally { field.setLong(Store, previous) }
      }
    } finally { d.deleteRecursively() }
  }

  @Test fun casRestoreRejectsConcurrentWrite() {
    val d = createTempDirectory("cas-race").toFile()
    try {
      Store.init(d); Store.set(C.K_VOL, "old")
      val snap = Store.snapshotVersioned()
      assertTrue(Store.applyAllChecked(mapOf(C.K_VOL to "imported")))
      Store.set(C.K_THEME, "light")
      assertFalse(Store.restoreIfVersion(snap.data, snap.version + 1))
      assertEquals("imported", Store.get(C.K_VOL)); assertEquals("light", Store.get(C.K_THEME))
    } finally { d.deleteRecursively() }
  }
}
