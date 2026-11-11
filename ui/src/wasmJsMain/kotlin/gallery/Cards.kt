package gallery

import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.interaction.*
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.input.pointer.*
import androidx.compose.ui.layout.*
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

fun Modifier.edgeFade(scroll: ScrollState): Modifier = graphicsLayer {
    compositingStrategy = CompositingStrategy.Offscreen
}
    .drawWithContent {
        drawContent()
        val fade = 24.dp.toPx().coerceAtMost(size.width / 3)
        if (scroll.value > 0)
            drawRect(
                Brush.horizontalGradient(listOf(Color.Transparent, Color.Black), 0f, fade),
                blendMode = BlendMode.DstIn,
            )
        if (scroll.value < scroll.maxValue)
            drawRect(
                Brush.horizontalGradient(
                    listOf(Color.Black, Color.Transparent),
                    size.width - fade,
                    size.width,
                ),
                blendMode = BlendMode.DstIn,
            )
    }

@Composable
fun OverflowLine(
    value: String,
    hover: Boolean,
    modifier: Modifier = Modifier,
    color: Color = LocalPalette.current.fg,
    bold: Boolean = false,
    size: Int = 13,
) {
    val scroll = rememberScrollState()
    val reduced = LocalReducedMotion.current
    LaunchedEffect(hover, value, scroll.maxValue, reduced) {
        if (reduced) {
            scroll.scrollTo(0)
            return@LaunchedEffect
        }
        if (hover && scroll.maxValue > 0) {
            delay(300)
            scroll.animateScrollTo(
                scroll.maxValue,
                tween((scroll.maxValue * 1000 / 33).coerceAtLeast(220), easing = LinearEasing),
            )
        } else if (scroll.value > 0) scroll.animateScrollTo(0, tween(220))
    }
    Box(modifier.clipToBounds().edgeFade(scroll)) {
        Row(Modifier.horizontalScroll(scroll)) {
            Label(value, color = color, bold = bold, size = size, maxLines = 1)
        }
    }
}

@Composable
fun Tags(
    tags: List<TagWire>,
    state: GalleryState,
    hover: Boolean,
    onImage: Boolean = false,
    wrap: Boolean = false,
) {
    val scroll = rememberScrollState()
    val strings = tags.map { it.label }
    if (strings.isEmpty()) return
    if (wrap) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            strings.forEach { tag -> TagChip(tag, state, false) }
        }
        return
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (scroll.value > 0)
            IconAction("left", "向左滚动", Modifier.size(24.dp)) {
                state.scope.launch { scroll.animateScrollTo((scroll.value - 120).coerceAtLeast(0)) }
            }
        Row(
            Modifier.weight(1f).clipToBounds().edgeFade(scroll).horizontalScroll(scroll),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            strings.forEach { tag ->
                TagChip(tag, state, onImage)
            }
        }
        if (scroll.value < scroll.maxValue)
            IconAction("right", "向右滚动", Modifier.size(24.dp)) {
                state.scope.launch {
                    scroll.animateScrollTo((scroll.value + 120).coerceAtMost(scroll.maxValue))
                }
            }
    }
    val reduced = LocalReducedMotion.current
    LaunchedEffect(hover, scroll.maxValue, reduced) {
        if (reduced) {
            scroll.scrollTo(0)
            return@LaunchedEffect
        }
        if (hover) {
            delay(300)
            scroll.animateScrollTo(
                scroll.maxValue,
                tween((scroll.maxValue * 1000 / 33).coerceAtLeast(220), easing = LinearEasing),
            )
        } else scroll.animateScrollTo(0, tween(220))
    }
}

@Composable
private fun TagChip(tag: String, state: GalleryState, onImage: Boolean) {
    val p = LocalPalette.current
    val chip =
        Modifier.height(if (onImage) 20.dp else 22.dp).keyboardFocus(GalleryShape(4.dp)).clickable {
            state.filters.includeTag(tag)
        }
    if (onImage)
        GlassSurface(chip, radius = 2.dp, color = Color.Black, opacity = .6f) {
            Box(
                Modifier.fillMaxHeight().padding(horizontal = 7.dp),
                contentAlignment = Alignment.Center,
            ) {
                Label(tag, color = Color.White, size = 11, maxLines = 1)
            }
        }
    else
        Box(
            chip.clip(GalleryShape(4.dp)).background(p.tag).padding(horizontal = 7.dp),
            contentAlignment = Alignment.Center,
        ) {
            Label(tag, color = p.fg2, size = 11, maxLines = 1)
        }
}

@Composable
fun ContentCard(
    state: GalleryState,
    item: ContentItem,
    list: Boolean,
    modifier: Modifier = Modifier,
) {
    val p = LocalPalette.current
    val interactions = remember { MutableInteractionSource() }
    val hovered by interactions.collectIsHoveredAsState()
    var longPress by remember { mutableStateOf(false) }
    val hover = hovered || longPress
    var spread by remember { mutableStateOf(false) }
    var previews by remember(itemKey(item)) { mutableStateOf<List<MediaSummaryWire>>(emptyList()) }
    LaunchedEffect(hover) {
        if (hover && !state.reduceMotion) {
            delay(120)
            spread = true
            if (!item.isAuthor && !item.isFolder && !item.isFile && previews.isEmpty())
                try {
                    previews =
                        resolveWork(item.stableId).let { work ->
                            visibleMedia(work).filter { it.id != work.cover?.id }.take(3)
                        }
                } catch (_: Exception) {
                    previews = emptyList()
                }
        } else spread = false
    }
    val selected = state.viewer?.work?.stableId == item.stableId
    val outer =
        modifier
            .fillMaxWidth()
            .zIndex(if (hover) 2f else 0f)
            .hoverable(interactions)
            .keyboardFocus(GalleryShape(6.dp))
            .combinedClickable(
                interactionSource = interactions,
                indication = null,
                onLongClick = {
                    if (state.route.kind == "history") {
                        state.people.selectedWork = item.work
                        state.panel = "history-work"
                    } else longPress = !longPress
                },
                onClick = {
                    longPress = false
                    state.open(item)
                },
            )
            .onWebPointerEvent(PointerEventType.Press) { e ->
                if (e.buttons.isSecondaryPressed && state.route.kind == "history") {
                    state.people.selectedWork = item.work
                    state.panel = "history-work"
                    e.changes.forEach { it.consume() }
                }
            }
            .semantics { contentDescription = title(item) }
            .then(if (selected) Modifier.border(2.dp, p.fg, GalleryShape(6.dp)) else Modifier)
    val privacy = if (state.privacy) Modifier.blur(18.dp) else Modifier
    if (list)
        Row(
            outer.height(100.dp).then(privacy),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Cover(item, state, Modifier.size(64.dp), hover, spread, previews)
            Row(Modifier.weight(.45f), verticalAlignment = Alignment.CenterVertically) {
                OverflowLine(title(item), hover, Modifier.weight(1f), bold = true)
                if (!item.isAuthor && !item.isFolder && !item.isFile)
                    CardFavorite(state, item.work, hover)
            }
            OverflowLine(author(item), hover, Modifier.weight(.25f), p.muted)
            Label(
                item.publishedAtMs.takeIf { it > 0 }?.let { isoDate(it.toDouble()) }.orEmpty(),
                Modifier.width(90.dp),
                p.faint,
                11,
            )
            Label(
                grouped(if (item.isAuthor) item.workCount else item.counts.media),
                Modifier.width(40.dp),
                p.faint,
                11,
            )
        }
    else
        Column(outer.then(privacy), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Cover(
                item,
                state,
                Modifier.fillMaxWidth()
                    .aspectRatio(if (item.isAuthor) 1f else Metrics.ratios[state.ratio] ?: 1f),
                hover,
                spread,
                previews,
            )
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                OverflowLine(title(item), hover, Modifier.weight(1f), bold = true)
                if (!item.isAuthor && !item.isFolder && !item.isFile)
                    CardFavorite(state, item.work, hover)
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                if (!state.hideAvatars) Fluent("author", size = 16, color = p.faint)
                OverflowLine(
                    if (item.isAuthor)
                        listOf(
                                (if (state.filters.mixed)
                                    (platformBadges[item.work.platformId] + " · ")
                                else "") + item.authorEntry?.handle.orEmpty(),
                                grouped(item.workCount) + " 个作品",
                                item.latestAtMs
                                    .takeIf { it > 0 }
                                    ?.let { isoDate(it.toDouble()) }
                                    .orEmpty(),
                            )
                            .filter { it.isNotEmpty() }
                            .joinToString(" · ")
                    else author(item),
                    hover,
                    Modifier.fillMaxWidth(),
                    p.muted,
                    size = 12,
                )
            }
        }
}

@Composable
private fun Cover(
    item: ContentItem,
    state: GalleryState,
    modifier: Modifier,
    hover: Boolean,
    spread: Boolean,
    previews: List<MediaSummaryWire>,
) {
    val p = LocalPalette.current
    val layer = rememberGraphicsLayer()
    val backdrop = remember { Backdrop(layer) }
    Box(modifier.onGloballyPositioned { state.cardBounds[itemKey(item)] = it.boundsInWindow() }) {
        previews.forEachIndexed { index, media ->
            val x = listOf(-.19f, .18f, .02f)[index]
            val y = listOf(-.10f, -.13f, -.21f)[index]
            val r = listOf(-9f, 8f, -2f)[index]
            val animation = remember { Animatable(0f) }
            LaunchedEffect(spread) {
                if (spread) delay(index * 30L)
                animation.animateTo(
                    if (spread) 1f else 0f,
                    if (state.reduceMotion) snap() else spring(dampingRatio = 1f, stiffness = 324f),
                )
            }
            val progress = animation.value
            Thumbnail(
                media,
                Modifier.fillMaxSize()
                    .graphicsLayer {
                        translationX = size.width * x * progress
                        translationY = size.height * y * progress
                        rotationZ = r * progress
                        alpha = progress
                        scaleX = .8f - index * .02f
                        scaleY = scaleX
                    }
                    .clip(GalleryShape(6.dp)),
            )
        }
        Box(Modifier.fillMaxSize().clip(GalleryShape(6.dp)).background(p.tint)) {
            Box(Modifier.fillMaxSize().captureBackdrop(backdrop)) {
                when {
                    item.isFolder -> Fluent("folder", Modifier.align(Alignment.Center), p.faint, 48)
                    item.isAuthor -> Collage(item.collage)
                    item.cover == null ->
                        Fluent("gallery", Modifier.align(Alignment.Center), p.faint, 48)
                    else -> Thumbnail(item.cover, Modifier.fillMaxSize())
                }
            }
            val readPage = item.work.personal?.page ?: 0
            val readablePages =
                item.work.personal?.totalPages?.takeIf { it > 0 } ?: item.counts.media
            if (readPage > 0 && readPage < readablePages)
                Box(
                    Modifier.align(Alignment.BottomStart)
                        .fillMaxWidth()
                        .height(2.dp)
                        .background(p.tint)
                ) {
                    Box(
                        Modifier.fillMaxHeight()
                            .fillMaxWidth(readPage.toFloat() / readablePages)
                            .background(p.fg)
                    )
                }
            CompositionLocalProvider(LocalBackdrop provides backdrop) {
                if (!item.isAuthor && !item.isFolder) {
                    val counts = item.counts.media
                    if (counts > 1)
                        Chip(grouped(counts), Modifier.align(Alignment.TopEnd).padding(6.dp))
                    val badges = buildList {
                        if (state.filters.mixed && !item.isFile)
                            platformBadges[item.work.platformId]?.let { add(it) }
                        if (
                            item.work.platformId == "pixiv" &&
                                item.work.details?.rating in listOf(1L, 2L)
                        )
                            add(if (item.work.details?.rating == 2L) "R-18G" else "R-18")
                        if (item.work.platformId == "pixiv" && item.flags.aiGenerated == true)
                            add("AI")
                        if (item.cover?.type == "video") add("视频")
                    }
                    if (badges.isNotEmpty())
                        Chip(
                            badges.joinToString(" · "),
                            Modifier.align(Alignment.TopStart).padding(6.dp),
                        )
                    if (item.tags.isNotEmpty())
                        Box(Modifier.align(Alignment.BottomStart).padding(6.dp)) {
                            Tags(item.tags, state, hover, true)
                        }
                }
            }
        }
    }
}

@Composable
fun Collage(media: List<MediaSummaryWire>) {
    if (media.isEmpty())
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Fluent("author", color = LocalPalette.current.faint, size = 48)
        }
    else
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            Thumbnail(
                media[0],
                Modifier.weight(if (media.size >= 3) 2f else 1f).fillMaxHeight(),
            )
            if (media.size == 2) Thumbnail(media[1], Modifier.weight(1f).fillMaxHeight())
            else if (media.size >= 3)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Thumbnail(media[1], Modifier.weight(1f).fillMaxWidth())
                    Thumbnail(media[2], Modifier.weight(1f).fillMaxWidth())
                }
        }
}

@Composable
fun Chip(text: String, modifier: Modifier = Modifier) {
    Box(
        modifier
            .clip(GalleryShape(2.dp))
            .background(Color.Black.copy(alpha = .6f))
            .border(1.dp, Color.White.copy(alpha = .1f), GalleryShape(2.dp))
            .padding(horizontal = 7.dp, vertical = 3.dp)
    ) {
        Label(text, color = Color.White, size = 11, maxLines = 1)
    }
}
