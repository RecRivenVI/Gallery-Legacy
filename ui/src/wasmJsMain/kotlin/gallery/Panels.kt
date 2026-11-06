package gallery

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.*
import androidx.compose.ui.window.*
import kotlinx.serialization.json.*

@Composable
fun GalleryPanel(state: GalleryState, width: Int, height: Int) {
    val p = LocalPalette.current
    val phone = width < 700
    val density = LocalDensity.current
    val panelWidth = if (state.panel == "advanced") 480 else 360
    key(state.panel, if (state.panel == "account") state.people.profilePage else "") {
        ModalLayer(
            when (state.panel) {
                "settings" -> "设置"
                "background" -> "选择背景"
                "tags" -> "标签"
                "filters" -> "筛选"
                "advanced" -> "高级搜索"
                "account" -> "账号"
                "collection-work" -> "添加到收藏夹"
                "collection-edit" -> "收藏夹"
                "sort" -> "排序"
                "author-link" -> "关联其他作者"
                "history-work" -> "历史"
                else -> "修改比例"
            },
            { state.panel = "" },
        ) {
            val placement =
                if (phone)
                    Modifier.align(Alignment.BottomCenter).padding(8.dp).width((width - 16).dp)
                else if (state.panel == "advanced")
                    Modifier.align(Alignment.TopStart)
                        .offset(
                            x =
                                with(density) { state.searchRect.left.toDp() }
                                    .coerceAtMost((width - panelWidth - 8).coerceAtLeast(8).dp),
                            y = 92.dp,
                        )
                        .width(panelWidth.dp)
                else
                    Modifier.align(Alignment.TopEnd)
                        .padding(
                            top =
                                (if (state.panel in listOf("settings", "background", "account")) 50
                                    else 92)
                                    .dp,
                            end = 8.dp,
                        )
                        .width(panelWidth.dp)

            Box(
                Modifier.fillMaxSize()
                    .focusProperties { canFocus = false }
                    .clickable(
                        interactionSource =
                            remember {
                                androidx.compose.foundation.interaction.MutableInteractionSource()
                            },
                        indication = null,
                    ) {
                        state.panel = ""
                    }
                    .clearAndSetSemantics {}
            )
            GlassSurface(
                placement.heightIn(max = (height - 66).coerceAtLeast(120).dp),
                opacity = Metrics.panelGlassOpacity,
            ) {
                Column(
                    Modifier.padding(16.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    when (state.panel) {
                        "advanced" -> AdvancedSearchPanel(state)
                        "filters" -> FiltersPanel(state)
                        "account" -> AccountPanel(state)
                        "collection-work" -> CollectionAssignment(state)
                        "collection-edit" -> CollectionEditor(state)
                        "author-link" -> AuthorLinkPanel(state)
                        "history-work" -> {
                            Label("历史", size = 16, bold = true)
                            state.people.selectedWork?.let { work ->
                                Action("从历史中移除") {
                                    state.people.removeHistory(work)
                                    state.panel = ""
                                }
                            }
                        }
                        "settings" -> {
                            Label("设置", size = 16, bold = true)
                            Label("主题", color = p.fg2)
                            Segment(
                                listOf("跟随系统", "深色", "浅色"),
                                listOf("system", "dark", "light").indexOf(state.theme),
                            ) {
                                state.theme = listOf("system", "dark", "light")[it]
                                state.preference("theme", state.theme)
                            }
                            Rule()
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Label("背景", Modifier.weight(1f))
                                Segment(
                                    listOf("纯色", "作品图片"),
                                    if (state.background.isEmpty()) 0 else 1,
                                ) {
                                    if (it == 0) {
                                        state.clearBackground()
                                    } else state.panel = "background"
                                }
                            }
                            if (state.background.isNotEmpty()) {
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    MediaImage(
                                        state.background,
                                        Modifier.size(48.dp).clip(GalleryShape(6.dp)),
                                    )
                                    Action("更换…") { state.panel = "background" }
                                }
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Label("背景淡化")
                                    Range(state.dim, .5f, .9f, "背景淡化", Modifier.weight(1f)) {
                                        state.dim = it
                                        state.preference("dim", it)
                                    }
                                    Label("${(state.dim*100).toInt()}%", color = p.faint)
                                }
                            }
                            Rule()
                            Toggle("隐私模糊", state.privacy) {
                                state.privacy = it
                                state.preference("privacy", it)
                            }
                            Toggle("隐藏没有可看内容的作品", state.hideEmpty) {
                                state.hideEmpty = it
                                state.preference("hideEmpty", it)
                                state.reload()
                            }
                            Toggle("隐藏作者头像", state.hideAvatars) {
                                state.hideAvatars = it
                                state.preference("hideAvatars", it)
                            }
                            Toggle("自动刷新", state.autoRefresh) {
                                state.autoRefresh = it
                                state.preference("autoRefresh", it)
                            }
                            Toggle("减少动态效果", state.reduceMotion) {
                                state.reduceMotion = it
                                state.preference("reduceMotion", it)
                            }
                            Toggle("记录浏览历史", state.recordHistory) {
                                state.recordHistory = it
                                state.preference("history", it)
                            }
                            Label("漫画默认阅读方式", color = p.fg2)
                            Segment(
                                listOf("自动", "单页", "双页", "连续"),
                                listOf("", "single", "double", "continuous")
                                    .indexOf(state.mangaDefault),
                            ) {
                                state.mangaDefault =
                                    listOf("", "single", "double", "continuous")[it]
                                state.preference("mangaDefault", state.mangaDefault)
                            }
                            Rule()
                            Label("每页数量", color = p.fg2)
                            val sizes = pageSizes
                            Segment(
                                sizes.map { it.toString() },
                                sizes.indexOf(state.route.pageSize),
                            ) {
                                state.preference("pageSize", sizes[it])
                                state.navigate(state.route.copy(pageSize = sizes[it], page = 1))
                            }
                            Label("字体：MiSans", color = p.faint, size = 11)
                        }
                        "tags" -> {
                            Label("标签", size = 16, bold = true)
                            Field(
                                state.tagQuery,
                                {
                                    state.tagQuery = it
                                    state.loadTags()
                                },
                                "搜索标签",
                                Modifier.fillMaxWidth(),
                            )
                            if (state.route.tag.isNotEmpty())
                                Action(state.route.tag + " ×", selected = true) {
                                    state.navigate(state.route.copy(tag = "", page = 1))
                                }
                            if (state.tagError.isNotEmpty())
                                ErrorNotice(state.tagError) { state.loadTags() }
                            state.tags.forEach { tag ->
                                Row(
                                    Modifier.fillMaxWidth().height(34.dp).clickable {
                                        state.navigate(state.route.copy(tag = tag.label, page = 1))
                                    },
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Label(tag.label, Modifier.weight(1f))
                                    Label(grouped(tag.workCount), color = p.faint)
                                }
                            }
                            if (state.tagCursor.isNotEmpty())
                                Action("继续加载") { state.loadTags(true) }
                        }
                        "sort" ->
                            availableSorts(state).forEach { (key, label) ->
                                Action(
                                    label,
                                    selected = state.route.sort == key,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    state.navigate(state.route.copy(sort = key, page = 1))
                                }
                            }
                        "ratio" ->
                            Metrics.ratios.keys.forEach { ratio ->
                                Action(
                                    ratio,
                                    selected = state.ratio == ratio,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    state.ratio = ratio
                                    state.preference("ratio", ratio)
                                    state.panel = ""
                                }
                            }
                        "background" -> BackgroundPicker(state)
                    }
                }
            }
        }
    }
}

@Composable
private fun BackgroundPicker(state: GalleryState) {
    WorkImagePicker(state, "选择背景", state.backgroundWork, "返回设置", { state.panel = "settings" }) {
        work,
        media ->
        state.setBackground(work, media)
        state.panel = "settings"
    }
}
