package io.github.vjoy233.vradio

import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.Backup
import io.github.vjoy233.vradio.data.Store
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 备份导入 Smoke（P2，docs/testing-strategy-2026-11.md §3 L4 Smoke 矩阵「备份导入」行）：
 * 预览（[Backup.parseImport]）→ 确认 → 提交（[Backup.commitImport] 四步事务链，真实 Store 落盘 +
 * 快照恢复零残留）。走服务层入口（AppVm.applyConfirmed 的同一批构件），不依赖 UI。
 *
 * fixture 选内联 Kotlin 常量而非 assets/resources：contracts/ 只挂 JVM test sourceSet
 * （app/build.gradle.kts 的 test resources 接线），instrumentation APK 拿不到，assets 打包 task
 * 只拷 radio/logos 数据文件——故把黄金样本逐字内联，各常量标注来源为 contracts/fixtures 目录的
 * backup-v2.json / backup-v3.json；格式契约改动须两侧同步（AGENTS.md 契约节），
 * 漂移由 Web test/backup-v3.js 与 Android BackupV3Test 双端拦截。
 * 本类不依赖网络与 fixtureBaseUrl，离线可跑；不触碰 my-radio.txt/sidecar 真实个人文件
 * （真文件路径已由 JVM 层 BackupV3Test 覆盖）。
 */
@RunWith(AndroidJUnit4::class)
class BackupRestoreSmokeTest {

  /** 来源：contracts/fixtures/backup-v3.json（黄金样本，逐字内联；格式契约改动须两侧同步） */
  private val backupV3Json = """{
  "format": "vradio-backup",
  "version": 3,
  "createdAt": 1731500000000,
  "app": "web",
  "data": {
    "radio.favs": "[{\"k\":\"华语音乐|示例台\",\"u\":[\"https://main.example/live\"]}]",
    "radio.recents": "[{\"k\":\"华语音乐|示例台\",\"n\":\"示例台\",\"u\":[\"https://main.example/live\"]}]",
    "radio.health": "{}",
    "radio.cfg": "{\"v\":2,\"moves\":{},\"names\":{},\"tag\":{},\"renames\":{},\"hideS\":{},\"hideC\":{},\"srcs\":{},\"srcManualOrder\":{},\"srcDisabled\":{},\"srcLabels\":{},\"cats\":[]}",
    "radio.songs": "{}",
    "radio.volperst": "{}",
    "radio.srcmem2": "{}",
    "radio.vol": "90",
    "radio.view": "grid",
    "radio.showdead": "0",
    "radio.theme": "auto",
    "radio.baseline": "done",
    "radio.baselineProg": "[]"
  },
  "myRadio": ["自建,#genre#", "我的电台,https://example.test/live"],
  "extensions": {
    "sidecars": {
      "quality": {
        "v": 1,
        "data": {
          "https://main.example/live": {
            "cf": 2,
            "sources": {
              "https://main.example/live": {
                "okCount": 5,
                "failCount": 1,
                "lastOkAt": 1731490000000,
                "lastPlaybackAt": 1731499000000,
                "latSum": 8200,
                "latN": 5,
                "modes": ["direct"],
                "lastDiag": { "t": "manual", "ok": true, "at": 1731490000000, "lat": 1600 }
              }
            }
          }
        }
      },
      "listenStats": {
        "v": 1,
        "data": {
          "2026-11-13": {
            "ms": 3600000,
            "sessions": 2,
            "stations": { "https://main.example/live": 3600000 },
            "categories": { "华语音乐": 3600000 }
          },
          "2026-11-14": {
            "ms": 1800000,
            "sessions": 1,
            "stations": { "https://main.example/live": 1800000 },
            "categories": { "华语音乐": 1800000 }
          }
        }
      }
    }
  }
}"""

  /** 来源：contracts/fixtures/backup-v2.json（黄金样本，逐字内联；格式契约改动须两侧同步） */
  private val backupV2Json = """{
  "v": 2,
  "at": 1731500000000,
  "data": {
    "radio.favs": "[{\"k\":\"华语音乐|示例台\",\"u\":[\"https://main.example/live\"]}]",
    "radio.recents": "[{\"k\":\"华语音乐|示例台\",\"n\":\"示例台\",\"u\":[\"https://main.example/live\"]}]",
    "radio.health": "{\"https://dead.example/live\":{\"u\":[\"https://dead.example/live\"],\"t\":1731400000000,\"t0\":1731300000000,\"n\":2,\"perm\":0}}",
    "radio.cfg": "{\"v\":2,\"moves\":{},\"names\":{},\"tag\":{},\"renames\":{},\"hideS\":{},\"hideC\":{},\"srcs\":{},\"srcManualOrder\":{},\"srcDisabled\":{},\"srcLabels\":{},\"cats\":[]}",
    "radio.songs": "{\"https://main.example/live\":[{\"t\":\"示例歌 - 示例曲\",\"at\":1731490000000}]}",
    "radio.volperst": "{\"https://main.example/live\":80}",
    "radio.srcmem2": "{\"https://main.example/live\":{\"i\":0,\"t\":1731490000000}}",
    "radio.vol": "90",
    "radio.view": "grid",
    "radio.showdead": "0",
    "radio.theme": "auto",
    "radio.baseline": "done",
    "radio.baselineProg": "[]"
  },
  "my": ["自建,#genre#", "我的电台,https://example.test/live"]
}"""

  @Before
  fun logEnv() {
    AndroidSmokeTest.logFixtureEnv(TAG) // 环境在案（本类不用 fixture，也如实记「未注入」）
  }

  @Test
  fun v3PreviewAndCommitRealStore() {
    // —— 预览段（确认框的数据来源，AppVm.applyConfirmed 前置）：版本/白名单/个人台/双 sidecar ——
    val p = Backup.parseImport(backupV3Json)
    assertNotNull("v3 黄金样本应可解析", p)
    assertEquals(3, p!!.ver)
    assertEquals(13, p.data.size)
    for (k in p.data.keys) assertTrue("非白名单键 $k", C.KEYS.contains(k))
    assertEquals(listOf("自建,#genre#", "我的电台,https://example.test/live"), p.my)
    assertNotNull(p.quality)
    assertNotNull(p.listenStats)
    // —— 提交段：真实 Store 落盘（VRadioApp.onCreate 已 init 到 app filesDir），my/sidecar 传 no-op
    //      不动真实个人文件；提交后快照恢复零残留（smoke 不污染设备数据） ——
    val snap = Store.snapshot()
    val err = Backup.commitImport(p.data, null, p.quality, Backup.ImportIO(
      { Store.applyAllChecked(p.data) }, { Store.applyAllChecked(snap) },
      { true }, {},                                  // my==null 语义 = 不动 my-radio.txt
      { true }, { true }, { true }, { true }),        // 质量/收听统计 sidecar no-op（JVM 层 BackupV3Test 已真文件覆盖）
      p.listenStats)
    assertNull("提交段不应失败：$err", err)
    assertEquals("fixture 收藏快照应已落 Store（提交面）",
      p.data[C.K_FAVS], Store.get(C.K_FAVS))
    assertEquals("90", Store.get(C.K_VOL))
    assertTrue("导入后快照恢复", Store.applyAllChecked(snap))
    assertEquals("Store 应回到导入前快照", snap, Store.snapshot())
  }

  @Test
  fun v2PreviewAndV1Fallback() { // v2 读 my 数组；v1（无版本字段/无 my）回退预览
    val p2 = Backup.parseImport(backupV2Json)
    assertNotNull(p2)
    assertEquals(2, p2!!.ver)
    assertEquals(13, p2.data.size)
    assertEquals(listOf("自建,#genre#", "我的电台,https://example.test/live"), p2.my)
    assertNull(p2.quality)                       // v2 无 sidecar 段
    val p1 = Backup.parseImport("""{"v":1,"at":1731500000000,"data":{"radio.vol":"88"}}""")
    assertEquals(1, p1!!.ver)
    assertNull(p1.my)                            // v1 不带个人台字段 = 不动 my-radio.txt
    assertEquals("88", p1.data[C.K_VOL])
  }

  companion object {
    private const val TAG = "VRadioSmoke"
  }
}
