package gallery

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.*
import kotlinx.coroutines.*

@Composable
fun CollectionsGrid(state: GalleryState, modifier: Modifier) {
    val p = LocalPalette.current
    if (state.people.collections.isEmpty()) {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Label("还没有收藏夹", color = p.fg2)
                var name by remember { mutableStateOf("") }
                Field(name, { name = it }, "收藏夹名称")
                Action("创建", enabled = name.isNotBlank()) { state.people.createCollection(name) }
            }
        }
        return
    }
    LazyVerticalGrid(
        GridCells.Adaptive(220.dp),
        modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        items(state.people.collections, key = { it.id }) { collection ->
            var covers by
                remember(collection.id, collection.covers) {
                    mutableStateOf<List<MediaSummaryWire>>(emptyList())
                }
            LaunchedEffect(collection.covers) {
                covers = coroutineScope {
                    collection.covers
                        .map { path ->
                            async {
                                try {
                                    readApi<WorkSummaryWire>("summary", mapOf("path" to path)).cover
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (_: Exception) {
                                    null
                                }
                            }
                        }
                        .awaitAll()
                        .filterNotNull()
                }
            }
            Column(
                Modifier.fillMaxWidth()
                    .then(semanticControl("button", collection.name))
                    .combinedClickable(
                        onLongClick = {
                            state.people.selectedCollection = collection
                            state.people.confirming = ""
                            state.panel = "collection-edit"
                        },
                        onClick = {
                            state.navigate(
                                Route("/@collection/" + collection.id, sort = "favorite_desc")
                            )
                        },
                    ),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Box(
                    Modifier.fillMaxWidth()
                        .aspectRatio(1f)
                        .clip(GalleryShape(6.dp))
                        .background(p.tint)
                ) {
                    Collage(covers)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Label(collection.name, Modifier.weight(1f), bold = true)
                    IconAction("settings", "编辑 ${collection.name}") {
                        state.people.selectedCollection = collection
                        state.people.confirming = ""
                        state.panel = "collection-edit"
                    }
                }
                Label(
                    "${grouped(collection.count)} 个作品" +
                        (if (collection.latestAt > 0)
                            " · ${isoDate(collection.latestAt.toDouble())}"
                        else ""),
                    color = p.muted,
                    size = 12,
                )
            }
        }
    }
}
