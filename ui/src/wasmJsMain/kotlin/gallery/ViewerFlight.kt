package gallery

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.lerp
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.lerp

internal fun fittedMediaRect(
    width: Float,
    height: Float,
    mediaWidth: Float,
    mediaHeight: Float,
): Rect {
    if (width <= 0 || height <= 0 || mediaWidth <= 0 || mediaHeight <= 0) return Rect.Zero
    val scale = minOf(width / mediaWidth, height / mediaHeight)
    val halfW = mediaWidth * scale / 2
    val halfH = mediaHeight * scale / 2
    return Rect(width / 2 - halfW, height / 2 - halfH, width / 2 + halfW, height / 2 + halfH)
}

@Composable
internal fun ViewerFlight(
    state: ViewerState,
    progress: Animatable<Float, AnimationVector1D>,
    stage: Rect,
    viewport: Rect,
    windowOrigin: Offset,
    onLoaded: () -> Unit,
) {
    val moving by remember(progress) { derivedStateOf { progress.value < .995f } }
    if (!moving || stage.width <= 0 || stage.height <= 0 || viewport.isEmpty) return
    val card =
        (if (state.closing) state.closeRect() else state.origin)
            ?: Rect(stage.center - Offset(24f, 24f), stage.center + Offset(24f, 24f))
    if (card.width <= 0 || card.height <= 0) return
    val media = state.current ?: return
    val preview = state.previewFor(media)
    val fromBehind = media.url != state.flightCoverUrl
    val source = card.translate(-windowOrigin)
    val stageClip = viewport.translate(-windowOrigin)
    MediaImage(
        preview.thumbnailUrl,
        Modifier.fillMaxSize(),
        placeholder = false,
        onLoaded = onLoaded,
    ) { image ->
        if (!state.flightStarted) return@MediaImage
        val fraction = progress.value.coerceIn(0f, 1f)
        val width = image.width.toFloat()
        val height = image.height.toFloat()
        val fit = fittedMediaRect(stage.width, stage.height, width, height)
        val zoom = if (state.reading.options.mode == "single") state.zoom else 1f
        val pan = if (state.reading.options.mode == "single") state.pan else Offset.Zero
        val center = stage.center - windowOrigin + pan
        val halfSize = Offset(fit.width, fit.height) * (zoom / 2)
        val target = Rect(center - halfSize, center + halfSize)
        val arc = if (fromBehind) 4f * fraction * (1f - fraction) else 0f
        val offset = Offset(-source.width * .32f, -source.height * .28f) * arc
        val frame = lerp(source, target, fraction).translate(offset)
        val cropBounds = lerp(source, target.intersect(stageClip), fraction).translate(offset)
        val fromScale = maxOf(source.width / width, source.height / height)
        val toScale = target.width / width
        val scale = fromScale + (toScale - fromScale) * fraction
        val origin = frame.center - Offset(width, height) * (scale / 2)
        val radius = Metrics.cardRadius.dp.toPx() * (1 - fraction)
        val crop = Path().apply { addRoundRect(RoundRect(cropBounds, CornerRadius(radius))) }
        clipPath(crop) {
            val reveal = {
                withTransform({
                    translate(origin.x, origin.y)
                    scale(scale, scale, Offset.Zero)
                }) {
                    drawImage(image)
                }
            }
            if (fromBehind) {
                val uncover = ((fraction - .10f) / .45f).coerceIn(0f, 1f)
                clipRect(
                    source.left,
                    lerp(source.top, source.bottom, uncover),
                    source.right,
                    source.bottom,
                    clipOp = androidx.compose.ui.graphics.ClipOp.Difference,
                ) {
                    reveal()
                }
            } else reveal()
        }
    }
}
