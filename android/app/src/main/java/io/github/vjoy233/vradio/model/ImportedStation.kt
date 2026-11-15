package io.github.vjoy233.vradio.model

/** 歌单导入条目（r4/B4）：Web playlist-import.js 的条目形态同构（双端契约，黄金样本 contracts/fixtures/playlist-*）。
 *  五格式（pls|xspf|asx|m3u|url）统一收敛到本形态；URL = 身份键（文件内按 URL 去重）。
 *  logo/externalId 目前仅供预览与未来扩展——my-radio.txt 行格式（分类/台名/地址）是两侧冻结契约，无此列，入库不落盘。 */
data class ImportedStation(
  val name: String,                 // 台名（清洗后：去换行/首尾空白，截 40 字；缺标题回退 URL host）
  val category: String,             // 分类（默认「自定义」；m3u group-title / #genre# 节可覆盖，截 24 字去分隔符）
  val url: String,                  // 流地址（只收 http(s)；XSPF/ASX 相对地址按 baseUrl 解析）
  val logo: String = "",            // XSPF <image>
  val externalId: String = "",      // XSPF <identifier>
  val sourceFormat: String = "",    // pls|xspf|asx|m3u|url（识别结果随行，预览展示用）
)
