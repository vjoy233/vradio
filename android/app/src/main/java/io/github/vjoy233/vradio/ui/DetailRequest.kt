package io.github.vjoy233.vradio.ui

// 仅主线程访问；世代同时保护结果写入和旧请求的收尾。
internal class DetailRequestGate {
  private var generation = 0L
  fun invalidate(): Long = ++generation
  fun owns(token: Long): Boolean = token == generation
  fun valid(token: Long, shown: Boolean, key: String?, expectedKey: String, urls: List<String>?, expectedUrls: List<String>): Boolean =
    owns(token) && shown && key == expectedKey && urls == expectedUrls
}
