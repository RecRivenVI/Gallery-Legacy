@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package gallery

import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

class ViewerState(
    val gallery: GalleryState,
    initial: WorkSummaryWire,
    initialPage: Int,
    initialSplit: Boolean,
    originKey: String = initial.stableId,
) {
    val origin = gallery.cardBounds[originKey]
    val openingCover = initial.cover
    var work by mutableStateOf(initial)
    var page by
        mutableIntStateOf(
            initialPage.coerceIn(0, (visibleMedia(initial).size - 1).coerceAtLeast(0))
        )
    var split by mutableStateOf(initialSplit)
    var details by
        mutableStateOf(
            if (browserWidth() < 700) stored("gallery_viewer_details") == "true"
            else stored("gallery_viewer_details") != "false"
        )
    var hidden by mutableStateOf(stored("gallery_viewer_hidden") == "1")
    var closing by mutableStateOf(false)
    var zoom by mutableFloatStateOf(1f)
    var pan by mutableStateOf(Offset.Zero)
    var error by mutableStateOf("")
    var retry by mutableIntStateOf(0)
    var lastPointer by mutableStateOf(now())
    var nearEdge by mutableStateOf(false)
    var message by mutableStateOf("")
    var imageWidth by mutableIntStateOf(0)
    var imageHeight by mutableIntStateOf(0)
    var areaWidth by mutableFloatStateOf(0f)
    var areaHeight by mutableFloatStateOf(0f)
    var pixelRatio by mutableFloatStateOf(1f)
    var dragging by mutableStateOf(false)
    var direction by mutableIntStateOf(1)
    var dragX by mutableFloatStateOf(0f)
    var neighbors by mutableStateOf(listOf(initial))
    val media
        get() = visibleMedia(work)

    val current
        get() = media.getOrNull(page)

    private var workJob: Job? = null
    private var neighborJob: Job? = null
    private val cachedWorks = mutableMapOf(initial.stableId to initial)
    val glassMasks = mutableStateMapOf<Any, GlassMask>()
    val reading = ViewerReading(this)

    init {
        reading.changedWork(initial)
        loadNeighbors()
    }

    fun dispose() {
        reading.dispose()
        workJob?.cancel()
        neighborJob?.cancel()
    }

    fun copy(value: String, success: String) {
        gallery.scope.launch {
            message =
                if (copyText(value).await<kotlin.js.JsBoolean>().toBoolean()) success
                else "浏览器不允许复制，请手动复制"
        }
    }

    fun closeRect(): Rect? {
        val key =
            if (gallery.route.kind == "pages")
                gallery.items.find { it.pageIndex == page }?.let(::itemKey)
            else work.stableId
        return gallery.cardBounds[key] ?: origin
    }

    private fun loadNeighbors() {
        neighborJob?.cancel()
        neighborJob =
            gallery.scope.launch {
                val list = gallery.items.filter { !it.isAuthor && !it.isFolder }
                val index = list.indexOfFirst { it.stableId == work.stableId }
                if (index < 0) {
                    neighbors = listOf(work)
                    return@launch
                }
                val candidates =
                    list.subList((index - 2).coerceAtLeast(0), (index + 3).coerceAtMost(list.size))
                try {
                    val result = coroutineScope {
                        candidates
                            .map { item ->
                                async {
                                    cachedWorks[item.stableId]
                                        ?: if (item.isFile)
                                            item.work.copy(media = listOfNotNull(item.cover))
                                        else resolveWork(item.stableId)
                                }
                            }
                            .awaitAll()
                    }
                    ensureActive()
                    neighbors = result
                    cachedWorks.clear()
                    for (item in result) cachedWorks[item.stableId] = item
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    neighbors = listOf(work)
                }
            }
    }

    fun mediaInfo(relative: String, width: Int, height: Int, animated: Boolean) {
        val old = media.find { it.relativePath == relative } ?: return
        if (old.width == width && old.height == height && old.animated == animated) return
        work =
            work.copy(
                media =
                    work.media.map {
                        if (it.relativePath == relative)
                            it.copy(width = width, height = height, animated = animated)
                        else it
                    }
            )
        imageWidth = width
        imageHeight = height
        if (animated && reading.options.mode != "single")
            reading.options = reading.options.copy(mode = "single")
    }

    fun updatePersonal(path: String, personal: PersonalStateWire?) {
        if (work.stableId == path) work = work.copy(personal = personal)
        cachedWorks[path]?.let { cachedWorks[path] = it.copy(personal = personal) }
        neighbors = neighbors.map { if (it.stableId == path) it.copy(personal = personal) else it }
    }

    fun accountWork(next: WorkSummaryWire) {
        cachedWorks.clear()
        neighbors = listOf(next)
        changeWork(next, page)
    }

    fun changeWork(next: WorkSummaryWire, index: Int = 0) {
        work = next
        page = index.coerceIn(0, (visibleMedia(next).size - 1).coerceAtLeast(0))
        zoom = 1f
        pan = Offset.Zero
        error = ""
        imageWidth = 0
        imageHeight = 0
        cachedWorks[next.stableId] = next
        reading.changedWork(next)
        loadNeighbors()
    }

    fun flip(delta: Int) {
        val step = reading.step(delta) ?: return
        flipPages(step)
        if (reading.options.mode == "continuous") reading.scrollTarget = page
    }

    private fun flipPages(delta: Int) {
        direction = delta
        val currentIndex = neighbors.indexOfFirst { it.stableId == work.stableId }
        if (currentIndex >= 0) {
            val next =
                adjacent(
                    ViewerPosition(currentIndex, page),
                    delta,
                    neighbors.map { visibleMedia(it).size },
                )
            if (next != null) {
                if (next.work != currentIndex) changeWork(neighbors[next.work], next.page)
                else {
                    page = next.page
                    zoom = 1f
                    pan = Offset.Zero
                    error = ""
                }
                lastPointer = now()
                updateLink()
                return
            }
        }
        if (page + delta in media.indices) {
            page += delta
            zoom = 1f
            pan = Offset.Zero
            error = ""
            updateLink()
        } else neighbor(delta)
    }

    fun neighbor(delta: Int) {
        direction = delta
        workJob?.cancel()
        workJob =
            gallery.scope.launch {
                try {
                    val works = gallery.items.filter { !it.isFolder && !it.isAuthor }
                    val index = works.indexOfFirst { it.stableId == work.stableId }
                    var item = works.getOrNull(index + delta)
                    if (
                        item == null &&
                            gallery.route.kind in listOf("works", "author") &&
                            gallery.route.page + delta in 1..gallery.totalPages
                    ) {
                        val next = gallery.route.copy(page = gallery.route.page + delta)
                        gallery.navigate(next, replace = true, closeViewer = false)
                        while (gallery.loading) delay(10)
                        item =
                            if (delta > 0) gallery.items.firstOrNull()
                            else gallery.items.lastOrNull()
                    }
                    if (item != null) {
                        val next =
                            if (item.isFile) item.work.copy(media = listOfNotNull(item.cover))
                            else resolveWork(item.stableId)
                        ensureActive()
                        changeWork(
                            next,
                            if (delta < 0) (visibleMedia(next).size - 1).coerceAtLeast(0) else 0,
                        )
                        updateLink()
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    error = humanError(e.message.orEmpty())
                }
            }
    }

    fun updateLink() {
        writeHash(
            routeHash(gallery.route) + "&view=" + encode(work.stableId) + "&index=" + page,
            true,
        )
    }

    fun close() {
        closing = true
    }

    fun toggleHidden() {
        hidden = !hidden
        saveStored("gallery_viewer_hidden", if (hidden) "1" else "0")
    }

    fun setScale(value: Float, anchor: Offset = Offset.Zero) {
        val next = value.coerceIn(.1f, 8f)
        val factor = next / zoom
        pan = (pan - anchor) * factor + anchor
        zoom = next
        constrainPan()
    }

    fun move(delta: Offset) {
        pan += delta
        constrainPan()
    }

    fun constrainPan() {
        if (imageWidth <= 0 || imageHeight <= 0 || areaWidth <= 0 || areaHeight <= 0) {
            pan = Offset.Zero
            return
        }
        val fit = minOf(areaWidth / imageWidth, areaHeight / imageHeight)
        val x = ((imageWidth * fit * zoom - areaWidth) / 2).coerceAtLeast(0f)
        val y = ((imageHeight * fit * zoom - areaHeight) / 2).coerceAtLeast(0f)
        pan = Offset(pan.x.coerceIn(-x, x), pan.y.coerceIn(-y, y))
    }

    fun actualScale(): Float =
        if (imageWidth > 0 && imageHeight > 0 && areaWidth > 0 && areaHeight > 0)
            pixelRatio / minOf(areaWidth / imageWidth, areaHeight / imageHeight)
        else 1f
}
