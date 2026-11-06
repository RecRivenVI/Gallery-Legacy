package gallery

import androidx.compose.runtime.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily

data class Palette(
    val bg: Color,
    val glass: Color,
    val fg: Color,
    val fg2: Color,
    val muted: Color,
    val faint: Color,
    val field: Color,
    val accent: Color,
    val accentInk: Color,
    val ok: Color,
    val warn: Color,
    val error: Color,
    val info: Color,
    val dark: Boolean,
) {
    val edge
        get() = fg.copy(alpha = .08f)

    val divider
        get() = fg.copy(alpha = .09f)

    val tint
        get() = fg.copy(alpha = if (dark) .07f else .05f)

    val pressed
        get() = fg.copy(alpha = if (dark) .12f else .09f)

    val selected
        get() = fg.copy(alpha = if (dark) .13f else .08f)

    val tag
        get() = fg.copy(alpha = if (dark) .1f else .065f)
}

val Dark =
    Palette(
        Color(0xff111213),
        Color(0xff18181a),
        Color(0xffededed),
        Color(0xffcfcfcf),
        Color(0xffa3a3a3),
        Color(0xff8a8a8a),
        Color(0xff1c1c1e),
        Color.White,
        Color(0xff111111),
        Color(0xff3ccf7e),
        Color(0xffe8b04b),
        Color(0xffff7a70),
        Color(0xff7ab8ff),
        true,
    )
val Light =
    Palette(
        Color(0xfff2f2f0),
        Color(0xfffafaf8),
        Color(0xff161616),
        Color(0xff333333),
        Color(0xff555555),
        Color(0xff6b6b6b),
        Color.White,
        Color(0xff111111),
        Color.White,
        Color(0xff1b7a43),
        Color(0xff8f6200),
        Color(0xffc4362c),
        Color(0xff1f66c2),
        false,
    )
val LocalPalette = staticCompositionLocalOf { Dark }
val LocalGalleryFont = staticCompositionLocalOf<FontFamily> { FontFamily.Default }
val LocalKeyboard = staticCompositionLocalOf { false }
val LocalReducedMotion = staticCompositionLocalOf { false }

object Metrics {
    const val sidebar = 240
    const val collapsed = 50
    const val header = 50
    const val toolbar = 42
    const val control = 34
    const val radius = 7
    const val cardRadius = 6
    const val panelRadius = 12
    const val gap = 8
    const val padding = 16
    const val blur = 24
    const val panelGlassOpacity = .96f
    const val pageBandMax = 310f
    const val pageGap = 3f
    const val pageHeight = 34
    const val pageFade = 28
    const val pageInset = 8
    const val pageBottom = 16
    const val pageArrival = 24
    const val pageStaggerMs = 12
    const val pageStaggerMaxMs = 200
    val cardWidths = listOf(0, 140, 180, 220, 280, 360)
    val touchWidths = listOf(0, 110, 145, 180, 250, 360)
    val sizes = listOf("列表", "小", "较小", "中", "大", "特大")
    val ratios =
        linkedMapOf(
            "1:1" to 1f,
            "4:3" to 4f / 3,
            "3:4" to 3f / 4,
            "16:9" to 16f / 9,
            "9:16" to 9f / 16,
        )
}
