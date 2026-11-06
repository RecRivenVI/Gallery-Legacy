package gallery

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.input.pointer.*
import androidx.compose.ui.unit.*

@Composable
fun CardFavorite(state: GalleryState, work: WorkSummaryWire, hover: Boolean) {
    val favorite = work.personal?.favorite == true
    if (
        favorite ||
            hover ||
            state.panel == "collection-work" && state.people.selectedWork?.stableId == work.stableId
    ) {
        FavoriteButton(state, work, Modifier.size(28.dp))
    } else Spacer(Modifier.size(28.dp))
}

@Composable
fun FavoriteButton(state: GalleryState, work: WorkSummaryWire, modifier: Modifier = Modifier) {
    val favorite = work.personal?.favorite == true
    Action(
        icon = if (favorite) "heart-filled" else "heart",
        description = if (favorite) "取消收藏" else "收藏",
        selected = favorite,
        modifier =
            modifier.onWebPointerEvent(PointerEventType.Press) { e ->
                if (e.buttons.isSecondaryPressed) {
                    state.people.collectionPanel(work)
                    e.changes.forEach { it.consume() }
                }
            },
        onLongClick = { state.people.collectionPanel(work) },
    ) {
        state.people.favorite(work)
    }
}
