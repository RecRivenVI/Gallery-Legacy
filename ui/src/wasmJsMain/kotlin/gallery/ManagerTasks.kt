package gallery

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
internal fun TaskPlatforms(state: ManagerState) {
    platforms.chunked(3).forEach { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            row.forEach { id ->
                Action(
                    id,
                    selected = id in state.selected,
                    enabled = !state.scan.running,
                    modifier = Modifier.weight(1f),
                ) {
                    state.select(
                        if (id in state.selected) state.selected - id else state.selected + id
                    )
                }
            }
        }
    }
}

@Composable
internal fun AuthorScanPage(state: ManagerState) {
    Section("作者扫描") {
        platforms
            .filter { it != "Venera" }
            .chunked(3)
            .forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { id ->
                        Action(id, selected = state.authorPlatform == id) {
                            state.authorPlatform = id
                        }
                    }
                }
            }
        Field(state.authorDirectory, { state.authorDirectory = it }, "作者目录名")
        Label(
            "${if(state.scanFull)"全量" else "增量"}扫描 · ${state.authorPlatform} · ${state.authorDirectory}"
        )
        Toggle("全量扫描", state.scanFull) { state.scanFull = it }
        Action(
            "确认并开始扫描",
            primary = true,
            enabled =
                state.active &&
                    !state.busy &&
                    !state.scan.running &&
                    state.authorDirectory.isNotBlank(),
        ) {
            state.update(state.scanFull, true)
        }
        if (state.scan.failure?.code == "EVERYTHING_CONFIRMATION_REQUIRED")
            Action("遍历目录并继续") { state.update(state.scanFull, true, true) }
        ManagerError(state, "scan")
    }
    ScanDetails(state)
}

@Composable
internal fun CoverTaskPage(state: ManagerState) {
    Section("生成封面") {
        TaskPlatforms(state)
        Field(
            state.coverAuthors,
            { state.coverAuthors = it },
            "平台/作者目录名，每行一个；留空为所选平台全部作者",
            multiline = true,
        )
        Label(state.selected.joinToString("、"))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Action(
                "生成新增或变化的封面",
                primary = true,
                enabled =
                    state.active &&
                        !state.busy &&
                        !state.scan.running &&
                        state.selected.isNotEmpty(),
            ) {
                state.startCovers()
            }
            Action(
                "全部重新生成",
                enabled =
                    state.active &&
                        !state.busy &&
                        !state.scan.running &&
                        state.selected.isNotEmpty(),
            ) {
                state.startCovers(true)
            }
        }
        if (state.thumbnails.running || state.thumbnails.paused)
            Action("停止封面任务") {
                state.action("covers", "停止封面任务") {
                    admin("thumbnails.cancel")
                    state.refreshStatus()
                }
            }
        if (state.scan.running) Label("扫描期间暂停生成封面")
        if (state.thumbnails.failure.isNotEmpty()) ErrorNotice(humanError(state.thumbnails.failure))
        if (state.thumbnails.failure.contains("EVERYTHING_CONFIRMATION_REQUIRED"))
            Action("遍历目录并继续") { state.startCovers(native = true) }
        ManagerError(state, "covers")
    }
    ThumbnailProgress(state)
}

@Composable
internal fun ScanDetails(state: ManagerState) {
    val p = LocalPalette.current
    if (state.scan.progress.platformProgress.isNotEmpty())
        Section("扫描进度") {
            state.scan.progress.platformProgress.forEach { s ->
                Label(s.platformId)
                TaskProgress("作品", s.scannedWorks + s.skippedWorks, s.totalWorks, s.skippedWorks)
                TaskProgress(
                    "作者",
                    s.scannedAuthors + s.skippedAuthors,
                    s.totalAuthors,
                    s.skippedAuthors,
                )
            }
        }
    val issues = state.issueResults?.items ?: state.scan.progress.issues
    if (issues.isNotEmpty())
        Section("失败和警告") {
            issues.forEach { i ->
                Label(
                    "${i.platformId} ${i.work} · ${humanError(i.code)}",
                    color = if (i.severity == "error") p.error else p.warn,
                )
            }
        }
    if (state.scan.diagnosticCount > 0 || issues.isNotEmpty()) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Action("查看全部问题") { state.loadIssues() }
            val page = state.issueResults
            if (page != null) {
                Action("上一页", enabled = state.issuePage > 1) {
                    state.loadIssues(state.issuePage - 1)
                }
                Label("${state.issuePage} / ${page.totalPages.coerceAtLeast(1)}")
                Action("下一页", enabled = state.issuePage < page.totalPages) {
                    state.loadIssues(state.issuePage + 1)
                }
            }
        }
    }
}

@Composable
internal fun TaskProgress(label: String, done: Long, total: Long, skipped: Long = 0) {
    val p = LocalPalette.current
    Label(
        "$label ${grouped(done)} / ${grouped(total)} · 跳过 ${grouped(skipped)}",
        color = p.faint,
        size = 11,
    )
    Box(Modifier.fillMaxWidth().height(3.dp).background(p.tint)) {
        Box(
            Modifier.fillMaxWidth(if (total > 0) (done.toFloat() / total).coerceIn(0f, 1f) else 0f)
                .height(3.dp)
                .background(p.accent)
        )
    }
}
