package gallery

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.interaction.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.focus.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.input.key.*
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable
fun GalleryApp(state: GalleryState, width: Int, height: Int) {
    LaunchedEffect(state) {
        while (kotlinx.coroutines.currentCoroutineContext().isActive) {
            kotlinx.coroutines.delay(5000)
            if (state.autoRefresh && state.pendingAutomaticRefresh && !state.loading) {
                state.pendingAutomaticRefresh = false
                state.refreshVisible()
            }
        }
    }
    val p = LocalPalette.current
    val narrow = width < 900
    val sidebar by
        animateDpAsState(
            if (state.expanded) 240.dp else 50.dp,
            if (state.reduceMotion) snap() else spring(dampingRatio = 1f, stiffness = 324f),
        )
    val split = state.viewer?.split == true && width >= 1280 && !coarsePointer()
    val modal = state.panel.isNotEmpty() || state.drawer || (!split && state.viewer != null)
    val mainFocus = remember { FocusRequester() }
    LaunchedEffect(modal) { if (!modal) mainFocus.requestFocus() }
    val gridShare by
        animateFloatAsState(
            if (split) .5f else 1f,
            if (state.reduceMotion) snap() else spring(dampingRatio = 1f, stiffness = 324f),
        )
    val backgroundLayer = rememberGraphicsLayer()
    val backgroundBackdrop = remember { Backdrop(backgroundLayer) }
    val gridLayer = rememberGraphicsLayer()
    val gridBackdrop = remember { Backdrop(gridLayer) }
    val viewerLayer = rememberGraphicsLayer()
    val viewerBackdrop = remember { Backdrop(viewerLayer) }
    val resultsLayer = rememberGraphicsLayer()
    val resultsBackdrop = remember { Backdrop(resultsLayer) }
    CompositionLocalProvider(
        LocalImageBackground provides state.background.isNotEmpty(),
        LocalBackdrop provides backgroundBackdrop,
    ) {
        Box(
            Modifier.fillMaxSize().onPreviewKeyEvent { event ->
                if (
                    event.type == KeyEventType.KeyDown &&
                        event.key == Key.Escape &&
                        (state.panel.isNotEmpty() || state.drawer)
                ) {
                    if (state.panel == "background") state.panel = "settings" else state.panel = ""
                    state.drawer = false
                    true
                } else false
            }
        ) {
            Box(
                Modifier.fillMaxSize()
                    .focusRequester(mainFocus)
                    .focusRestorer()
                    .focusGroup()
                    .then(
                        semanticControl(
                            "group",
                            hidden =
                                state.panel.isNotEmpty() ||
                                    state.drawer ||
                                    (!split && state.viewer != null),
                        )
                    )
                    .captureBackdrop(gridBackdrop)
            ) {
                Box(Modifier.fillMaxSize().captureBackdrop(backgroundBackdrop).background(p.bg)) {
                    if (state.background.isNotEmpty()) {
                        MediaImage(state.background, Modifier.fillMaxSize())
                        Box(Modifier.fillMaxSize().background(p.bg.copy(alpha = state.dim)))
                    }
                }
                Row(Modifier.fillMaxSize()) {
                    if (!narrow)
                        Sidebar(state, Modifier.width(sidebar).fillMaxHeight(), state.expanded)
                    Row(Modifier.weight(1f).fillMaxHeight()) {
                        Column(Modifier.fillMaxWidth(gridShare).fillMaxHeight()) {
                            GalleryHeader(state, narrow, width)
                            Box(Modifier.weight(1f)) {
                                GalleryResults(
                                    state,
                                    Modifier.fillMaxSize().captureBackdrop(resultsBackdrop),
                                    narrow,
                                )
                                if (
                                    !state.loading &&
                                        state.error.isEmpty() &&
                                        state.items.isNotEmpty() &&
                                        state.totalPages > 1
                                )
                                    CompositionLocalProvider(
                                        LocalBackdrop provides resultsBackdrop
                                    ) {
                                        Pager(
                                            state,
                                            narrow,
                                            Modifier.align(Alignment.BottomCenter)
                                                .padding(bottom = Metrics.pageBottom.dp),
                                        )
                                    }
                            }
                        }
                        if (split)
                            Box(Modifier.weight(1f).fillMaxHeight()) {
                                Viewer(
                                    state.viewer!!,
                                    width / 2,
                                    Modifier.captureBackdrop(viewerBackdrop),
                                )
                            }
                    }
                }
            }
            AnimatedVisibility(
                narrow && state.drawer,
                enter = fadeIn(tween(if (state.reduceMotion) 0 else 220)),
                exit = fadeOut(tween(if (state.reduceMotion) 0 else 220)),
            ) {
                Box(
                    Modifier.fillMaxSize()
                        .background(Color.Black.copy(alpha = .4f))
                        .clickable {
                            state.drawer = false
                        }
                        .clearAndSetSemantics {}
                )
            }
            val density = androidx.compose.ui.platform.LocalDensity.current
            AnimatedVisibility(
                narrow && state.drawer,
                enter =
                    slideInHorizontally(tween(if (state.reduceMotion) 0 else 220)) {
                        -with(density) { Metrics.sidebar.dp.roundToPx() }
                    },
                exit =
                    slideOutHorizontally(tween(if (state.reduceMotion) 0 else 220)) {
                        -with(density) { Metrics.sidebar.dp.roundToPx() }
                    },
            ) {
                ModalLayer("导航", { state.drawer = false }, active = state.panel.isEmpty()) {
                    Sidebar(state, Modifier.width(240.dp).fillMaxHeight(), true)
                }
            }
            if (state.people.error.isNotEmpty() && state.panel.isEmpty() && state.viewer == null) {
                Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 72.dp)) {
                    GlassSurface(Modifier.padding(12.dp)) {
                        Label(state.people.error, Modifier.padding(12.dp), color = p.error)
                    }
                }
            }
            val viewer = state.viewer
            if (viewer != null && !split)
                ModalLayer(
                    "看大图",
                    viewer::close,
                    active = state.panel.isEmpty(),
                    autoFocus = false,
                ) {
                    Viewer(viewer, width, Modifier.captureBackdrop(viewerBackdrop))
                }
            if (viewer == null && !state.drawer) SearchCompletion(state)
            if (state.panel.isNotEmpty())
                CompositionLocalProvider(
                    LocalBackdrop provides if (viewer != null) viewerBackdrop else gridBackdrop,
                    LocalGlassMasks provides viewer?.glassMasks,
                ) {
                    GalleryPanel(state, width, height)
                }
        }
    }
    LaunchedEffect(width) { if (width < 1280 || coarsePointer()) state.viewer?.split = false }
}
