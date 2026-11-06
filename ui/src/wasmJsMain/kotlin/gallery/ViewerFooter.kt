package gallery

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.focus.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.*
import androidx.compose.ui.layout.*
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable
internal fun ViewerFooter(state: ViewerState, phone: Boolean, modifier: Modifier) {
    val p = LocalPalette.current
    val scroll = rememberLazyListState()
    var stripWidth by remember { mutableFloatStateOf(100f) }
    val density = androidx.compose.ui.platform.LocalDensity.current
    val works = state.neighbors.ifEmpty { listOf(state.work) }
    val strip =
        buildList<Pair<WorkSummaryWire, Int>> {
                works.forEachIndexed { i, w ->
                    if (i > 0) add(w to -1)
                    visibleMedia(w).indices.forEach { add(w to it) }
                }
            }
            .let {
                if (state.reading.options.rtl && state.reading.options.mode != "continuous")
                    it.reversed()
                else it
            }
    val index =
        strip
            .indexOfFirst {
                it.first.stableId == state.work.stableId && it.second == state.page
            }
            .coerceAtLeast(0)
    LaunchedEffect(index, stripWidth, strip.size) {
        if (state.gallery.reduceMotion) scroll.scrollToItem(index)
        else scroll.animateScrollToItem(index)
    }
    Row(
        modifier.fillMaxWidth().background(p.glass.copy(alpha = .9f)).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (state.reading.resumePage >= 0)
            Action("从第 ${state.reading.resumePage+1} 页继续") {
                state.reading.select(state.reading.resumePage)
                state.reading.resumePage = -1
            }
        if (!phone)
            Label(
                (if (state.reading.options.mode == "double" && state.reading.spread.size > 1)
                    "${state.reading.spread.first()+1}–${state.reading.spread.last()+1}"
                else (state.page + 1).toString()) + " / " + state.media.size,
                Modifier.widthIn(min = 64.dp),
                color = p.faint,
            )
        IconAction("left", "上一个作品") { state.neighbor(state.reading.physicalDelta(-1)) }
        LazyRow(
            Modifier.weight(1f)
                .onSizeChanged { stripWidth = with(density) { it.width.toDp().value } }
                .clipToBounds(),
            state = scroll,
            contentPadding = PaddingValues(horizontal = (stripWidth / 2 - 24).coerceAtLeast(0f).dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            itemsIndexed(
                strip,
                key = { _, pair -> pair.first.stableId + ":" + pair.second },
            ) { _, pair ->
                val (work, page) = pair
                if (page < 0)
                    Box(
                        Modifier.padding(horizontal = 4.dp)
                            .width(1.dp)
                            .height(40.dp)
                            .background(p.divider)
                    )
                else
                    Box(
                        Modifier.size(48.dp)
                            .alpha(if (work.stableId == state.work.stableId) 1f else .55f)
                            .clip(GalleryShape(4.dp))
                            .then(
                                if (work.stableId == state.work.stableId && page == state.page)
                                    Modifier.border(2.dp, p.fg, GalleryShape(4.dp))
                                else Modifier
                            )
                            .keyboardFocus(GalleryShape(4.dp))
                            .clickable {
                                state.direction = if (strip.indexOf(pair) > index) 1 else -1
                                if (work.stableId != state.work.stableId)
                                    state.changeWork(work, page)
                                else {
                                    state.reading.select(page)
                                    state.zoom = 1f
                                    state.pan = Offset.Zero
                                }
                                state.updateLink()
                            }
                            .semantics {
                                contentDescription = title(work) + " 第 " + (page + 1) + " 页"
                            }
                    ) {
                        Thumbnail(
                            visibleMedia(work)[page],
                            Modifier.fillMaxSize(),
                        )
                    }
            }
        }
        IconAction("right", "下一个作品") { state.neighbor(state.reading.physicalDelta(1)) }
        if (!phone)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Action("适应") { state.setScale(1f) }
                Action("100%") { state.setScale(state.actualScale()) }
                Action("−") { state.setScale(state.zoom / 1.25f) }
                Range(state.zoom, .1f, 8f, "缩放", Modifier.width(80.dp)) { state.setScale(it) }
                Action("+") { state.setScale(state.zoom * 1.25f) }
            }
    }
}
