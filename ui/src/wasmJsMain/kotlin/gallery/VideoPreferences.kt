package gallery

import androidx.compose.runtime.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

internal enum class VideoEnd {
    Stop,
    Loop,
    Continue,
}

@Serializable
internal data class VideoPreferences(
    val volume: Double = 1.0,
    val muted: Boolean = false,
    val rate: Double = 1.0,
    val autoplay: Boolean = false,
    val afterEnd: VideoEnd = VideoEnd.Stop,
    val captions: String = "",
)

private const val videoPreferencesKey = "gallery_video_preferences"
private const val videoPositionsKey = "gallery_video_positions"
private const val videoPositionLimit = 64

internal class VideoPreferencesStore {
    var value by
        mutableStateOf(
            runCatching { json.decodeFromString<VideoPreferences>(stored(videoPreferencesKey)) }
                .getOrDefault(VideoPreferences())
        )
        private set

    private val positions = runCatching {
        json.decodeFromString<Map<String, Double>>(stored(videoPositionsKey))
    }
        .getOrDefault(emptyMap())
        .toMutableMap()

    fun change(next: VideoPreferences) {
        value = next
        runCatching { saveStored(videoPreferencesKey, json.encodeToString(next)) }
    }

    fun position(key: String): Double = positions[key] ?: 0.0

    fun rememberPosition(key: String, seconds: Double) {
        if (seconds == position(key)) return
        positions.remove(key)
        if (seconds > 0) positions[key] = seconds
        while (positions.size > videoPositionLimit) positions.remove(positions.keys.first())
        runCatching { saveStored(videoPositionsKey, json.encodeToString(positions)) }
    }
}
