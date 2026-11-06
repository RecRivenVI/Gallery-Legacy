package gallery

val filterKeys =
    setOf(
        "platforms",
        "includeTags",
        "excludeTags",
        "types",
        "ratings",
        "ai",
        "paid",
        "from",
        "to",
        "pages",
        "favorite",
        "minRating",
        "hideRead",
        "myTags",
        "series",
        "linkedAuthor",
    )

val pageSizes = listOf(24, 48, 72, 96, 120)

data class Route(
    val path: String = "/@all/pixiv",
    val query: String = "",
    val tag: String = "",
    val mediaType: String = "all",
    val sort: String =
        if (path.startsWith("/@authors/")) "latest_desc"
        else if (path.startsWith("/f/")) "name_asc" else "date_desc",
    val page: Int = 1,
    val pageSize: Int = 48,
    val filters: Map<String, String> = emptyMap(),
) {
    val kind
        get() =
            when {
                path.startsWith("/@my/") -> path.substringAfterLast('/')
                path.startsWith("/@collection/") -> "collection"
                path.startsWith("/@authors/") -> "authors"
                path.startsWith("/f/") -> "files"
                path.startsWith("/p/") -> if (path.count { it == '/' } > 3) "pages" else "author"
                else -> "works"
            }

    val personalView
        get() = kind in listOf("favorites", "history", "continue", "collections", "collection")

    val platform
        get() = path.split('/').getOrElse(2) { "pixiv" }

    val valid
        get() =
            Regex("^/(?:@all|@authors|@my|@collection)/[^/]+$|^/(?:f|p)/[^/]+(?:/[^/]+)*$")
                .matches(path) &&
                !Regex("%(?![0-9a-fA-F]{2})").containsMatchIn(path) &&
                (!path.startsWith("/@my/") || personalView)

    val validFilter
        get() =
            mediaType in protocolMediaFilters &&
                sort in
                    if (kind == "authors") authorSorts
                    else if (kind == "files") workSorts.filterKeys { it.startsWith("name_") }
                    else workSorts

    fun parameters() =
        linkedMapOf(
            "q" to query,
            "tag" to tag,
            "mediaType" to mediaType,
            "sort" to sort,
            "page" to page.toString(),
            "pageSize" to pageSize.toString(),
        ) + filters
}

fun parseRoute(path: String, parameters: Map<String, String>): Route =
    Route(
        path = path.ifBlank { "/@all/pixiv" },
        query = parameters["q"].orEmpty(),
        tag = parameters["tag"].orEmpty(),
        mediaType = parameters["mediaType"] ?: "all",
        sort =
            parameters["sort"]
                ?: if (path.startsWith("/@authors")) "latest_desc"
                else if (path.startsWith("/f/")) "name_asc" else "date_desc",
        page = parameters["page"]?.toIntOrNull()?.coerceIn(1, 1000000) ?: 1,
        pageSize = parameters["pageSize"]?.toIntOrNull()?.takeIf { it in pageSizes } ?: 48,
        filters = parameters.filterKeys { it in filterKeys },
    )

data class ViewerPosition(val work: Int, val page: Int)

fun adjacent(position: ViewerPosition, delta: Int, sizes: List<Int>): ViewerPosition? {
    var work = position.work
    var page = position.page + delta
    while (work in sizes.indices) {
        if (page < 0) {
            work--
            if (work in sizes.indices) page += sizes[work]
        } else if (page >= sizes[work]) {
            page -= sizes[work]
            work++
        } else return ViewerPosition(work, page)
    }
    return null
}

fun fitScale(width: Float, height: Float, areaWidth: Float, areaHeight: Float): Float =
    minOf(areaWidth / width.coerceAtLeast(1f), areaHeight / height.coerceAtLeast(1f))

fun thumbnailBandWidth(total: Int, step: Float, available: Float) =
    minOf(310f, available, (total * step - 3).coerceAtLeast(0f))

fun pageBandTarget(page: Int, total: Int, step: Float, width: Float): Float =
    ((page - .5f) * step - width / 2).coerceIn(0f, (total * step - 3 - width).coerceAtLeast(0f))

fun visiblePageRange(offset: Float, step: Float, width: Float, total: Int): IntRange {
    val first = (offset / step).toInt().coerceAtLeast(0)
    return first..((offset + width) / step).toInt().coerceAtMost(total - 1)
}
