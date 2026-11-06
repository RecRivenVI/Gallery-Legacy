package gallery

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.unit.*
import kotlinx.coroutines.*

@Composable
fun AuthorHeader(state: GalleryState) {
    val data = state.authorPage ?: return
    val a = data.author
    val p = LocalPalette.current
    Column(
        Modifier.fillMaxWidth().padding(bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (!state.hideAvatars) AccountAvatar(a.name, "", 48)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Label(a.name, size = 16, bold = true)
                Label(
                    listOf(platformBadges[a.platformId].orEmpty(), a.handle.orEmpty())
                        .filter { it.isNotEmpty() }
                        .joinToString(" · "),
                    color = p.muted,
                )
            }
            if (!a.sourceUrl.isNullOrEmpty()) Action("来源", icon = "link") { openLink(a.sourceUrl) }
        }
        val dates =
            listOfNotNull(
                    data.firstAt?.let { isoDate(it.toDouble()).take(7) },
                    data.lastAt?.let { isoDate(it.toDouble()).take(7) },
                )
                .joinToString(" 至 ")
        Label(
            listOf(
                    "作品 ${grouped(a.workCount)}",
                    "共 ${grouped(data.pages)} 页",
                    dates,
                    data.types
                        .filterKeys { it.isNotEmpty() }
                        .entries
                        .joinToString(" / ") { (type, n) ->
                            "${workTypeNames[type]?:type} ${grouped(n)}"
                        },
                )
                .filter { it.isNotEmpty() }
                .joinToString(" · "),
            color = p.fg2,
        )
        if (data.bio.isNotEmpty()) Label(data.bio, color = p.fg2)
        val tagsScroll = rememberScrollState()
        Row(
            Modifier.fillMaxWidth().edgeFade(tagsScroll).horizontalScroll(tagsScroll),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            data.tags.forEach { tag ->
                Action("${tag.label} ${grouped(tag.workCount)}") {
                    state.filters.includeTag(tag.label)
                }
            }
        }
        if (data.linked.isNotEmpty()) Label("其他平台", color = p.faint, size = 11)
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            data.linked.forEach { other ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Action(
                        "${platformBadges[other.platformId]} ${other.name} ${grouped(other.workCount)}"
                    ) {
                        state.navigate(Route(other.stableId))
                    }
                    IconAction("close", "取消关联 ${other.name}") {
                        state.people.link(a.stableId, other.stableId, "unlink")
                    }
                }
            }
            Action("＋ 关联其他作者") { state.panel = "author-link" }
        }
        if (data.linked.isNotEmpty()) {
            val all = state.route.filters["linkedAuthor"] != null
            Segment(
                listOf(
                    "本平台 ${grouped(a.workCount)}",
                    "全部平台 ${grouped(a.workCount+data.linked.sumOf {it.workCount})}",
                ),
                if (all) 1 else 0,
            ) {
                state.filters.set("linkedAuthor", if (it == 1) data.key else "")
            }
        }
    }
}

@Composable
fun AuthorLinkPanel(state: GalleryState) {
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<AuthorSummaryWire>>(emptyList()) }
    var error by remember { mutableStateOf("") }
    LaunchedEffect(query) {
        if (query.isBlank()) {
            results = emptyList()
            return@LaunchedEffect
        }
        delay(250)
        try {
            results =
                readApi<PageWire<AuthorSummaryWire>>(
                        "authors",
                        mapOf("q" to query, "pageSize" to 20),
                    )
                    .items
            error = ""
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = humanError(e.message.orEmpty())
        }
    }
    Label("关联其他作者", size = 16, bold = true)
    Field(query, { query = it }, "搜索名称、账号", Modifier.fillMaxWidth())
    results
        .filter { it.id != state.authorPage?.author?.id }
        .forEach { other ->
            Action(
                "${platformBadges[other.platformId]} · ${other.name} · ${grouped(other.workCount)}",
                modifier = Modifier.fillMaxWidth(),
            ) {
                state.authorPage?.author?.let {
                    state.people.link(it.stableId, other.stableId, "link")
                }
            }
        }
    if (error.isNotEmpty()) Label(error, color = LocalPalette.current.error)
}
