package gallery

import androidx.compose.animation.core.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

@Composable
internal fun Modifier.pageArrival(
    route: Route,
    index: Int,
    direction: Int,
    reduced: Boolean,
): Modifier {
    var entered by remember(route) { mutableStateOf(false) }
    LaunchedEffect(route) {
        if (!reduced)
            delay((index * Metrics.pageStaggerMs).coerceAtMost(Metrics.pageStaggerMaxMs).toLong())
        entered = true
    }
    val offset by
        animateFloatAsState(
            if (entered || reduced) 0f else (Metrics.pageArrival * direction).toFloat(),
            if (reduced) snap() else spring(dampingRatio = 1f, stiffness = 324f),
        )
    val opacity by
        animateFloatAsState(if (entered || reduced) 1f else 0f, if (reduced) snap() else tween(220))
    return graphicsLayer {
        translationX = offset.dp.toPx()
        alpha = opacity
    }
}
