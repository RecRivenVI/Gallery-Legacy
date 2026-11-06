package gallery

import androidx.compose.animation.core.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.unit.*

internal fun LazyGridScope.resultCards(state: GalleryState) {
    if (state.route.kind == "history") {
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
                    GridCard(state, item, base + index)
                }
            }
    } else
        itemsIndexed(state.items, key = { _, item -> itemKey(item) }) { index, item ->
            GridCard(state, item, index)
        }
}

@Composable
private fun LazyGridItemScope.GridCard(state: GalleryState, item: ContentItem, index: Int) {
    ContentCard(
        state,
        item,
        false,
        Modifier.animateItem(
                fadeInSpec = null,
                fadeOutSpec = if (state.reduceMotion) snap() else tween(220),
                placementSpec =
                    if (state.reduceMotion) snap() else spring(dampingRatio = 1f, stiffness = 324f),
            )
            .pageArrival(state.route, index, state.pageDirection, state.reduceMotion),
    )
}

internal fun galleryGridIndex(state: GalleryState, index: Int): Int {
    if (state.route.kind == "author") return index + 1
    if (state.route.kind != "history") return index
    return index +
        state.items
            .take(index + 1)
            .map { historyGroup(it.work.personal?.readAt ?: 0) }
            .distinct()
            .size
}
