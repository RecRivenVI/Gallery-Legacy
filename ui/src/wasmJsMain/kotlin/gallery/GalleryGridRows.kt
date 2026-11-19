package gallery

import androidx.compose.animation.core.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.unit.*

internal fun LazyGridScope.resultCards(
    state: GalleryState,
    list: Boolean,
    kind: String,
    arrival: State<Float>?,
) {
    if (kind == "history") {
        var offset = 0
        state.items
            .groupBy { historyGroup(it.work.personal?.readAt ?: 0) }
            .forEach { (group, items) ->
                val base = offset
                offset += items.size
                item(key = "history:$group", span = { GridItemSpan(maxLineSpan) }) {
                    Label(
                        group,
                        Modifier.padding(top = 8.dp),
                        color = LocalPalette.current.faint,
                        size = 11,
                    )
                }
                itemsIndexed(items, key = { _, item -> itemKey(item) }) { index, item ->
                    GridCard(state, item, base + index, list, arrival)
                }
            }
    } else
        itemsIndexed(state.items, key = { _, item -> itemKey(item) }) { index, item ->
            GridCard(state, item, index, list, arrival)
        }
}

@Composable
private fun LazyGridItemScope.GridCard(
    state: GalleryState,
    item: ContentItem,
    index: Int,
    list: Boolean,
    arrival: State<Float>?,
) {
    val entering = arrival.takeUnless { itemKey(item) in state.retainedCards }
    ContentCard(
        state,
        item,
        list,
        Modifier.animateItem(
                fadeInSpec = if (state.reduceMotion || entering != null) null else tween(180),
                fadeOutSpec = if (state.reduceMotion) snap() else tween(220),
                placementSpec =
                    if (state.reduceMotion) snap() else spring(dampingRatio = 1f, stiffness = 324f),
            )
            .pageArrival(entering, index, state.pageDirection),
    )
}

internal fun galleryGridIndex(state: GalleryState, index: Int): Int {
    val kind = (state.loadedRoute ?: state.route).kind
    if (kind == "author") return index + 1
    if (kind != "history") return index
    return index +
        state.items
            .take(index + 1)
            .map { historyGroup(it.work.personal?.readAt ?: 0) }
            .distinct()
            .size
}
