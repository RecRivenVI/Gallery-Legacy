package gallery

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.focus.*
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.*
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.*
import androidx.compose.ui.layout.*
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*

@Composable
fun Viewer(state: ViewerState, width: Int, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    val phone = width < 700
    val progress = remember(state) { Animatable(0f) }
    val velocity = remember(state) { FloatArray(1) }
    val frame = remember(progress) { progress.asState() }
    val opened by remember(frame) { derivedStateOf { frame.value >= .995f } }
    val focus = remember { FocusRequester() }
    val galleryBackdrop = LocalBackdrop.current
    var stageBounds by remember(state) { mutableStateOf(Rect.Zero) }
    var viewerBounds by remember { mutableStateOf(Rect.Zero) }
    var readerPageBounds by
        remember(state, state.current?.url, state.reading.options.mode) {
            mutableStateOf(Rect.Zero)
        }
    var flightReady by remember(state) { mutableStateOf(false) }
    val useFlight =
        !state.split && !state.gallery.reduceMotion && state.origin != null && state.current != null
    val flightArea = if (state.reading.options.mode == "single") stageBounds else readerPageBounds
    SideEffect { state.flightProgress = frame }
    LaunchedEffect(state, state.closing) {
        withFrameNanos {}
        if (!state.closing && useFlight)
            withTimeoutOrNull(200) { snapshotFlow { flightReady }.first { it } }
        state.flightStarted = useFlight
        progress.animateTo(
            if (state.closing) 0f else 1f,
            if (state.gallery.reduceMotion) snap()
            else spring(dampingRatio = 1f, stiffness = 245f, visibilityThreshold = .002f),
            initialVelocity = velocity[0],
        ) {
            velocity[0] = this.velocity
        }
        if (state.closing) {
            Snapshot.withMutableSnapshot { state.gallery.viewer = null }
            writeHash(routeHash(state.gallery.route), true)
        }
    }
    LaunchedEffect(state.reading.menu, state.gallery.panel) {
        if (!state.reading.menu && state.gallery.panel.isEmpty()) focus.requestFocus()
    }
    LaunchedEffect(state.hidden) { if (state.hidden) focus.requestFocus() }
    LaunchedEffect(
        state.work.stableId,
        state.page,
        state.reading.options.mode,
        state.gallery.people.account?.id,
    ) {
        if (state.media.isNotEmpty())
            state.gallery.people.record(state.work, state.reading.progressPage)
    }
    DisposableEffect(state) { onDispose { state.dispose() } }
    val videoFullscreen by
        remember(state) {
            derivedStateOf { state.videoPlayback?.status?.fullscreen == true }
        }
    val detailWidth by
        animateDpAsState(
            if (state.details && !state.hidden && !state.split && !phone && !videoFullscreen) 240.dp
            else 0.dp,
            if (state.gallery.reduceMotion) snap() else spring(dampingRatio = 1f, stiffness = 324f),
        )
    val bars by
        animateFloatAsState(
            if (state.hidden || videoFullscreen) 0f else 1f,
            if (state.gallery.reduceMotion) snap() else spring(dampingRatio = 1f, stiffness = 324f),
        )
    val masks = state.glassMasks
    val pictureLayer = rememberGraphicsLayer()
    val pictureBackdrop = remember { Backdrop(pictureLayer) }
    CompositionLocalProvider(LocalGlassMasks provides masks) {
        Box(
            modifier
                .fillMaxSize()
                .onGloballyPositioned { viewerBounds = it.boundsInWindow() }
                .focusRequester(focus)
                .onKeyEvent { e ->
                    if (
                        e.type != KeyEventType.KeyDown ||
                            editingText() ||
                            e.isCtrlPressed ||
                            e.isMetaPressed ||
                            e.isAltPressed
                    )
                        false
                    else if (state.videoPlayback?.let { videoShortcut(it, e) } == true) true
                    else
                        when (e.key) {
                            Key.Escape -> {
                                state.dismiss()
                                true
                            }
                            Key.DirectionLeft -> {
                                if (e.isShiftPressed) state.neighbor(-1)
                                else state.flip(state.reading.physicalDelta(-1))
                                true
                            }
                            Key.DirectionRight -> {
                                if (e.isShiftPressed) state.neighbor(1)
                                else state.flip(state.reading.physicalDelta(1))
                                true
                            }
                            Key.F -> {
                                if (state.work.stableId.startsWith("/p/"))
                                    state.gallery.people.favorite(state.work)
                                true
                            }
                            Key.M -> {
                                if (state.reading.canUsePages)
                                    state.reading.menu = !state.reading.menu
                                true
                            }
                            Key.DirectionUp,
                            Key.DirectionDown,
                            Key.Spacebar -> {
                                if (state.reading.options.mode == "continuous") {
                                    val amount =
                                        if (e.key == Key.Spacebar) state.areaHeight * .8f else 80f
                                    state.gallery.scope.launch {
                                        state.reading.scroll.animateScrollBy(
                                            if (e.key == Key.DirectionUp || e.isShiftPressed)
                                                -amount
                                            else amount
                                        )
                                    }
                                    true
                                } else false
                            }
                            Key.I -> {
                                state.details = !state.details
                                saveStored("gallery_viewer_details", state.details.toString())
                                true
                            }
                            Key.H -> {
                                state.toggleHidden()
                                true
                            }
                            Key.Equals,
                            Key.Plus -> {
                                state.setScale(state.zoom * 1.25f)
                                true
                            }
                            Key.Minus -> {
                                state.setScale(state.zoom / 1.25f)
                                true
                            }
                            Key.Zero -> {
                                state.setScale(1f)
                                true
                            }
                            else -> false
                        }
                }
                .focusable()
                .semantics { paneTitle = "看大图" }
        ) {
            Box(Modifier.fillMaxSize().graphicsLayer { alpha = progress.value }) {
                if (!state.split && galleryBackdrop != null) ViewerBackdrop(galleryBackdrop)
                Box(
                    Modifier.fillMaxSize()
                        .background(p.bg.copy(alpha = if (state.split) 1f else .48f))
                )
            }
            Column(
                Modifier.fillMaxSize()
                    .graphicsLayer { alpha = progress.value }
                    .then(
                        if (phone && state.details && !state.split || state.reading.menu)
                            Modifier.captureBackdrop(pictureBackdrop)
                        else Modifier
                    )
            ) {
                if (bars > .01f)
                    Row(
                        Modifier.fillMaxWidth()
                            .graphicsLayer { translationY = -50.dp.toPx() * (1 - progress.value) }
                            .height((50 * bars).dp)
                            .background(p.glass.copy(alpha = .9f))
                            .padding(horizontal = 8.dp)
                            .clipToBounds(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        IconAction("close", "关闭", onClick = state::close)
                        Spacer(Modifier.weight(1f))
                        if (state.split) IconAction("expand", "完整看大图") { state.split = false }
                        if (state.reading.canUsePages)
                            IconAction("book", "阅读方式", selected = state.reading.menu) {
                                state.reading.menu = !state.reading.menu
                            }
                        if (state.work.stableId.startsWith("/p/"))
                            FavoriteButton(state.gallery, state.work)
                        IconAction("download", "下载") {
                            state.current?.let { download(it.url, it.fileName) }
                        }
                        IconAction("link", "复制链接") {
                            state.copy(pageAddress() + currentHash(), "已复制链接")
                        }
                        if (!state.split)
                            IconAction("panel-right", "详情栏", selected = state.details) {
                                state.details = !state.details
                                saveStored("gallery_viewer_details", state.details.toString())
                            }
                    }
                Row(Modifier.weight(1f)) {
                    Box(
                        Modifier.weight(1f).fillMaxHeight().onGloballyPositioned {
                            stageBounds = it.boundsInWindow()
                        }
                    ) {
                        if (state.reading.options.mode == "single") {
                            ViewerStage(state, phone, frame, opened, useFlight)
                            state.reading.episodePrompt?.let { episode ->
                                Box(Modifier.align(Alignment.Center)) {
                                    GlassSurface(Modifier.widthIn(max = 420.dp).padding(16.dp)) {
                                        Action(
                                            (if (
                                                episode.stableId ==
                                                    state.reading.episodes.next?.stableId
                                            )
                                                "下一话："
                                            else "上一话：") + episode.title
                                        ) {
                                            state.reading.openEpisode(episode)
                                        }
                                    }
                                }
                            }
                        } else
                            ReaderStage(state, phone, frame, useFlight) {
                                readerPageBounds = it
                            }
                    }
                    if (detailWidth > 0.dp)
                        Box(
                            Modifier.width(detailWidth)
                                .graphicsLayer {
                                    translationX =
                                        240.dp.toPx() *
                                            (1 - ((progress.value - .15f) / .85f).coerceIn(0f, 1f))
                                }
                                .fillMaxHeight()
                                .background(p.glass)
                                .clipToBounds()
                        ) {
                            Box(
                                Modifier.fillMaxHeight()
                                    .wrapContentWidth(Alignment.Start, unbounded = true)
                                    .width(240.dp)
                            ) {
                                ViewerDetails(state)
                            }
                        }
                }
                if (bars > .01f)
                    ViewerFooter(
                        state,
                        phone,
                        Modifier.height((64 * bars).dp)
                            .graphicsLayer {
                                translationY =
                                    64.dp.toPx() *
                                        (1 - ((progress.value - .08f) / .92f).coerceIn(0f, 1f))
                            }
                            .clipToBounds(),
                    )
            }
            CompositionLocalProvider(LocalBackdrop provides pictureBackdrop) {
                if (phone && state.details && !state.hidden && !state.split && !videoFullscreen)
                    GlassSurface(
                        Modifier.align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            .fillMaxHeight(.65f)
                            .clip(GalleryShape(topStart = 12.dp, topEnd = 12.dp))
                    ) {
                        Column(Modifier.fillMaxSize()) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                Action("收起") { state.details = false }
                            }
                            ViewerDetails(state)
                        }
                    }
                if (state.message.isNotEmpty())
                    Label(
                        state.message,
                        Modifier.align(Alignment.TopCenter)
                            .padding(16.dp)
                            .background(p.glass)
                            .padding(12.dp),
                    )
                if (state.reading.menu) ReadingMenu(state)
            }
            if (useFlight)
                ViewerFlight(state, progress, flightArea, stageBounds, viewerBounds.topLeft) {
                    flightReady = true
                }
        }
    }
    LaunchedEffect(state.message) {
        if (state.message.isNotEmpty()) {
            delay(1600)
            state.message = ""
        }
    }
}
