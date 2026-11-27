package io.github.vjoy233.vradio.sync

import org.json.JSONObject

/** 偏好不包含资产事实；时间均为 UTC epoch 毫秒。 */
object Freshness {
  const val DAY = 86400000L
  const val COOLDOWN = 60000L
  data class Pref(val reminderDays: Int = 14, val disabled: Boolean = false,
                  val dismissedUntil: Long = 0, val lastPromptAt: Long = 0) {
    fun json(): String = JSONObject().put("reminderDays", reminderDays).put("disabled", disabled)
      .put("dismissedUntil", dismissedUntil).put("lastPromptAt", lastPromptAt).toString()
  }
  data class State(val age: String, val prompt: Boolean)
  data class Fact(val version: String, val refreshedAt: Long, val provenance: String)
  fun fact(dir: java.io.File): Fact? = runCatching {
    val stamp = JSONObject(java.io.File(dir, "stamp.json").readText())
    val provenance = stamp.optString("freshnessProvenance")
    val at = stamp.optLong("freshnessAt", 0)
    val radio = java.io.File(dir, "radio.txt").readText()
    if (provenance != "device-full-sync" || at <= 0 || stamp.optString("radioHash") != hashText(radio)) null
    else Fact(stamp.optString("commitIso"), at, provenance)
  }.getOrNull()
  fun parse(raw: String?): Pref {
    val o = if (raw == null || raw.length > 1024) null else runCatching { JSONObject(raw) }.getOrNull()
    fun time(key: String): Long {
      val n = o?.opt(key) as? Number ?: return 0
      val d = n.toDouble()
      return if (d > 0 && d <= 9007199254740991.0 && d % 1.0 == 0.0) d.toLong() else 0
    }
    val d = o?.opt("reminderDays") as? Number
    val days = d?.toDouble()?.takeIf { it == 7.0 || it == 14.0 || it == 30.0 }?.toInt() ?: 14
    return Pref(days, o?.opt("disabled") == true, time("dismissedUntil"), time("lastPromptAt"))
  }
  fun state(p: Pref, refreshedAt: Long?, provenance: String?, now: Long): State {
    val known = refreshedAt != null && refreshedAt > 0 && refreshedAt <= now && !provenance.isNullOrEmpty()
    val age = if (!known) "unknown" else if (now - refreshedAt!! >= p.reminderDays * DAY) "due" else "fresh"
    val dismissed = p.dismissedUntil > now && p.dismissedUntil - now <= DAY
    val cooling = p.lastPromptAt > 0 && p.lastPromptAt <= now && now - p.lastPromptAt < COOLDOWN
    return State(age, !p.disabled && !dismissed && !cooling && age != "fresh")
  }
}
