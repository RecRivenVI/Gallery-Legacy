package gallery

import androidx.compose.animation.core.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp

@Composable
internal fun rememberPageArrival(
    route: Route,
    ready: Boolean,
    direction: Int,
    reduced: Boolean,
): State<Float>? {
    if (reduced || direction == 0) return null
    val duration = Metrics.pageStaggerMaxMs + cardArrivalDuration
    val elapsed = remember(route) { Animatable(0f) }
    LaunchedEffect(elapsed, ready) {
        if (ready && elapsed.value < duration)
            elapsed.animateTo(duration.toFloat(), tween(duration, easing = LinearEasing))
    }
    val finished by remember(elapsed) { derivedStateOf { elapsed.value >= duration } }
    return if (finished) null else elapsed.asState()
}

private const val cardArrivalDuration = 220

internal fun Modifier.pageArrival(elapsed: State<Float>?, index: Int, direction: Int): Modifier {
    if (elapsed == null) return this
    val stagger = (index * Metrics.pageStaggerMs).coerceAtMost(Metrics.pageStaggerMaxMs)
    return graphicsLayer {
        val progress = ((elapsed.value - stagger) / cardArrivalDuration).coerceIn(0f, 1f)
        translationX =
            (Metrics.pageArrival * direction).dp.toPx() *
                (1 - LinearOutSlowInEasing.transform(progress))
        alpha = FastOutSlowInEasing.transform(progress)
    }
}
