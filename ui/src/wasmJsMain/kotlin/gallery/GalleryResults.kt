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
        if (
            !state.loading &&
                (state.items.isEmpty() ||
                    state.error.isNotEmpty() ||
                    !state.route.valid ||
                    !state.route.validFilter)
        ) {
            Column(
                Modifier.align(Alignment.Center).padding(24.dp),
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
        } else {
            val scroll = rememberLazyGridState()
            val listScroll = rememberLazyListState()
            LaunchedEffect(state.viewer?.work?.stableId, state.items) {
                val viewer = state.viewer
                if (viewer != null && !viewer.split) {
                    val index =
                        state.items.indexOfFirst {
                            it.stableId == viewer.work.stableId
                        }
                    if (index >= 0) {
                        val visible =
                            if (state.size == 0)
                                listScroll.layoutInfo.visibleItemsInfo.any {
                                    it.key == itemKey(state.items[index])
                                }
                            else
                                scroll.layoutInfo.visibleItemsInfo.any {
                                    it.key == itemKey(state.items[index])
                                }
                        if (!visible) {
                            if (state.size == 0)
                                listScroll.scrollToItem(
                                    index + if (state.route.kind == "author") 1 else 0
                                )
                            else scroll.scrollToItem(galleryGridIndex(state, index))
                        }
                    }
                }
            }
            val width =
                if (narrow) Metrics.touchWidths[state.size] else Metrics.cardWidths[state.size]
            if (state.size == 0)
                LazyColumn(
                    Modifier.fillMaxSize().padding(horizontal = 16.dp),
                    state = listScroll,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(bottom = 80.dp, top = 16.dp),
                ) {
                    if (!state.loading && state.route.kind == "author")
                        item(key = "author-heading") { AuthorHeader(state) }
                    if (state.loading) items(12) { Skeleton(Modifier.fillMaxWidth().height(96.dp)) }
                    else
                        itemsIndexed(state.items, key = { _, item -> itemKey(item) }) { index, item
                            ->
                            Column {
                                if (
                                    state.route.kind == "history" &&
                                        (index == 0 ||
                                            historyGroup(item.work.personal?.readAt ?: 0) !=
                                                historyGroup(
                                                    state.items[index - 1].work.personal?.readAt
                                                        ?: 0
                                                ))
                                )
                                    Label(
                                        historyGroup(item.work.personal?.readAt ?: 0),
                                        Modifier.padding(vertical = 8.dp),
                                        color = p.faint,
                                        size = 11,
                                    )
                                ContentCard(
                                    state,
                                    item,
                                    true,
                                    Modifier.animateItem(
                                            fadeInSpec = null,
                                            fadeOutSpec =
                                                if (state.reduceMotion) snap() else tween(220),
                                        )
                                        .pageArrival(
                                            state.route,
                                            index,
                                            state.pageDirection,
                                            state.reduceMotion,
                                        ),
                                )
                            }
                        }
                }
            else
                LazyVerticalGrid(
                    if (narrow)
                        GridCells.Fixed(
                            if (maxWidth < 600.dp) {
                                if (state.size <= 2) 3 else 2
                            } else {
                                if (state.size <= 2) 4 else 3
                            }
                        )
                    else GridCells.Adaptive((if (width == 0) 220 else width).dp),
                    Modifier.fillMaxSize(),
                    state = scroll,
                    contentPadding =
                        PaddingValues(
                            start = 16.dp,
                            end = 16.dp,
                            top = 16.dp,
                            bottom = if (state.totalPages > 1) 80.dp else 16.dp,
                        ),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    if (!state.loading && state.route.kind == "author")
                        item(key = "author-heading", span = { GridItemSpan(maxLineSpan) }) {
                            AuthorHeader(state)
                        }
                    if (state.loading)
                        items(24) {
                            Skeleton(
                                Modifier.fillMaxWidth()
                                    .aspectRatio(Metrics.ratios[state.ratio] ?: 1f)
                            )
                        }
                    else resultCards(state)
                }
            LaunchedEffect(state.route, state.items) {
                if (state.items.isEmpty()) return@LaunchedEffect
                snapshotFlow {
                    if (state.size == 0)
                        listScroll.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
                    else scroll.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
                }
                    .collect { index ->
                        if (index >= state.items.size - 6) {
                            state.prefetchNext()
                            awaitCancellation()
                        }
                    }
            }
            LaunchedEffect(
                state.route.page,
                state.route.path,
                state.route.query,
                state.route.tag,
                state.route.sort,
            ) {
                scroll.scrollToItem(0)
                listScroll.scrollToItem(0)
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
