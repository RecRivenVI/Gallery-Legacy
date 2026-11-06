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
internal fun ViewerStage(state: ViewerState, phone: Boolean, progress: Float) {
    val media = state.current
    val density = LocalDensity.current
    var rect by remember { mutableStateOf(Rect.Zero) }
    var loaded by remember(media?.url, state.retry) { mutableStateOf(false) }
    var failed by remember(media?.url, state.retry) { mutableStateOf(false) }
    var previewReady by remember(media?.url, state.retry) { mutableStateOf(false) }
    var delayed by remember(media?.url, state.retry) { mutableStateOf(false) }
    var autoHidden by remember { mutableStateOf(false) }
    val imageLayer = rememberGraphicsLayer()
    val imageBackdrop = remember { Backdrop(imageLayer) }
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
    LaunchedEffect(media?.url, state.retry) {
        delay(1000)
        delayed = true
    }
    LaunchedEffect(state.work.stableId, state.page) {
        coroutineScope {
            (-2..2)
                .filter { it != 0 }
                .mapNotNull { state.media.getOrNull(state.page + it) }
                .forEach { nearby ->
                    launch {
                        try {
                            prefetchImage(nearby.thumbnails?.l ?: nearby.thumbnailUrl)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            /* A failed prefetch is retried on navigation. */
                        }
                    }
                }
        }
    }
    LaunchedEffect(state.lastPointer) {
        autoHidden = false
        delay(1800)
        autoHidden = true
    }
    val arrows = !state.hidden && !(phone && state.details) && (!autoHidden || state.nearEdge)
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
                state.lastPointer = now()
                val x = e.changes.firstOrNull()?.position?.x ?: 0f
                state.nearEdge =
                    x < with(density) { 200.dp.toPx() } ||
                        x > rect.width - with(density) { 200.dp.toPx() }
            }
    ) {
        MediaImage(
            media?.thumbnailUrl.orEmpty(),
            Modifier.fillMaxSize().blur(40.dp).alpha(.18f),
            placeholder = false,
        )
        val transform =
            Modifier.fillMaxSize().graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationX = panX + state.dragX
                translationY = panY
            }
        Box(Modifier.fillMaxSize().viewerGestures(state, phone)) {
            Box(Modifier.fillMaxSize().captureBackdrop(imageBackdrop)) {
                if (media == null)
                    Label(
                        "这个作品没有图片或视频",
                        Modifier.align(Alignment.Center),
                        color = Color(0xffcfcfcf),
                        size = 14,
                    )
                else {
                    val opening = progress < .999f && !state.split
                    val target = if (state.closing) state.closeRect() else state.origin
                    val ratioW =
                        (state.imageWidth.takeIf { it > 0 } ?: media.width).coerceAtLeast(1)
                    val ratioH =
                        (state.imageHeight.takeIf { it > 0 } ?: media.height).coerceAtLeast(1)
                    val fit = minOf(rect.width / ratioW, rect.height / ratioH)
                    val final =
                        Rect(
                            (rect.width - ratioW * fit) / 2,
                            (rect.height - ratioH * fit) / 2,
                            (rect.width + ratioW * fit) / 2,
                            (rect.height + ratioH * fit) / 2,
                        )
                    val origin =
                        target?.translate(-rect.topLeft)
                            ?: Rect(
                                rect.width * .4f,
                                rect.height * .4f,
                                rect.width * .6f,
                                rect.height * .6f,
                            )
                    val start =
                        if (state.openingCover?.relativePath.orEmpty() != media.relativePath)
                            origin.translate(Offset(-origin.width * .19f, -origin.height * .1f))
                        else origin
                    val bounds = lerp(start, final, progress)
                    val imageModifier =
                        if (opening)
                            Modifier.offset {
                                    IntOffset(bounds.left.roundToInt(), bounds.top.roundToInt())
                                }
                                .size(
                                    with(density) { bounds.width.toDp() },
                                    with(density) { bounds.height.toDp() },
                                )
                                .clip(GalleryShape((6 * (1 - progress)).dp))
                        else transform
                    AnimatedContent(
                        media.url,
                        transitionSpec = {
                            if (state.gallery.reduceMotion)
                                fadeIn(tween(150)) togetherWith fadeOut(tween(150))
                            else
                                (slideInHorizontally(spring(dampingRatio = 1f, stiffness = 324f)) {
                                    it * state.direction / 8
                                } + fadeIn(tween(160))) togetherWith
                                    (slideOutHorizontally(tween(180)) {
                                        -it * state.direction / 8
                                    } + fadeOut(tween(160)))
                        },
                        modifier = Modifier.fillMaxSize(),
                    ) { target ->
                        val picture = remember(target) { media }
                        MediaImage(
                            picture.thumbnailUrl,
                            imageModifier,
                            fit = !opening,
                            placeholder = false,
                            onLoaded = { previewReady = true },
                            onError = { previewReady = true },
                            onInfo = { w, h, animated ->
                                state.mediaInfo(picture.relativePath, w, h, animated)
                            },
                            onSize = { w, h ->
                                if (state.imageWidth == 0) {
                                    state.imageWidth = w
                                    state.imageHeight = h
                                }
                            },
                        )
                    }
                }
            }
        }
        if (
            media != null &&
                !failed &&
                (previewReady ||
                    media.type == "video" ||
                    media.animated ||
                    media.fileName.endsWith(".gif", ignoreCase = true))
        )
            BrowserMedia(
                media.copy(
                    url =
                        viewerImage(
                            media,
                            state.zoom,
                            maxOf(rect.width, rect.height) / density.density,
                            density.density,
                        )
                ),
                state,
                scale,
                Offset(panX + state.dragX, panY),
                rect,
                progress,
                { loaded = true },
                { failed = true },
            )
        CompositionLocalProvider(LocalBackdrop provides imageBackdrop) {
            if (delayed && !loaded && !failed) {
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
                        .height(2.dp)
                        .background(Color.White.copy(alpha = .7f))
                )
            }
            if (failed || state.error.isNotEmpty())
                GlassSurface(
                    Modifier.align(Alignment.Center).widthIn(max = 360.dp).padding(16.dp)
                ) {
                    Column(
                        Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Label(
                            "加载失败：" +
                                state.error.ifEmpty {
                                    if (media?.type == "video") "视频无法播放" else "文件无法读取"
                                }
                        )
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
