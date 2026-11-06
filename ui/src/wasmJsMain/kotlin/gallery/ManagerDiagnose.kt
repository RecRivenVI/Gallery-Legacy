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
internal fun DiagnosePage(state: ManagerState) {
    val p = LocalPalette.current
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(Modifier.weight(1.5f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Section("日志") {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Segment(
                        listOf("全部", "警告", "错误"),
                        listOf("", "warn", "error").indexOf(state.logLevel),
                    ) {
                        state.logLevel = listOf("", "warn", "error")[it]
                        state.action("logs", "读取日志") { state.readLogs() }
                    }
                    Action("打开日志目录") {
                        state.action("logs", "打开日志目录") {
                            host("openDirectory", document("kind" to "logs"))
                        }
                    }
                }
                Field(state.logQuery, { state.logQuery = it }, "搜索日志", Modifier.fillMaxWidth())
                LaunchedEffect(state.logQuery) {
                    delay(150)
                    try {
                        state.readLogs()
                    } catch (e: Exception) {
                        state.failure("logs", "读取日志失败", e)
                    }
                }
                ManagerError(state, "logs") { state.readLogs() }
                if (state.logs.isEmpty()) Label("还没有日志", color = p.muted)
                else {
                    val scroll = rememberLazyListState()
                    var following by remember { mutableStateOf(true) }
                    LaunchedEffect(state.logs) {
                        if (following) scroll.scrollToItem((state.logs.size - 1).coerceAtLeast(0))
                    }
                    LaunchedEffect(scroll) {
                        snapshotFlow { scroll.layoutInfo.visibleItemsInfo.lastOrNull()?.index }
                            .collect { last ->
                                following = last == null || last >= state.logs.size - 2
                            }
                    }
                    LazyColumn(
                        Modifier.height(420.dp),
                        state = scroll,
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        itemsIndexed(state.logs, key = { index, it -> it.raw + index }) { _, row ->
                            var open by remember { mutableStateOf(false) }
                            Column(
                                Modifier.fillMaxWidth()
                                    .clickable { open = !open }
                                    .padding(vertical = 6.dp)
                            ) {
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Label(row.time, Modifier.width(64.dp), p.faint, 11)
                                    Label(
                                        when (row.level) {
                                            "error" -> "错误"
                                            "warn",
                                            "warning" -> "警告"
                                            "debug" -> "调试"
                                            else -> "信息"
                                        },
                                        color =
                                            if (row.level == "error") p.error
                                            else if (row.level == "warn") p.warn else p.faint,
                                        size = 11,
                                    )
                                    Label(row.summary, Modifier.weight(1f), size = 12)
                                }
                                if (open)
                                    androidx.compose.foundation.text.selection.SelectionContainer {
                                        Label(row.raw, Modifier.padding(top = 8.dp), p.muted, 11)
                                    }
                            }
                        }
                    }
                }
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Section("检查图库") {
                Label(
                    if (state.validation.running)
                        "正在检查 · 已检查 " + grouped(state.validation.works) + " 个作品"
                    else if (state.validation.finishedAtMs > 0)
                        "上次检查 " +
                            clock(state.validation.finishedAtMs.toDouble()) +
                            " · 发现 " +
                            grouped(state.validation.total) +
                            " 个问题"
                    else "还没有检查过",
                    color = p.muted,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Action(
                        "开始检查",
                        primary = true,
                        enabled = !state.busy && !state.validation.running,
                    ) {
                        state.action("validation", "检查图库") {
                            state.validation =
                                readAdmin<ValidationStatusWire>(
                                    "validation.start",
                                    document("confirmReadOnly" to true),
                                )
                        }
                    }
                    Action("查看问题", enabled = state.validation.id.isNotEmpty()) {
                        state.viewFindings()
                    }
                    if (state.validation.running)
                        Action("停止检查", enabled = !state.busy) {
                            state.action("validation", "停止检查") {
                                admin("validation.cancel")
                                state.validation =
                                    readAdmin<ValidationStatusWire>("validation.status")
                            }
                        }
                }
                ManagerError(state, "validation")
            }
            Section("运行环境") {
                val checks = state.environment?.checks.orEmpty()
                (listOf("libvips", "ffmpeg") + platforms).forEach { id ->
                    val row = checks.find { it.tool == id || it.platform == id }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Label(
                            if (row == null) "待检查" else if (row.available) "可用" else "不可用",
                            color =
                                if (row == null) p.faint else if (row.available) p.ok else p.error,
                        )
                        Label(
                            when (id) {
                                "libvips" -> "libvips"
                                "ffmpeg" -> "FFmpeg"
                                else -> id
                            }
                        )
                    }
                }
                Action("重新检查", enabled = !state.busy) {
                    state.action("environment", "检查运行环境") {
                        state.environment = readAdmin<EnvironmentWire>("diagnostics.run")
                    }
                }
                ManagerError(state, "environment")
            }
            Section("缓存") {
                val bytes = state.storage.cache.bytes
                Label(
                    if (bytes == 0L) "没有缓存"
                    else "缩略图缓存 ${(bytes/1048576.0).toInt()} MB，清理后会在浏览时重新生成",
                    color = p.muted,
                )
                Action("清理缓存…", enabled = !state.busy) {
                    state.confirmation =
                        ManagerConfirmation(
                            "缩略图缓存会被删除，浏览时会重新生成，这段时间图片加载会变慢。",
                            "清理",
                            {
                                val active = state.active
                                if (active) host("stop")
                                try {
                                    admin("cache.clear", document("confirm" to true))
                                } finally {
                                    if (active) host("start")
                                }
                                state.storage = readAdmin<StorageSnapshotWire>("storage.read")
                                state.refreshStatus()
                            },
                        )
                }
                ManagerError(state, "cache")
            }
        }
    }
    if (state.findingsOpen && state.findings != null)
        Section("检查结果") {
            var checks by remember { mutableStateOf<List<InspectionCheckWire>>(emptyList()) }
            LaunchedEffect(Unit) {
                checks = readAdmin<PageWire<InspectionCheckWire>>("validation.checks").items
            }
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Action("全部问题", selected = state.findingType.isEmpty()) {
                    state.findingType = ""
                    state.viewFindings()
                }
                checks.forEach { check ->
                    Action(
                        inspectionLabel(check.id),
                        selected = state.findingType == check.id,
                    ) {
                        state.findingType = check.id
                        state.viewFindings()
                    }
                }
            }
            Row {
                listOf("csv", "json").forEach { format ->
                    Action("导出 " + format.uppercase()) {
                        state.action("validation", "导出问题") {
                            admin(
                                "validation.export",
                                document("id" to state.validation.id, "format" to format),
                            )
                            host("openDirectory", document("kind" to "reports"))
                        }
                    }
                }
                Spacer(Modifier.weight(1f))
                Action("收起") { state.findingsOpen = false }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Field(state.findingQuery, { state.findingQuery = it }, "筛选路径", Modifier.weight(1f))
                Segment(
                    listOf("全部级别", "警告", "错误"),
                    listOf("", "warning", "error").indexOf(state.findingSeverity),
                ) {
                    state.findingSeverity = listOf("", "warning", "error")[it]
                    state.viewFindings()
                }
                Action("筛选") { state.viewFindings() }
            }
            state.findings?.items.orEmpty().forEach { finding ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Label(inspectionLabel(finding.code))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Label(
                            finding.platformId + " / " + finding.relativePath.replace('\\', '/'),
                            Modifier.weight(1f),
                            p.muted,
                            11,
                        )
                        Action("在资源管理器中显示") {
                            state.action("validation", "显示问题") {
                                host(
                                    "openFinding",
                                    document(
                                        "id" to state.validation.id,
                                        "index" to finding.index,
                                    ),
                                )
                            }
                        }
                    }
                    Rule()
                }
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Label("共 " + grouped((state.findings?.total ?: 0L)) + " 个问题", color = p.faint)
                Spacer(Modifier.weight(1f))
                Action("上一页", enabled = state.findingPage > 1 && !state.busy) {
                    state.viewFindings(state.findingPage - 1)
                }
                Label(state.findingPage.toString(), color = p.faint)
                Action(
                    "下一页",
                    enabled =
                        state.findingPage * 100 < (state.findings?.total ?: 0L) && !state.busy,
                ) {
                    state.viewFindings(state.findingPage + 1)
                }
            }
        }
}
