package gallery

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.focus.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.*
import androidx.compose.ui.layout.*
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable
internal fun ViewerDetails(state: ViewerState) {
    val p = LocalPalette.current
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SelectionContainer { Label(title(state.work), size = 16, bold = true) }
        if (author(state.work).isNotEmpty())
            Action(author(state.work)) {
                val path = state.work.stableId.substringBeforeLast('/')
                state.gallery.navigate(state.gallery.route.copy(path = path, page = 1))
            }
        Label(
            listOf(
                    state.work.platformId,
                    (state.work.publishedAtMs ?: 0L)
                        .takeIf { it > 0 }
                        ?.let { isoDate(it.toDouble()) }
                        .orEmpty(),
                    "${state.media.size} 页",
                )
                .filter { it.isNotEmpty() }
                .joinToString(" · "),
            color = p.faint,
            size = 11,
        )
        if (!state.work.stableId.startsWith("/f/"))
            Action("查看全部 ${state.media.size} 页") {
                state.gallery.navigate(
                    state.gallery.route.copy(path = state.work.stableId, page = 1)
                )
            }
        Tags(state.work.tags, state.gallery, false, wrap = true)
        PersonalDetails(state)
        state.work.details?.let { details ->
            if (details.seriesId.isNotEmpty())
                Action("系列：" + details.seriesTitle.ifEmpty { "全部作品" }) {
                    state.gallery.navigate(
                        Route(
                            "/@all/" + encode(state.work.platformId),
                            sort = "date_asc",
                            filters = mapOf("series" to details.seriesId),
                        )
                    )
                }
        }
        WorkFacts(state.work)
        Action(decode(state.work.stableId)) {
            state.copy(decode(state.work.stableId), "已复制位置")
        }
        if (state.work.sourceUrl.orEmpty().isNotEmpty())
            Action("来源链接") { openLink(state.work.sourceUrl.orEmpty()) }
        val source = state.work.description ?: TextSourceWire()
        val description = if (source.format == "html") plainHtml(source.text) else source.text
        if (description.isNotEmpty()) {
            Rule()
            LinkedDescription(description)
        }
        state.work.links
            .filter { it.url != state.work.sourceUrl }
            .forEach { link ->
                Action(link.label) { openLink(link.url) }
            }
        state.work.relations.forEach { relation ->
            val label =
                when (relation.type) {
                    "quote" -> "引用"
                    "reply" -> "回复"
                    "conversation" -> "会话"
                    else -> "转发"
                } + "：" + relation.targetId
            if (relation.targetPath.isEmpty()) Label(label, color = p.muted)
            else
                Action(label) {
                    state.gallery.navigate(
                        state.gallery.route.copy(path = relation.targetPath, page = 1)
                    )
                }
        }
        Rule()
        Action("设为背景") {
            state.current?.let {
                state.gallery.setBackground(state.work, it)
            }
        }
    }
}

@Composable
private fun WorkFacts(work: WorkSummaryWire) {
    val d = work.details ?: return
    val p = LocalPalette.current
    val facts = buildList {
        workTypeNames[d.workType]?.let { add(it) }
        if (work.platformId == "pixiv" && d.rating != null)
            add(listOf("全年龄", "R-18", "R-18G")[d.rating.toInt()])
        if (d.planName.isNotEmpty()) add("档位：" + d.planName + (d.planFee?.let { " · $it" } ?: ""))
        if (d.tools.isNotEmpty()) add("工具：" + d.tools.joinToString("、"))
        if (work.language.isNotEmpty()) add("语言：" + work.language)
        if (d.region.isNotEmpty()) add("地区：" + d.region)
        if (d.originalService.isNotEmpty())
            add("原平台：${d.originalService} · ${d.originalUser} · ${d.originalPost}")
    }
    facts.forEach { Label(it, color = p.muted, size = 12) }
    work.metrics?.let { m ->
        val values =
            listOf(
                    "收藏" to m.bookmarks,
                    "浏览" to m.views,
                    "点赞" to m.likes,
                    "评论" to m.comments,
                    "转发" to m.reposts,
                )
                .mapNotNull { (name, value) -> value?.let { name + " " + grouped(it) } }
        if (values.isNotEmpty()) Label(values.joinToString(" · "), color = p.faint, size = 11)
    }
}

@Composable
private fun LinkedDescription(text: String) {
    val fonts = LocalFonts.current
    val palette = LocalPalette.current
    LaunchedEffect(text) { fonts?.ensure(text) }
    val annotated =
        androidx.compose.ui.text.buildAnnotatedString {
            append(fonts?.annotated(text) ?: androidx.compose.ui.text.AnnotatedString(text))
            Regex("""https?://[^\s]+""").findAll(text).forEach { match ->
                addLink(
                    androidx.compose.ui.text.LinkAnnotation.Clickable(
                        match.value,
                        androidx.compose.ui.text.TextLinkStyles(
                            style =
                                androidx.compose.ui.text.SpanStyle(
                                    color = palette.fg,
                                    textDecoration =
                                        androidx.compose.ui.text.style.TextDecoration.Underline,
                                )
                        ),
                    ) {
                        openLink(match.value)
                    },
                    match.range.first,
                    match.range.last + 1,
                )
            }
        }
    SelectionContainer {
        androidx.compose.foundation.text.BasicText(
            annotated,
            style =
                androidx.compose.ui.text.TextStyle(
                    color = palette.fg2,
                    fontFamily = LocalGalleryFont.current,
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                ),
        )
    }
}
