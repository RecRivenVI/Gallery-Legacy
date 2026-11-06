package gallery

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.focus.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

private val managerPages =
    listOf(
        "update" to "更新图库",
        "authors" to "作者扫描",
        "covers" to "封面生成",
        "access" to "访问",
        "settings" to "设置",
        "diagnose" to "排查",
    )

@Composable
fun ManagerApp(state: ManagerState) {
    val p = LocalPalette.current
    val mainFocus = remember { FocusRequester() }
    LaunchedEffect(state.confirmation) { if (state.confirmation == null) mainFocus.requestFocus() }
    Box(Modifier.fillMaxSize().background(p.bg)) {
        Row(
            Modifier.fillMaxSize()
                .focusRequester(mainFocus)
                .focusRestorer()
                .focusGroup()
                .then(semanticControl("group", hidden = state.confirmation != null))
        ) {
            Column(
                Modifier.width(200.dp).fillMaxHeight().background(p.glass).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Label("画廊", Modifier.padding(12.dp), size = 18, bold = true)
                Rule()
                managerPages.forEach { (id, label) ->
                    Action(
                        label,
                        icon =
                            when (id) {
                                "settings" -> "settings"
                                "diagnose" -> "diagnose"
                                "authors" -> "author"
                                "covers" -> "gallery"
                                else -> id
                            },
                        selected = state.page == id,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        state.go(id)
                    }
                }
                Spacer(Modifier.weight(1f))
                Action("打开画廊", icon = "gallery", modifier = Modifier.fillMaxWidth()) {
                    state.action("service", "打开画廊") { host("openGallery") }
                }
                Label(
                    if (state.active) "服务运行中 · 端口 " + state.config.value.port else "服务已停止",
                    Modifier.padding(8.dp),
                    p.faint,
                    11,
                )
            }
            Column(Modifier.weight(1f).fillMaxHeight()) {
                Label(
                    managerPages.find { it.first == state.page }!!.second,
                    Modifier.padding(horizontal = 24.dp, vertical = 20.dp),
                    size = 20,
                    bold = true,
                )
                Column(
                    Modifier.weight(1f)
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(start = 24.dp, end = 24.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    when (state.page) {
                        "update" -> UpdatePage(state)
                        "authors" -> AuthorScanPage(state)
                        "covers" -> CoverTaskPage(state)
                        "access" -> AccessPage(state)
                        "settings" -> ManagerSettings(state)
                        "diagnose" -> DiagnosePage(state)
                    }
                }
                if (state.page == "settings" && state.draft != null && state.changes > 0)
                    Row(
                        Modifier.fillMaxWidth().background(p.glass).padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Column(Modifier.weight(1f)) {
                            Label("${state.changes} 项改动未保存")
                            if (state.active) Label("保存后会重启服务", color = p.muted, size = 11)
                        }
                        Action("放弃", enabled = !state.busy) {
                            state.draft = state.config.value
                        }
                        Action(
                            if (state.active) "保存并重启" else "保存",
                            primary = true,
                            enabled = !state.busy,
                        ) {
                            state.action("settings", "保存设置") { state.save() }
                        }
                    }
            }
        }
        val confirmation = state.confirmation
        if (confirmation != null)
            Confirmation(
                confirmation.text,
                confirmation.label,
                { state.confirmation = null },
                {
                    state.confirmation = null
                    state.action(
                        if (state.page in listOf("update", "authors")) "scan" else state.page,
                        "执行操作",
                        confirmation.execute,
                    )
                },
                confirmation.extra?.let {
                    it.first to
                        {
                            state.confirmation = null
                            it.second()
                        }
                },
            )
    }
}

@Composable
internal fun ManagerError(
    state: ManagerState,
    panel: String,
    retry: suspend () -> Unit = { state.refreshPage() },
) {
    state.errors[panel]?.let { ErrorNotice(it) { state.action(panel, "重试", retry) } }
}
