package gallery

import kotlin.test.*
import kotlinx.serialization.json.*

class ModelTest {
    @Test
    fun typedWorkKeepsDescriptionFlagsAndNullFields() {
        val work =
            json.decodeFromString<WorkSummaryWire>(
                """{"id":"9223372036854775807","sourceUrl":null,"flags":{"adult":null,"paid":true},"tags":null,"description":{"format":"plain","text":"一段简介"},"cover":{"width":1600,"height":1200,"thumbnails":{"s":"small","m":"medium","l":"large"}}}"""
            )
        assertEquals("9223372036854775807", work.id)
        assertNull(work.sourceUrl)
        assertEquals("一段简介", work.description?.text)
        assertTrue(work.flags.paid == true)
        assertEquals(emptyList(), work.tags)
        assertEquals("large", work.cover?.thumbnails?.l)
    }

    @Test
    fun viewerUsesLargePreviewUntilResolutionNeedsOriginal() {
        val media =
            MediaSummaryWire(
                fileName = "synthetic.jpg",
                url = "original",
                width = 4000,
                height = 3000,
                thumbnails = ThumbnailUrlsWire(s = "s", m = "m", l = "l"),
            )
        assertEquals("l", viewerImage(media, 1f, 1440f, 1f))
        assertEquals("l", viewerImage(media, 1.2f, 1000f, 1f))
        assertEquals("original", viewerImage(media, 2.1f, 1000f, 1f))
        assertEquals("original", viewerImage(media.copy(animated = true), 1f, 1000f, 1f))
        assertEquals("original", viewerImage(media.copy(type = "video"), 1f, 1000f, 1f))
    }

    @Test
    fun thousandPageBandCentersAndOnlyNeedsVisiblePages() {
        val total = 1080
        val step = 55f
        val width = 310f
        assertEquals(0f, pageBandTarget(1, total, step, width))
        assertEquals(total * step - 3 - width, pageBandTarget(total, total, step, width))
        val middle = pageBandTarget(540, total, step, width)
        assertEquals(width / 2, (540 - .5f) * step - middle)
        assertTrue(visiblePageRange(middle, step, width, total).count() <= 7)
        assertEquals(0..1, visiblePageRange(0f, 37f, 71f, 2))
    }

    @Test
    fun pagingAndRouteRoundTripsKeepAllConditions() {
        val route =
            Route(query = "合成", tag = "几何", mediaType = "image", sort = "name_desc", pageSize = 24)
        val page = route.copy(page = 1080)
        assertEquals(page, parseRoute(page.path, page.parameters()))
        assertEquals(route, page.copy(page = 1))
    }

    @Test
    fun stableWorkAndAuthorRoutesStayDistinct() {
        assertEquals("author", parseRoute("/p/pixiv/700", emptyMap()).kind)
        assertEquals("pages", parseRoute("/p/pixiv/700/2026-01-01_作品", emptyMap()).kind)
        assertEquals("files", parseRoute("/f/demo/Unicode%20folder", emptyMap()).kind)
        assertFalse(parseRoute("/unknown", emptyMap()).valid)
    }

    @Test
    fun invalidFiltersAreNotSilentlyRewritten() {
        assertFalse(parseRoute("/@all/pixiv", mapOf("mediaType" to "unknown")).validFilter)
        assertFalse(parseRoute("/@all/pixiv", mapOf("sort" to "posts_desc")).validFilter)
        assertTrue(parseRoute("/@authors/pixiv", emptyMap()).validFilter)
    }

    @Test
    fun pageLimitsAndAcceptedPageSizesMatchPublicContract() {
        assertEquals(1000000, parseRoute("/@all/pixiv", mapOf("page" to "1000001")).page)
        assertEquals(48, parseRoute("/@all/pixiv", mapOf("pageSize" to "200")).pageSize)
        assertEquals(120, parseRoute("/@all/pixiv", mapOf("pageSize" to "120")).pageSize)
    }

    @Test
    fun idsDoNotPassThroughFloatingPoint() {
        val row = json.parseToJsonElement("""{"id":"9223372036854775807","works":1080}""")
        assertEquals(
            "9223372036854775807",
            (row as kotlinx.serialization.json.JsonObject)["id"].text(),
        )
        assertEquals(
            "1,080",
            grouped((row as kotlinx.serialization.json.JsonObject)["works"].text().toLong()),
        )
    }

    @Test
    fun saveBarCountsChangedFieldsIncludingDirectoryNames() {
        val old =
            json.parseToJsonElement(
                """{"port":18200,"fileBrowserRoots":[{"name":"A","path":"D:/synthetic"}]}"""
            )
        val next =
            json.parseToJsonElement(
                """{"port":18201,"fileBrowserRoots":[{"name":"B","path":"D:/synthetic"}]}"""
            )
        assertEquals(2, changedFields(old, next))
        assertEquals(0, changedFields(old, old))
    }

    @Test
    fun crossWorkReadingPreservesBoundaryPages() {
        assertEquals(ViewerPosition(1, 0), adjacent(ViewerPosition(0, 2), 1, listOf(3, 48)))
        assertEquals(ViewerPosition(0, 2), adjacent(ViewerPosition(1, 0), -1, listOf(3, 48)))
        assertNull(adjacent(ViewerPosition(0, 0), -1, listOf(3)))
        assertNull(adjacent(ViewerPosition(1, 47), 1, listOf(3, 48)))
    }

    @Test
    fun panoramicAndStripImagesFitWithoutCropping() {
        assertEquals(.1f, fitScale(1000f, 10000f, 1000f, 1000f))
        assertEquals(.125f, fitScale(8000f, 1000f, 1000f, 1000f))
    }

    @Test
    fun shortPageBandsShrink() {
        assertEquals(71f, thumbnailBandWidth(2, 37f, 310f))
        assertEquals(310f, thumbnailBandWidth(1080, 37f, 310f))
    }

    @Test
    fun fileRoutesUseNameSortingAndMalformedEscapesShowInvalidUrl() {
        assertTrue(parseRoute("/f/demo", emptyMap()).validFilter)
        assertEquals("name_asc", parseRoute("/f/demo", emptyMap()).sort)
        assertFalse(parseRoute("/p/pixiv/%ZZ", emptyMap()).valid)
    }

    @Test
    fun streamedCommitsNotifyBeforePlatformCompletesWithoutRepeatingSameRevision() {
        val tracker = CollectionUpdates()
        val initial =
            json.parseToJsonElement(
                """{"live":{"epoch":"test","platformRevisions":{"pixiv":0}},"platforms":[{"id":"pixiv","works":0}],"scan":{"running":true}}"""
            )
        val complete =
            json.parseToJsonElement(
                """{"live":{"epoch":"test","platformRevisions":{"pixiv":1}},"platforms":[{"id":"pixiv","works":3}],"scan":{"running":true}}"""
            )
        assertEquals(false to 0L, tracker.receive(initial, "pixiv"))
        assertEquals(true to 3L, tracker.receive(complete, "pixiv"))
        assertEquals(false to 0L, tracker.receive(complete, "pixiv"))
    }

    @Test
    fun changingPlatformDoesNotReplayAnAlreadyObservedCommit() {
        val tracker = CollectionUpdates()
        val before =
            json.parseToJsonElement(
                """{"live":{"epoch":"same","platformRevisions":{"pixiv":0,"Patreon":0}},"platforms":[{"id":"pixiv","works":3},{"id":"Patreon","works":0}]}"""
            )
        val after =
            json.parseToJsonElement(
                """{"live":{"epoch":"same","platformRevisions":{"pixiv":0,"Patreon":1}},"platforms":[{"id":"pixiv","works":3},{"id":"Patreon","works":5}]}"""
            )
        tracker.receive(before, "pixiv")
        assertEquals(false to 0L, tracker.receive(after, "pixiv"))
        assertEquals(false to 0L, tracker.receive(after, "Patreon"))
    }

    @Test
    fun legacyMediaSelectionMatchesForFirstOpenAndExistingViewer() {
        val work =
            json.decodeFromString<WorkSummaryWire>(
                """{"media":[{"relativePath":"cover.jpg","defaultVisible":false},{"relativePath":"1.png"},{"relativePath":"nested/2.png"}]}"""
            )
        val parameters = mapOf("media" to "nested\\2.png", "index" to "0")
        assertEquals(1, requestedMediaPage(work, parameters))
        assertEquals(0, requestedMediaPage(work, mapOf("index" to "0")))
    }
}
