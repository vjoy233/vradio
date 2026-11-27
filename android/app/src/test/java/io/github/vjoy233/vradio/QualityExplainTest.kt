package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.QualityExplanation
import io.github.vjoy233.vradio.data.QualityStore
import io.github.vjoy233.vradio.data.diagnosticAction
import io.github.vjoy233.vradio.data.qExplain
import io.github.vjoy233.vradio.ui.codeBadge
import io.github.vjoy233.vradio.ui.diagnosticSuggestion
import io.github.vjoy233.vradio.ui.qualityReasonText
import io.github.vjoy233.vradio.ui.suggestionText
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test

class QualityExplainTest {
  private fun expected(o: JSONObject) = QualityExplanation(o.getString("level"), o.getString("action"), o.getString("reason"))
  private fun aggregate(o: JSONObject) = QualityStore.QualityAggregate(
    "", 0, 0, o.getInt("okCount"), o.getInt("failCount"), 0, 0, 0,
    o.getLong("lastObservedAt"), 0, 0, "none", o.getString("stability"))

  @Test fun 双端共享黄金样本() {
    val text = javaClass.classLoader!!.getResource("fixtures/quality-explain.json")!!.readText()
    val fixture = JSONObject(text)
    val explain = fixture.getJSONArray("explain")
    for (i in 0 until explain.length()) {
      val row = explain.getJSONObject(i)
      val summary = row.optJSONObject("summary")?.let(::aggregate)
      assertEquals("explain[$i]", expected(row.getJSONObject("expected")), qExplain(summary, row.getLong("now")))
    }
    val diagnostic = fixture.getJSONArray("diagnostic")
    for (i in 0 until diagnostic.length()) {
      val row = diagnostic.getJSONObject(i)
      assertEquals("diagnostic[$i]", expected(row.getJSONObject("expected")),
        diagnosticAction(row.getString("code"), row.getInt("httpStatus")))
    }
  }

  @Test fun 界面消费机器建议与过期状态() {
    assertTrue(suggestionText(diagnosticAction("HTTP", 401)).contains("配置"))
    assertTrue(suggestionText(diagnosticAction("HTTP", 403)).contains("拒绝"))
    assertEquals("建议检查源地址", suggestionText(diagnosticAction("HTML", 200)))
    assertEquals("建议稍后重试", suggestionText(diagnosticAction("NETWORK", 0)))
    assertEquals("建议重新检测", suggestionText(diagnosticAction("new_code", 0)))
    assertEquals("观察已过期", qualityReasonText("stale"))
    assertEquals("暂无样本", qualityReasonText(qExplain(null, 1).reason))
  }

  @Test fun 字节通过但服务拒绝时不显示可用() {
    for (status in listOf(401, 403)) {
      assertEquals("字节检测通过" to 0, codeBadge("OK", status))
      assertTrue(diagnosticSuggestion("OK", status).contains("配置"))
      assertTrue(diagnosticSuggestion("HTTP", status).contains("拒绝"))
    }
    assertEquals("✓ 可用" to 1, codeBadge("OK", 200))
    assertEquals("无需操作", diagnosticSuggestion("OK", 200))
    assertEquals("HTTP 500" to 2, codeBadge("HTTP", 500))
  }

  @Test fun 未知稳定性与状态优先级() {
    val base = JSONObject("""{"okCount":3,"failCount":0,"lastObservedAt":1,"stability":"future"}""")
    assertEquals(QualityExplanation("unknown", "retest", "unknown_stability"), qExplain(aggregate(base), 2))
    assertEquals(QualityExplanation("unknown", "configure", "service_refused"), diagnosticAction("OK", 403))
  }
}
