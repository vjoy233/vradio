package io.github.vjoy233.vradio.media

import io.github.vjoy233.vradio.model.Station

/* 车机点播安全门（B6 AIbot P1 修复）：MediaSession 是 exported=true 的跨进程入口，外部 MediaController
   提交的 mediaId/URI 一律不可信——本门是会话侧 set/add/replace media item 的唯一放行判据：
   - 放行 = mediaId 为 u:<Base64URL(u0)> 且解码后命中本地库（§10 硬约束：车机不接受任意 URL）；
   - 拒绝 = 非 u: 形态（含把流地址直接当 id 的 playFromUri 类提交）、坏 base64、合法编码但库外、
     解析器未接线——fail-closed，绝无「解析失败透传底层裸播」的兜底（按 id 前缀/URI 形态放行均可被
     伪造，AIbot P1）；混合列表任一项被拒即整批拒绝（不部分放行，防夹带）。
   应用内部 variant 装载不经此门：PlayerHolder 直走 exo.setMediaItem（不经会话转发壳 Fwd），即
   「不经 session 转发的直通路径」，外部无从伪造、无需内部标记。纯 JVM 可测（不 import android.*）。 */
object CarGate {

  /** 单项解析：mediaId → 库内台；null=拒绝（lookup 未接线视同库外） */
  fun resolve(id: String?, lookup: (String) -> Station?): Station? {
    val u0 = if (id != null) MediaTree.decId(id) else null
    return u0?.let(lookup)
  }

  /** 整批解析（onAddMediaItems 口径）：任一项拒绝即 null（fail-closed 整批拒）；空批=空放行（空操作） */
  fun resolveAll(ids: List<String?>, lookup: (String) -> Station?): List<Station>? {
    if (ids.isEmpty()) return emptyList()
    val out = ArrayList<Station>(ids.size)
    for (id in ids) out.add(resolve(id, lookup) ?: return null)
    return out
  }
}
