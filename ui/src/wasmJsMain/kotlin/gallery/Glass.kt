package gallery

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.layer.*
import androidx.compose.ui.layout.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.*

class Backdrop(val layer: GraphicsLayer) {
    var origin = Offset.Zero
}

data class GlassMask(val rect: Rect, val radius: Float)

val LocalGlassMasks = staticCompositionLocalOf<MutableMap<Any, GlassMask>?> { null }

val LocalBackdrop = staticCompositionLocalOf<Backdrop?> { null }
val LocalImageBackground = staticCompositionLocalOf { false }

fun Modifier.captureBackdrop(backdrop: Backdrop) = onGloballyPositioned {
    backdrop.origin = it.positionInWindow()
}
    .drawWithContent {
        backdrop.layer.record { this@drawWithContent.drawContent() }
        drawLayer(backdrop.layer)
    }

@Composable
fun GlassSurface(
    modifier: Modifier = Modifier,
    radius: Dp = 12.dp,
    color: Color = LocalPalette.current.glass,
    opacity: Float =
        if (LocalImageBackground.current) .9f else if (LocalPalette.current.dark) .8f else .84f,
    content: @Composable BoxScope.() -> Unit,
) {
    val source = LocalBackdrop.current
    val saturation = remember {
        Paint().apply {
            colorFilter = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(1.3f) })
        }
    }
    val masks = LocalGlassMasks.current
    val identity = remember { Any() }
    val maskRadius = with(LocalDensity.current) { radius.toPx() }
    DisposableEffect(identity) { onDispose { masks?.remove(identity) } }
    val shape = GalleryShape(radius)
    var point by remember { mutableStateOf(Offset.Zero) }
    Box(
        modifier
            .onGloballyPositioned {
                point = it.positionInWindow()
                masks?.set(identity, GlassMask(it.boundsInWindow(), maskRadius))
            }
            .clip(shape)
            .border(1.dp, LocalPalette.current.edge, shape),
        contentAlignment = Alignment.Center,
    ) {
        if (source != null)
            Canvas(Modifier.matchParentSize().blur(24.dp)) {
                val offset = source.origin - point
                drawContext.canvas.saveLayer(Rect(Offset.Zero, size), saturation)
                translate(offset.x, offset.y) { drawLayer(source.layer) }
                drawContext.canvas.restore()
            }
        Box(Modifier.matchParentSize().background(color.copy(alpha = opacity)))
        content()
    }
}
