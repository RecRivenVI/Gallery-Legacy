package gallery

import androidx.compose.animation.core.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer

@Composable
internal fun rememberCardMedia(state: GalleryState, url: String?): CardMediaVisibility {
    val claimed by
        remember(state, url) {
            derivedStateOf {
                url != null &&
                    state.viewer?.let {
                        it.hasMedia(url) && (!it.isOpeningCover(url) || it.flightStarted)
                    } == true
            }
        }
    val flyingCover by
        remember(state, url) {
            derivedStateOf {
                val viewer = state.viewer
                url != null &&
                    viewer?.coverInFlight(url) == true &&
                    url == viewer.flightCoverUrl &&
                    (viewer.flightProgress?.value ?: 0f) < .995f
            }
        }
    val direct by
        remember(state, url) {
            derivedStateOf { url != null && state.viewer?.isOpeningCover(url) == true }
        }
    val opacity =
        animateFloatAsState(
            if (claimed) 0f else 1f,
            if (state.reduceMotion || flyingCover || direct) snap()
            else tween(if (claimed) 110 else 180),
        )
    return CardMediaVisibility(opacity, state, flyingCover)
}

internal class CardMediaVisibility(
    private val opacity: State<Float>,
    private val state: GalleryState,
    private val flyingCover: Boolean,
) {
    fun image(): Modifier = Modifier.graphicsLayer { alpha = opacity.value }

    fun badges(): Modifier = Modifier.graphicsLayer {
        alpha =
            if (flyingCover)
                (1f - (state.viewer?.flightProgress?.value ?: 1f) * 4f).coerceIn(0f, 1f)
            else opacity.value
    }
}
