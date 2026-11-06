package gallery

import kotlin.test.*

class ReadingTest {
    @Test
    fun spreadsKeepCoverAndWidePagesAlone() {
        val portrait = MediaSummaryWire(width = 1000, height = 1500)
        val landscape = MediaSummaryWire(width = 1800, height = 1000)
        val pages = listOf(portrait, portrait, portrait, landscape, portrait, portrait)
        assertEquals(
            listOf(listOf(0), listOf(1, 2), listOf(3), listOf(4, 5)),
            pageSpreads(pages, true),
        )
        assertEquals(
            listOf(listOf(0, 1), listOf(2), listOf(3), listOf(4, 5)),
            pageSpreads(pages, false),
        )
    }

    @Test
    fun mangaDefaultsRequireAnActualMajorityOfLongPages() {
        val strip = MediaSummaryWire(type = "image", width = 1000, height = 4000)
        val unknown = MediaSummaryWire(type = "image")
        val manga =
            WorkSummaryWire(platformId = "Venera", media = listOf(strip, unknown, unknown, unknown))
        assertEquals(ReadingOptions("double", true, true), defaultReading(manga, 1440, 900, ""))
        assertEquals(ReadingOptions("single", true, true), defaultReading(manga, 393, 852, ""))
        assertEquals(
            "continuous",
            defaultReading(manga.copy(media = listOf(strip, strip, strip, unknown)), 1440, 900, "")
                .mode,
        )
        assertEquals("single", defaultReading(manga, 1440, 900, "single").mode)
        assertEquals(
            ReadingOptions(),
            defaultReading(WorkSummaryWire(platformId = "pixiv"), 1440, 900, ""),
        )
    }

    @Test
    fun syntaxRoundTripPreservesPhraseAndUtf8Boundaries() {
        val prefix = "雨 🧪 "
        val raw = "title:风景"
        val text = prefix + raw
        val term =
            SearchTermWire(
                field = "title",
                value = "风景",
                raw = raw,
                start = prefix.encodeToByteArray().size.toLong(),
                end = text.encodeToByteArray().size.toLong(),
            )
        assertEquals("雨 🧪", removeSearchTerm(text, term))
        assertEquals(
            "\"初音 未来\" 雨 tag:\"space tag\" platform:pixiv,微博",
            advancedQuery(
                linkedMapOf("any" to "\"初音 未来\" 雨", "tag" to "\"space tag\""),
                listOf("pixiv", "微博"),
            ),
        )
        val route =
            parseRoute(
                "/@my/favorites",
                mapOf(
                    "q" to "雨 -漫画",
                    "includeTags" to "风景,夜景",
                    "ratings" to "0,1",
                    "from" to "2026-01-01",
                    "sort" to "favorite_desc",
                ),
            )
        assertTrue(route.valid && route.validFilter && route.personalView)
        assertEquals("风景,夜景", route.parameters()["includeTags"])
        assertEquals("雨 -漫画", route.parameters()["q"])
    }

    @kotlin.test.Test
    fun commaTagsDatesAndEmojiInitial() {
        kotlin.test.assertEquals(listOf("a,b", "风景"), tagValues(tagValue(listOf("a,b", "风景"))))
        kotlin.test.assertTrue(validDate("2024-02-29"))
        kotlin.test.assertFalse(validDate("2026-02-29"))
        kotlin.test.assertFalse(validDate("2026-13-01"))
        kotlin.test.assertEquals("🌈", initial("🌈读者"))
    }
}
