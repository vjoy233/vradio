package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.QualityStore
import io.github.vjoy233.vradio.data.qExplain
import io.github.vjoy233.vradio.discovery.Discovery
import io.github.vjoy233.vradio.discovery.DiscoveryInput
import io.github.vjoy233.vradio.discovery.qualityInfo
import io.github.vjoy233.vradio.model.Station
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class QualityConsistencyTest {
  @get:Rule val tmp = TemporaryFolder()
  @Test fun sharedStatusExplanationDiscovery() {
    val f = JSONObject(javaClass.classLoader!!.getResource("fixtures/quality-consistency.json")!!.readText())
    val now = f.getLong("now")
    val cases = f.getJSONArray("cases")
    val u = "https://example.test/live"
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val source = JSONObject().put("okCount", c.getInt("ok")).put("failCount", c.getInt("fail"))
        .put("lastOkAt", c.getLong("at")).put("modes", org.json.JSONArray().put("direct"))
      val disk = JSONObject().put("stations", JSONObject().put(u, JSONObject().put("cf", 0)
        .put("sources", JSONObject().put(u, source))))
      File(tmp.root, QualityStore.FILE).writeText(disk.toString())
      val store = QualityStore(tmp.root, clock = { now }); store.load()
      val q = store.summary(u, listOf(u))!!
      assertEquals(c.getString("name"), c.getString("stability"), q.stability)
      val e = qExplain(q, now)
      assertEquals(c.getString("name"), c.getString("reason"), e.reason)
      val s = Station("X", "x", mutableListOf(u))
      val info = qualityInfo(q, now)
      val groups = Discovery.build(DiscoveryInput(stations = listOf(s), quality = mapOf(u to info), now = now))
      assertEquals(c.getString("name"), if (e.level == "good") 1 else 0, groups.stableDirect.size)
    }
  }
}
