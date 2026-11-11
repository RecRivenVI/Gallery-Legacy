package gallery

// A UI projection of the three typed API entities, with list-only presentation.
data class ContentItem(
    val work: WorkSummaryWire = WorkSummaryWire(),
    val authorEntry: AuthorSummaryWire? = null,
    val folder: Boolean = false,
    val file: Boolean = false,
    val pageIndex: Int = 0,
    val key: String = work.stableId,
    val collage: List<MediaSummaryWire> = emptyList(),
) {
    val stableId
        get() = work.stableId

    val id
        get() = work.id

    val isAuthor
        get() = authorEntry != null

    val isFolder
        get() = folder

    val isFile
        get() = file

    val cover
        get() = work.cover

    val tags
        get() = work.tags

    val flags
        get() = work.flags

    val counts
        get() = work.counts

    val publishedAtMs
        get() = work.publishedAtMs ?: work.sortAtMs ?: 0L

    val sourceAuthorId
        get() = authorEntry?.sourceAuthorId.orEmpty()

    val sourceUrl
        get() = authorEntry?.sourceUrl ?: work.sourceUrl.orEmpty()

    val workCount
        get() = authorEntry?.workCount ?: 0L

    val latestAtMs
        get() = authorEntry?.latestAtMs ?: 0L
}

fun authorItem(value: AuthorSummaryWire, collage: List<MediaSummaryWire> = emptyList()) =
    ContentItem(
        work =
            WorkSummaryWire(
                id = value.id,
                stableId = value.stableId,
                platformId = value.platformId,
                title = value.name,
                authorName = value.handle.orEmpty(),
                cover = value.cover,
            ),
        authorEntry = value,
        collage = collage,
    )

fun author(item: ContentItem) = author(item.work)

fun author(work: WorkSummaryWire) = work.authorName

fun itemKey(item: ContentItem) = item.key.ifEmpty { item.stableId.ifEmpty { item.id } }

fun visibleMedia(work: WorkSummaryWire) = work.media.filter { it.defaultVisible }

data class ContentPage(
    val items: List<ContentItem>,
    val total: Long,
    val totalPages: Int,
    val heading: ContentItem? = null,
    val incomplete: Boolean = false,
)

fun requestedMediaPage(
    work: WorkSummaryWire,
    parameters: Map<String, String>,
): Int {
    val selected = parameters["media"].orEmpty().replace('\\', '/')
    return if (selected.isNotEmpty())
        visibleMedia(work)
            .indexOfFirst { it.relativePath.replace('\\', '/') == selected }
            .coerceAtLeast(0)
    else parameters["index"].orEmpty().toIntOrNull() ?: 0
}
