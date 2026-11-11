package gallery

import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
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

@Composable
fun ReaderStage(state: ViewerState, phone: Boolean, progress: Float) {
    val density = LocalDensity.current
    val layer = rememberGraphicsLayer()
    val backdrop = remember { Backdrop(layer) }
    var autoHidden by remember { mutableStateOf(false) }
    LaunchedEffect(state.lastPointer) {
        autoHidden = false
        delay(1800)
        autoHidden = true
    }
    LaunchedEffect(state.page, state.work.media) {
        if (state.reading.options.mode == "double") {
            val pages = state.reading.spread.mapNotNull { state.media.getOrNull(it) }
            val height = pages.maxOfOrNull { it.height.takeIf { h -> h > 0 } ?: 1800 } ?: 1800
            state.imageHeight = height
            state.imageWidth = pages.sumOf { page ->
                ((page.width.takeIf { it > 0 } ?: 1200).toDouble() /
                        (page.height.takeIf { it > 0 } ?: 1800) * height)
                    .toInt()
            }
            state.constrainPan()
        }
    }
    Box(
        Modifier.fillMaxSize()
            .clipToBounds()
            .onSizeChanged {
                state.areaWidth = it.width.toFloat()
                state.areaHeight = it.height.toFloat()
                state.pixelRatio = density.density
            }
            .onWebPointerEvent(PointerEventType.Move) { event ->
                state.lastPointer = now()
                val x = event.changes.firstOrNull()?.position?.x ?: 0f
                state.nearEdge =
                    x < 200 * density.density || x > state.areaWidth - 200 * density.density
            }
    ) {
        Box(Modifier.fillMaxSize().captureBackdrop(backdrop)) {
            if (state.reading.options.mode == "continuous") ContinuousPages(state, progress)
            else {
                val indices =
                    state.reading.spread.let {
                        if (state.reading.options.rtl) it.reversed() else it
                    }
                Row(
                    Modifier.fillMaxSize().viewerGestures(state, phone).graphicsLayer {
                        scaleX = state.zoom
                        scaleY = state.zoom
                        translationX = state.pan.x + state.dragX
                        translationY = state.pan.y
                    }
                ) {
                    indices.forEach { index ->
                        ReaderPage(state, index, Modifier.weight(1f).fillMaxHeight(), progress)
                    }
                }
            }
        }
        CompositionLocalProvider(LocalBackdrop provides backdrop) {
            if (!state.hidden && !(phone && state.details) && (!autoHidden || state.nearEdge)) {
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
            if (state.reading.options.mode != "continuous")
                state.reading.episodePrompt?.let { episode ->
                    GlassSurface(
                        Modifier.align(Alignment.Center).widthIn(max = 420.dp).padding(16.dp)
                    ) {
                        Action(
                            (if (episode.stableId == state.reading.episodes.next?.stableId) "下一话："
                            else "上一话：") + episode.title
                        ) {
                            state.reading.openEpisode(episode)
                        }
                    }
                }
        }
    }
}

@Composable
private fun ReaderPage(
    state: ViewerState,
    index: Int,
    modifier: Modifier,
    progress: Float,
    continuous: Boolean = false,
) {
    val media = state.media.getOrNull(index) ?: return
    val density = LocalDensity.current
    var rect by remember { mutableStateOf(Rect.Zero) }
    val large = media.url
    var loaded by remember(large, state.retry) { mutableStateOf(false) }
    var failed by remember(large, state.retry) { mutableStateOf(false) }
    var delayed by remember(large, state.retry) { mutableStateOf(false) }
    val layer = rememberGraphicsLayer()
    val backdrop = remember { Backdrop(layer) }
    LaunchedEffect(large, state.retry) {
        delay(200)
        delayed = true
    }
    val primary = index == state.page
    val target = if (state.closing) state.closeRect() else state.origin
    val picture =
        if (primary && progress < .999f && target != null && rect.width > 0 && rect.height > 0) {
            val origin = target.translate(-rect.topLeft)
            val box = lerp(origin, Rect(0f, 0f, rect.width, rect.height), progress)
            Modifier.wrapContentSize(Alignment.TopStart, unbounded = true)
                .offset { IntOffset(box.left.roundToInt(), box.top.roundToInt()) }
                .requiredSize(
                    with(density) { box.width.toDp() },
                    with(density) { box.height.toDp() },
                )
        } else Modifier.fillMaxSize()
    Box(
        modifier
            .onGloballyPositioned { rect = it.boundsInWindow() }
            .then(
                if (primary) Modifier else Modifier.alpha(((progress - .3f) / .7f).coerceIn(0f, 1f))
            )
    ) {
        Box(Modifier.fillMaxSize().captureBackdrop(backdrop)) {
            key(media.url, state.retry) {
                MediaImage(
                    media.thumbnailUrl,
                    picture,
                    fit = progress > .99f,
                    placeholder = false,
                    onInfo = { w, h, animated ->
                        state.mediaInfo(media.relativePath, w, h, animated)
                    },
                )
                MediaImage(
                    large,
                    picture,
                    fit = progress > .99f,
                    placeholder = false,
                    onLoaded = { loaded = true },
                    onError = { failed = true },
                )
            }
        }
        CompositionLocalProvider(LocalBackdrop provides backdrop) {
            if (delayed && !loaded && !failed)
                Box(
                    Modifier.align(Alignment.BottomStart)
                        .fillMaxWidth(.3f)
                        .height(3.dp)
                        .background(Color.White.copy(alpha = .7f))
                )
            if (failed)
                GlassSurface(
                    Modifier.align(Alignment.Center).widthIn(max = 300.dp).padding(12.dp)
                ) {
                    Column(
                        Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Label("加载失败：文件无法读取")
                        Action("重试") { state.retry++ }
                    }
                }
        }
    }
}

@Composable
private fun ContinuousPages(state: ViewerState, progress: Float) {
    val reader = state.reading
    val horizontal = rememberScrollState()
    val density = LocalDensity.current
    val shown by rememberUpdatedState(progress)
    val offset = if (reader.episodes.previous != null) 1 else 0
    val currentOffset by rememberUpdatedState(offset)
    val visible by
        remember(offset) {
            derivedStateOf {
                reader.scroll.layoutInfo.visibleItemsInfo
                    .map { it.index - offset }
                    .filter { it in state.media.indices }
                    .let { if (it.isEmpty()) 0..0 else it.first()..it.last() }
            }
        }
    LaunchedEffect(reader.scrollTarget) {
        val target = reader.scrollTarget
        if (target >= 0 || target == -2) {
            reader.scroll.scrollToItem(if (target == -2) 0 else target + offset)
            reader.scrollTarget = -1
        }
    }
    LaunchedEffect(state.zoom) {
        withFrameNanos {}
        horizontal.scrollTo(horizontal.maxValue / 2)
    }
    LaunchedEffect(state.work.stableId) {
        snapshotFlow { reader.scroll.layoutInfo }
            .collect { layout ->
                if (
                    shown >= .99f &&
                        layout.visibleItemsInfo.any {
                            it.index - currentOffset in state.media.indices
                        }
                ) {
                    val center = (layout.viewportStartOffset + layout.viewportEndOffset) / 2
                    val page =
                        layout.visibleItemsInfo
                            .filter { it.index - currentOffset in state.media.indices }
                            .minBy { abs(it.offset + it.size / 2 - center) }
                            .index - currentOffset
                    if (state.page != page) {
                        state.page = page
                        state.updateLink()
                    }
                }
            }
    }
    BoxWithConstraints(
        Modifier.fillMaxSize()
            .pointerInput(state) {
                detectTapGestures(
                    onTap = { state.toggleHidden() },
                    onDoubleTap = { state.setScale(if (state.zoom < 1.5f) 2f else 1f) },
                )
            }
            .pointerInput(state, "continuous-pinch") {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        if (event.changes.count { it.pressed } > 1) {
                            state.setScale(state.zoom * event.calculateZoom())
                            event.changes.forEach { it.consume() }
                        }
                    } while (event.changes.any { it.pressed })
                }
            }
    ) {
        val viewportWidth = maxWidth
        val width = viewportWidth * state.zoom.coerceIn(.1f, 4f)
        Box(Modifier.fillMaxSize().horizontalScroll(horizontal)) {
            LazyColumn(
                Modifier.width(maxOf(viewportWidth, width)).fillMaxHeight(),
                state = reader.scroll,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                reader.episodes.previous?.let { episode ->
                    item(key = "previous-episode") {
                        EpisodeCard("上一话", episode) { reader.openEpisode(episode) }
                    }
                }
                itemsIndexed(state.media, key = { _, media -> media.url }) { index, media ->
                    val ratio =
                        if (media.width > 0 && media.height > 0)
                            media.width.toFloat() / media.height
                        else 2f / 3f
                    if (index in visible.first - 3..visible.last + 3)
                        ReaderPage(
                            state,
                            index,
                            Modifier.width(width).height(width / ratio),
                            progress,
                            continuous = true,
                        )
                    else
                        Box(
                            Modifier.width(width)
                                .height(width / ratio)
                                .background(Color(0xff151515))
                        )
                }
                reader.episodes.next?.let { episode ->
                    item(key = "next-episode") {
                        EpisodeCard("下一话", episode) { reader.openEpisode(episode) }
                    }
                }
            }
        }
    }
}

@Composable
private fun EpisodeCard(label: String, episode: WorkSummaryWire, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().height(150.dp), contentAlignment = Alignment.Center) {
        GlassSurface(Modifier.widthIn(max = 420.dp).padding(16.dp)) {
            Action("$label：${episode.title}", onClick = onClick)
        }
    }
}
