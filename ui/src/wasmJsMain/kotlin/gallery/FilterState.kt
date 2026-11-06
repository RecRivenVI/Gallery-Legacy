package gallery

import androidx.compose.runtime.*
import kotlinx.coroutines.*

@Stable
class GalleryFilters(private val gallery: GalleryState) {
    var terms by mutableStateOf<List<SearchTermWire>>(emptyList())
    var routeTerms by mutableStateOf<List<SearchTermWire>>(emptyList())
    var parsedPlatforms by mutableStateOf<List<String>>(emptyList())
    private var committedPlatforms by mutableStateOf<List<String>>(emptyList())
    private var optionJob: Job? = null
    var fields by mutableStateOf<Map<String, String>>(emptyMap())
    var suggestions by mutableStateOf<List<String>>(emptyList())
    var suggestionIndex by mutableIntStateOf(0)
    var options by mutableStateOf(AvailableFiltersWire())
    private var parseJob: Job? = null
    private var pushed = false
    val count
        get() =
            gallery.route.filters
                .filterKeys { it !in listOf("platforms", "series", "linkedAuthor") }
                .values
                .count { it.isNotEmpty() && it != "all" } +
                if (gallery.route.tag.isEmpty()) 0 else 1

    val selectedPlatforms
        get() = committedPlatforms.ifEmpty {
            gallery.route.filters["platforms"]?.split(',')?.filter { it.isNotEmpty() }
                ?: listOf(decode(gallery.route.platform).takeIf { it in platforms } ?: "pixiv")
        }

    val mixed
        get() =
            gallery.route.personalView ||
                selectedPlatforms.size > 1 ||
                gallery.route.filters.containsKey("linkedAuthor")

    fun parse(text: String) {
        parseJob?.cancel()
        parseJob =
            gallery.scope.launch {
                try {
                    val value = readApi<SearchParseWire>("search-parse", mapOf("q" to text))
                    terms = value.terms
                    parsedPlatforms = value.platforms
                    if (text == gallery.route.query) {
                        committedPlatforms = value.platforms
                        routeTerms = value.terms
                    }
                    val tail = text.substringAfterLast(' ')
                    val prefix = tail.substringBefore(':').substringBefore('：')
                    val needle = tail.substringAfter(':', tail.substringAfter('：', ""))
                    suggestions =
                        when (prefix) {
                            "tag",
                            "标签" ->
                                readApi<PageWire<TagWire>>(
                                        "tags",
                                        mapOf(
                                            "platform" to decode(gallery.route.platform),
                                            "q" to needle,
                                            "pageSize" to 8,
                                        ),
                                    )
                                    .items
                                    .map { it.label }
                            "platform",
                            "平台" ->
                                platforms
                                    .filter {
                                        it.contains(needle, true) ||
                                            platformBadges[it]?.contains(needle, true) == true
                                    }
                                    .take(8)
                            else -> emptyList()
                        }
                    suggestionIndex = 0
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    suggestions = emptyList()
                    gallery.error = e.message.orEmpty()
                }
            }
    }

    fun complete(index: Int = suggestionIndex) {
        val value = suggestions.getOrNull(index) ?: return
        val text = gallery.search.text
        val start = text.lastIndexOf(' ') + 1
        val tail = text.substring(start)
        val prefix = tail.substringBefore(':').substringBefore('：')
        gallery.search.edit(text.substring(0, start) + prefix + ":" + searchValue(value) + " ")
        suggestions = emptyList()
    }

    fun remove(term: SearchTermWire) {
        gallery.search.draft(removeSearchTerm(gallery.search.text, term))
        gallery.search.submit(force = true)
    }

    fun openAdvanced() {
        gallery.search.pause()
        gallery.scope.launch {
            try {
                val parsed =
                    readApi<SearchParseWire>("search-parse", mapOf("q" to gallery.search.text))
                terms = parsed.terms
                fields =
                    terms
                        .filter { it.field != "platform" }
                        .groupBy {
                            if (it.exclude && it.field != "any") "raw"
                            else if (it.exclude) "exclude" else it.field
                        }
                        .mapValues { (key, values) ->
                            values.joinToString(" ") {
                                if (key == "raw") it.raw else searchValue(it.value)
                            }
                        }
                parsedPlatforms = parsed.platforms.ifEmpty { selectedPlatforms }
                gallery.panel = "advanced"
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                gallery.error = e.message.orEmpty()
            }
        }
    }

    fun advanced(field: String, value: String) {
        fields = fields + (field to value)
        gallery.search.draft(advancedQuery(fields, parsedPlatforms))
    }

    fun choosePlatforms(values: List<String>) {
        parsedPlatforms = values
        gallery.search.draft(advancedQuery(fields, values))
    }

    fun loadOptions() {
        optionJob?.cancel()
        optionJob =
            gallery.scope.launch {
                try {
                    options =
                        readApi<AvailableFiltersWire>(
                            "filter-options",
                            if (gallery.route.personalView) emptyMap()
                            else
                                mapOf(
                                    "platform" to selectedPlatforms.first(),
                                    "q" to gallery.route.query,
                                    "platforms" to selectedPlatforms.joinToString(","),
                                ),
                        )
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    gallery.error = e.message.orEmpty()
                }
            }
    }

    fun open() {
        pushed = false
        gallery.panel = "filters"
        gallery.loadTags()
        loadOptions()
    }

    fun set(key: String, value: String) {
        val values = gallery.route.filters.toMutableMap()
        if (value.isEmpty() || value == "all") values.remove(key) else values[key] = value
        gallery.navigate(
            gallery.route.copy(filters = values, page = 1),
            replace = pushed,
            keepPanel = gallery.panel == "filters",
        )
        pushed = true
    }

    fun cycleTag(label: String) {
        val includes = tagValues(gallery.route.filters["includeTags"]).toMutableList()
        val excludes = tagValues(gallery.route.filters["excludeTags"]).toMutableList()
        if (label in includes) {
            includes.remove(label)
            excludes.add(label)
        } else if (label in excludes) excludes.remove(label) else includes.add(label)
        val values = gallery.route.filters.toMutableMap()
        if (includes.isEmpty()) values.remove("includeTags")
        else values["includeTags"] = tagValue(includes)
        if (excludes.isEmpty()) values.remove("excludeTags")
        else values["excludeTags"] = tagValue(excludes)
        gallery.navigate(
            gallery.route.copy(filters = values, tag = "", page = 1),
            replace = pushed,
            keepPanel = gallery.panel == "filters",
        )
        pushed = true
    }

    fun includeTag(label: String) {
        val values = tagValues(gallery.route.filters["includeTags"]).toMutableSet()
        values.add(label)
        set("includeTags", tagValue(values))
    }

    fun clear() {
        gallery.navigate(
            gallery.route.copy(
                filters =
                    gallery.route.filters.filterKeys {
                        it in listOf("platforms", "linkedAuthor", "series")
                    },
                tag = "",
                page = 1,
            ),
            replace = pushed,
            keepPanel = gallery.panel == "filters",
        )
        pushed = true
    }
}

val platformBadges =
    mapOf(
        "pixiv" to "p",
        "pixivFANBOX" to "f",
        "Gank" to "G",
        "Fantia" to "F",
        "Patreon" to "P",
        "Pawchive" to "Pw",
        "X" to "X",
        "微博" to "微",
        "Venera" to "V",
    )

fun availableSorts(state: GalleryState): Map<String, String> =
    when {
        state.route.kind == "authors" -> authorSorts
        state.route.kind == "files" -> workSorts.filterKeys { it.startsWith("name_") }
        else ->
            workSorts.filterKeys { key ->
                when {
                    key in listOf("rating_desc", "favorite_desc") ->
                        state.people.account != null &&
                            state.filters.selectedPlatforms.size < 2 &&
                            (key != "favorite_desc" ||
                                state.route.kind in listOf("favorites", "collection"))
                    key in listOf("bookmarks_desc", "views_desc", "likes_desc") ->
                        !state.filters.mixed &&
                            key.substringBefore('_') in state.filters.options.metrics
                    else -> true
                }
            }
    }
