package gallery

import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Rect
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Stable
class GalleryState(val scope: CoroutineScope) {
    internal var preferences =
        try {
            json.decodeFromString<PreferencesWire>(
                stored("gallery_canvas_preferences").ifEmpty { "{}" }
            )
        } catch (_: IllegalArgumentException) {
            PreferencesWire()
        }
    var route by mutableStateOf(routeFromBrowser())
    val search = GallerySearch(this)
    val people = GalleryPeople(this)
    val filters = GalleryFilters(this)
    var authorPage by mutableStateOf<AuthorPageWire?>(null)
    var recordHistory by mutableStateOf(preferences.history)
    var mangaDefault by mutableStateOf(preferences.mangaDefault)
    val pageBand = androidx.compose.animation.core.Animatable(0f)
    var pageBandInitialized = false
    var pageDirection by mutableIntStateOf(0)
    var sources by mutableStateOf<List<PlatformSummaryWire>>(emptyList())
    var roots by mutableStateOf<List<FileRootWire>>(emptyList())
    var items by mutableStateOf<List<ContentItem>>(emptyList())
    var heading by mutableStateOf<ContentItem?>(null)
    var total by mutableLongStateOf(0)
    var authorTotal by mutableLongStateOf(0)
    var workTotal by mutableLongStateOf(0)
    var totalPages by mutableIntStateOf(0)
    var loading by mutableStateOf(true)
    var error by mutableStateOf("")
    var incomplete by mutableStateOf(false)
    var connected by mutableStateOf(false)
    var updatedAt by mutableStateOf(0L)
    var scanProgress by mutableStateOf(ScanProgressWire())
    var scanRunning by mutableStateOf(false)
    var autoRefresh by mutableStateOf(preferences.autoRefresh)
    internal var pendingAutomaticRefresh = false
    var newContent by mutableStateOf(false)
    var newCount by mutableLongStateOf(0)
    private val updates = CollectionUpdates()
    var theme by mutableStateOf(stored("gallery_theme").ifEmpty { "system" })
    var expanded by
        mutableStateOf(
            stored("gallery_canvas_sidebar").ifEmpty { if (coarsePointer()) "0" else "1" } != "0" &&
                browserWidth() >= 1100
        )
    var drawer by mutableStateOf(false)
    var panel by mutableStateOf("")
    var size by mutableIntStateOf(preferences.size.coerceIn(0, 5))
    var ratio by
        mutableStateOf(
            mapOf(
                "square" to "1:1",
                "landscape" to "4:3",
                "portrait" to "3:4",
                "wide" to "16:9",
                "tall" to "9:16",
            )[preferences.aspect] ?: "1:1"
        )
    var privacy by mutableStateOf(preferences.privacy)
    var hideEmpty by mutableStateOf(preferences.hideEmpty)
    var hideAvatars by mutableStateOf(preferences.hideAuthorAvatar)
    var reduceMotion by mutableStateOf(preferences.reduced || reducedMotion())
    var background by mutableStateOf("")
    var backgroundWork by mutableStateOf(preferences.background?.work.orEmpty())
    var dim by mutableFloatStateOf(preferences.dim.coerceIn(.5f, .9f))
    var splitEnabled by mutableStateOf(false)
    var viewer by mutableStateOf<ViewerState?>(null)
    val cardBounds = mutableMapOf<String, Rect>()
    var searchRect by mutableStateOf(Rect.Zero)
    var tagQuery by mutableStateOf("")
    var tags by mutableStateOf<List<TagWire>>(emptyList())
    var tagCursor by mutableStateOf("")
    var tagError by mutableStateOf("")
    private var loadingJob: Job? = null
    private var tagJob: Job? = null
    private var openJob: Job? = null
    val dark
        get() = theme == "dark" || (theme == "system" && systemDark())

    init {
        if (!currentHash().contains("pageSize="))
            route =
                route.copy(
                    pageSize =
                        preferences.pageSize.takeIf {
                            it in pageSizes
                        } ?: 48
                )
    }

    fun navigate(
        next: Route,
        replace: Boolean = false,
        closeViewer: Boolean = true,
        keepPanel: Boolean = false,
    ) {
        pageDirection =
            if (next.copy(page = route.page) == route && next.page != route.page) {
                if (next.page > route.page) 1 else -1
            } else 0
        route = next
        search.sync(next)
        if (closeViewer) viewer = null
        drawer = false
        if (!keepPanel) panel = ""
        writeHash(routeHash(next), replace)
        reload()
    }

    suspend fun refreshSources() {
        people.refresh(apply = true)
        val a = scope.async { readApi<PageWire<PlatformSummaryWire>>("platforms") }
        val b = scope.async { readApi<PageWire<FileRootWire>>("file-roots") }
        val c = scope.async { readApi<ServiceStatusWire>("status") }
        sources = a.await().items
        roots = b.await().items
        val status = c.await()
        connected = true
        updatedAt = status.scan?.finishedAtMs ?: 0L
        if (updatedAt == 0L)
            updatedAt =
                status.generations.find { it.id == status.loadedGenerationId }?.createdAtMs ?: 0L
        if (people.account == null) restoreBackground()
    }

    fun reload() {
        filters.parse(route.query)
        filters.loadOptions()
        loadingJob?.cancel()
        loading = true
        var requested = route
        loadingJob = scope.launch {
            loading = true
            error = ""
            newCount = 0
            newContent = false
            heading = null
            authorPage = null
            if (!requested.valid || !requested.validFilter) {
                loading = false
                return@launch
            }
            try {
                var data = readRows(requested)
                ensureActive()
                if (route != requested) return@launch
                val last = data.totalPages.coerceAtLeast(1)
                if (requested.page > last) {
                    requested = requested.copy(page = last)
                    route = requested
                    search.sync(requested)
                    writeHash(routeHash(requested), true)
                    data = readRows(requested)
                    ensureActive()
                    if (route != requested) return@launch
                }
                items = data.items
                total = data.total
                totalPages = data.totalPages
                heading = data.heading
                incomplete = data.incomplete
                workTotal = if (requested.kind != "authors") total else 0
                authorTotal = if (requested.kind == "authors") total else 0
                if (
                    requested.kind in listOf("works", "authors") &&
                        requested.filters.isEmpty() &&
                        requested.tag.isEmpty() &&
                        requested.mediaType == "all"
                ) {
                    val opposite = if (requested.kind == "authors") "works" else "authors"
                    val count =
                        readApi<PageWire<WorkSummaryWire>>(
                                opposite,
                                parameters(requested.copy(page = 1, pageSize = 24), opposite) +
                                    ("pageSize" to 1),
                            )
                            .total
                    ensureActive()
                    if (opposite == "works") workTotal = count else authorTotal = count
                }
                connected = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message.orEmpty()
                connected = false
            } finally {
                if (route == requested) loading = false
            }
        }
    }

    private fun parameters(r: Route, kind: String = r.kind): Map<String, Any?> = buildMap {
        if (!r.personalView && r.filters["linkedAuthor"].isNullOrEmpty())
            put("platform", decode(r.platform))
        if (kind == "works") putAll(r.filters)
        else r.filters["platforms"]?.let { put("platforms", it) }
        if (r.kind in listOf("favorites", "history", "continue")) put("my", r.kind)
        if (r.kind == "collection") put("collection", r.path.substringAfterLast('/'))
        put("q", r.query)
        put(
            "sort",
            if (kind == "authors" && r.sort !in authorSorts) "latest_desc"
            else if (kind == "works" && r.sort !in workSorts) "date_desc" else r.sort,
        )
        put("page", r.page)
        put("pageSize", r.pageSize)
        if (kind == "works") {
            put("tag", r.tag)
            put("mediaType", r.mediaType)
            put("hideEmpty", if (hideEmpty) 1 else 0)
        }
    }

    internal suspend fun readRows(r: Route): ContentPage {
        if (r.kind == "files") {
            val parts = r.path.split('/')
            val dir = parts.drop(3).joinToString("/") { decode(it) }
            val response =
                readApi<PageWire<FileEntryWire>>(
                    if (r.query.isEmpty()) "files" else "file-search",
                    mapOf(
                        "root" to parts[2],
                        "path" to dir,
                        "q" to r.query,
                        "page" to r.page,
                        "pageSize" to r.pageSize,
                        "mediaType" to r.mediaType,
                        "order" to if (r.sort == "name_desc") "desc" else "asc",
                    ),
                )
            val rows =
                response.items.map { f ->
                    val stable =
                        "/f/" +
                            parts[2] +
                            "/" +
                            f.relativePath
                                .ifEmpty { f.name }
                                .split('/')
                                .joinToString("/") { encode(it) }
                    val folder = f.type == "directory"
                    val cover =
                        if (folder) null
                        else
                            MediaSummaryWire(
                                fileName = f.name,
                                relativePath = f.relativePath,
                                type = f.type,
                                size = f.size,
                                url = f.url,
                                thumbnailUrl = f.thumbnailUrl,
                                width = f.width,
                                height = f.height,
                                thumbHash = f.thumbHash,
                                animated = f.animated,
                                defaultVisible = true,
                            )
                    ContentItem(
                        work =
                            WorkSummaryWire(
                                stableId = stable,
                                title = f.name,
                                cover = cover,
                                media = listOfNotNull(cover),
                            ),
                        folder = folder,
                        file = !folder,
                    )
                }
            return ContentPage(
                rows,
                response.total,
                response.totalPages,
                incomplete = response.complete == false || response.truncated,
            )
        }
        if (r.kind == "collections") {
            people.refresh()
            return ContentPage(emptyList(), people.collections.size.toLong(), 1)
        }
        if (r.kind == "pages") {
            val work = resolveWork(r.path)
            val media = visibleMedia(work)
            return ContentPage(
                media.drop((r.page - 1) * r.pageSize).take(r.pageSize).mapIndexed { i, m ->
                    ContentItem(
                        work.copy(cover = m, title = m.fileName, tags = emptyList()),
                        pageIndex = (r.page - 1) * r.pageSize + i,
                        key = work.stableId + m.relativePath,
                    )
                },
                media.size.toLong(),
                (media.size + r.pageSize - 1) / r.pageSize,
                ContentItem(work),
            )
        }
        if (r.kind == "author") {
            val author = resolveAuthor(r.path)
            authorPage = readApi<AuthorPageWire>("author-pages/" + author.id)
            val response =
                readApi<PageWire<WorkSummaryWire>>(
                    "works",
                    parameters(r, "works") +
                        if (r.filters["linkedAuthor"].isNullOrEmpty()) mapOf("author" to author.id)
                        else emptyMap(),
                )
            return ContentPage(
                response.items.map { ContentItem(it) },
                response.total,
                response.totalPages,
                authorItem(author),
            )
        }
        if (r.kind != "authors") {
            val response = readApi<PageWire<WorkSummaryWire>>("works", parameters(r, "works"))
            return ContentPage(
                response.items.map { ContentItem(it) },
                response.total,
                response.totalPages,
            )
        }
        val response = readApi<PageWire<AuthorSummaryWire>>("authors", parameters(r))
        val rows =
            response.items
                .map { author ->
                    scope.async {
                        val recent =
                            readApi<PageWire<WorkSummaryWire>>(
                                "works",
                                mapOf(
                                    "platform" to decode(r.platform),
                                    "author" to author.id,
                                    "pageSize" to 3,
                                    "sort" to "date_desc",
                                ),
                            )
                        authorItem(author, recent.items.mapNotNull { it.cover })
                    }
                }
                .awaitAll()
        return ContentPage(rows, response.total, response.totalPages)
    }

    suspend fun prefetchNext() {
        if (route.kind !in listOf("works", "author") || route.page >= totalPages) return
        try {
            val page = readRows(route.copy(page = route.page + 1))
            coroutineScope {
                page.items
                    .mapNotNull { it.cover }
                    .forEach { media ->
                        launch { prefetchImage(media.thumbnailUrl) }
                    }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            /* Navigation handles an unavailable next page. */
        }
    }

    fun open(item: ContentItem) {
        if (item.isFolder || item.isAuthor) {
            navigate(
                route.copy(
                    path = item.stableId,
                    page = 1,
                    sort = if (item.isAuthor) "date_desc" else "name_asc",
                )
            )
            return
        }
        openJob?.cancel()
        openJob = scope.launch {
            try {
                val work =
                    if (item.isFile) item.work.copy(media = listOfNotNull(item.cover))
                    else resolveWork(item.stableId)
                val index =
                    if (route.kind in listOf("history", "continue"))
                        ((work.personal?.page ?: 1) - 1).coerceAtLeast(0)
                    else item.pageIndex
                val existing = viewer
                if (existing != null && existing.split) {
                    existing.changeWork(work, index)
                    existing.closing = false
                    existing.updateLink()
                    return@launch
                }
                viewer =
                    ViewerState(
                        this@GalleryState,
                        work,
                        index,
                        splitEnabled && browserWidth() >= 1280 && !coarsePointer(),
                        itemKey(item),
                    )
                writeHash(
                    routeHash(route) + "&view=" + encode(work.stableId) + "&index=" + index,
                    false,
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message.orEmpty()
            }
        }
    }

    fun loadTags(append: Boolean = false) {
        tagJob?.cancel()
        tagJob = scope.launch {
            try {
                val result =
                    readApi<PageWire<TagWire>>(
                        "tags",
                        mapOf(
                            "platforms" to
                                if (route.personalView) null
                                else filters.selectedPlatforms.joinToString(","),
                            "q" to tagQuery,
                            "pageSize" to 40,
                            "cursor" to if (append) tagCursor else null,
                        ),
                    )
                tags = (if (append) tags else emptyList()) + result.items
                tagCursor = result.cursor.orEmpty()
                tagError = ""
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                tagError = "标签加载失败：" + humanError(e.message.orEmpty())
            }
        }
    }

    fun changedStatus(raw: String) {
        val data = json.decodeFromString<ApiEnvelopeWire<ServiceStatusWire>>(raw).data ?: return
        scanProgress = data.scan?.progress ?: ScanProgressWire()
        scanRunning = data.scan?.running == true
        val counters = data.platforms.associateBy { it.id }
        sources = sources.map { source ->
            counters[source.id]?.let { source.copy(works = it.works) } ?: source
        }
        val finish = data.scan?.finishedAtMs ?: 0L
        if (finish > 0) updatedAt = finish
        val (changed, added) = updates.receive(data, decode(route.platform))
        if (changed) {
            newContent = true
            newCount += added
            pendingAutomaticRefresh = true
        }
        connected = true
    }

    fun restoreViewer(hash: String = currentHash()) {
        val values =
            json.decodeFromString<Map<String, String>>(
                parseParameters(hash.substringAfter('?', ""))
            )
        val selectedMedia = values["media"].orEmpty()
        val path =
            values["view"].orEmpty().ifEmpty {
                if (selectedMedia.isNotEmpty() && route.kind in listOf("pages", "files")) route.path
                else ""
            }
        if (path.isEmpty()) {
            openJob?.cancel()
            viewer?.close()
            return
        }
        if (viewer?.work?.stableId == path) {
            viewer?.closing = false
            viewer?.page =
                requestedMediaPage(viewer!!.work, values)
                    .coerceIn(
                        0,
                        (viewer!!.media.size - 1).coerceAtLeast(0),
                    )
            return
        }
        openJob?.cancel()
        openJob = scope.launch {
            try {
                loadingJob?.join()
                val selectedPath =
                    if (route.kind == "files" && selectedMedia.isNotEmpty())
                        path.trimEnd('/') +
                            "/" +
                            selectedMedia.split('/').joinToString("/") { encode(it) }
                    else path
                val file = items.find { it.isFile && it.stableId == selectedPath }
                val work =
                    (if (file != null) file.work.copy(media = listOfNotNull(file.cover))
                    else resolveWork(path))
                viewer =
                    ViewerState(
                        this@GalleryState,
                        work,
                        requestedMediaPage(work, values),
                        false,
                    )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message.orEmpty()
            }
        }
    }
}

internal fun GalleryState.refreshVisible() {
    val requested = route
    scope.launch {
        try {
            val data = readRows(requested)
            if (route == requested) {
                items = data.items
                total = data.total
                totalPages = data.totalPages
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            pendingAutomaticRefresh = true
            connected = false
        }
    }
}
