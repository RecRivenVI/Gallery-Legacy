package gallery

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.*
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.geometry.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.input.pointer.*
import androidx.compose.ui.layout.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.*
import kotlin.math.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable
internal fun ViewerStage(
    state: ViewerState,
    phone: Boolean,
    progress: State<Float>,
    opened: Boolean,
    useFlight: Boolean,
) {
    val media = state.current
    val playback =
        remember(state, media?.url, state.retry) {
            media?.takeIf { it.type == "video" }?.let { VideoPlayback(state, it) }
        }
    SideEffect { state.videoPlayback = playback }
    val density = LocalDensity.current
    var rect by remember { mutableStateOf(Rect.Zero) }
    var autoHidden by remember { mutableStateOf(false) }
    val scale by
        animateFloatAsState(
            state.zoom,
            if (state.dragging || state.gallery.reduceMotion) snap()
            else spring(dampingRatio = 1f, stiffness = 324f),
        )
    val panX by
        animateFloatAsState(
            state.pan.x,
            if (state.dragging) snap() else spring(dampingRatio = 1f, stiffness = 324f),
        )
    val panY by
        animateFloatAsState(
            state.pan.y,
            if (state.dragging) snap() else spring(dampingRatio = 1f, stiffness = 324f),
        )
    LaunchedEffect(state.lastPointer) {
        autoHidden = false
        delay(1800)
        autoHidden = true
    }
    val videoFullscreen by
        remember(playback) { derivedStateOf { playback?.status?.fullscreen == true } }
    val arrows =
        !state.hidden &&
            !(phone && state.details) &&
            (!autoHidden || state.nearEdge) &&
            playback?.menu != true &&
            !videoFullscreen
    Box(
        Modifier.fillMaxSize()
            .clipToBounds()
            .onSizeChanged {
                state.pixelRatio = density.density
                state.areaWidth = it.width.toFloat()
                state.areaHeight = it.height.toFloat()
                state.constrainPan()
            }
            .onGloballyPositioned { rect = it.boundsInWindow() }
            .onWebPointerEvent(PointerEventType.Move) { e ->
                if (!phone) playback?.activity()
                state.lastPointer = now()
                val x = e.changes.firstOrNull()?.position?.x ?: 0f
                state.nearEdge =
                    x < with(density) { 200.dp.toPx() } ||
                        x > rect.width - with(density) { 200.dp.toPx() }
            }
    ) {
        Box(Modifier.fillMaxSize().viewerGestures(state, phone, playback)) {
            Box(Modifier.fillMaxSize()) {
                if (media == null)
                    Label(
                        "这个作品没有图片或视频",
                        Modifier.align(Alignment.Center),
                        color = Color(0xffcfcfcf),
                        size = 14,
                    )
                else {
                    SingleMediaTransition(
                        media,
                        state,
                        rect,
                        scale,
                        Offset(panX, panY),
                        visible = !useFlight || opened,
                        nativeProgress = if (useFlight) null else progress,
                        playback = playback,
                    )
                }
            }
        }
        CompositionLocalProvider(LocalBackdrop provides null) {
            if (playback != null && opened && !state.closing && state.error.isEmpty()) {
                VideoControls(playback, phone, Modifier.matchParentSize())
            }
            if (state.error.isNotEmpty())
                GlassSurface(
                    Modifier.align(Alignment.Center).widthIn(max = 360.dp).padding(16.dp)
                ) {
                    Column(
                        Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Label("加载失败：" + state.error)
                        Action("重试") {
                            state.error = ""
                            state.retry++
                        }
                    }
                }
            if (arrows) {
                GlassSurface(Modifier.align(Alignment.CenterStart).padding(12.dp), radius = 50.dp) {
                    IconAction("left", if (state.reading.physicalDelta(-1) > 0) "下一页" else "上一页") {
                        state.flip(state.reading.physicalDelta(-1))
                    }
                }
                GlassSurface(Modifier.align(Alignment.CenterEnd).padding(12.dp), radius = 50.dp) {
                    IconAction("right", if (state.reading.physicalDelta(1) > 0) "下一页" else "上一页") {
                        state.flip(state.reading.physicalDelta(1))
                    }
                }
            }
        }
    }
}
