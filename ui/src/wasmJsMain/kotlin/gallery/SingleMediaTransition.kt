package gallery

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

private data class MediaPose(
    val media: MediaSummaryWire,
    val scale: Float,
    val pan: Offset,
    val playback: VideoPlayback?,
)

@Composable
internal fun SingleMediaTransition(
    media: MediaSummaryWire,
    state: ViewerState,
    rect: Rect,
    scale: Float,
    pan: Offset,
    visible: Boolean,
    nativeProgress: State<Float>?,
    playback: VideoPlayback?,
) {
    val poses = remember { mutableMapOf<String, MediaPose>() }
    poses[media.url] = MediaPose(media, scale, pan, playback)
    val reduced = state.gallery.reduceMotion
    AnimatedContent(
        media.url,
        modifier = Modifier.fillMaxSize(),
        transitionSpec = {
            mediaFade(reduced)
        },
    ) { url ->
        val (picture, imageScale, imagePan, player) = poses.getValue(url)
        DisposableEffect(url) {
            state.showMedia(url)
            onDispose {
                state.hideMedia(url)
                poses.remove(url)
            }
        }
        val active = url == media.url
        var loaded by remember(picture.url, state.retry) { mutableStateOf(false) }
        var failed by remember(picture.url, state.retry) { mutableStateOf(false) }
        var delayed by remember(picture.url, state.retry) { mutableStateOf(false) }
        LaunchedEffect(picture.url, state.retry) {
            delay(200)
            delayed = true
        }
        val opacity by
            transition.animateFloat(
                transitionSpec = {
                    mediaFadeTiming(reduced, targetState == EnterExitState.Visible)
                }
            ) {
                if (it == EnterExitState.Visible) 1f else 0f
            }
        Box(Modifier.fillMaxSize().graphicsLayer { alpha = if (visible) 1f else 0f }) {
            if (!loaded)
                MediaImage(
                    state.previewFor(picture).thumbnailUrl,
                    Modifier.fillMaxSize().graphicsLayer {
                        scaleX = imageScale
                        scaleY = imageScale
                        translationX = imagePan.x
                        translationY = imagePan.y
                    },
                    fit = true,
                    placeholder = false,
                    onInfo = { w, h, animated ->
                        if (active) state.mediaInfo(picture.relativePath, w, h, animated)
                    },
                )
            if (!failed)
                BrowserMedia(
                    picture,
                    state,
                    imageScale,
                    imagePan,
                    rect,
                    if (visible && loaded) opacity * (nativeProgress?.value ?: 1f) else 0f,
                    active && !state.closing && (player == null || visible),
                    player,
                    { w, h ->
                        loaded = true
                        if (active) {
                            state.imageWidth = w
                            state.imageHeight = h
                        }
                    },
                    { reason ->
                        failed = true
                        if (active) state.error = reason
                    },
                )
            if (active && delayed && !loaded && !failed) {
                val cycle = rememberInfiniteTransition()
                val x by
                    cycle.animateFloat(
                        0f,
                        1f,
                        infiniteRepeatable(tween(1200, easing = LinearEasing)),
                    )
                Box(
                    Modifier.align(Alignment.BottomStart)
                        .fillMaxWidth(.3f)
                        .offset { IntOffset((rect.width * x * .7f).roundToInt(), 0) }
                        .height(3.dp)
                        .background(Color.White.copy(alpha = .7f))
                )
            }
        }
    }
}

internal fun mediaFade(reduced: Boolean): ContentTransform =
    fadeIn(mediaFadeTiming(reduced, true)) togetherWith fadeOut(mediaFadeTiming(reduced, false))

private fun mediaFadeTiming(reduced: Boolean, entering: Boolean): FiniteAnimationSpec<Float> =
    if (reduced) snap()
    else if (entering) tween(175, delayMillis = 95, easing = LinearEasing)
    else tween(270, easing = LinearEasing)
