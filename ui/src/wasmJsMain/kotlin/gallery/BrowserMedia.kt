@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package gallery

import androidx.compose.runtime.*
import androidx.compose.ui.geometry.*
import androidx.compose.ui.platform.LocalDensity
import kotlinx.coroutines.*

@Composable
internal fun BrowserMedia(
    media: MediaSummaryWire,
    state: ViewerState,
    scale: Float,
    pan: Offset,
    rect: Rect,
    opacity: Float,
    active: Boolean,
    playback: VideoPlayback?,
    loaded: (Int, Int) -> Unit,
    failed: (String) -> Unit,
) {
    val video = media.type == "video"
    val density = LocalDensity.current.density
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
    DisposableEffect(media.url, state.retry) {
        val node =
            createMedia(
                media.url,
                video,
                playback?.preloadShortClip == true,
                title(state.work),
                { w, h ->
                    loadedNow(
                        media.width.takeIf { it > 0 } ?: w,
                        media.height.takeIf { it > 0 } ?: h,
                    )
                },
                { code ->
                    val recovering =
                        playback?.compatibilityLoading == true ||
                            ((code == 3 || code == 4) && playback?.tryCompatibility() == true)
                    if (!recovering) {
                        failedNow(
                            if (!video) "文件无法读取"
                            else if (playback?.usingCompatibleSource == true) "浏览器无法解码兼容视频"
                            else if (code == 3) "浏览器无法解码视频" else "视频无法播放"
                        )
                    }
                },
            )
        element = node
        playback?.attach(node) { failedNow(it) }
        val compatibility =
            if (playback?.canTryCompatibility == true)
                watchVideoCompatibility(node) {
                    playback.tryCompatibility(resume = true)
                }
            else null
        val observation = playback?.let {
            observeVideo(node, it::update, it::ended)
        }
        onDispose {
            if (compatibility != null) unobserveVideo(compatibility)
            if (observation != null) unobserveVideo(observation)
            playback?.detach()
            releaseMedia(node)
            element = null
        }
    }
    val masks = LocalGlassMasks.current?.values?.toList().orEmpty()
    SideEffect {
        playback?.activate(active)
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
                pan.x / density,
                pan.y / density,
                gallery.element(holes).toString(),
                opacity,
                active,
            )
        }
    }
    LaunchedEffect(playback, element, tracks) { playback?.setTracks(tracks) }
}
