package io.github.vjoy233.vradio.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import io.github.vjoy233.vradio.FeatureFlags
import io.github.vjoy233.vradio.ui.theme.LocalVrPalette
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/* 顶层导航（P0，docs/ui-android-redesign-plan-2026-11.md §3/§6）：
   电台/发现/收藏 三目的地；设置与添加电台是次级页不占顶层（Q2/Q19）。
   发现关（FeatureFlags.DISCOVERY=false）时隐藏目的地并回退电台，不保留空位（Q14）。
   手机（<600dp）底栏、平板/横屏（>=600dp）左 rail；断点与守卫/返回裁决拆纯函数供 JVM 直测（§8.1）。 */

/** 顶层目的地；SETTINGS/ADD_STATION 走 SecondaryRoute 次级页，不是顶层 */
enum class Destination(val title: String) {
  LIBRARY("电台"), DISCOVER("发现"), FAVORITES("收藏"),
}

/** 次级页路由：从更多菜单进入；期间显式切目的地经 navigate() 自动收次级页——返回=当前未改变的目的地（Q11/Q15，review#45 二轮：secondaryFrom 已删） */
enum class SecondaryRoute { SETTINGS, ADD_STATION }

/** 窗口档位：600dp 断点（Q7），手写双形态不引 adaptive 依赖 */
enum class VrWindow { COMPACT, EXPANDED }

// ---- 纯函数（NavigationStateTest / WindowClassTest 直测，§8.1）----

/** 断点口径：>=600dp 展开（rail），其余紧凑（底栏） */
fun windowClassOf(screenWidthDp: Int): VrWindow =
  if (screenWidthDp >= 600) VrWindow.EXPANDED else VrWindow.COMPACT

/** 可见目的地：发现关闭时只剩电台/收藏，不保留空位（Q14） */
fun navDestinations(): List<Destination> =
  if (FeatureFlags.DISCOVERY) Destination.entries.toList()
  else Destination.entries.filter { it != Destination.DISCOVER }

/** 目的地守卫（§6.1 navigate）：发现关时去发现 = 回退电台 */
fun navigateGuard(to: Destination): Destination =
  if (to == Destination.DISCOVER && !FeatureFlags.DISCOVERY) Destination.LIBRARY else to

/** 返回裁决纯函数：次级页开着 → 回当前顶层目的地（即来源页；确认弹窗/sheet 浮层在 root BackHandler 里先序消费，§Q21）；无次级页 → null 不消费 */
fun backTarget(secondary: SecondaryRoute?, destination: Destination): Destination? =
  if (secondary != null) destination else null

@Composable
fun rememberVrWindow(): VrWindow {
  val cfg = LocalConfiguration.current
  return remember(cfg) { windowClassOf(cfg.screenWidthDp) }
}

// ---- 导航形态（§6.3：三枚图标自绘 Canvas，不引图标库）----

@Composable
fun VrBottomNav(selected: Destination, onNavigate: (Destination) -> Unit) {
  NavigationBar {
    navDestinations().forEach { d ->
      NavigationBarItem(
        selected = selected == d,
        onClick = { onNavigate(d) },
        icon = { DestinationIcon(d, selected == d) },
        label = { Text(d.title) },
      )
    }
  }
}

@Composable
fun VrNavigationRail(selected: Destination, onNavigate: (Destination) -> Unit) {
  NavigationRail {
    navDestinations().forEach { d ->
      NavigationRailItem(
        selected = selected == d,
        onClick = { onNavigate(d) },
        icon = { DestinationIcon(d, selected == d) },
        label = { Text(d.title) },
      )
    }
  }
}

/** 电台=列表三行、发现=罗盘、收藏=五角星；选中 accent / 未选 dim（不单靠颜色，label 同屏） */
@Composable
fun DestinationIcon(d: Destination, selected: Boolean) {
  val pal = LocalVrPalette.current
  val tint = if (selected) pal.acc else pal.dim
  Canvas(Modifier.size(24.dp)) {
    val h = size.height
    when (d) {
      Destination.LIBRARY -> {   // 列表三横行：首尾全宽、中行短半格
        val w = size.width
        val rows = listOf(Triple(0.22f, 0.20f, 0.80f), Triple(0.50f, 0.34f, 0.80f), Triple(0.78f, 0.20f, 0.80f))
        rows.forEach { (y, x0, x1) ->
          drawLine(tint, Offset(w * x0, h * y), Offset(w * x1, h * y), strokeWidth = h * 0.08f, cap = StrokeCap.Round)
        }
      }
      Destination.DISCOVER -> {  // 罗盘：外圆描边 + 内针实心菱形
        val c = center; val r = size.minDimension * 0.42f
        drawCircle(tint, radius = r, center = c, style = Stroke(width = size.minDimension * 0.07f))
        val needle = Path().apply {
          moveTo(c.x, c.y - r * 0.55f); lineTo(c.x + r * 0.30f, c.y)
          lineTo(c.x, c.y + r * 0.55f); lineTo(c.x - r * 0.30f, c.y); close()
        }
        drawPath(needle, tint)
      }
      Destination.FAVORITES -> { // 五角星：外内半径交替十点闭合
        val c = center; val ro = size.minDimension * 0.42f; val ri = ro * 0.44f
        val star = Path()
        for (i in 0 until 10) {
          val ang = PI * (i / 5.0) - PI / 2
          val rad = if (i % 2 == 0) ro else ri
          val x = c.x + (rad * cos(ang)).toFloat(); val y = c.y + (rad * sin(ang)).toFloat()
          if (i == 0) star.moveTo(x, y) else star.lineTo(x, y)
        }
        star.close()
        drawPath(star, tint)
      }
    }
  }
}
