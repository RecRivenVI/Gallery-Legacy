package gallery

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.unit.*

@Composable
fun AdvancedSearchPanel(state: GalleryState) {
    val p = LocalPalette.current
    val f = state.filters
    Label("高级搜索", size = 16, bold = true)
    Label("平台", color = p.fg2)
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Action("全部", selected = f.parsedPlatforms.size == platforms.size) {
            f.choosePlatforms(
                if (f.parsedPlatforms.size == platforms.size) emptyList() else platforms
            )
        }
        platforms.forEach { platform ->
            Action(
                platformBadges[platform] + " " + platform,
                selected = platform in f.parsedPlatforms,
            ) {
                f.choosePlatforms(
                    if (platform in f.parsedPlatforms) f.parsedPlatforms - platform
                    else f.parsedPlatforms + platform
                )
            }
        }
    }
    Rule()
    searchFields
        .filterKeys {
            (it != "mytag" || state.people.account != null) &&
                (state.route.kind != "authors" ||
                    it in listOf("any", "exclude", "author", "user", "uid"))
        }
        .forEach { (key, label) ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Label(label, Modifier.width(78.dp), color = p.fg2)
                Field(
                    f.fields[key].orEmpty(),
                    { f.advanced(key, it) },
                    label,
                    Modifier.weight(1f),
                    onEnter = {
                        if (f.fields.values.any { it.isNotBlank() })
                            state.search.submit(force = true)
                    },
                )
            }
        }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Action("清除") {
            f.fields = emptyMap()
            state.search.draft(advancedQuery(emptyMap(), f.parsedPlatforms))
        }
        Action(
            "搜索",
            primary = true,
            enabled = f.fields.values.any { it.isNotBlank() } && f.parsedPlatforms.isNotEmpty(),
        ) {
            state.search.submit(force = true)
            state.panel = ""
        }
    }
}

@Composable
fun FiltersPanel(state: GalleryState) {
    val p = LocalPalette.current
    val f = state.filters
    val values = state.route.filters
    fun values(key: String) =
        if (key in listOf("includeTags", "excludeTags", "myTags")) tagValues(values[key])
        else values[key].orEmpty().split(',').filter { it.isNotEmpty() }
    fun toggle(key: String, item: String) {
        val before = values(key)
        val after = if (item in before) before - item else before + item
        f.set(
            key,
            if (key in listOf("includeTags", "excludeTags", "myTags")) tagValue(after)
            else after.joinToString(","),
        )
    }
    Label("筛选", size = 16, bold = true)
    if (state.people.account != null && state.people.tags.isNotEmpty()) {
        Label("我的标签", color = p.fg2)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            state.people.tags.forEach { tag ->
                Action(tag.label, selected = tag.label in values("myTags")) {
                    toggle("myTags", tag.label)
                }
            }
        }
        Rule()
    }
    Label("标签", color = p.fg2)
    Field(
        state.tagQuery,
        {
            state.tagQuery = it
            state.loadTags()
        },
        "搜索标签",
        Modifier.fillMaxWidth(),
    )
    val included = values("includeTags") + listOfNotNull(state.route.tag.takeIf { it.isNotEmpty() })
    val excluded = values("excludeTags")
    val rows =
        (state.tags.filter { it.label in included || it.label in excluded } + state.tags)
            .distinctBy { it.label }
    Column(Modifier.heightIn(max = 204.dp).verticalScroll(rememberScrollState())) {
        rows.forEach { tag ->
            Row(
                Modifier.fillMaxWidth().height(34.dp).clickable { f.cycleTag(tag.label) },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Label(
                    if (tag.label in included) "✓" else if (tag.label in excluded) "−" else "",
                    Modifier.width(24.dp),
                    color = p.fg2,
                )
                Label(
                    tag.label,
                    Modifier.weight(1f),
                    color = if (tag.label in excluded) p.muted else p.fg,
                )
                Label(grouped(tag.workCount), color = p.faint)
            }
        }
        if (state.tagCursor.isNotEmpty()) Action("更多") { state.loadTags(true) }
        if (state.tagError.isNotEmpty()) Label(state.tagError, color = p.error)
    }
    if (f.options.workTypes.isNotEmpty()) {
        Rule()
        Label("作品类型", color = p.fg2)
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            f.options.workTypes.forEach { type ->
                Action(workTypeNames[type] ?: type, selected = type in values("types")) {
                    toggle("types", type)
                }
            }
        }
    }
    if (f.options.pixiv) {
        Rule()
        Label("pixiv 分级", color = p.fg2)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf("全年龄", "R-18", "R-18G").forEachIndexed { index, label ->
                Action(label, selected = index.toString() in values("ratings")) {
                    toggle("ratings", index.toString())
                }
            }
        }
        Label("AI", color = p.fg2)
        Segment(
            listOf("全部", "非 AI", "AI"),
            listOf("all", "0", "1").indexOf(values["ai"] ?: "all"),
        ) {
            f.set("ai", listOf("all", "0", "1")[it])
        }
    }
    if (f.options.paid) {
        Rule()
        Label("付费", color = p.fg2)
        Segment(
            listOf("全部", "免费", "付费"),
            listOf("all", "0", "1").indexOf(values["paid"] ?: "all"),
        ) {
            f.set("paid", listOf("all", "0", "1")[it])
        }
    }
    Rule()
    Label("发布日期", color = p.fg2)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        DateFilter(state, "from", "从")
        DateFilter(state, "to", "到")
    }
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        listOf(7 to "近 7 天", 30 to "近 30 天", 365 to "近 1 年").forEach { (days, label) ->
            Action(label) {
                f.set("from", isoDate(now() - days * 86400000.0))
                f.set("to", isoDate(now()))
            }
        }
    }
    Rule()
    Label("页数", color = p.fg2)
    Segment(
        listOf("全部", "单页", "多页"),
        listOf("all", "single", "multi").indexOf(values["pages"] ?: "all"),
    ) {
        f.set("pages", listOf("all", "single", "multi")[it])
    }
    if (state.people.account != null) {
        Rule()
        Label("我的", color = p.fg2)
        Toggle("只看收藏", values["favorite"] == "1") { f.set("favorite", if (it) "1" else "") }
        Label("我的评分不低于", color = p.fg2)
        Stars(values["minRating"]?.toIntOrNull() ?: 0) {
            f.set("minRating", if (it == 0) "" else it.toString())
        }
        Toggle("隐藏看过的", values["hideRead"] == "1") { f.set("hideRead", if (it) "1" else "") }
    }
    Rule()
    Action("清除筛选", enabled = f.count > 0) { f.clear() }
}

@Composable
private fun RowScope.DateFilter(state: GalleryState, key: String, label: String) {
    var draft by
        remember(state.route.filters[key]) { mutableStateOf(state.route.filters[key].orEmpty()) }
    Column(Modifier.weight(1f)) {
        Field(
            draft,
            {
                draft = it
                if (it.isEmpty() || validDate(it)) state.filters.set(key, it)
            },
            label + " YYYY-MM-DD",
            Modifier.fillMaxWidth(),
            onEnter = { if (draft.isEmpty() || validDate(draft)) state.filters.set(key, draft) },
        )
        if (draft.length >= 10 && !validDate(draft))
            Label("日期不存在，请检查", color = LocalPalette.current.error, size = 11)
    }
}

@Composable
fun Stars(value: Int, onChange: (Int) -> Unit) {
    Row {
        for (star in 1..5) IconAction(
            if (star <= value) "star-filled" else "star",
            "$star 星",
            selected = star <= value,
        ) {
            onChange(if (value == star) 0 else star)
        }
    }
}
