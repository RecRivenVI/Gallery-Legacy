package gallery

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.input.key.*
import androidx.compose.ui.layout.*
import androidx.compose.ui.unit.*
import androidx.compose.ui.window.*

@Composable
internal fun GallerySearchField(
    state: GalleryState,
    narrow: Boolean,
    modifier: Modifier = Modifier,
) {
    val search = state.search
    val p = LocalPalette.current
    Box(modifier.onGloballyPositioned { state.searchRect = it.boundsInWindow() }) {
        Field(
            search.text,
            search::edit,
            if (state.route.kind == "authors") "搜索名称、账号"
            else if (state.route.kind == "files") "搜索文件名" else "搜索标题、作者、标签",
            Modifier.fillMaxWidth().onPreviewKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown || state.filters.suggestions.isEmpty()) false
                else
                    when (e.key) {
                        Key.DirectionDown -> {
                            state.filters.suggestionIndex =
                                (state.filters.suggestionIndex + 1) % state.filters.suggestions.size
                            true
                        }
                        Key.DirectionUp -> {
                            state.filters.suggestionIndex =
                                (state.filters.suggestionIndex - 1 +
                                    state.filters.suggestions.size) % state.filters.suggestions.size
                            true
                        }
                        Key.Enter,
                        Key.Tab -> {
                            state.filters.complete()
                            true
                        }
                        else -> false
                    }
            },
            onEnter = { search.submit(force = true) },
            onFocus = search::begin,
            onBlur = { if (state.panel != "advanced") search.submit() },
            onComposition = search::composition,
            focusRequest = search.focusRequest,
            leading = { Fluent("search", color = p.faint, size = 16) },
            trailing = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (state.route.kind != "files")
                        IconAction("filter", "高级搜索", Modifier.size(24.dp)) {
                            state.filters.openAdvanced()
                        }
                    if (!narrow) Label("/", color = p.faint)
                }
            },
        )
    }
}

@Composable
fun SearchCompletion(state: GalleryState) {
    if (state.filters.suggestions.isEmpty() || state.panel.isNotEmpty()) return
    val density = androidx.compose.ui.platform.LocalDensity.current
    Box(Modifier.fillMaxSize()) {
        Box(
            Modifier.fillMaxSize().clickable(
                interactionSource =
                    remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                indication = null,
            ) {
                state.filters.suggestions = emptyList()
            }
        )
        GlassSurface(
            Modifier.align(Alignment.TopStart)
                .offset(
                    x = with(density) { state.searchRect.left.toDp() },
                    y = with(density) { state.searchRect.bottom.toDp() },
                )
                .widthIn(min = 220.dp, max = 400.dp),
            opacity = Metrics.panelGlassOpacity,
        ) {
            Column(Modifier.padding(8.dp)) {
                state.filters.suggestions.forEachIndexed { index, value ->
                    Action(
                        value,
                        selected = index == state.filters.suggestionIndex,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        state.filters.complete(index)
                    }
                }
            }
        }
    }
}
