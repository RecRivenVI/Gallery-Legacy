package gallery

import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp

// Port of the approved canvas cornerCurves/path at the frozen migration reference.
// Each corner has two C2 cubics with zero endpoint curvature; Compose caches its outline.
data class GalleryShape(
    val topStart: Dp = 0.dp,
    val topEnd: Dp = 0.dp,
    val bottomEnd: Dp = 0.dp,
    val bottomStart: Dp = 0.dp,
) : Shape {
    constructor(radius: Dp) : this(radius, radius, radius, radius)

    override fun createOutline(
        size: Size,
        layoutDirection: LayoutDirection,
        density: Density,
    ): Outline {
        val rtl = layoutDirection == LayoutDirection.Rtl
        val corners =
            if (rtl) listOf(topStart, bottomStart, bottomEnd, topEnd)
            else listOf(topEnd, bottomEnd, bottomStart, topStart)
        val lengths = corners.map {
            with(density) { it.toPx() * 1.5f }.coerceIn(0f, minOf(size.width, size.height) / 2)
        }
        val w = size.width
        val h = size.height
        val path = Path()
        path.moveTo(lengths[3], 0f)
        path.lineTo(w - lengths[0], 0f)
        for (k in 0..3) {
            val l = lengths[k]
            fun point(x: Float, y: Float) =
                when (k) {
                    0 -> Pair(w - y, x)
                    1 -> Pair(w - x, h - y)
                    2 -> Pair(y, h - x)
                    else -> Pair(x, y)
                }
            fun curve(x1: Float, y1: Float, x2: Float, y2: Float, x3: Float, y3: Float) {
                val a = point(x1, y1)
                val b = point(x2, y2)
                val c = point(x3, y3)
                path.cubicTo(a.first, a.second, b.first, b.second, c.first, c.second)
            }
            curve(0f, 2 * l / 3, 0f, l / 3, l / 6, l / 6)
            curve(l / 3, 0f, 2 * l / 3, 0f, l, 0f)
            when (k) {
                0 -> path.lineTo(w, h - lengths[1])
                1 -> path.lineTo(lengths[2], h)
                2 -> path.lineTo(0f, lengths[3])
            }
        }
        path.close()
        return Outline.Generic(path)
    }
}
