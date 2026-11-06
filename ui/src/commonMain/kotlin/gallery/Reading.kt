package gallery

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
data class ReadingOptions(
    val mode: String = "single",
    val rtl: Boolean = false,
    val coverAlone: Boolean = true,
)

fun defaultReading(
    work: WorkSummaryWire,
    width: Int,
    height: Int,
    preference: String,
): ReadingOptions {
    val manga = work.platformId == "Venera" || work.details?.workType == "manga"
    if (!manga) return ReadingOptions()
    val pages = work.media.filter { it.type == "image" && it.width > 0 && it.height > 0 }
    val strips =
        pages.isNotEmpty() &&
            pages.count { it.height >= it.width * 2.5f } >
                work.media.count { it.type == "image" } / 2
    val mode =
        when {
            preference in listOf("single", "double", "continuous") -> preference
            strips -> "continuous"
            width >= 1280 && width > height -> "double"
            else -> "single"
        }
    return ReadingOptions(mode, rtl = true)
}

fun pageSpreads(pages: List<MediaSummaryWire>, coverAlone: Boolean): List<List<Int>> {
    val result = mutableListOf<List<Int>>()
    var index = 0
    while (index < pages.size) {
        val first = pages[index]
        val wide = first.width > 0 && first.width > first.height
        val next = pages.getOrNull(index + 1)
        if (
            (index == 0 && coverAlone) ||
                wide ||
                next == null ||
                (next.width > 0 && next.width > next.height)
        ) {
            result += listOf(index)
            index++
        } else {
            result += listOf(index, index + 1)
            index += 2
        }
    }
    return result
}

fun removeSearchTerm(text: String, term: SearchTermWire): String {
    val bytes = text.encodeToByteArray()
    val start = term.start.toInt().coerceIn(0, bytes.size)
    val end = term.end.toInt().coerceIn(start, bytes.size)
    return (bytes.copyOfRange(0, start) + bytes.copyOfRange(end, bytes.size))
        .decodeToString()
        .trim()
}

fun searchValue(value: String): String =
    if (value.any { it.isWhitespace() }) "\"$value\"" else value

val searchFields =
    linkedMapOf(
        "any" to "包含的词",
        "exclude" to "排除的词",
        "title" to "标题",
        "author" to "作者名",
        "user" to "账号",
        "uid" to "作者 ID",
        "id" to "作品 ID",
        "tag" to "标签",
        "text" to "正文",
        "mytag" to "我的标签",
    )

fun advancedQuery(fields: Map<String, String>, platforms: List<String>): String = buildList {
    fields.forEach { (field, value) ->
        if (field != "raw") {
            Regex("\"[^\"]*\"|[^\\s]+")
                .findAll(value)
                .map { it.value }
                .forEach {
                    add(
                        (if (field == "exclude") "-" else if (field == "any") "" else "$field:") +
                            searchValue(it.removeSurrounding("\""))
                    )
                }
        } else if (value.isNotBlank()) add(value)
    }
    if (platforms.isNotEmpty()) add("platform:" + platforms.joinToString(","))
}
    .joinToString(" ")

fun tagValues(value: String?): List<String> =
    if (value.isNullOrEmpty()) emptyList()
    else
        try {
            json.decodeFromString<List<String>>(value)
        } catch (_: IllegalArgumentException) {
            emptyList()
        }

fun tagValue(values: Collection<String>): String =
    if (values.isEmpty()) "" else json.encodeToString(values.toList())

fun validDate(value: String): Boolean {
    val parts = value.split('-').map { it.toIntOrNull() ?: return false }
    if (!Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(value) || parts.size != 3) return false
    val (year, month, day) = parts
    if (year == 0 || month !in 1..12) return false
    val days =
        listOf(
            31,
            if (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) 29 else 28,
            31,
            30,
            31,
            30,
            31,
            31,
            30,
            31,
            30,
            31,
        )
    return day in 1..days[month - 1]
}

fun initial(name: String): String =
    name.take(if (name.firstOrNull()?.isHighSurrogate() == true) 2 else 1).ifEmpty { "·" }
