package gallery

import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.interaction.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.input.key.*
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable
fun Sidebar(state: GalleryState, modifier: Modifier, expanded: Boolean) {
    val p = LocalPalette.current
    val textAlpha by
        animateFloatAsState(if (expanded) 1f else 0f, tween(if (state.reduceMotion) 0 else 220))
    val textX by
        animateDpAsState(
            if (expanded) 0.dp else (-12).dp,
            tween(if (state.reduceMotion) 0 else 220),
        )
    val brandInteraction = remember { MutableInteractionSource() }
    val brandHover by brandInteraction.collectIsHoveredAsState()
    GlassSurface(modifier.clipToBounds(), radius = 0.dp) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.wrapContentWidth(Alignment.Start, unbounded = true)
                    .width(240.dp)
                    .height(50.dp)
                    .padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.hoverable(brandInteraction)) {
                    if (expanded) Fluent("gallery", Modifier.padding(8.dp), size = 18)
                    else
                        IconAction(
                            if (!expanded && brandHover) "menu" else "gallery",
                            if (expanded) "画廊" else "展开侧边栏",
                        ) {
                            if (!expanded) state.sidebar(true)
                        }
                }
                Row(
                    Modifier.weight(1f).offset(x = textX).alpha(textAlpha),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Label("画廊", Modifier.weight(1f), size = 18, bold = true)
                    if (expanded)
                        IconAction("menu", "收起侧边栏") {
                            if (browserWidth() < 900) state.drawer = false else state.sidebar(false)
                        }
                }
            }
            Rule()
            Box(Modifier.weight(1f)) {
                Column(
                    Modifier.requiredWidth(240.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 4.dp)
                ) {
                    if (state.people.account != null) {
                        Label(
                            "我的",
                            Modifier.offset(x = textX)
                                .alpha(textAlpha)
                                .padding(start = 12.dp, top = 16.dp, bottom = 8.dp),
                            p.faint,
                            11,
                        )
                        listOf(
                                Triple("continue", "继续阅读", "book"),
                                Triple("favorites", "收藏", "heart"),
                                Triple("history", "历史", "history"),
                            )
                            .forEach { (key, label, icon) ->
                                Row(
                                    Modifier.fillMaxWidth()
                                        .height(42.dp)
                                        .clip(GalleryShape(10.dp))
                                        .background(
                                            if (state.route.kind == key) p.selected
                                            else Color.Transparent
                                        )
                                        .keyboardFocus()
                                        .clickable {
                                            state.navigate(
                                                Route(
                                                    "/@my/$key",
                                                    sort =
                                                        if (key == "favorites") "favorite_desc"
                                                        else "date_desc",
                                                )
                                            )
                                        }
                                        .padding(horizontal = 12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Fluent(icon, Modifier.width(30.dp), p.muted, 18)
                                    Row(
                                        Modifier.offset(x = textX).alpha(textAlpha),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Label(label, Modifier.weight(1f))
                                        Label(
                                            grouped(state.people.counts[key] ?: 0),
                                            color = p.faint,
                                        )
                                    }
                                }
                            }
                    }
                    Label(
                        "平台",
                        Modifier.offset(x = textX)
                            .alpha(textAlpha)
                            .padding(start = 12.dp, top = 16.dp, bottom = 8.dp),
                        p.faint,
                        11,
                    )
                    state.sources.forEach { source ->
                        val id = source.id
                        val selected =
                            !state.route.personalView &&
                                state.route.kind != "files" &&
                                id in state.filters.selectedPlatforms
                        val interaction = remember { MutableInteractionSource() }
                        val hover by interaction.collectIsHoveredAsState()
                        val press by interaction.collectIsPressedAsState()
                        val focus by interaction.collectIsFocusedAsState()
                        Row(
                            Modifier.fillMaxWidth()
                                .height(42.dp)
                                .clip(GalleryShape(10.dp))
                                .background(
                                    if (press) p.pressed
                                    else if (selected) p.selected
                                    else if (hover) p.tint else Color.Transparent
                                )
                                .then(
                                    if (focus && LocalKeyboard.current)
                                        Modifier.border(2.dp, p.fg, GalleryShape(10.dp))
                                    else Modifier
                                )
                                .hoverable(interaction)
                                .clickable(interaction, null, role = Role.Tab) {
                                    state.navigate(Route(path = "/@all/" + encode(id)))
                                }
                                .semantics {
                                    this.selected = selected
                                    contentDescription = id + " " + grouped(source.works)
                                }
                                .padding(horizontal = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Label(
                                platformBadges[id] ?: id.take(2),
                                Modifier.width(30.dp),
                                p.muted,
                                11,
                            )
                            Row(
                                Modifier.offset(x = textX).alpha(textAlpha),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Label(id, Modifier.weight(1f), bold = selected, maxLines = 1)
                                Label(grouped(source.works), color = p.faint)
                            }
                        }
                        if (state.scanRunning && expanded)
                            state.scanProgress.platformProgress
                                .find { it.platformId == id }
                                ?.let { s ->
                                    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                                        TaskProgress(
                                            "作品",
                                            s.scannedWorks + s.skippedWorks,
                                            s.totalWorks,
                                            s.skippedWorks,
                                        )
                                        if (id != "Venera")
                                            TaskProgress(
                                                "作者",
                                                s.scannedAuthors + s.skippedAuthors,
                                                s.totalAuthors,
                                                s.skippedAuthors,
                                            )
                                    }
                                }
                    }
                    run {
                        Label(
                            "全部文件",
                            Modifier.offset(x = textX)
                                .alpha(textAlpha)
                                .padding(start = 12.dp, top = 20.dp, bottom = 8.dp),
                            p.faint,
                            11,
                        )
                    }
                    state.roots.forEach { root ->
                        Row(
                            Modifier.fillMaxWidth()
                                .height(42.dp)
                                .clip(GalleryShape(10.dp))
                                .keyboardFocus(GalleryShape(10.dp))
                                .clickable { state.navigate(Route(path = "/f/" + root.id)) }
                                .padding(horizontal = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Fluent("folder", Modifier.width(30.dp), p.muted)
                            Label(
                                root.name,
                                Modifier.offset(x = textX).alpha(textAlpha),
                                maxLines = 1,
                            )
                        }
                    }
                }
            }
            Row(
                Modifier.requiredWidth(240.dp)
                    .height(42.dp)
                    .keyboardFocus()
                    .then(semanticControl("button", state.people.account?.name ?: "登录"))
                    .clickable { state.people.openLogin() }
                    .padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                val account = state.people.account
                if (account != null) AccountAvatar(account.name, account.avatar, 20)
                else Fluent("author", size = 20, color = p.muted)
                Label(
                    account?.name ?: "登录",
                    Modifier.offset(x = textX).alpha(textAlpha),
                    maxLines = 1,
                )
            }
            Row(
                Modifier.requiredWidth(240.dp).height(44.dp).padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Label("●", color = if (state.connected) p.ok else p.error, size = 9)
                Label(
                    if (state.connected) "已连接 · " + connectionTime(state.updatedAt) else "连接已断开",
                    modifier = Modifier.offset(x = textX).alpha(textAlpha),
                    color = p.faint,
                    size = 11,
                )
            }
        }
    }
}

fun connectionTime(time: Long): String {
    if (time == 0L) return "还没有更新过"
    val minutes = ((now() - time) / 60000).toLong().coerceAtLeast(0)
    return when {
        minutes < 1 -> "刚刚更新"
        minutes < 60 -> "$minutes 分钟前更新"
        minutes < 1440 -> "${minutes/60} 小时前更新"
        else -> clock(time.toDouble()).substringBefore(' ') + "更新"
    }
}
