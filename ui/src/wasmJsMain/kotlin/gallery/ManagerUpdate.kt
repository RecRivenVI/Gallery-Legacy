@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

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
internal fun UpdatePage(state: ManagerState) {
    val p = LocalPalette.current
    val c = state.config.value
    val scan = state.scan
    val progress = scan
    val running = progress.running
    Section {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Label("●", color = if (state.active) p.ok else p.faint)
            Label(if (state.active) "服务运行中" else "服务已停止", bold = true)
            if (state.active) {
                Label(c.listenAddress + ":" + c.port, color = p.muted)
                Action("复制") {
                    state.action("service", "复制地址") {
                        copyText(c.publicUrl.ifEmpty { "http://127.0.0.1:" + c.port })
                            .await<kotlin.js.JsBoolean>()
                    }
                }
            }
            Spacer(Modifier.weight(1f))
            if (state.active)
                Action("重启", enabled = !state.busy) {
                    state.action("service", "重启") {
                        host("restart")
                        state.refreshStatus()
                    }
                }
            Action(
                if (state.active) "停止" else "启动",
                primary = !state.active,
                enabled = !state.busy,
            ) {
                state.action("service", if (state.active) "停止" else "启动") {
                    host(if (state.active) "stop" else "start")
                    state.refreshStatus()
                }
            }
        }
        ManagerError(state, "service") { state.refreshStatus() }
    }
    if (c.sources.values.all { it.isEmpty() }) {
        Section("先设置平台目录") { Action("去设置", primary = true) { state.go("settings") } }
        return
    }
    Section(
        if (running)
            when (progress.phase) {
                "VALIDATING",
                "PUBLISHING",
                "CATALOG_FINALIZE",
                "SEARCH_FINALIZE" -> "保存结果"
                else -> "读取作品"
            }
        else "更新图库"
    ) {
        Label(
            if (running) "已用时 " + duration((now() - progress.startedAtMs).toLong())
            else if (progress.finishedAtMs > 0)
                "上次更新 " +
                    clock(progress.finishedAtMs.toDouble()) +
                    " · 用时 " +
                    duration(scan.elapsedMs)
            else "还没有更新过",
            color = p.muted,
        )
        if (running) {
            val checked =
                scan.observedWorks.takeIf { it > 0 }
                    ?: scan.works.takeIf { it > 0 }
                    ?: (scan.indexedWorks + scan.reusedWorks)
            val total = scan.preflight.totalWorks.takeIf { it > 0 } ?: scan.totalWorks
            Label("已检查 " + grouped(checked) + if (total > 0) " / " + grouped(total) else "")
            if (total > 0)
                Box(Modifier.fillMaxWidth().height(4.dp).background(p.tint)) {
                    Box(
                        Modifier.fillMaxWidth((checked.toFloat() / total).coerceIn(0f, 1f))
                            .height(4.dp)
                            .background(p.accent)
                    )
                }
            else Skeleton(Modifier.fillMaxWidth().height(4.dp))
        } else
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Action("全选") { state.select(platforms) }
                Action("清空") { state.select(emptyList()) }
            }
        val counts = state.status.platforms.associate { it.id to it.works }
        platforms.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { id ->
                    Row(
                        Modifier.weight(1f)
                            .height(40.dp)
                            .clip(GalleryShape(7.dp))
                            .background(p.tint)
                            .clickable(enabled = !running && state.active) {
                                state.select(
                                    if (id in state.selected) state.selected - id
                                    else state.selected + id
                                )
                            }
                            .padding(horizontal = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Box(
                            Modifier.size(14.dp)
                                .background(
                                    if (id in state.selected) p.accent else Color.Transparent,
                                    GalleryShape(3.dp),
                                )
                                .border(1.dp, p.faint, GalleryShape(3.dp))
                        ) {
                            if (id in state.selected)
                                Fluent("check", color = p.accentInk, size = 12)
                        }
                        Label(id, Modifier.weight(1f))
                        Label(
                            if (running) {
                                val completed =
                                    (scan.platformResults + scan.progress.platformResults).find {
                                        it.platformId == id &&
                                            it.status in listOf("COMPLETE", "INCREMENTAL_COMPLETE")
                                    }
                                if (completed != null) "已完成"
                                else if (id in scan.activePlatforms) "进行中"
                                else if (id in state.selected) "等待" else "未选择"
                            } else grouped(counts[id] ?: 0),
                            color = p.faint,
                            size = 11,
                        )
                    }
                }
            }
        }
        if (!running) Label("增量 / 全量扫描 · " + state.selected.joinToString("、"), color = p.muted)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (running)
                Action("停止", enabled = !state.busy) {
                    state.action("scan", "停止更新") {
                        admin("scan.cancel")
                        state.refreshStatus()
                    }
                }
            else {
                Action(
                    if (state.selected.isEmpty()) "先选择平台"
                    else if (state.selected.size == 9) "更新全部平台"
                    else "更新所选的 ${state.selected.size} 个平台",
                    primary = true,
                    enabled = state.active && !state.busy && state.selected.isNotEmpty(),
                ) {
                    state.update()
                }
                Action(
                    "全量扫描所选平台…",
                    enabled = state.active && !state.busy && state.selected.isNotEmpty(),
                ) {
                    state.update(true)
                }
            }
        }
        if (state.scan.failure?.code == "EVERYTHING_CONFIRMATION_REQUIRED")
            Action("遍历目录并继续") { state.update(full = state.scan.mode == "full", native = true) }
        ManagerError(state, "scan") { state.refreshStatus() }
    }
    ScanDetails(state)
    ThumbnailProgress(state)
    Section("上次结果") {
        val change = scan.changes
        Label(
            "新增 ${grouped(change.worksAdded)} · 更新 ${grouped(change.worksUpdated)} · 移除 ${grouped(change.worksDeleted)} · 作品总数 ${grouped(state.status.counts.works)}"
        )
        if (scan.state in listOf("FAILED", "CANCELLED"))
            Label(
                if (scan.state == "FAILED") "更新没有完成" else "更新已停止",
                color = if (scan.state == "FAILED") p.error else p.muted,
            )
        val issues = scan.diagnosticCount
        if (issues > 0)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Label("有 ${grouped(issues)} 个问题需要检查", Modifier.weight(1f), p.warn)
                Action("查看 ›") { state.go("diagnose") }
            }
    }
}

@Composable
internal fun ThumbnailProgress(state: ManagerState) {
    val value = state.thumbnails
    if (value.total == 0L) return
    Section("封面预生成") {
        Label(
            "${grouped(value.completed)} / ${grouped(value.total)}",
            color = LocalPalette.current.muted,
        )
        if (value.failed > 0)
            Label("${grouped(value.failed)} 个封面未能生成", color = LocalPalette.current.warn)
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Label(
                if (value.waitingForScan) "扫描中，已暂停"
                else if (value.paused) "已暂停" else if (value.running) "正在生成" else "已完成",
                Modifier.weight(1f),
            )
            if (value.completed + value.failed < value.total)
                Action(if (value.paused) "继续" else "暂停", enabled = !state.busy) {
                    state.action("thumbnails", "更改封面预生成") {
                        state.thumbnails =
                            readAdmin<ThumbnailProgressWire>(
                                "thumbnails.pause",
                                document("paused" to !value.paused),
                            )
                    }
                }
        }
    }
}
