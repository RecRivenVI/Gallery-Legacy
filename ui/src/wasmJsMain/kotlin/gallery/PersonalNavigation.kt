package gallery

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.unit.*

fun personalTitle(kind: String, state: GalleryState): String =
    when (kind) {
        "favorites",
        "collections" -> "收藏"
        "history" -> "历史"
        "continue" -> "继续阅读"
        "collection" ->
            state.people.collections
                .find { it.id == state.route.path.substringAfterLast('/') }
                ?.name ?: "收藏夹"
        else -> "画廊"
    }

@Composable
fun PersonalNavigation(state: GalleryState) {
    val people = state.people
    when (state.route.kind) {
        "favorites",
        "collections" -> {
            Action(
                "全部收藏 ${grouped(people.counts["favorites"]?:0)}",
                selected = state.route.kind == "favorites",
            ) {
                state.navigate(Route("/@my/favorites", sort = "favorite_desc"))
            }
            Label("|", color = LocalPalette.current.faint)
            Action("收藏夹 ${people.collections.size}", selected = state.route.kind == "collections") {
                state.navigate(Route("/@my/collections"))
            }
        }
        "history" ->
            if (people.confirming == "history") {
                Label("清空浏览历史？", color = LocalPalette.current.fg2)
                Action("取消") { people.confirming = "" }
                Action("清空") { people.clearHistory() }
            } else
                Action("清空历史", enabled = (people.counts["history"] ?: 0) > 0) {
                    people.confirming = "history"
                }
        "collection" ->
            Action("编辑收藏夹") {
                people.selectedCollection =
                    people.collections.find { it.id == state.route.path.substringAfterLast('/') }
                people.confirming = ""
                state.panel = "collection-edit"
            }
        else -> Label("作品 ${grouped(state.total)}", color = LocalPalette.current.faint)
    }
    if (state.route.kind !in listOf("collections"))
        Action("筛选" + (if (state.filters.count > 0) " ${state.filters.count}" else "") + " ▾") {
            state.filters.open()
        }
}

@Composable
fun SearchConditions(state: GalleryState) {
    val terms = state.filters.routeTerms
    val filters =
        state.route.filters.filterKeys { it !in listOf("platforms", "linkedAuthor", "series") }
    if (terms.isEmpty() && filters.isEmpty() && state.route.tag.isEmpty()) return
    Row(
        Modifier.fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        terms.forEach { term ->
            val name =
                when (term.field) {
                    "any" -> ""
                    "platform" -> "平台："
                    else -> (searchFields[term.field] ?: term.field) + "："
                }
            val value =
                if (term.field == "platform") state.filters.selectedPlatforms.joinToString("、")
                else term.value
            Action((if (term.exclude) "排除：" else "") + name + value + " ×", selected = true) {
                state.filters.remove(term)
            }
        }
        if (state.route.tag.isNotEmpty())
            Action("标签：${state.route.tag} ×", selected = true) {
                state.navigate(state.route.copy(tag = "", page = 1))
            }
        filters.forEach { (key, value) ->
            val label =
                when (key) {
                    "includeTags" -> "标签：${tagValues(value).joinToString("、")}"
                    "excludeTags" -> "排除标签：${tagValues(value).joinToString("、")}"
                    "myTags" -> "我的标签：${tagValues(value).joinToString("、")}"
                    "types" -> value.split(',').joinToString("、") { workTypeNames[it] ?: it }
                    "ratings" ->
                        value.split(',').joinToString("、") {
                            when (it) {
                                "0" -> "全年龄"
                                "1" -> "R-18"
                                else -> "R-18G"
                            }
                        }
                    "ai" -> if (value == "1") "AI" else "非 AI"
                    "paid" -> if (value == "1") "付费" else "免费"
                    "from" -> "从 $value"
                    "to" -> "到 $value"
                    "pages" -> if (value == "single") "单页" else "多页"
                    "favorite" -> "只看收藏"
                    "minRating" -> "评分 ≥ $value"
                    "hideRead" -> "隐藏看过的"
                    else -> value
                }
            Action("$label ×", selected = true) { state.filters.set(key, "") }
        }
        Action("清除全部") {
            state.navigate(
                state.route.copy(
                    query = "",
                    tag = "",
                    mediaType = "all",
                    filters = emptyMap(),
                    page = 1,
                )
            )
        }
        Label("${grouped(state.total)} 个结果", color = LocalPalette.current.faint)
    }
}
