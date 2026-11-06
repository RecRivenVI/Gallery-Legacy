package gallery

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.*
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString

class ViewerReading(private val viewer: ViewerState) {
    var options by mutableStateOf(ReadingOptions())
    var menu by mutableStateOf(false)
    var episodes by mutableStateOf(EpisodeNavigationWire())
    var episodePrompt by mutableStateOf<WorkSummaryWire?>(null)
    var resumePage by mutableIntStateOf(-1)
    var scrollTarget by mutableIntStateOf(-1)
    val scroll = LazyListState()
    private var episodeJob: Job? = null
    private var resumeJob: Job? = null
    private var guestModes =
        json.decodeFromString<Map<String, ReadingOptions>>(
            stored("gallery_reading_modes").ifEmpty { "{}" }
        )
    val spreads
        get() = pageSpreads(viewer.media, options.coverAlone)

    val spread
        get() = spreads.firstOrNull { viewer.page in it } ?: listOf(viewer.page)

    val progressPage
        get() = if (options.mode == "double") spread.last() else viewer.page

    val canUsePages
        get() = viewer.media.all { it.type == "image" && !it.animated }

    fun changedWork(work: WorkSummaryWire) {
        val saved = work.personal
        options =
            if (saved != null && saved.readingMode.isNotEmpty())
                ReadingOptions(saved.readingMode, saved.rtl, saved.coverAlone)
            else if (viewer.gallery.people.account == null && guestModes.containsKey(work.stableId))
                guestModes.getValue(work.stableId)
            else defaultReading(work, browserWidth(), browserHeight(), viewer.gallery.mangaDefault)
        if (!canUsePages) options = options.copy(mode = "single")
        episodePrompt = null
        episodes = EpisodeNavigationWire()
        scrollTarget = viewer.page
        val savedPage = (saved?.page ?: 0) - 1
        resumePage =
            if (
                viewer.gallery.route.kind !in listOf("history", "continue") &&
                    savedPage in viewer.media.indices &&
                    savedPage != viewer.page
            )
                savedPage
            else -1
        resumeJob?.cancel()
        resumeJob =
            viewer.gallery.scope.launch {
                delay(4000)
                resumePage = -1
            }
        episodeJob?.cancel()
        if (work.id.isNotEmpty() && work.stableId.startsWith("/p/"))
            episodeJob =
                viewer.gallery.scope.launch {
                    try {
                        episodes =
                            readApi<EpisodeNavigationWire>("episodes", mapOf("work" to work.id))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        viewer.message = humanError(e.message.orEmpty())
                    }
                }
    }

    fun change(value: ReadingOptions) {
        options = value
        menu = false
        viewer.zoom = 1f
        viewer.pan = androidx.compose.ui.geometry.Offset.Zero
        scrollTarget = viewer.page
        val state = viewer.gallery
        if (state.people.account == null) {
            guestModes = guestModes + (viewer.work.stableId to value)
            saveStored("gallery_reading_modes", json.encodeToString(guestModes))
        } else
            state.people.perform {
                state.people.change(viewer.work, "mode", text = value.mode, options = value)
            }
    }

    fun physicalDelta(delta: Int) =
        if (options.rtl && options.mode != "continuous") -delta else delta

    // Returns a logical page delta, or consumes the flip to show/open a chapter.
    fun step(delta: Int): Int? {
        val index = spreads.indexOfFirst { viewer.page in it }
        val atEdge =
            if (options.mode == "double")
                (if (delta > 0) index == spreads.lastIndex else index <= 0)
            else if (delta > 0) viewer.page == viewer.media.lastIndex else viewer.page == 0
        val chapter = if (delta > 0) episodes.next else episodes.previous
        if (atEdge && chapter != null) {
            if (episodePrompt?.stableId == chapter.stableId) openEpisode(chapter)
            else {
                episodePrompt = chapter
                if (options.mode == "continuous")
                    scrollTarget = if (delta > 0) viewer.media.size else -2
            }
            return null
        }
        episodePrompt = null
        if (options.mode != "double") return delta
        val next = spreads.getOrNull(index + delta)
        return next?.let { it.first() - viewer.page }
            ?: if (delta > 0) viewer.media.size - viewer.page else -viewer.page - 1
    }

    fun openEpisode(summary: WorkSummaryWire) {
        viewer.gallery.scope.launch {
            try {
                val next = resolveWork(summary.stableId)
                if (viewer.gallery.items.none { it.stableId == next.stableId }) {
                    val position =
                        readApi<WorkPositionWire>(
                            "position",
                            mapOf(
                                "path" to next.stableId,
                                "pageSize" to viewer.gallery.route.pageSize,
                            ),
                        )
                    viewer.gallery.navigate(
                        Route(
                            position.path,
                            sort = "date_asc",
                            page = position.page.toInt(),
                            pageSize = viewer.gallery.route.pageSize,
                            filters =
                                if (position.seriesId.isEmpty()) emptyMap()
                                else mapOf("series" to position.seriesId),
                        ),
                        replace = true,
                        closeViewer = false,
                    )
                }
                viewer.changeWork(next)
                viewer.updateLink()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                viewer.message = humanError(e.message.orEmpty())
            }
        }
    }

    fun select(page: Int) {
        viewer.page = page.coerceIn(0, (viewer.media.size - 1).coerceAtLeast(0))
        scrollTarget = viewer.page
        viewer.updateLink()
    }

    fun dispose() {
        episodeJob?.cancel()
        resumeJob?.cancel()
    }
}
