package io.github.vjoy233.vradio.timeshift

import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.ByteArrayDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.io.IOException

/* 流字节旁路 DataSource（B7 Spike）：包住 OkHttpDataSource——
   - 直播 URI：字节原样透传给上层（IcyDataSource 的 ICY 剥离在本层之上，见 IcyStripper 注释，
     返回值动一个字节普通播放就坏）；同时旁路副本经 Timeshift.feedCapture（内含 IcyStripper
     清洗）进环形缓冲。开关关闭/范围外（HLS 等）时 feedCapture 自身空转，纯透传零行为变化。
   - 回放 URI（Timeshift.REPLAY_URL）：改喂内存快照（一次性消费；重开失败走 IOException →
     PlayerHolder 既有 error 级联自愈回直播）。 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
class TsDataSource(private val upstream: DataSource) : DataSource {

  private var url = ""
  private var replay: ByteArrayDataSource? = null

  override fun addTransferListener(transferListener: TransferListener) {
    upstream.addTransferListener(transferListener)
  }

  override fun open(dataSpec: DataSpec): Long {
    url = dataSpec.uri.toString()
    if (url == Timeshift.REPLAY_URL) {
      val bytes = Timeshift.takeSnapshot() ?: throw IOException("timeshift snapshot missing")
      replay = ByteArrayDataSource(bytes)
      return replay!!.open(dataSpec)
    }
    val n = upstream.open(dataSpec)
    Timeshift.onOpen(url, icyMetaintOf(upstream.responseHeaders))
    return n
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    replay?.let { return it.read(buffer, offset, length) }
    val n = upstream.read(buffer, offset, length)
    if (n > 0) Timeshift.feedCapture(url, buffer, offset, n)   // 旁路副本；read 返回值不受影响
    return n
  }

  override fun getUri() = replay?.uri ?: upstream.uri

  override fun getResponseHeaders(): Map<String, List<String>> =
    replay?.responseHeaders ?: upstream.responseHeaders

  override fun close() {
    runCatching { replay?.close() }
    runCatching { upstream.close() }
    replay = null; url = ""
  }

  private fun icyMetaintOf(h: Map<String, List<String>>): Int {
    for ((k, v) in h) if (k.equals("icy-metaint", ignoreCase = true)) {
      return v.firstOrNull()?.trim()?.toIntOrNull() ?: 0
    }
    return 0
  }
}
