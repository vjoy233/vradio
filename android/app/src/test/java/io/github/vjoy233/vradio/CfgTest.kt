package io.github.vjoy233.vradio

import io.github.vjoy233.vradio.data.CfgCodec
import io.github.vjoy233.vradio.model.Cfg
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/* Cfg：坏形状回退空配置、srcs 封顶清洗、URL 键过滤、toJson 往返、count */
class CfgTest {

  @Test fun badShapesFallBackToEmpty() {
    assertEquals(Cfg(), CfgCodec.parse(null))
    assertEquals(Cfg(), CfgCodec.parse("不是json"))
    assertEquals(Cfg(), CfgCodec.parse("[1,2]")) // 数组 = 坏形状
    assertEquals(Cfg(), CfgCodec.parse("\"str\""))
    assertEquals(Cfg(), CfgCodec.parse("{}")) // 空对象 = 空配置
  }

  @Test fun urlKeyFilter() { // moves/names/tag 键须 http(s)；renames 任意键
    val c = CfgCodec.parse("{\"moves\":{\"http://a/1\":\"华语\",\"ftp://x\":\"坏\",\"\":\"坏2\"}," +
      "\"renames\":{\"华语音乐\":\"华语\"},\"tag\":{\"http://a/1\":\"原名\"}}")
    assertEquals(mapOf("http://a/1" to "华语"), c.moves)
    assertEquals(mapOf("华语音乐" to "华语"), c.renames)
    assertEquals(mapOf("http://a/1" to "原名"), c.tag)
  }

  @Test fun strMapValueRules() { // 值须非空字符串；trim；数字值丢弃
    val c = CfgCodec.parse("{\"names\":{\"http://a/1\":\" 新名 \",\"http://a/2\":\"\",\"http://a/3\":123}}")
    assertEquals(mapOf("http://a/1" to "新名"), c.names)
  }

  @Test fun hideMaps() { // hideS 键须 URL；hideC 键非空、值非 null/false
    val c = CfgCodec.parse("{\"hideS\":{\"http://a/1\":1,\"x://b\":1},\"hideC\":{\"分类甲\":1,\"\":1,\"分类乙\":false}}")
    assertEquals(mapOf("http://a/1" to true), c.hideS)
    assertEquals(mapOf("分类甲" to true), c.hideC)
  }

  @Test fun hideSKeyNoTrim() { // 审计 P3：hideS 键不 trim（app.js urlKeys 同判）——带空白尾巴的键原样保留成死键（永不命中台 URL），不清洗成活键跨端漂移
    val c = CfgCodec.parse("{\"hideS\":{\"http://a/1 \":1,\" http://a/2\":1,\"http://a/3\":1}}")
    assertEquals(mapOf("http://a/1 " to true, "http://a/3" to true), c.hideS)   // 前导空格键不匹配 ^http → 整键丢弃（Web 同）
  }

  @Test fun srcsCapAndClean() { // 键须 URL 且值为数组；元素 trim/512/http(s)、去重、取前 6；空数组整键丢弃
    val json = "{\"srcs\":{\"http://a/1\":[\" http://s/1 \",\"http://s/1\",\"ftp://坏\",\"http://s/2\",\"http://s/3\",\"http://s/4\",\"http://s/5\",\"http://s/6\",\"http://s/7\"]," +
      "\"http://b/1\":\"not-array\",\"坏键\":[\"http://x/1\"],\"http://c/1\":[]}}"
    val c = CfgCodec.parse(json)
    assertEquals(listOf("http://s/1", "http://s/2", "http://s/3", "http://s/4", "http://s/5", "http://s/6"), c.srcs["http://a/1"]) // 封顶 6 + 去重 + 坏元素滤除
    assertTrue(!c.srcs.containsKey("http://b/1")) // 非数组值丢弃
    assertTrue(!c.srcs.containsKey("坏键"))       // 非 URL 键丢弃
    assertTrue(!c.srcs.containsKey("http://c/1")) // 空数组整键丢弃
  }

  @Test fun catsDedupeAndPipeFilter() { // 去重/trim/空与带 | 丢弃；非字符串丢弃（Web 只滤空与 |，URL 样式分类名合法保留）
    val c = CfgCodec.parse("{\"cats\":[\" 自建A \",\"自建A\",\"带|分隔\",\"\",123,\"http://x\"]}")
    assertEquals(listOf("自建A", "http://x"), c.cats)
  }

  @Test fun toJsonRoundTrip() {
    val c = Cfg(
      moves = mapOf("http://a/1" to "华语"),
      names = mapOf("http://a/1" to "新名"),
      tag = mapOf("http://a/1" to "原名"),
      renames = mapOf("旧分类" to "新分类"),
      hideS = mapOf("http://b/1" to true),
      hideC = mapOf("隐藏分类" to true),
      srcs = mapOf("http://a/1" to listOf("http://s/1", "http://s/2")),
      cats = listOf("自建A"),
    )
    assertEquals(c, CfgCodec.parse(CfgCodec.toJson(c))) // 编解码往返无损
  }

  @Test fun countSumsAll() {
    val c = CfgCodec.parse("{\"moves\":{\"http://a/1\":\"x\"},\"names\":{\"http://a/2\":\"y\"},\"renames\":{\"A\":\"B\"},\"cats\":[\"C\"]}")
    assertEquals(4, CfgCodec.count(c)) // 1+1+1+1
  }
}
