package gallery

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable
private fun PathTail(value: String, modifier: Modifier = Modifier) {
    val scroll = rememberScrollState()
    LaunchedEffect(value, scroll.maxValue) { scroll.scrollTo(scroll.maxValue) }
    Box(modifier.clipToBounds().edgeFade(scroll)) {
        Row(Modifier.horizontalScroll(scroll)) { Label(value, maxLines = 1) }
    }
}

@Composable
internal fun ManagerSettings(state: ManagerState) {
    val c = state.draft
    if (c == null) {
        Skeleton(Modifier.fillMaxWidth().height(240.dp))
        ManagerError(state, "settings")
        return
    }
    Section("平台目录") {
        platforms.forEach { id ->
            Row(
                Modifier.fillMaxWidth().height(40.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Label(id, Modifier.width(100.dp))
                PathTail(c.sources[id].orEmpty(), Modifier.weight(1f))
                Action("更改…", enabled = !state.busy) {
                    state.action("settings", "选择目录") {
                        val path = host("pickDirectory")
                        if (path != JsonNull)
                            state.edit { it.copy(sources = c.sources + (id to path.text())) }
                    }
                }
            }
        }
    }
    Section("全部文件") {
        val roots = c.fileBrowserRoots
        roots.forEachIndexed { index, root ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Field(
                    root.name,
                    { value ->
                        state.edit {
                            it.copy(
                                fileBrowserRoots =
                                    roots.mapIndexed { i, r ->
                                        if (i == index) r.copy(name = value) else r
                                    }
                            )
                        }
                    },
                    "目录名称",
                    Modifier.width(120.dp),
                )
                PathTail(root.path, Modifier.weight(1f))
                Action("更改…") {
                    state.action("settings", "选择目录") {
                        val path = host("pickDirectory")
                        if (path != JsonNull)
                            state.edit {
                                it.copy(
                                    fileBrowserRoots =
                                        roots.mapIndexed { i, r ->
                                            if (i == index) r.copy(path = path.text()) else r
                                        }
                                )
                            }
                    }
                }
                Action("移除") {
                    state.edit {
                        it.copy(fileBrowserRoots = roots.filterIndexed { i, _ -> i != index })
                    }
                }
            }
        }
        Action("＋ 添加目录") {
            state.action("settings", "添加目录") {
                val path = host("pickDirectory")
                if (path != JsonNull)
                    state.edit {
                        it.copy(
                            fileBrowserRoots =
                                roots +
                                    RuntimeConfigurationFileBrowserRootsEntryWire(
                                        id = "folder-" + now().toLong(),
                                        name = "新目录",
                                        path = path.text(),
                                    )
                        )
                    }
            }
        }
    }
    Section("缩略图") {
        Label("视频处理程序")
        Field(
            c.ffmpegPath,
            { value -> state.edit { it.copy(ffmpegPath = value) } },
            "FFmpeg 路径",
            Modifier.fillMaxWidth(),
        )
        Label("中、大缩略图缓存上限（GB）")
        Field(
            (c.thumbnailCacheBytes / 1073741824L).toString(),
            { value ->
                state.edit {
                    it.copy(thumbnailCacheBytes = (value.toLongOrNull() ?: 0L) * 1073741824L)
                }
            },
            "缓存上限",
            Modifier.width(140.dp),
        )
    }
    Section("网络") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Label("谁能访问", Modifier.width(100.dp))
            Segment(
                listOf("仅本机", "局域网", "公网"),
                listOf("local", "lan", "public").indexOf(c.mode),
            ) {
                val mode = listOf("local", "lan", "public")[it]
                state.edit { c -> c.copy(mode = mode) }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Label("端口", Modifier.width(100.dp))
            Field(
                c.port.toString(),
                {
                    val port = it.toLongOrNull() ?: 0L
                    state.edit { c -> c.copy(port = port) }
                },
                "端口",
                Modifier.width(120.dp),
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Label("对外地址", Modifier.width(100.dp))
            Field(
                c.publicUrl,
                {
                    val url = it
                    state.edit { c -> c.copy(publicUrl = url) }
                },
                "Venera 使用的画廊地址",
                Modifier.weight(1f),
                enabled = c.mode != "local",
            )
        }
        Action(if (state.advanced) "高级 ▴" else "高级 ▾") { state.advanced = !state.advanced }
        if (state.advanced) {
            for ((key, label) in
                listOf("allowedHosts" to "允许的 Host", "allowedOrigins" to "允许的 Origin")) {
                Label(label)
                Field(
                    (if (key == "allowedHosts") c.allowedHosts else c.allowedOrigins).joinToString(
                        "\n"
                    ),
                    {
                        val lines = it.lines().filter(String::isNotBlank)
                        state.edit { c ->
                            if (key == "allowedHosts") c.copy(allowedHosts = lines)
                            else c.copy(allowedOrigins = lines)
                        }
                    },
                    label,
                    Modifier.fillMaxWidth(),
                    multiline = true,
                )
            }
            Label("短链")
            Field(
                c.shortLinks.entries.joinToString("\n") { it.key + " " + it.value },
                { value ->
                    state.edit { c ->
                        c.copy(
                            shortLinks =
                                value
                                    .lines()
                                    .filter { it.contains(' ') }
                                    .associate { it.substringBefore(' ') to it.substringAfter(' ') }
                        )
                    }
                },
                "短链",
                Modifier.fillMaxWidth(),
                multiline = true,
            )
        }
        ManagerAccounts(state)
        ManagerError(state, "settings") { state.save() }
    }
}
