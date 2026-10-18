package io.github.vjoy233.vradio.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/* 双主题照抄 Web 色板（index.html CSS 变量，契约 §Agent C）。
   radio.theme 三态：auto（默认，跟随系统实时）/light/dark，持久化在 Store；
   不做 Material You 动态取色。收藏星色浅底单独分档（#f5c542 对白面板对比度不足，Web 同款换 #8a6508）。 */

data class VrPalette(
  val bg: Color, val panel: Color, val line: Color, val tx: Color, val dim: Color,
  val acc: Color, val warn: Color, val star: Color, val isLight: Boolean,
)

val DarkPal = VrPalette(
  bg = Color(0xFF101418), panel = Color(0xFF1A2027), line = Color(0xFF2A323C),
  tx = Color(0xFFE8ECF1), dim = Color(0xFF8B97A5), acc = Color(0xFF4FC08D),
  warn = Color(0xFFE07A5F), star = Color(0xFFF5C542), isLight = false,
)
/* N18 纯黑 OLED 档（batch1 2026-10-18 拍板；radio.theme 值域软扩展——Web 侧未知值回退 auto 不炸）：
   bg 纯黑 + 面板近黑，其余沿用深色档（对比度不降档，仅压底色省 OLED 像素功耗） */
val OledPal = VrPalette(
  bg = Color(0xFF000000), panel = Color(0xFF0A0D10), line = Color(0xFF1B222A),
  tx = DarkPal.tx, dim = DarkPal.dim, acc = DarkPal.acc,
  warn = DarkPal.warn, star = DarkPal.star, isLight = false,
)
val LightPal = VrPalette(
  bg = Color(0xFFF4F6F8), panel = Color(0xFFFFFFFF), line = Color(0xFFD9DEE4),
  tx = Color(0xFF1F2733), dim = Color(0xFF5D6A77), acc = Color(0xFF1F7A54),
  warn = Color(0xFFB5431A), star = Color(0xFF8A6508), isLight = true,
)

/** 自定义色板（Web 变量一一对应），组件里 LocalVrPalette.current 取用 */
val LocalVrPalette = staticCompositionLocalOf { DarkPal }

@Composable
fun VrTheme(theme: String, content: @Composable () -> Unit) {
  val dark = theme == "dark" || theme == "oled" || (theme == "auto" && isSystemInDarkTheme())   // auto 跟随系统实时；oled 走深色 scheme 纯黑档
  val p = when (theme) {
    "oled" -> OledPal
    else -> if (dark) DarkPal else LightPal
  }
  val scheme = if (dark) darkColorScheme(
    primary = p.acc, onPrimary = Color(0xFF04150C),
    background = p.bg, onBackground = p.tx,
    surface = p.panel, onSurface = p.tx,
    surfaceVariant = p.panel, onSurfaceVariant = p.dim,
    outline = p.line, outlineVariant = p.line,
    secondary = p.dim, onSecondary = p.bg,
    tertiary = p.warn, onTertiary = Color(0xFF1B0B05),
    error = p.warn, onError = Color(0xFF1B0B05),
    inverseSurface = p.tx, inverseOnSurface = p.bg, inversePrimary = p.acc,
    surfaceContainerLowest = p.bg, surfaceContainerLow = p.bg, surfaceContainer = p.panel,
    surfaceContainerHigh = p.panel, surfaceContainerHighest = p.panel,
  ) else lightColorScheme(
    primary = p.acc, onPrimary = Color(0xFFFFFFFF),
    background = p.bg, onBackground = p.tx,
    surface = p.panel, onSurface = p.tx,
    surfaceVariant = p.bg, onSurfaceVariant = p.dim,
    outline = p.line, outlineVariant = p.line,
    secondary = p.dim, onSecondary = Color(0xFFFFFFFF),
    tertiary = p.warn, onTertiary = Color(0xFFFFFFFF),
    error = p.warn, onError = Color(0xFFFFFFFF),
    inverseSurface = p.tx, inverseOnSurface = p.bg, inversePrimary = p.acc,
    surfaceContainerLowest = Color(0xFFE9EDF0), surfaceContainerLow = Color(0xFFEFF2F4),
    surfaceContainer = p.panel, surfaceContainerHigh = Color(0xFFF6F8FA), surfaceContainerHighest = p.bg,
  )
  CompositionLocalProvider(LocalVrPalette provides p) { MaterialTheme(colorScheme = scheme, content = content) }
}
