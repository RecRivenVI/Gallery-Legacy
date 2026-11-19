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
import kotlinx.coroutines.flow.collectLatest
import kotlinx.serialization.json.*

@Composable
fun GalleryResults(state: GalleryState, modifier: Modifier, narrow: Boolean) {
    val p = LocalPalette.current
    if (state.route.kind == "collections" && state.people.account != null) {
        CollectionsGrid(state, modifier)
        return
    }
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val emptyText =
            when {
                !state.route.valid -> "找不到这个作品，它可能已被移动或删除。"
                !state.route.validFilter -> "网址里的筛选条件无法识别"
                state.error.isNotEmpty() -> "加载失败：" + humanError(state.error)
                state.route.personalView && state.people.account == null -> "登录后查看"
                state.route.query.isNotEmpty() ||
                    state.route.tag.isNotEmpty() ||
                    state.route.mediaType != "all" ||
                    state.filters.count > 0 -> "没有符合条件的作品"
                state.route.kind == "favorites" -> "还没有收藏的作品"
                state.route.kind == "history" -> "还没有浏览记录"
                state.route.kind == "continue" -> "没有看到一半的作品"
                state.route.kind == "collection" -> "这个收藏夹里还没有作品"
                state.route.kind == "files" -> "这个文件夹里没有图片或视频"
                else -> "这个平台还没有作品"
            }
        val showEmpty =
            !state.loading &&
                (state.items.isEmpty() ||
                    state.error.isNotEmpty() ||
                    !state.route.valid ||
                    !state.route.validFilter)
        if (showEmpty) {
            Column(
                Modifier.align(Alignment.Center).zIndex(1f).padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Fluent(
                    if (state.route.kind == "files") "folder" else "gallery",
                    color = p.faint,
                    size = 48,
                )
                Label(emptyText, color = p.fg2, size = 14)
                if (state.route.personalView && state.people.account == null)
                    Action("登录") { state.people.openLogin() }
                else if (state.error.isNotEmpty()) Action("重试", onClick = state::reload)
                else if (!state.route.valid) Action("返回") { state.navigate(Route()) }
                else if (
                    !state.route.validFilter ||
                        state.route.query.isNotEmpty() ||
                        state.route.tag.isNotEmpty() ||
                        state.route.mediaType != "all" ||
                        state.filters.count > 0
                )
                    Action("清除筛选") {
                        state.navigate(
                            state.route.copy(
                                query = "",
                                filters = emptyMap(),
                                tag = "",
                                mediaType = "all",
                                sort =
                                    if (state.route.kind == "files") "name_asc"
                                    else if (state.route.kind == "authors") "latest_desc"
                                    else "date_desc",
                                page = 1,
                            )
                        )
                    }
            }
        }
        run {
            val scroll = rememberLazyGridState()
            val list = state.size == 0
            val displayedRoute = state.loadedRoute ?: state.route
            val arrival =
                rememberPageArrival(
                    displayedRoute,
                    true,
                    if (state.loading) 0 else state.pageDirection,
                    state.reduceMotion,
                )
            LaunchedEffect(displayedRoute) {
                if (scroll.firstVisibleItemIndex != 0 || scroll.firstVisibleItemScrollOffset != 0)
                    scroll.scrollToItem(0)
            }
            LaunchedEffect(state.viewer?.work?.stableId, state.viewer?.page, state.items) {
                val viewer = state.viewer ?: return@LaunchedEffect
                if (viewer.split) return@LaunchedEffect
                val index =
                    state.items.indexOfFirst {
                        if (displayedRoute.kind == "pages") it.cover?.url == viewer.current?.url
                        else it.stableId == viewer.work.stableId
                    }
                if (
                    index >= 0 &&
                        scroll.layoutInfo.visibleItemsInfo.none {
                            it.key == itemKey(state.items[index])
                        }
                ) {
                    scroll.scrollToItem(galleryGridIndex(state, index))
                }
            }
            val columns =
                when {
                    list -> GridCells.Fixed(1)
                    !narrow -> GridCells.Adaptive(Metrics.cardWidths[state.size].dp)
                    maxWidth < 600.dp -> GridCells.Fixed(if (state.size <= 2) 3 else 2)
                    else -> GridCells.Fixed(if (state.size <= 2) 4 else 3)
                }
            LazyVerticalGrid(
                columns,
                Modifier.fillMaxSize(),
                state = scroll,
                contentPadding =
                    PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = 16.dp,
                        bottom = if (list || state.totalPages > 1) 80.dp else 16.dp,
                    ),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(if (list) 8.dp else 16.dp),
            ) {
                if (!showEmpty && displayedRoute.kind == "author")
                    item(key = "author-heading", span = { GridItemSpan(maxLineSpan) }) {
                        AuthorHeader(state)
                    }
                if (!showEmpty && state.items.isNotEmpty()) {
                    resultCards(state, list, displayedRoute.kind, arrival)
                } else if (state.loading) {
                    items(if (list) 12 else 24) {
                        Skeleton(
                            Modifier.fillMaxWidth()
                                .then(
                                    if (list) Modifier.height(96.dp)
                                    else Modifier.aspectRatio(Metrics.ratios[state.ratio] ?: 1f)
                                )
                        )
                    }
                }
            }
            LaunchedEffect(displayedRoute, state.items, state.loading) {
                if (state.items.isEmpty() || state.loading) return@LaunchedEffect
                var prefetched = false
                snapshotFlow {
                    !scroll.isScrollInProgress &&
                        (scroll.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1) >=
                            state.items.size - 6
                }
                    .collectLatest { nearEnd ->
                        if (nearEnd && !prefetched) {
                            delay(180)
                            state.prefetchNext()
                            prefetched = true
                        }
                    }
            }
        }
        if (state.newContent && state.viewer == null)
            Box(
                Modifier.align(Alignment.TopCenter)
                    .padding(top = 12.dp)
                    .clip(GalleryShape(12.dp))
                    .background(p.glass.copy(alpha = .9f))
                    .border(1.dp, p.edge, GalleryShape(12.dp))
            ) {
                Action(
                    if (state.newCount > 0) "有 " + grouped(state.newCount) + " 个新作品 · 刷新"
                    else "有新内容 · 刷新"
                ) {
                    state.reload()
                }
            }
        if (state.incomplete)
            Label("结果不完整：部分目录无法读取", Modifier.align(Alignment.TopCenter).padding(8.dp), p.warn)
    }
}
