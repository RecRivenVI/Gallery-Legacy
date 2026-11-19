package gallery

import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.interaction.*
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.*
import kotlinx.coroutines.*

@Composable
fun Pager(state: GalleryState, narrow: Boolean, modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier.then(semanticControl("group", "页码条"))) {
        val summaryWidth = Metrics.pageJumpSize + grouped(state.totalPages.toLong()).length * 8 + 64
        val bandAvailable = (maxWidth.value - summaryWidth - 178).coerceAtLeast(36f)
        Row(
            horizontalArrangement = Arrangement.spacedBy(Metrics.pageInset.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (narrow)
                GlassSurface(radius = Metrics.panelRadius.dp, opacity = Metrics.panelGlassOpacity) {
                    Row(Modifier.padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        PageArrow(state, false)
                        JumpPage(state, true)
                        PageArrow(state, true)
                    }
                }
            else {
                GlassSurface(radius = Metrics.panelRadius.dp, opacity = Metrics.panelGlassOpacity) {
                    Row(Modifier.padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconAction("first", "第一页", enabled = state.route.page > 1) {
                            state.navigate(state.route.copy(page = 1))
                        }
                        PageArrow(state, false)
                        PageDivider()
                        PageBand(state, bandAvailable)
                        PageDivider()
                        PageArrow(state, true)
                        IconAction("last", "最后一页", enabled = state.route.page < state.totalPages) {
                            state.navigate(state.route.copy(page = state.totalPages))
                        }
                    }
                }
                GlassSurface(radius = Metrics.panelRadius.dp, opacity = Metrics.panelGlassOpacity) {
                    JumpPage(state, false)
                }
            }
        }
    }
}

@Composable
private fun PageArrow(state: GalleryState, next: Boolean) {
    IconAction(
        if (next) "right" else "left",
        if (next) "下一页" else "上一页",
        enabled = if (next) state.route.page < state.totalPages else state.route.page > 1,
    ) {
        state.navigate(state.route.copy(page = state.route.page + if (next) 1 else -1))
    }
}

@Composable
private fun PageDivider() {
    Box(
        Modifier.padding(horizontal = 4.dp)
            .width(1.dp)
            .height(20.dp)
            .background(LocalPalette.current.divider)
    )
}

@Composable
private fun JumpPage(state: GalleryState, phone: Boolean) {
    val p = LocalPalette.current
    val currentPage = state.route.page.toString()
    var editing by remember { mutableStateOf(false) }
    var text by remember(state.route.page) { mutableStateOf(state.route.page.toString()) }
    Row(
        Modifier.height((Metrics.pageHeight + 8).dp).padding(horizontal = Metrics.pageInset.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (!phone) Label("第", color = p.faint)
        Box(Modifier.size(Metrics.pageJumpSize.dp)) {
            if (editing)
                Field(
                    text,
                    { text = it.filter(Char::isDigit).take(7) },
                    modifier = Modifier.fillMaxSize(),
                    onEnter = {
                        val page =
                            text.toIntOrNull()?.coerceIn(1, state.totalPages) ?: state.route.page
                        editing = false
                        if (page != state.route.page) state.navigate(state.route.copy(page = page))
                    },
                    autoFocus = true,
                    onEscape = { editing = false },
                    onBlur = { editing = false },
                    compact = true,
                    textAlign = TextAlign.Center,
                    fontSize = pageNumberFontSize(text, Metrics.pageJumpSize),
                    description = "跳到指定页",
                )
            else
                Action(
                    currentPage,
                    description = "跳到指定页",
                    modifier = Modifier.fillMaxSize(),
                    centered = true,
                    fontSize = pageNumberFontSize(currentPage, Metrics.pageJumpSize),
                ) {
                    text = currentPage
                    editing = true
                }
        }
        Label("/ " + grouped(state.totalPages.toLong()) + if (phone) "" else " 页", color = p.faint)
    }
}

@Composable
private fun PageBand(state: GalleryState, available: Float) {
    val count = state.totalPages
    val buttonSize = Metrics.pageHeight
    val step = buttonSize + Metrics.pageGap
    val width =
        minOf(
            Metrics.pageBandMax,
            available,
            count * step - Metrics.pageGap,
        )
    val maximum = (count * step - Metrics.pageGap - width).coerceAtLeast(0f)
    val position = state.pageBand
    val offset = { position.value.coerceIn(0f, maximum) }
    val scope = state.scope
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val left by remember(maximum) { derivedStateOf { offset() > .5f } }
    val right by remember(maximum) { derivedStateOf { offset() < maximum - .5f } }
    val leftArrow by animateFloatAsState(if (hovered && left) 1f else 0f, tween(220))
    val rightArrow by animateFloatAsState(if (hovered && right) 1f else 0f, tween(220))
    val visible by
        remember(step, width, count) {
            derivedStateOf { visiblePageRange(offset(), step, width, count) }
        }
    LaunchedEffect(state.route.page, count, width) {
        val target = pageBandTarget(state.route.page, count, step, width)
        if (!state.pageBandInitialized || state.reduceMotion) position.snapTo(target)
        else {
            val velocity = position.velocity
            state.scope.launch {
                position.animateTo(
                    target,
                    spring(dampingRatio = 1f, stiffness = 324f),
                    initialVelocity = velocity,
                )
            }
        }
        state.pageBandInitialized = true
    }
    Box(
        Modifier.width(width.dp)
            .height(buttonSize.dp)
            .hoverable(interaction)
            .then(semanticControl("group", "页码带"))
    ) {
        Box(
            Modifier.fillMaxSize()
                .clipToBounds()
                .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
                .drawWithContent {
                    drawContent()
                    val fade = Metrics.pageFade.dp.toPx().coerceAtMost(size.width / 3)
                    val l = (offset().dp.toPx() / fade).coerceIn(0f, 1f)
                    val r = ((maximum - offset()).dp.toPx() / fade).coerceIn(0f, 1f)
                    drawRect(
                        Brush.horizontalGradient(
                            listOf(Color.Black.copy(alpha = 1 - l), Color.Black),
                            0f,
                            fade,
                        ),
                        blendMode = BlendMode.DstIn,
                    )
                    drawRect(
                        Brush.horizontalGradient(
                            listOf(Color.Black, Color.Black.copy(alpha = 1 - r)),
                            size.width - fade,
                            size.width,
                        ),
                        blendMode = BlendMode.DstIn,
                    )
                }
        ) {
            for (index in visible) key(index) {
                val number = (index + 1).toString()
                Action(
                    number,
                    selected = state.route.page == index + 1,
                    centered = true,
                    fontSize = pageNumberFontSize(number, buttonSize),
                    modifier =
                        Modifier.size(buttonSize.dp).graphicsLayer {
                            translationX = (index * step - offset()).dp.toPx()
                        },
                ) {
                    state.navigate(state.route.copy(page = index + 1))
                }
            }
        }
        if (leftArrow > 0)
            IconAction("left", "向左滚动", Modifier.align(Alignment.CenterStart).alpha(leftArrow)) {
                scope.launch {
                    position.animateTo(
                        (offset() - width * .75f).coerceAtLeast(0f),
                        spring(dampingRatio = 1f, stiffness = 324f),
                    )
                }
            }
        if (rightArrow > 0)
            IconAction("right", "向右滚动", Modifier.align(Alignment.CenterEnd).alpha(rightArrow)) {
                scope.launch {
                    position.animateTo(
                        (offset() + width * .75f).coerceAtMost(maximum),
                        spring(dampingRatio = 1f, stiffness = 324f),
                    )
                }
            }
    }
}

private fun pageNumberFontSize(number: String, buttonSize: Int): Int =
    ((buttonSize - 4) / (number.length.coerceAtLeast(1) * .62f)).toInt().coerceAtMost(13)
