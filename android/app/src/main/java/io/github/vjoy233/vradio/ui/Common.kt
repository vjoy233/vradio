package io.github.vjoy233.vradio.ui

/* UI 公共件：台标图（okhttp→BitmapFactory→LruCache 手写小工具，契约：40-200px 小图量级不引 Coil）、
   自绘播放/暂停图标（白名单无图标库，一律 Canvas/文字字形）、徽标、分段按钮、确认弹窗、
   首字母色块参数（logos.js phd 同款 hash 色相——同一台永远同色）。 */

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.ColorUtils
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/* ---------- 台标图加载（remember(url) + LaunchedEffect，坏图/无图回退首字母色块） ---------- */

private val logoClient = OkHttpClient.Builder()
  .connectTimeout(6, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).build()
private val logoCache = object : LruCache<String, Bitmap>(96) {
  override fun sizeOf(key: String, value: Bitmap) = 1   // 按张数封顶（小图，96 张内存可控）
}
private val logoFail = HashSet<String>()   // 会话级坏图负缓存（G P3：LazyColumn 滚出再滚入不重拉坏 URL；logos.js 坏图 onerror 一次性语义）

private fun fetchLogo(url: String): Bitmap? = runCatching {
  logoClient.newCall(Request.Builder().url(url).build()).execute().use { r ->
    if (!r.isSuccessful) return@use null
    val b = r.body?.bytes() ?: return@use null
    if (b.isEmpty() || b.size > (2 shl 20)) null        // 2MB 防护（台标都是小图，超大即坏响应）
    else BitmapFactory.decodeByteArray(b, 0, b.size)
  }
}.getOrNull()

/** 台标：URL 空/坏图一律回退首字母色块（有图无图节奏统一，logos.js visual 同款）；
 *  key=分类|台名（首字母色块色相的 hash 输入，phParams 见下） */
@Composable
fun StationLogo(url: String, name: String, key: String, size: Dp, modifier: Modifier = Modifier) {
  var bmp by remember(url) { mutableStateOf(logoCache.get(url)) }
  LaunchedEffect(url) {
    if (url.isNotEmpty() && bmp == null && url !in logoFail) {
      val b = withContext(Dispatchers.IO) { fetchLogo(url) }
      if (b != null) { logoCache.put(url, b); bmp = b } else logoFail.add(url)
    }
  }
  val pal = LocalVrPalette.current
  val shape = RoundedCornerShape(if (size >= 32.dp) 10.dp else 4.dp)
  Box(modifier.size(size).clip(shape).background(pal.panel).border(1.dp, pal.line, shape), contentAlignment = Alignment.Center) {
    val b = bmp
    if (b != null) Image(b.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    else {
      val (ch, hue) = phParams(key, name)
      Box(Modifier.fillMaxSize().background(hsl(hue, .42f, .44f)), contentAlignment = Alignment.Center) {
        Text(ch, color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * .42f).sp)
      }
    }
  }
}

/* 首字母色块参数：首字符取剥 [国别] 后缀的台名；色相 hash 输入 = key（分类|台名全名，含后缀）——
   logos.js phd 对 s.c+'|'+s.n 同款（G P3：两端同台同色相），同一台永远同色 */
fun phParams(key: String, name: String): Pair<String, Int> {
  val n = name.replace(Regex("""\s*\[[^\]]+\]\s*$"""), "")
  var h = 0
  for (c in key) h = h * 31 + c.code
  return (n.trim().firstOrNull()?.toString() ?: "?").uppercase() to ((h % 360) + 360) % 360
}
fun hsl(h: Int, s: Float, l: Float): Color = Color(ColorUtils.HSLToColor(floatArrayOf(h.toFloat(), s, l)))

/* 台名剥离「[国别]」后缀（app.js render 的信息降噪 P2-1：国别进 meta 不进主名） */
private val CM_RE = Regex("""\s*\[([^\]]+)\]\s*$""")
fun displayParts(n: String): Pair<String, String?> {
  val m = CM_RE.find(n) ?: return n to null
  return n.removeRange(m.range) to m.groupValues[1]
}

/* ---------- 自绘图标（无图标库依赖） ---------- */

@Composable
fun PlayIcon(tint: Color, modifier: Modifier = Modifier) = Canvas(modifier) {
  val w = size.width; val h = size.height
  drawPath(Path().apply {
    moveTo(w * .30f, h * .18f); lineTo(w * .84f, h * .50f); lineTo(w * .30f, h * .82f); close()
  }, tint)
}

@Composable
fun PauseIcon(tint: Color, modifier: Modifier = Modifier) = Canvas(modifier) {
  val w = size.width; val h = size.height
  drawRoundRect(tint, topLeft = Offset(w * .28f, h * .20f), size = Size(w * .16f, h * .60f), cornerRadius = CornerRadius(3f, 3f))
  drawRoundRect(tint, topLeft = Offset(w * .56f, h * .20f), size = Size(w * .16f, h * .60f), cornerRadius = CornerRadius(3f, 3f))
}

/** 连接中脉冲点（蜻蜓建流 5-10s 属正常，要有连接中反馈） */
@Composable
fun PulseDot(color: Color, modifier: Modifier = Modifier) {
  val a by rememberInfiniteTransition(label = "dot").animateFloat(
    1f, .25f, infiniteRepeatable(tween(600, easing = LinearEasing), RepeatMode.Reverse), label = "alpha",
  )
  Canvas(modifier) { drawCircle(color.copy(alpha = a)) }
}

/* ---------- 小部件 ---------- */

/** 徽标：kind 0=普通（dim）1=accent（正在用）2=warn（已停运） */
@Composable
fun VrBadge(text: String, kind: Int = 0, modifier: Modifier = Modifier) {
  val pal = LocalVrPalette.current
  val fg = if (kind == 1) pal.acc else if (kind == 2) pal.warn else pal.dim
  val bd = if (kind == 1) pal.acc else if (kind == 2) pal.warn else pal.line
  Text(text, fontSize = 11.sp, color = fg, maxLines = 1,
    modifier = modifier.clip(RoundedCornerShape(4.dp)).border(1.dp, bd, RoundedCornerShape(4.dp))
      .padding(horizontal = 5.dp, vertical = 1.dp))
}

/** 分段按钮（网格/列表视图切换、无效源开关等）；modifier 在前使尾 lambda 落到 onClick */
@Composable
fun SegBtn(text: String, on: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
  val pal = LocalVrPalette.current
  Text(text, fontSize = 13.sp, color = if (on) pal.acc else pal.dim,
    modifier = modifier.clip(RoundedCornerShape(8.dp))
      .border(1.dp, if (on) pal.acc else pal.line, RoundedCornerShape(8.dp))
      .clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 7.dp))
}

/** 确认弹窗（导入覆盖/清空类确认门槛用） */
@Composable
fun ConfirmDialog(title: String, msg: String, okText: String = "继续", onOk: () -> Unit, onDismiss: () -> Unit) {
  AlertDialog(onDismissRequest = onDismiss,
    title = { Text(title) }, text = { Text(msg) },
    confirmButton = { TextButton(onClick = onOk) { Text(okText) } },
    dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}

/** 睡眠定时倒计时格式 m:ss */
fun fmtLeft(ms: Long): String {
  val s = (ms + 999) / 1000
  return "${s / 60}:${if (s % 60 < 10) "0" else ""}${s % 60}"
}
