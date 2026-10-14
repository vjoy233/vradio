package io.github.vjoy233.vradio.data

import io.github.vjoy233.vradio.model.Station

/* 内置精选（app.js:6-21 逐条照抄，14 台）：地址已实测直连可用（含同一电台多备选源）；
   l = 台标（蜻蜓频道页封面实测可直连）。装配时按「精确台名」与主列表去重后并入（见 Library.applySources）。 */
val STARTER: List<Station> = listOf(
  Station("常听", "Love Radio FM103.7 经典金曲", mutableListOf("http://lhttp.qingting.fm/live/273/64k.mp3", "http://ls.qingting.fm/live/273.m3u8"), "http://pic.qtfm.cn/2014/0909/20140909125130474.jpg!200"),
  Station("常听", "动感101 FM101.7", mutableListOf("http://lhttp.qingting.fm/live/274/64k.mp3", "http://live.xmcdn.com/live/53/64.m3u8"), "http://pic.qtfm.cn/2014/0909/20140909123511693.jpg!200"),
  Station("常听", "经典947 FM94.7", mutableListOf("http://lhttp.qingting.fm/live/267/64k.mp3"), "http://pic.qtfm.cn/sso/48/1641437907698_k0NNOUP54.jpeg!200"),
  Station("常听", "上海东广新闻台", mutableListOf("http://lhttp.qingting.fm/live/275/64k.mp3"), "http://pic.qtfm.cn/sso/198/1606449636209_K8-0Zavn2.png!200"),
  Station("常听", "上海交通台 FM105.7", mutableListOf("http://lhttp.qingting.fm/live/266/64k.mp3", "http://ls.qingting.fm/live/266.m3u8"), "http://pic.qtfm.cn/sso/48/1641437453117_JxQnTn1vv.jpeg!200"),
  Station("常听", "CNR 中国之声", mutableListOf("http://ngcdn001.cnr.cn/live/zgzs/index.m3u8")),
  Station("常听", "CNR 音乐之声", mutableListOf("http://ngcdn003.cnr.cn/live/yyzs/index.m3u8")),
  Station("常听", "CRI 环球资讯广播 FM90.5", mutableListOf("http://sk.cri.cn/905.m3u8")),
  Station("常听", "CRI 怀旧金曲频道", mutableListOf("https://lhttp.qingting.fm/live/5022038/64k.mp3"), "http://pic.qtfm.cn/2024/0726/20240726111933.png!200"),
  Station("常听", "Asia FM 亚洲经典台", mutableListOf("https://lhttp.qingting.fm/live/5021912/64k.mp3"), "http://pic.qtfm.cn/2022/0712/20220712122112.jpeg!200"),
  Station("亚洲·港台", "YES 933 (新加坡)", mutableListOf("http://playerservices.streamtheworld.com/api/livestream-redirect/YES933AAC.aac")),
  Station("亚洲·港台", "Class 95 (新加坡)", mutableListOf("http://playerservices.streamtheworld.com/api/livestream-redirect/CLASS95AAC.aac")),
  Station("亚洲·港台", "Listen.Moe JPop", mutableListOf("https://listen.moe/stream")),
  Station("欧美音乐", "Nightwave Plaza", mutableListOf("http://radio.plaza.one/opus")),
)
