package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.sync.HealthRecoveryV1Codec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HealthRecoveryV1CodecTest {
  private val h = "a".repeat(64)
  private val t = "b".repeat(64)
  private val id = "http://example.test/a"
  private fun sample() = HealthRecoveryV1Codec.Journal("123e4567-e89b-12d3-a456-426614174000", h, t, "PREPARED", listOf(HealthRecoveryV1Codec.Station(id, listOf(id))), emptyList())
  @Test fun roundTrip() { val j=sample(); val x=HealthRecoveryV1Codec.encode(j); assertEquals(j, HealthRecoveryV1Codec.decode(x)) }
  @Test fun rejectsTrailingDuplicateAndNonStandardNumber() {
    val x=HealthRecoveryV1Codec.encode(sample()); assertTrue(runCatching{HealthRecoveryV1Codec.decode(x+"x")}.isFailure)
    assertTrue(runCatching{HealthRecoveryV1Codec.decode("{\"v\":1,\"v\":1}")}.isFailure)
    assertTrue(runCatching{HealthRecoveryV1Codec.decode(x.replace("\"v\":1", "\"v\":01"))}.isFailure)
  }
  @Test fun rejectsDepthAndStationLimit() {
    val x=HealthRecoveryV1Codec.encode(sample()); assertTrue(x.isNotEmpty())
    var deep = "0"; repeat(33) { deep = "[$deep]" }
    assertTrue(runCatching { HealthRecoveryV1Codec.decode("{\"v\":1,\"batchId\":\"123e4567-e89b-12d3-a456-426614174000\",\"oldHash\":\"$h\",\"targetHash\":\"$t\",\"phase\":\"PREPARED\",\"stations\":$deep,\"completed\":[]}") }.isFailure)
    val many=(1..501).map { HealthRecoveryV1Codec.Station("http://e/$it", listOf("http://e/$it")) }
    assertTrue(runCatching{HealthRecoveryV1Codec.encode(sample().copy(stations=many))}.isFailure)
  }
}
