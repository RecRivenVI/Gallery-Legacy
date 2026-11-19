@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package gallery

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlin.js.*
import kotlin.math.floor
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.await
import kotlinx.coroutines.delay

@Composable
internal fun VideoScrubPreview(player: VideoPlayback, seconds: Double, phone: Boolean) {
    val previewWidth = if (phone) 60.dp else 144.dp
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val progress = (seconds / player.status.duration).toFloat().coerceIn(0f, 1f)
        val left =
            ((maxWidth * progress) - previewWidth / 2).coerceIn(
                0.dp,
                (maxWidth - previewWidth).coerceAtLeast(0.dp),
            )
        GlassSurface(Modifier.absoluteOffset(x = left).width(previewWidth), opacity = .98f) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (!phone) {
                    val sample = floor(seconds / 2) * 2
                    val frame = rememberScrubFrame(player.previewUrl, sample)
                    if (frame.isNotEmpty())
                        ScrubImage(frame, Modifier.width(previewWidth).height(81.dp))
                }
                Label(
                    videoTime(seconds),
                    Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                    size = 12,
                )
            }
        }
    }
}

@Composable
private fun rememberScrubFrame(url: String, sample: Double): String {
    val source = remember(url) { videoPreviewSource(url) }
    DisposableEffect(source) { onDispose { releaseVideoPreview(source) } }
    val frame by
        produceState("", source, sample) {
            value = ""
            delay(300)
            value =
                try {
                    sampleVideoPreview(source, sample).await<JsString>().toString()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    ""
                }
        }
    return frame
}

@Composable
private fun ScrubImage(frame: String, modifier: Modifier) {
    val density = LocalDensity.current.density
    var image by remember { mutableStateOf<JsAny?>(null) }
    var bounds by remember { mutableStateOf(Rect.Zero) }
    DisposableEffect(Unit) {
        val node = createVideoPreviewImage()
        image = node
        onDispose { releaseVideoPreviewImage(node) }
    }
    val position = bounds
    image?.let { node ->
        SideEffect {
            placeVideoPreviewImage(
                node,
                frame,
                (position.left / density).toDouble(),
                (position.top / density).toDouble(),
                (position.width / density).toDouble(),
                (position.height / density).toDouble(),
            )
        }
    }
    Box(modifier.onGloballyPositioned { bounds = it.boundsInWindow() })
}
