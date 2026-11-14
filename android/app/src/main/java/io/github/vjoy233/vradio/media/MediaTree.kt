package io.github.vjoy233.vradio.media

import io.github.vjoy233.vradio.model.Station
import java.util.Base64

/* 媒体树（B6，plan-expansion-r4 §10）——Android Auto/车机浏览面唯一数据形状，纯 JVM 可测：
   - 固定四层：root → favorites / recents / categories / custom（个人电台分类）→ 分类节点 → 台叶子。
   - mediaId 稳定口径：台叶子 = u:<Base64URL(u0 UTF-8，无 padding)>（URL=持久身份，不受分类/台名变化影响）；
     分类节点 c:<分类名>（categories 下）/ m:<分类名>（custom 下，前缀分开防同名撞 id）；固定节点 root/favorites/recents/categories/custom。
   - 解析后必须命中本地库（stationOf 查不到即 null——车机不接受任意 URL，§10 硬约束）。
   - 可见性口径 = Library.visible（app.js visible 同源）：手藏台/藏分类/死台默认不入树（正在播/连接中死台例外）。
   - 不在车机提供维护、导入、体检、源地址和复杂搜索（§10 边界，只有浏览与点播）。
   MediaItem 映射在 CarBrowse（android 面），本文件不 import android.*。 */

data class MNode(
  val id: String,          // 稳定 mediaId（见上）
  val title: String,       // 台名/节点名
  val sub: String = "",    // artist 行：叶子=分类；目录节点默认空
  val art: String = "",    // 台标 URL（有则填，无则空——由调用方注入 logoOf）
  val playable: Boolean = false,   // true=台叶子（isPlayable）；false=目录（isBrowsable）
  val uri: String = "",    // 叶子=流地址（u0；兜底直播放路径用，正常路径经 Fwd.carPlay 重定向决策链）
)

class MediaTree private constructor(
  private val vis: List<Station>,          // 可见台（过滤已在本类完成）
  private val favsKeys: List<String>,      // 收藏键序（radio.favs 序）
  private val recentsKeys: List<String>,   // 最近键序（队首最新）
  private val catsOrder: List<String>,     // 分类序（Library.cats()——已剔藏分类/空分类）
  private val myUrls: Set<String>,         // my-radio 全部 URL（个人台判定）
  private val logoOf: (Station) -> String,
) {
  companion object {
    const val ID_ROOT = "root"
    const val ID_FAVS = "favorites"
    const val ID_RECENTS = "recents"
    const val ID_CATS = "categories"
    const val ID_CUSTOM = "custom"
    private const val P_U = "u:"
    private const val P_C = "c:"
    private const val P_M = "m:"

    /** u0 → u:<base64url 无 padding>（+→-、/→_、去 =；URL-safe 编码进 mediaId 安全字符域） */
    fun encId(u0: String): String =
      P_U + Base64.getUrlEncoder().withoutPadding().encodeToString(u0.toByteArray(Charsets.UTF_8))

    /** mediaId → u0；非 u: 前缀/坏 base64 一律 null（车机输入不可信，容错解码） */
    fun decId(id: String): String? {
      if (!id.startsWith(P_U) || id.length == P_U.length) return null
      return runCatching { String(Base64.getUrlDecoder().decode(id.removePrefix(P_U)), Charsets.UTF_8) }.getOrNull()
    }

    /** 装配树。stations=全量装配后（隐藏/死台过滤在内部，口径=Library.visible）；logoOf=台标窥探（默认 STARTER.l） */
    fun of(
      stations: List<Station>,
      favsKeys: List<String>,
      recentsKeys: List<String>,
      catsOrder: List<String>,
      myUrls: Set<String>,
      hideCats: Set<String>,
      playingKey: String?,
      connectingKey: String?,
      logoOf: (Station) -> String = { it.l },
    ): MediaTree {
      val vis = stations.filter { s ->
        !s.hidden && !hideCats.contains(s.c) && // 手动隐藏/藏分类 = 彻底消失（无正在播例外，owner 拍板）
          (s.health != "dead" || s.key == playingKey || s.key == connectingKey) // 死台隐藏的正在播/连接中例外（自动标记独有豁免）
      }
      return MediaTree(vis, favsKeys, recentsKeys, catsOrder, myUrls, logoOf)
    }

    /** 分页切片：pageSize<=0 或 page<0 视为不分页（media3 语义：非法分页参数回退全量） */
    fun <T> pageOf(list: List<T>, page: Int, pageSize: Int): List<T> =
      if (pageSize <= 0 || page < 0) list else list.drop(page * pageSize).take(pageSize)
  }

  private val byKey = HashMap<String, Station>().apply { for (s in vis) put(s.key, s) }
  private val byU0 = HashMap<String, Station>().apply { for (s in vis) putIfAbsent(s.u0, s) }

  /** 指定父节点的子项（分页在 pageOf；未知/叶子 parentId 一律空列表） */
  fun children(parentId: String, page: Int, pageSize: Int): List<MNode> = pageOf(when (parentId) {
    ID_ROOT -> { // 固定导航锚点：favorites/recents/categories 恒在（空态由车机呈现），custom 仅个人台存在时出现
      val out = ArrayList<MNode>(4)
      out.add(dir(ID_FAVS, "★ 收藏"))
      out.add(dir(ID_RECENTS, "最近播放"))
      out.add(dir(ID_CATS, "分类"))
      if (customCats().isNotEmpty()) out.add(dir(ID_CUSTOM, "自定义电台"))
      out
    }
    ID_FAVS -> favsKeys.mapNotNull { byKey[it] }.map { leaf(it) }   // 休眠收藏（回绑失联）自然跳过
    ID_RECENTS -> recentsKeys.mapNotNull { byKey[it] }.map { leaf(it) }
    ID_CATS -> catNodes()
    ID_CUSTOM -> customCats().map { MNode(P_M + it, it, playable = false) }
    else -> {
      val c = catNameOf(parentId)
      if (c != null) stationsOf(c).map { leaf(it) } else emptyList()
    }
  }, page, pageSize)

  /** 按 mediaId 查节点（onGetItem）：目录节点须真实存在（空分类不出；c:/m: 前缀各归各的子树），叶子须在库内 */
  fun item(id: String): MNode? = when {
    id == ID_ROOT -> dir(ID_ROOT, "VRadio")
    id == ID_FAVS -> dir(ID_FAVS, "★ 收藏")
    id == ID_RECENTS -> dir(ID_RECENTS, "最近播放")
    id == ID_CATS -> dir(ID_CATS, "分类")
    id == ID_CUSTOM -> if (customCats().isNotEmpty()) dir(ID_CUSTOM, "自定义电台") else null
    id.startsWith(P_C) -> catNameOf(id)?.takeIf { it in catsOf(P_C) }?.let { MNode(id, it, playable = false) }
    id.startsWith(P_M) -> catNameOf(id)?.takeIf { it in customCats() }?.let { MNode(id, it, playable = false) }
    else -> stationOf(id)?.let { leaf(it) }
  }

  /** mediaId → 库内可见台（播放联动校验口：车机不接受任意 URL——解码后须命中本地库） */
  fun stationOf(id: String): Station? = decId(id)?.let { stationByU0(it) }

  fun stationByU0(u0: String): Station? = byU0[u0]

  /* —— 内部 —— */

  private fun catNameOf(id: String): String? = when {
    id.startsWith(P_C) -> id.removePrefix(P_C).takeIf { it.isNotEmpty() }
    id.startsWith(P_M) -> id.removePrefix(P_M).takeIf { it.isNotEmpty() }
    else -> null
  }

  private fun stationsOf(c: String): List<Station> = vis.filter { it.c == c }

  /** categories 子节点：空分类不出现（§10 拍板），顺序 = catsOrder（华语/欧美置顶随 Library.cats()） */
  private fun catNodes(): List<MNode> = catsOf(P_C).map { MNode(P_C + it, it, playable = false) }

  /** P_C 前缀子树收录的分类（非空；个人分类归 custom 子树，c:/m: 不重叠） */
  private fun catsOf(prefix: String): List<String> {
    val custom = if (prefix == P_C) customCats().toSet() else emptySet()
    return catsOrder.filter { it !in custom && stationsOf(it).isNotEmpty() }
  }

  /** 个人电台分类：该分类下可见台全部来自 my-radio（按 URL 身份）。混合分类（个人台 + 库台共存，
   *  如添加电台时选了标准分类）仍归 categories——个人台照样可从该分类找到，宁重复归类不丢台不藏标准分类。 */
  private fun customCats(): List<String> =
    catsOrder.filter { c -> val ss = stationsOf(c); ss.isNotEmpty() && ss.all { s -> s.u.any { it in myUrls } } }

  private fun leaf(s: Station) = MNode(encId(s.u0), s.n, s.c, logoOf(s).orEmpty(), playable = true, uri = s.u0)

  private fun dir(id: String, title: String) = MNode(id, title)
}
