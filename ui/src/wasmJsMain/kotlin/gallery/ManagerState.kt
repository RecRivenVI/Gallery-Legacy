package gallery

import androidx.compose.runtime.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Stable
class ManagerState(val scope: CoroutineScope) {
    var page by
        mutableStateOf(
            currentHash().removePrefix("#").takeIf {
                it in listOf("update", "authors", "covers", "access", "settings", "diagnose")
            } ?: "update"
        )
    var status by mutableStateOf(ManagerStatusWire())
    var config by mutableStateOf(ConfigSnapshotWire())
    var draft by mutableStateOf<RuntimeConfigurationWire?>(null)
    var access by mutableStateOf<AccessSnapshotWire?>(null)
    var period by mutableIntStateOf(1)
    var selected by
        mutableStateOf(
            stored("manager_selected").split('|').filter { it in platforms }.ifEmpty { platforms }
        )
    var validation by mutableStateOf(ValidationStatusWire())
    var findings by mutableStateOf<PageWire<FindingWire>?>(null)
    var findingType by mutableStateOf("")
    var findingSeverity by mutableStateOf("")
    var findingQuery by mutableStateOf("")
    var findingPage by mutableIntStateOf(1)
    var environment by mutableStateOf<EnvironmentWire?>(null)
    var storage by mutableStateOf(StorageSnapshotWire())
    var logs by mutableStateOf<List<LogLine>>(emptyList())
    var logQuery by mutableStateOf("")
    var logLevel by mutableStateOf("")
    var errors by mutableStateOf<Map<String, String>>(emptyMap())
    var busy by mutableStateOf(false)
    var confirmation by mutableStateOf<ManagerConfirmation?>(null)
    var advanced by mutableStateOf(false)
    var findingsOpen by mutableStateOf(false)
    var scan by mutableStateOf(ScanStatusWire())
    var issuePage by mutableIntStateOf(1)
    var issueResults by mutableStateOf<PageWire<ScanIssueWire>?>(null)

    fun loadIssues(page: Int = 1) =
        action("scan", "读取扫描记录") {
            issuePage = page
            issueResults =
                readAdmin<PageWire<ScanIssueWire>>("scan.issues", document("page" to page))
        }

    var thumbnails by mutableStateOf(ThumbnailProgressWire())
    var accounts by mutableStateOf<List<AccountWire>>(emptyList())

    fun loadAccounts() =
        action("settings", "读取账号") {
            accounts = readAdmin<PageWire<AccountWire>>("accounts.list").items
        }

    fun accountChange(operation: String, id: String, password: String = "") =
        action("settings", "修改账号") {
            accounts =
                readAdmin<PageWire<AccountWire>>(
                        operation,
                        document("id" to id, "password" to password),
                    )
                    .items
        }

    private var serviceState by mutableStateOf("")

    val active
        get() = serviceState in listOf("READY", "READY_LIVE", "STARTING")

    val changes
        get() =
            changedFields(
                json.encodeToJsonElement(config.value),
                draft?.let { json.encodeToJsonElement(it) },
            )

    fun failure(panel: String, action: String, e: Exception) {
        errors = errors + (panel to "$action：${humanError(e.message.orEmpty())}")
    }

    fun action(panel: String, label: String, block: suspend () -> Unit) {
        if (busy) return
        scope.launch {
            busy = true
            try {
                block()
                errors = errors - panel
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure(panel, label + "失败", e)
            } finally {
                busy = false
            }
        }
    }

    suspend fun start() {
        try {
            config = readAdmin<ConfigSnapshotWire>("config.read")
            draft = config.value
            refreshStatus()
            refreshPage()
        } catch (e: Exception) {
            failure("service", "读取服务状态失败", e)
        }
        while (currentCoroutineContext().isActive) {
            delay(1500)
            try {
                refreshStatus()
                if (page != "settings")
                    try {
                        refreshPage()
                        errors = errors - page
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        failure(page, "读取页面失败", e)
                    }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure("service", "读取服务状态失败", e)
            }
        }
    }

    suspend fun refreshStatus() {
        val incoming = json.decodeFromJsonElement<ManagerStatusWire>(host("status"))
        serviceState = incoming.state
        if (incoming.scan.startedAtMs != scan.startedAtMs) {
            issueResults = null
            issuePage = 1
        }
        scan = incoming.scan
        // Keep changing progress outside the stable page shell.
        thumbnails = incoming.thumbnails
        status = incoming.copy(scan = ScanStatusWire(), thumbnails = ThumbnailProgressWire())
        errors =
            if (incoming.hostFailure.isNotEmpty())
                errors + ("service" to "读取服务状态失败：${humanError(incoming.hostFailure)}")
            else errors - "service"
    }

    suspend fun refreshPage() {
        when (page) {
            "access" ->
                access = readAdmin<AccessSnapshotWire>("access.read", document("days" to period))
            "diagnose" -> {
                validation = readAdmin<ValidationStatusWire>("validation.status")
                storage = readAdmin<StorageSnapshotWire>("storage.read")
                readLogs()
                if (environment == null) environment = readAdmin<EnvironmentWire>("diagnostics.run")
            }
        }
    }

    fun go(next: String) {
        if (next == page) return
        val navigate = {
            page = next
            writeHash("#" + next, true)
            action(next, "读取页面") { refreshPage() }
        }
        if (page == "settings" && changes > 0)
            confirmation =
                ManagerConfirmation(
                    "有 $changes 项改动未保存。",
                    if (active) "保存并重启" else "保存",
                    {
                        save()
                        navigate()
                    },
                    "放弃改动" to
                        {
                            draft = config.value
                            navigate()
                        },
                )
        else navigate()
    }

    fun edit(change: (RuntimeConfigurationWire) -> RuntimeConfigurationWire) {
        draft = draft?.let(change)
    }

    suspend fun save() {
        var value = draft ?: return
        val port = value.port
        if (port !in 1..65535) throw IllegalStateException("PORT_INVALID")
        val mode = value.mode
        val listen =
            when (mode) {
                "local" -> "127.0.0.1"
                "public" -> "0.0.0.0"
                else -> {
                    val address =
                        value.publicUrl
                            .substringAfter("://")
                            .substringBefore(':')
                            .substringBefore('/')
                    if (
                        !Regex("^(10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)")
                            .containsMatchIn(address)
                    )
                        throw IllegalStateException("LAN_URL_REQUIRED")
                    address
                }
            }
        value = value.copy(listenAddress = listen)
        admin("config.validate", document("value" to json.encodeToJsonElement(value)))
        admin(
            "config.save",
            document(
                "value" to json.encodeToJsonElement(value),
                "revision" to config.revision,
                "confirm" to true,
            ),
        )
        if (active) host("restart")
        config = readAdmin<ConfigSnapshotWire>("config.read")
        draft = config.value
        refreshStatus()
    }

    fun select(ids: List<String>) {
        selected = ids
        saveStored("manager_selected", ids.joinToString("|"))
    }

    var authorPlatform by mutableStateOf("pixiv")
    var authorDirectory by mutableStateOf("")
    var coverAuthors by mutableStateOf("")
    var scanFull by mutableStateOf(false)

    fun update(full: Boolean = scanFull, author: Boolean = false, native: Boolean = false) {
        val ids = if (author) listOf(authorPlatform) else selected.toList()
        val mode = if (full) "full" else "incremental"
        val start: suspend () -> Unit = {
            try {
                admin(
                    "scan.start",
                    document(
                        "confirmReadOnly" to true,
                        "mode" to mode,
                        "platformIds" to ids,
                        "authorDirectoryName" to if (author) authorDirectory else null,
                        "allowNative" to native,
                    ),
                )
                refreshStatus()
            } catch (e: Exception) {
                if (e.message.orEmpty().contains("EVERYTHING_CONFIRMATION_REQUIRED")) {
                    confirmation =
                        ManagerConfirmation(
                            "文件清单服务不可用，是否改为遍历目录？",
                            "继续",
                            execute = {
                                admin(
                                    "scan.start",
                                    document(
                                        "confirmReadOnly" to true,
                                        "mode" to mode,
                                        "platformIds" to ids,
                                        "authorDirectoryName" to
                                            if (author) authorDirectory else null,
                                        "allowNative" to true,
                                    ),
                                )
                                refreshStatus()
                            },
                        )
                } else throw e
            }
        }
        confirmation =
            ManagerConfirmation(
                "${if(full) "全量" else "增量"}扫描 · ${ids.joinToString("、")}${if(author) " · "+authorDirectory else ""}",
                "开始扫描",
                start,
            )
    }

    fun startCovers(full: Boolean = false, native: Boolean = false) {
        val ids = selected.toList()
        val authors =
            coverAuthors
                .lineSequence()
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .groupBy({ it.substringBefore('/') }, { it.substringAfter('/') })
        val request =
            document(
                "mode" to if (full) "full" else "incremental",
                "platformIds" to ids,
                "authors" to authors,
                "allowNative" to native,
            )
        action("covers", "生成封面") {
            try {
                admin("thumbnails.start", request)
                refreshStatus()
            } catch (e: Exception) {
                if (!native && e.message.orEmpty().contains("EVERYTHING_CONFIRMATION_REQUIRED"))
                    confirmation =
                        ManagerConfirmation(
                            "文件清单服务不可用，是否改为遍历目录？",
                            "继续",
                            execute = {
                                admin(
                                    "thumbnails.start",
                                    JsonObject(request + ("allowNative" to JsonPrimitive(true))),
                                )
                                refreshStatus()
                            },
                        )
                else throw e
            }
        }
    }

    suspend fun readLogs() {
        val files = readAdmin<PageWire<LogFileWire>>("logs.list").items.take(3)
        val lines = mutableListOf<LogLine>()
        for (file in files) {
            val data =
                readAdmin<LogTextWire>(
                    "logs.read",
                    document(
                        "name" to file.name,
                        "raw" to true,
                        "query" to logQuery,
                        "level" to logLevel,
                    ),
                )
            lines += parseLogs(data.text)
        }
        logs = lines
    }

    fun viewFindings(page: Int = 1) {
        findingPage = page
        action("validation", "读取检查结果") {
            findings =
                readAdmin<PageWire<FindingWire>>(
                    "validation.findings",
                    document(
                        "id" to validation.id,
                        "check" to findingType.takeIf { it.isNotEmpty() },
                        "severity" to findingSeverity.takeIf { it.isNotEmpty() },
                        "query" to findingQuery,
                        "page" to page,
                        "limit" to 100,
                    ),
                )
            findingsOpen = true
        }
    }
}

class ManagerConfirmation(
    val text: String,
    val label: String,
    val execute: suspend () -> Unit,
    val extra: Pair<String, () -> Unit>? = null,
)

data class LogLine(val raw: String, val time: String, val level: String, val summary: String)

fun parseLogs(text: String): List<LogLine> =
    text
        .lineSequence()
        .filter { it.isNotBlank() }
        .map { raw ->
            val row =
                try {
                    json.decodeFromString<LogEntryWire>(raw)
                } catch (_: Exception) {
                    null
                }
            val event = row?.event.orEmpty()
            val counts = row?.changes ?: row?.platformChanges ?: ScanChangesWire()
            val platform = row?.platformId.orEmpty().ifEmpty { row?.platform.orEmpty() }
            val summary =
                when (event) {
                    "scan.complete",
                    "platform.complete",
                    "platform.incremental.complete" ->
                        "${platform.ifEmpty{"图库"}} ${if(row?.mode.orEmpty()=="full")"全量"else "增量"}更新完成：新增 ${counts.worksAdded} · 更新 ${counts.worksUpdated} · 移除 ${counts.worksDeleted} · 用时 ${(row?.elapsedMs ?: 0L)/1000} 秒"
                    "ready" -> "服务已启动"
                    "stopped" -> "服务已停止"
                    "scan.start" -> "${platform.ifEmpty{"图库"}} 更新开始"
                    "scan.cancelled" -> "更新已停止"
                    "scan.failed" -> "更新没有完成，请查看详细日志"
                    "validation.complete" -> "图库检查完成：发现 ${(row?.total ?: 0L)} 个问题"
                    else ->
                        row?.message
                            .orEmpty()
                            .ifEmpty { row?.msg.orEmpty() }
                            .takeIf {
                                it.any { c -> c in '\u3400'..'\u9fff' }
                            } ?: "服务记录"
                }
            LogLine(
                raw,
                row?.time
                    .orEmpty()
                    .ifEmpty { row?.at.orEmpty() }
                    .substringAfter('T')
                    .substringBefore('.')
                    .take(8),
                row?.level.orEmpty().ifEmpty { "info" },
                summary.lineSequence().first(),
            )
        }
        .toList()

fun duration(ms: Long): String =
    when {
        ms < 1000 -> "不到 1 秒"
        ms < 60000 -> "${ms/1000} 秒"
        ms < 3600000 -> "${ms/60000} 分 ${ms/1000%60} 秒"
        else -> "${ms/3600000} 小时 ${ms/60000%60} 分钟"
    }
