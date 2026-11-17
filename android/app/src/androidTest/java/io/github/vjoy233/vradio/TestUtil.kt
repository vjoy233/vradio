package io.github.vjoy233.vradio

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import io.github.vjoy233.vradio.data.Store
import io.github.vjoy233.vradio.player.PlayerHolder
import org.junit.rules.TestRule
import org.junit.runner.Description
import org.junit.runners.model.MultipleFailureException
import org.junit.runners.model.Statement
import java.io.File

/* 设备测试数据生命周期 guard（review#40 P1，方案 §3 纪律：写用户数据必须有快照、try/finally、异常恢复）。
   凡写真实应用数据的设备用例必须挂 @get:Rule = TestUtil.dataGuard()：
   · before：Store 内存快照 + filesDir 五数据文件字节级快照（store.json/my-radio.txt/quality.json/
     listen-stats.json/listen-stats.pending.json）+ SharedPreferences 键值快照（经 API 拿——直改 XML
     字节会被 SharedPreferencesImpl 内存缓存盖回）；
   · after（断言失败/异常也必走）：主线程可靠停播（PlayerHolder.stop 幂等，连接中/播放中/失败路径
     统一归位）→ 留出 volPersist 300ms 攒批窗口并排空主队列 → 磁盘字节级恢复（原不存在的文件删除
     ——测试可能新增）→ SharedPreferences 键值恢复（clear+重放，commit 同步落）→ Store.init 重载
     已恢复的 store.json → 主线程 PlayerHolder.reloadMems()（radio.srcmem2/volperst 的 fixture 键
     从播放器内存清掉）；磁盘恢复有异常时再以 Store 内存快照兜底（空库不回写，避免无 store.json
     设备留下空文件）。
   快照/测试/恢复三类失败收集后统一抛出（JUnit4 MultipleFailureException，互不吞）——清理失败
   记录在案，绝不静默吞；快照失败 = 隔离前提失效，直接报隔离失败、不跑本体也不做恢复（空快照
   restore 会 clear+重放空 SharedPreferences，属破坏面扩大，review#40-r2 P2）。
   ⚠「主动断言失败/建流超时演练确认归位」= 模拟器接入批次的验收项（本机无模拟器，不跑
   connectedTest，本批只验编译）；挂账见 docs/testing-strategy-2026-11.md §10 附录。 */
object TestUtil {

  /** app 私有数据文件清单（server.js HOST_FILES 的安卓面 + ListenStats pending；新增落盘文件须同步此处） */
  private val DATA_FILES = listOf(
    "store.json", "my-radio.txt", "quality.json", "listen-stats.json", "listen-stats.pending.json")

  private const val PENDING_VOL_MS = 400L // PlayerHolder volPersist 300ms 攒批窗口余量

  fun dataGuard(): TestRule = DataGuard()

  private class DataGuard : TestRule {
    private var files: Map<String, ByteArray?> = emptyMap()  // filesDir 字节快照（null = 原不存在）
    private var prefs: Map<String, Any?> = emptyMap()        // SharedPreferences 键值快照
    private var storeSnap: Map<String, String>? = null       // Store 内存快照（磁盘恢复异常时的兜底源）

    override fun apply(base: Statement, description: Description): Statement = object : Statement() {
      override fun evaluate() {
        val errs = ArrayList<Throwable>()
        var snapOk = false
        try { snapshot(); snapOk = true } catch (t: Throwable) { errs.add(t) }
        if (snapOk) { // 快照成功是本体 + 恢复的前提：快照失败 = 隔离前提失效（files/prefs 停留空 map，
          // restore 的 clear+重放只会把用户 prefs 清光、扩大破坏）——跳过本体直接报隔离失败（AIbot review#40-r2 P2）
          try { base.evaluate() } catch (t: Throwable) { errs.add(t) }
          try { restore() } catch (t: Throwable) { errs.add(t) }
        }
        MultipleFailureException.assertEmpty(errs) // 原测试失败与清理失败都上报，不互相掩盖
      }
    }

    private fun ctx(): Context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun snapshot() {
      storeSnap = Store.snapshot()
      val dir = ctx().filesDir
      files = DATA_FILES.associate { f -> f to File(dir, f).takeIf { it.isFile }?.readBytes() }
      prefs = LinkedHashMap(ctx().getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE).all)
    }

    private fun restore() {
      val instr = InstrumentationRegistry.getInstrumentation()
      val errs = ArrayList<Throwable>()
      // ① 主线程可靠停播（不留连接/通知态污染同进程后续用例；原成功路径的 stop 断言仍属被测行为）
      try {
        instr.runOnMainSync { PlayerHolder.stop() }
        Thread.sleep(PENDING_VOL_MS) // volPersist 300ms 攒批：让在飞落盘先发生，恢复磁盘才不被回写
        instr.runOnMainSync { }      // 排空主队列（含 sleep 窗口内到期的回调）
      } catch (t: Throwable) { errs.add(t) }
      // ② filesDir 字节级恢复（原不存在 = 测试新增 → 删除）
      val dir = ctx().filesDir
      for ((name, bytes) in files) try {
        val f = File(dir, name)
        if (bytes == null) { if (f.exists()) f.delete() }
        else { f.parentFile?.mkdirs(); f.writeBytes(bytes) }
      } catch (t: Throwable) { errs.add(t) }
      // ③ SharedPreferences 键值恢复（clear+重放；commit 同步落盘——@After 内 apply 异步不可靠）
      try {
        val sp = ctx().getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE)
        val e = sp.edit().clear()
        for ((k, v) in prefs) when (v) {
          is Boolean -> e.putBoolean(k, v)
          is String -> e.putString(k, v)
          is Int -> e.putInt(k, v)
          is Long -> e.putLong(k, v)
          is Float -> e.putFloat(k, v)
          is Set<*> -> @Suppress("UNCHECKED_CAST") e.putStringSet(k, v as Set<String>)
        }
        e.commit()
      } catch (t: Throwable) { errs.add(t) }
      // ④ 单例内存归位：Store 重载已恢复的 store.json → 播放器记忆（radio.srcmem2/volperst fixture 键）随行清
      try { Store.init(ctx().filesDir) } catch (t: Throwable) { errs.add(t) }
      try { instr.runOnMainSync { PlayerHolder.reloadMems() } } catch (t: Throwable) { errs.add(t) }
      // ⑤ 磁盘恢复有异常时内存兜底（快照非空才套用；与 §4 同一语义面，不留 fixture 数据在内存）
      val snap = storeSnap
      if (errs.isNotEmpty() && !snap.isNullOrEmpty()) try { Store.applyAllChecked(snap) } catch (t: Throwable) { errs.add(t) }
      MultipleFailureException.assertEmpty(errs) // 清理失败不静默吞
    }
  }
}
