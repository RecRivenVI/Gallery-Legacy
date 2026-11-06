package gallery

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.*

@Composable
fun WorkImagePicker(
    state: GalleryState,
    heading: String,
    selectedIdentity: String,
    backLabel: String,
    onBack: () -> Unit,
    onPick: (WorkSummaryWire, MediaSummaryWire) -> Unit,
) {
    var works by remember { mutableStateOf<List<WorkSummaryWire>>(emptyList()) }
    var page by remember { mutableIntStateOf(1) }
    var error by remember { mutableStateOf("") }
    var more by remember { mutableStateOf(true) }
    LaunchedEffect(page) {
        try {
            val data =
                readApi<PageWire<WorkSummaryWire>>(
                    "works",
                    mapOf(
                        "platform" to
                            decode(state.route.platform)
                                .takeIf { it in platforms }
                                .orEmpty()
                                .ifEmpty { "pixiv" },
                        "page" to page,
                        "pageSize" to 24,
                        "mediaType" to "image",
                        "hideEmpty" to 1,
                    ),
                )
            works = works + data.items
            more = page < data.totalPages
            error = ""
        } catch (e: Exception) {
            error = "加载失败：" + humanError(e.message.orEmpty())
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconAction("left", backLabel, onClick = onBack)
        Label(heading, size = 16, bold = true)
    }
    if (error.isNotEmpty()) ErrorNotice(error) { page = 1 }
    works.chunked(3).forEach { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            row.forEach { work ->
                val cover = work.cover
                Box(
                    Modifier.weight(1f)
                        .aspectRatio(1f)
                        .clip(GalleryShape(6.dp))
                        .then(
                            if (
                                selectedIdentity == work.stableId ||
                                    selectedIdentity == cover?.thumbnailUrl
                            )
                                Modifier.border(
                                    2.dp,
                                    LocalPalette.current.fg,
                                    GalleryShape(6.dp),
                                )
                            else Modifier
                        )
                        .keyboardFocus(GalleryShape(6.dp))
                        .clickable {
                            onPick(work, cover ?: return@clickable)
                        }
                        .semantics {
                            contentDescription = title(work)
                            selected =
                                selectedIdentity == work.stableId ||
                                    selectedIdentity == cover?.thumbnailUrl
                        }
                ) {
                    MediaImage(cover?.thumbnailUrl.orEmpty(), Modifier.fillMaxSize())
                }
            }
            repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
        }
    }
    if (more) Action("继续加载") { page++ }
}
