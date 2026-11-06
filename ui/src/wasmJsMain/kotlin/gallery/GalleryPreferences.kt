package gallery

import kotlinx.coroutines.*
import kotlinx.serialization.json.*

fun GalleryState.preference(key: String, value: Any) {
    if (key == "theme") {
        saveStored("gallery_theme", value.toString())
        people.savePreferences()
        return
    }
    preferences =
        when (key) {
            "autoRefresh" -> preferences.copy(autoRefresh = value as Boolean)
            "history" -> preferences.copy(history = value as Boolean)
            "mangaDefault" -> preferences.copy(mangaDefault = value as String)
            "hideAvatars" -> preferences.copy(hideAuthorAvatar = value as Boolean)
            "reduceMotion" -> preferences.copy(reduced = value as Boolean)
            "privacy" -> preferences.copy(privacy = value as Boolean)
            "hideEmpty" -> preferences.copy(hideEmpty = value as Boolean)
            "size" -> preferences.copy(size = value as Int)
            "dim" -> preferences.copy(dim = value as Float)
            "pageSize" -> preferences.copy(pageSize = value as Int)
            "ratio" ->
                preferences.copy(
                    aspect =
                        mapOf(
                            "1:1" to "square",
                            "4:3" to "landscape",
                            "3:4" to "portrait",
                            "16:9" to "wide",
                            "9:16" to "tall",
                        )[value] ?: "square"
                )
            else -> preferences
        }
    saveStored(
        "gallery_canvas_preferences",
        json.encodeToString(PreferencesWire.serializer(), preferences),
    )
    people.savePreferences()
}

fun GalleryState.sidebar(value: Boolean) {
    expanded = value
    saveStored("gallery_canvas_sidebar", if (value) "1" else "0")
    people.savePreferences()
}

fun GalleryState.setBackground(work: WorkSummaryWire, media: MediaSummaryWire) {
    background = media.thumbnailUrl
    backgroundWork = work.stableId
    preferences =
        preferences.copy(
            background = BackgroundPreferenceWire(work = backgroundWork, media = media.relativePath)
        )
    saveStored(
        "gallery_canvas_preferences",
        json.encodeToString(PreferencesWire.serializer(), preferences),
    )
    people.savePreferences()
}

fun GalleryState.clearBackground() {
    background = ""
    backgroundWork = ""
    preferences = preferences.copy(background = null)
    saveStored(
        "gallery_canvas_preferences",
        json.encodeToString(PreferencesWire.serializer(), preferences),
    )
    people.savePreferences()
}

fun GalleryState.accountPreferences() =
    AccountPreferencesWire(
        view = preferences,
        theme = theme,
        expanded = expanded,
        history = recordHistory,
    )

fun GalleryState.applyPreferences(value: AccountPreferencesWire) {
    preferences = value.view
    autoRefresh = preferences.autoRefresh
    theme = value.theme.ifEmpty { "system" }
    expanded = value.expanded && browserWidth() >= 900
    size = preferences.size.coerceIn(0, 5)
    ratio =
        mapOf(
            "square" to "1:1",
            "landscape" to "4:3",
            "portrait" to "3:4",
            "wide" to "16:9",
            "tall" to "9:16",
        )[preferences.aspect] ?: "1:1"
    privacy = preferences.privacy
    hideEmpty = preferences.hideEmpty
    hideAvatars = preferences.hideAuthorAvatar
    reduceMotion = preferences.reduced || reducedMotion()
    dim = preferences.dim.coerceIn(.5f, .9f)
    recordHistory = value.history
    mangaDefault = preferences.mangaDefault
    backgroundWork = preferences.background?.work.orEmpty()
    background = ""
    if (!currentHash().contains("pageSize="))
        route = route.copy(pageSize = preferences.pageSize.takeIf { it in pageSizes } ?: 48)
    saveStored("gallery_theme", theme)
    saveStored("gallery_canvas_sidebar", if (expanded) "1" else "0")
    saveStored(
        "gallery_canvas_preferences",
        json.encodeToString(PreferencesWire.serializer(), preferences),
    )
    scope.launch { restoreBackground() }
}

suspend fun GalleryState.restoreBackground() {
    val target = backgroundWork
    val preference = preferences.background
    if (backgroundWork.startsWith("/f/") && background.isEmpty()) {
        val parts = backgroundWork.split('/')
        background =
            "/api/v1/file-thumbnails?root=" +
                encode(parts[2]) +
                "&path=" +
                encode(parts.drop(3).joinToString("/") { decode(it) })
    }
    if (backgroundWork.isNotEmpty() && background.isEmpty())
        try {
            val work = resolveWork(target)
            val media =
                visibleMedia(work).find {
                    it.relativePath == preference?.media.orEmpty()
                }
            if (media != null && backgroundWork == target) background = media.thumbnailUrl
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            if (backgroundWork == target) background = ""
        }
}
