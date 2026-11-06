@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package gallery

import androidx.compose.runtime.*
import androidx.compose.ui.geometry.*
import androidx.compose.ui.platform.LocalDensity
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable
internal fun BrowserMedia(
    media: MediaSummaryWire,
    state: ViewerState,
    scale: Float,
    pan: Offset,
    rect: Rect,
    opening: Float,
    loaded: () -> Unit,
    failed: () -> Unit,
) {
    val video = media.type == "video"
    val density = LocalDensity.current.density
    val appearance = remember(media.url) { androidx.compose.animation.core.Animatable(0f) }
    LaunchedEffect(media.url) {
        appearance.animateTo(
            1f,
            androidx.compose.animation.core.tween(if (state.gallery.reduceMotion) 120 else 220),
        )
    }
    var element by remember { mutableStateOf<kotlin.js.JsAny?>(null) }
    var tracks by remember(media) { mutableStateOf(media.subtitles) }
    val loadedNow by rememberUpdatedState(loaded)
    val failedNow by rememberUpdatedState(failed)
    LaunchedEffect(media) {
        if (video && tracks.isEmpty()) {
            val url =
                media.url
                    .replace("/media/", "/subtitles/")
                    .replace("/file-media?", "/file-subtitles?")
            if (url != media.url) {
                val found = mutableListOf<SubtitleWire>()
                for ((lang, label) in listOf("zh-CN" to "中文", "en-US" to "English")) {
                    val target = url + (if (url.contains('?')) "&" else "?") + "lang=" + lang
                    try {
                        if (mediaExists(target).await<kotlin.js.JsBoolean>().toBoolean())
                            found += SubtitleWire(url = target, language = lang, label = label)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        /* Optional subtitle lookup does not stop playback. */
                    }
                }
                tracks = found
            }
        }
    }
    DisposableEffect(media.url, state.retry, tracks) {
        val node =
            createMedia(
                media.url,
                video,
                json.encodeToString(
                    kotlinx.serialization.builtins.ListSerializer(SubtitleWire.serializer()),
                    tracks,
                ),
                title(state.work),
                { w, h ->
                    state.imageWidth = media.width.takeIf { it > 0 } ?: w
                    state.imageHeight = media.height.takeIf { it > 0 } ?: h
                    loadedNow()
                },
                failedNow,
            )
        element = node
        onDispose {
            releaseMedia(node)
            element = null
        }
    }
    val masks = LocalGlassMasks.current?.values?.toList().orEmpty()
    SideEffect {
        val w = rect.width / density
        val h = rect.height / density
        val holes =
            masks
                .filter { it.rect.overlaps(rect) }
                .map { mask ->
                    val r = mask.rect
                    listOf(
                        (r.left - rect.left) / density,
                        (r.top - rect.top) / density,
                        r.width / density,
                        r.height / density,
                        mask.radius / density,
                    )
                }
        element?.let {
            placeMedia(
                it,
                rect.left / density,
                rect.top / density,
                w,
                h,
                scale,
                pan.x / density + (1 - appearance.value) * w * .125f * state.direction,
                pan.y / density,
                gallery.element(holes).toString(),
                if (opening > .99f) appearance.value else 0f,
            )
        }
    }
}
