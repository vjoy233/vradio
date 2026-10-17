package io.github.vjoy233.vradio.sync

import io.github.vjoy233.vradio.consts.C
import io.github.vjoy233.vradio.data.HttpText
import org.json.JSONArray

/* GitHub 客户端（D7 轻更新与 M4 端内同步共用，update-sources.js ghFile 语义）。
   HttpText 用 data/Logos.kt 的契约接口（收口：删了并行期的同签名双生版）。
   语义：2xx 返回 UTF-8 文本，超时/非 2xx/畸形 URL → null 不抛（异常一律不出网络层，UI 据此明示）。 */

class Gh(private val http: HttpText) {

  companion object {
    internal const val API = "https://api.github.com"   // 直连，不引 raw.githubusercontent.com（JS ghFile 同款）
  }

  /** 取仓库文件原文：contents API + Accept vnd.github.raw + 4MB 封顶 + body>100 校验（update-sources.js:146-157）。
   *  与 JS 差异：端上无 gh CLI 回退（JS 失败回退 gh api --jq），失败即 null 由 UI 明示 toast。 */
  suspend fun file(repo: String, path: String): String? =
    http.get("$API/repos/$repo/contents/$path", C.GH_TIMEOUT_MS, C.GH_MAX_BYTES.toLong(),
      mapOf("Accept" to "application/vnd.github.raw"))
      ?.takeIf { it.length > 100 }   // 限流/404 的短错误页一律按失败处理（JS body>100 同款闸）

  /** 路径最近一次提交时刻（ISO8601，D7 判新旧用）：/commits?path=…&per_page=1 → commit.committer.date。 */
  suspend fun lastCommitIso(repo: String, path: String): String? {
    val t = http.get("$API/repos/$repo/commits?path=$path&per_page=1",
      C.GH_TIMEOUT_MS, 1L shl 20, mapOf("Accept" to "application/vnd.github+json")) ?: return null
    val arr = try { JSONArray(t) } catch (_: Exception) { return null }
    return arr.optJSONObject(0)?.optJSONObject("commit")?.optJSONObject("committer")
      ?.optString("date", "")?.takeIf { it.isNotEmpty() }
  }
}

/** 同步上下游与自身仓库（CONTRACTS 冻结名）。 */
object GhRepos {
  const val SELF = "vjoy233/vradio"            // D7 轻更新：仓库根成品 radio.txt/logos.txt
  const val CN_UP = "gaotianliuyun/gao"        // 国内直播源上游
  const val EU_UP = "AlonDrilich/radio-playlists"   // Radio Browser 数据镜像
}
