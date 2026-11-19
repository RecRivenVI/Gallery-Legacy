package gallery

import androidx.compose.animation.AnimatedContent
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
fun ReaderStage(
    state: ViewerState,
    phone: Boolean,
    progress: State<Float>,
    useFlight: Boolean,
    onPageBounds: (Rect) -> Unit,
) {
    val density = LocalDensity.current
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
        Box(Modifier.fillMaxSize()) {
            if (state.reading.options.mode == "continuous")
                ContinuousPages(state, progress, useFlight, onPageBounds)
            else {
                val spread = state.reading.spread.mapNotNull { state.media.getOrNull(it) }
                AnimatedContent(
                    spread,
                    Modifier.fillMaxSize().viewerGestures(state, phone).graphicsLayer {
                        scaleX = state.zoom
                        scaleY = state.zoom
                        translationX = state.pan.x
                        translationY = state.pan.y
                    },
                    transitionSpec = { mediaFade(state.gallery.reduceMotion) },
                    contentKey = { pages -> pages.map { it.url } },
                ) { pages ->
                    Row(Modifier.fillMaxSize()) {
                        val ordered = if (state.reading.options.rtl) pages.reversed() else pages
                        ordered.forEach { media ->
                            ReaderPage(
                                state,
                                media,
                                Modifier.weight(1f).fillMaxHeight(),
                                progress,
                                useFlight,
                                onPageBounds,
                                claimed = true,
                            )
                        }
                    }
                }
            }
        }
        CompositionLocalProvider(LocalBackdrop provides null) {
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
    media: MediaSummaryWire,
    modifier: Modifier,
    progress: State<Float>,
    useFlight: Boolean,
    onPageBounds: (Rect) -> Unit,
    claimed: Boolean,
) {
    val large = media.url
    var loaded by remember(large, state.retry) { mutableStateOf(false) }
    var failed by remember(large, state.retry) { mutableStateOf(false) }
    var delayed by remember(large, state.retry) { mutableStateOf(false) }
    LaunchedEffect(large, state.retry) {
        delay(1000)
        delayed = true
    }
    val primary = media.url == state.current?.url
    if (claimed) {
        DisposableEffect(media.url) {
            state.showMedia(media.url)
            onDispose { state.hideMedia(media.url) }
        }
    }
    Box(
        modifier
            .then(
                if (primary && useFlight)
                    Modifier.onGloballyPositioned {
                        onPageBounds(
                            Rect(
                                it.positionInWindow(),
                                Size(it.size.width.toFloat(), it.size.height.toFloat()),
                            )
                        )
                    }
                else Modifier
            )
            .graphicsLayer {
                val frame = progress.value
                alpha =
                    if (primary) {
                        if (useFlight && frame < .995f) 0f else 1f
                    } else ((frame - .3f) / .7f).coerceIn(0f, 1f)
            }
    ) {
        Box(Modifier.fillMaxSize()) {
            key(media.url, state.retry) {
                if (!loaded)
                    MediaImage(
                        state.previewFor(media).thumbnailUrl,
                        Modifier.fillMaxSize(),
                        fit = true,
                        placeholder = false,
                        onInfo = { w, h, animated ->
                            state.mediaInfo(media.relativePath, w, h, animated)
                        },
                    )
                MediaImage(
                    large,
                    Modifier.fillMaxSize(),
                    fit = true,
                    placeholder = false,
                    onLoaded = { loaded = true },
                    onError = { failed = true },
                    onInfo = { w, h, animated ->
                        state.mediaInfo(media.relativePath, w, h, animated)
                    },
                )
            }
        }
        CompositionLocalProvider(LocalBackdrop provides null) {
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
private fun ContinuousPages(
    state: ViewerState,
    progress: State<Float>,
    useFlight: Boolean,
    onPageBounds: (Rect) -> Unit,
) {
    val reader = state.reading
    val horizontal = rememberScrollState()
    val density = LocalDensity.current
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
                    progress.value >= .99f &&
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
                        state.selectPage(page)
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
                            media,
                            Modifier.width(width).height(width / ratio),
                            progress,
                            useFlight,
                            onPageBounds,
                            claimed = index in visible,
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
