package io.github.vjoy233.vradio.timeshift

import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.io.IOException

/* TsDataSource 的路由决策核心（纯 JVM——AIbot 非阻塞建议的伪 DataSource 测试面）：
   回放 = open 时从控制器取走一次性快照（重复 open 无快照 → false → IOException 走既有 error 自愈）；
   直播 = open 上报 icy-metaint、read 旁路副本进环（返回值不动）。TsDataSource 仅剩 media3 适配。 */
internal class TsRoute(private val ctl: TsController) {

  var url = ""; private set
  var isReplay = false; private set
  var replayLen = 0; private set
  private var snap: ByteArray? = null
  private var pos = 0

  /** 回放 open：取走一次性快照；false=快照已丢（重复回退未重新武装/切台已清）。 */
  fun openReplay(u: String): Boolean {
    url = u; isReplay = true
    val s = ctl.takeSnapshot()
    snap = s; pos = 0; replayLen = s?.size ?: 0
    return s != null
  }

  /** 直播 open：上报响应头 icy-metaint（每条连接各绑一份剥离器）。 */
  fun openLive(u: String, metaint: Int) { url = u; isReplay = false; ctl.onOpen(u, metaint) }

  /** 直播读旁路：n>0 才喂（TsDataSource.read 返回值原样透传不动字节）。 */
  fun onLiveRead(buf: ByteArray, off: Int, n: Int) { if (n > 0) ctl.feedCapture(url, buf, off, n) }

  /** 回放读：读尽返回 -1（DataSource 惯例）。 */
  fun replayRead(buf: ByteArray, off: Int, len: Int): Int {
    val s = snap ?: return -1
    if (pos >= s.size) return -1
    val n = minOf(len, s.size - pos)
    System.arraycopy(s, pos, buf, off, n); pos += n
    return n
  }

  /** close：清路由态，下一次 open 重新判定（直播/回放形态互斥切换的复位点）。 */
  fun close() { url = ""; isReplay = false; snap = null; pos = 0; replayLen = 0 }
}

/* 流字节旁路 DataSource（B7 Spike）：包住 okhttp DataSource——
   - 直播 URI：字节原样透传给上层（IcyDataSource 的 ICY 剥离在本层之上，见 IcyStripper 注释，
     返回值动一个字节普通播放就坏）；同时旁路副本经 TsRoute.onLiveRead → feedCapture（内含
     IcyStripper 清洗）进环形缓冲。开关关闭/范围外（HLS 等）时 feedCapture 自身空转，纯透传零行为变化。
   - 回放 URI（TsController.REPLAY_URL）：改喂内存快照（一次性消费；重开失败走 IOException →
     PlayerHolder 既有 error 级联自愈回直播）。 */
@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
class TsDataSource(private val upstream: DataSource) : DataSource {

  private val route = TsRoute(Timeshift.ctl)
  private var spec: DataSpec? = null   // getUri 用（回放形态 upstream 未开、uri 须回占位 URI）

  override fun addTransferListener(transferListener: TransferListener) {
    upstream.addTransferListener(transferListener)
  }

  override fun open(dataSpec: DataSpec): Long {
    spec = dataSpec
    val url = dataSpec.uri.toString()
    if (url == TsController.REPLAY_URL) {
      if (!route.openReplay(url)) throw IOException("timeshift snapshot missing")
      return route.replayLen.toLong()
    }
    val n = upstream.open(dataSpec)
    route.openLive(url, icyMetaintOf(upstream.responseHeaders))
    return n
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
    if (route.isReplay) route.replayRead(buffer, offset, length)
    else upstream.read(buffer, offset, length).also { if (it > 0) route.onLiveRead(buffer, offset, it) }

  override fun getUri() = if (route.isReplay) spec?.uri else upstream.uri

  override fun getResponseHeaders(): Map<String, List<String>> =
    if (route.isReplay) emptyMap() else upstream.responseHeaders

  override fun close() {
    route.close()
    runCatching { upstream.close() }   // 回放形态 upstream 未开过：close 幂等安全
  }

  private fun icyMetaintOf(h: Map<String, List<String>>): Int {
    for ((k, v) in h) if (k.equals("icy-metaint", ignoreCase = true)) {
      return v.firstOrNull()?.trim()?.toIntOrNull() ?: 0
    }
    return 0
  }
}
