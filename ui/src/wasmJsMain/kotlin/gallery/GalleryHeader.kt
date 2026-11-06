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
fun GalleryHeader(state: GalleryState, narrow: Boolean, width: Int) {
    val p = LocalPalette.current
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    val searching = state.search.expanded
    Column {
        Row(
            Modifier.fillMaxWidth().height(50.dp).padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (narrow) {
                if (searching)
                    IconAction("left", "收起搜索") {
                        state.search.submit()
                        focus.clearFocus()
                        state.search.expanded = false
                    }
                else IconAction("menu", "展开侧边栏") { state.drawer = true }
            }
            if (!narrow || !searching) {
                if (state.route.kind == "files") {
                    val parts = state.route.path.split('/').filter { it.isNotEmpty() }
                    Row(
                        Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (narrow) Label(decode(parts.last()), size = 15, maxLines = 1)
                        else
                            parts.drop(1).forEachIndexed { index, part ->
                                Action(
                                    if (index == 0)
                                        (state.roots.find { it.id == part }?.name ?: part)
                                    else decode(part)
                                ) {
                                    state.navigate(
                                        state.route.copy(
                                            path =
                                                "/f/" +
                                                    parts.drop(1).take(index + 1).joinToString("/"),
                                            page = 1,
                                        )
                                    )
                                }
                            }
                    }
                } else
                    Label(
                        if (state.heading != null) title(state.heading!!)
                        else if (state.route.personalView) personalTitle(state.route.kind, state)
                        else if (state.filters.selectedPlatforms.size > 1)
                            "搜索 · ${state.filters.selectedPlatforms.size} 个平台"
                        else decode(state.route.platform),
                        Modifier.weight(1f),
                        size = 15,
                        maxLines = 1,
                    )
            }
            if (!narrow || searching) {
                GallerySearchField(
                    state,
                    narrow,
                    Modifier.then(
                        if (narrow) Modifier.weight(1f)
                        else Modifier.widthIn(max = 400.dp).width((width / 3).dp)
                    ),
                )
                if (state.search.text.isNotEmpty())
                    IconAction("close", "清除搜索") {
                        state.search.clear()
                    }
            } else IconAction("search", "搜索") { state.search.focus() }
            IconAction("settings", "设置") {
                state.panel = if (state.panel == "settings") "" else "settings"
            }
        }
        Rule()
        Row(
            Modifier.fillMaxWidth()
                .height(42.dp)
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (state.route.personalView) PersonalNavigation(state)
            else if (state.route.kind in listOf("works", "authors")) {
                Action("作品 " + grouped(state.workTotal), selected = state.route.kind != "authors") {
                    state.navigate(
                        state.route.copy(
                            path = "/@all/" + state.route.platform,
                            sort = "date_desc",
                            page = 1,
                        )
                    )
                }
                Label("|", color = p.faint)
                Action(
                    "作者" +
                        if (
                            state.route.tag.isEmpty() &&
                                state.route.mediaType == "all" &&
                                state.filters.count == 0 &&
                                state.filters.routeTerms.all {
                                    it.field in listOf("any", "author", "user", "uid", "platform")
                                }
                        )
                            " " + grouped(state.authorTotal)
                        else "",
                    selected = state.route.kind == "authors",
                ) {
                    state.navigate(
                        state.route.copy(
                            path =
                                "/@authors/" +
                                    if (
                                        state.filters.routeTerms.any {
                                            it.field in listOf("any", "author", "user", "uid")
                                        }
                                    )
                                        state.route.platform
                                    else encode(state.filters.selectedPlatforms.first()),
                            query =
                                state.filters.routeTerms
                                    .filter {
                                        it.field in listOf("any", "author", "user", "uid") ||
                                            (it.field == "platform" &&
                                                state.filters.routeTerms.any { term ->
                                                    term.field in
                                                        listOf("any", "author", "user", "uid")
                                                })
                                    }
                                    .joinToString(" ") { it.raw },
                            sort = "latest_desc",
                            page = 1,
                            tag = "",
                            mediaType = "all",
                            filters =
                                if (
                                    state.filters.routeTerms.any {
                                        it.field in listOf("any", "author", "user", "uid")
                                    }
                                )
                                    state.route.filters.filterKeys { it == "platforms" }
                                else emptyMap(),
                        )
                    )
                }
                if (state.route.kind != "authors")
                    Action(
                        "筛选" +
                            (if (state.filters.count > 0) " ${state.filters.count}" else "") +
                            " ▾"
                    ) {
                        state.filters.open()
                    }
            }
            if (state.route.kind == "author") {
                Label("作品 ${grouped(state.total)}", color = p.faint)
                Action(
                    "筛选" + (if (state.filters.count > 0) " ${state.filters.count}" else "") + " ▾"
                ) {
                    state.filters.open()
                }
            }
            if (state.route.kind == "pages") Label("共 ${grouped(state.total)} 页", color = p.faint)
            if (state.route.kind !in listOf("authors", "collections"))
                Segment(
                    listOf("全部", "图片", "视频"),
                    listOf("all", "image", "video").indexOf(state.route.mediaType),
                ) {
                    state.navigate(
                        state.route.copy(mediaType = listOf("all", "image", "video")[it], page = 1)
                    )
                }
            Action(
                (if (state.route.kind == "authors") authorSorts[state.route.sort]
                    else workSorts[state.route.sort])
                    .orEmpty() + " ▾"
            ) {
                state.panel = "sort"
            }
            if (width >= 1280 && !coarsePointer())
                IconAction("panel", "分栏", selected = state.splitEnabled) {
                    state.splitEnabled = !state.splitEnabled
                }
            val sizes = if (width < 700) listOf(0, 2, 3) else (0..5).toList()
            Range(
                sizes.indexOf(state.size).let { if (it < 0) sizes.lastIndex else it }.toFloat(),
                0f,
                sizes.lastIndex.toFloat(),
                "大小",
                Modifier.width(118.dp),
                steps = sizes.size - 2,
            ) {
                state.size = sizes[it.toInt().coerceIn(sizes.indices)]
                state.preference("size", state.size)
            }
            Label(Metrics.sizes[state.size], color = p.faint)
            Action(state.ratio + " ▾") { state.panel = "ratio" }
        }
        SearchConditions(state)
    }
}
