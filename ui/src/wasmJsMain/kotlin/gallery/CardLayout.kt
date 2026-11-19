package gallery

import androidx.compose.animation.core.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

private class CardPartBounds(private val scope: CoroutineScope) {
    private var target: Rect? = null
    private var reduced = false
    private var animation: Animatable<Rect, AnimationVector4D>? = null
    private var job: Job? = null

    fun position(bounds: Rect, reduced: Boolean): Rect {
        val motion = animation ?: Animatable(bounds, Rect.VectorConverter).also { animation = it }
        if (bounds != target || this.reduced != reduced) {
            target = bounds
            this.reduced = reduced
            val velocity = motion.velocity
            job?.cancel()
            if (motion.value != bounds)
                job = scope.launch {
                    if (reduced) motion.snapTo(bounds)
                    else
                        motion.animateTo(
                            bounds,
                            spring(dampingRatio = 1f, stiffness = 324f),
                            initialVelocity = velocity,
                        )
                }
        }
        return if (reduced) bounds else motion.value
    }
}

@Composable
internal fun CardLayout(
    modifier: Modifier,
    list: Boolean,
    ratio: Float,
    reduced: Boolean,
    cover: @Composable () -> Unit,
    title: @Composable () -> Unit,
    author: @Composable () -> Unit,
    date: @Composable () -> Unit,
    count: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val parts = remember { List(5) { CardPartBounds(scope) } }
    Layout(listOf(cover, title, author, date, count), modifier) { children, constraints ->
        val width = constraints.maxWidth
        val coverSize = if (list) 64.dp.roundToPx().coerceAtMost(width) else width
        val coverHeight = if (list) coverSize else (width / ratio).roundToInt()
        val textHeight = 24.dp.roundToPx()
        val rowHeight = 100.dp.roundToPx()
        val rowGap = 16.dp.roundToPx()
        val cardGap = 5.dp.roundToPx()
        val dateWidth = 90.dp.roundToPx()
        val countWidth = 40.dp.roundToPx()
        val available = (width - coverSize - rowGap * 4 - dateWidth - countWidth).coerceAtLeast(0)
        val titleWidth = (available * .45f / .70f).roundToInt()
        val authorWidth = available - titleWidth
        val textY = (rowHeight - textHeight) / 2
        fun bounds(x: Int, y: Int, w: Int, h: Int) =
            Rect(x.toFloat(), y.toFloat(), (x + w).toFloat(), (y + h).toFloat())
        val targets =
            if (list)
                listOf(
                    bounds(0, (rowHeight - coverHeight) / 2, coverSize, coverHeight),
                    bounds(coverSize + rowGap, textY, titleWidth, textHeight),
                    bounds(coverSize + rowGap * 2 + titleWidth, textY, authorWidth, textHeight),
                    bounds(width - countWidth - rowGap - dateWidth, textY, dateWidth, textHeight),
                    bounds(width - countWidth, textY, countWidth, textHeight),
                )
            else
                listOf(
                    bounds(0, 0, coverSize, coverHeight),
                    bounds(0, coverHeight + cardGap, width, textHeight),
                    bounds(0, coverHeight + cardGap + textHeight, width, textHeight),
                    bounds(width, coverHeight, 0, textHeight),
                    bounds(width, coverHeight, 0, textHeight),
                )
        val frames = targets.mapIndexed { index, target -> parts[index].position(target, reduced) }
        val measured =
            children.zip(frames).map { (slot, frame) ->
                slot
                    .single()
                    .measure(
                        Constraints.fixed(
                            frame.width.roundToInt().coerceAtLeast(0),
                            frame.height.roundToInt().coerceAtLeast(0),
                        )
                    )
            }
        val height = if (list) rowHeight else coverHeight + cardGap + textHeight * 2
        layout(width, height) {
            measured.zip(frames).forEach { (child, frame) ->
                child.placeRelative(frame.left.roundToInt(), frame.top.roundToInt())
            }
        }
    }
}
