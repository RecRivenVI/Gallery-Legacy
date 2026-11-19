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
internal fun AccessPage(state: ManagerState) {
    val p = LocalPalette.current
    AutoBanSettings(state)
    Section {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
                Toggle(
                    "封禁功能",
                    state.access?.enabled ?: true,
                    state.access != null && !state.busy,
                ) { enabled ->
                    state.action("access", "更改封禁功能") {
                        admin("access.configure", document("enabled" to enabled))
                        state.refreshPage()
                    }
                }
            }
            Spacer(Modifier.width(30.dp))
            val periods = listOf(1, 7, 30, 0)
            Segment(listOf("今天", "7 天", "30 天", "全部"), periods.indexOf(state.period)) {
                state.action("access", "读取访问记录") {
                    state.period = periods[it]
                    state.accessPage = 1
                    state.refreshPage()
                }
            }
        }
        ManagerError(state, "access")
        if (state.access != null)
            Action("清空访问记录…", enabled = !state.busy) {
                state.confirmation =
                    ManagerConfirmation(
                        "清空访问次数和事件记录，现有封禁和封禁历史将保留。",
                        "清空",
                        {
                            admin("access.clear", document("confirm" to true))
                            state.accessPage = 1
                            state.refreshPage()
                        },
                    )
            }
        AccessPagination(state)
        if (state.access == null) Skeleton(Modifier.fillMaxWidth().height(120.dp))
        else if (state.access?.clients.orEmpty().isEmpty()) Label("这段时间没有访问记录", color = p.muted)
        else {
            Row {
                listOf("地址", "客户端", "请求数", "错误数", "最近访问", "操作").forEach {
                    Label(it, Modifier.weight(1f), p.faint, 11)
                }
            }
            Rule()
            state.access?.clients.orEmpty().forEach { client ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 44.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Label(client.address, Modifier.weight(1f), size = 12)
                    Label(
                        if (client.local) "本机"
                        else if (client.agent == "Venera") "Venera" else "浏览器",
                        Modifier.weight(1f),
                    )
                    Label(grouped(client.requests), Modifier.weight(1f))
                    Label(
                        grouped(client.errors),
                        Modifier.weight(1f),
                        color = if (client.errors > 0) p.error else p.fg,
                    )
                    Label(
                        clock(client.lastSeenAtMs.toDouble()),
                        Modifier.weight(1f),
                        p.faint,
                        11,
                    )
                    Box(Modifier.weight(1f)) {
                        if (client.local) Label("本机", color = p.faint)
                        else
                            Action(
                                if (client.blocked) "解除" else "封禁",
                                enabled = !state.busy,
                            ) {
                                state.action("access", "更改封禁") {
                                    admin(
                                        "access.block",
                                        document(
                                            "id" to client.id,
                                            "blocked" to !client.blocked,
                                        ),
                                    )
                                    state.refreshPage()
                                }
                            }
                    }
                }
            }
        }
    }
}

@Composable
private fun AccessPagination(state: ManagerState) {
    val snapshot = state.access ?: return
    if (snapshot.clientPages < 2) return
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Action("上一页", enabled = !state.busy && snapshot.clientPage > 1) {
            state.action("access", "读取访问记录") {
                state.accessPage = snapshot.clientPage - 1
                state.refreshPage()
            }
        }
        Label("${snapshot.clientPage} / ${snapshot.clientPages}")
        Action("下一页", enabled = !state.busy && snapshot.clientPage < snapshot.clientPages) {
            state.action("access", "读取访问记录") {
                state.accessPage = snapshot.clientPage + 1
                state.refreshPage()
            }
        }
    }
}

@Composable
private fun AutoBanSettings(state: ManagerState) {
    val rule = state.access?.autoBan ?: AutoBanRuleWire()
    var enabled by remember(rule) { mutableStateOf(rule.enabled) }
    var seconds by remember(rule) { mutableStateOf(rule.windowSeconds.toString()) }
    var requests by remember(rule) { mutableStateOf(rule.maxRequests.toString()) }
    var errors by remember(rule) { mutableStateOf(rule.maxErrors.toString()) }
    var minutes by remember(rule) { mutableStateOf(rule.banMinutes.toString()) }
    Section("自动封禁") {
        Toggle("自动封禁", enabled) { enabled = it }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f)) {
                Label("统计时长（秒）")
                Field(seconds, { seconds = it })
            }
            Column(Modifier.weight(1f)) {
                Label("请求数上限")
                Field(requests, { requests = it })
            }
            Column(Modifier.weight(1f)) {
                Label("错误数上限")
                Field(errors, { errors = it })
            }
            Column(Modifier.weight(1f)) {
                Label("封禁时长（分钟）")
                Field(minutes, { minutes = it })
            }
        }
        Action("应用", enabled = state.access != null && !state.busy) {
            state.action("access", "设置自动封禁") {
                admin(
                    "access.autoban",
                    document(
                        "enabled" to enabled,
                        "windowSeconds" to (seconds.toLongOrNull() ?: 0L),
                        "maxRequests" to (requests.toLongOrNull() ?: 0L),
                        "maxErrors" to (errors.toLongOrNull() ?: 0L),
                        "banMinutes" to (minutes.toLongOrNull() ?: 0L),
                    ),
                )
                state.refreshPage()
            }
        }
    }
}
