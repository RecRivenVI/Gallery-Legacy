@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package gallery

import androidx.compose.runtime.*
import kotlin.js.JsAny
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
internal data class VideoStatus(
    val time: Double = 0.0,
    val duration: Double = 0.0,
    val buffered: List<List<Double>> = emptyList(),
    val seekable: List<List<Double>> = emptyList(),
    val paused: Boolean = true,
    val hasFrame: Boolean = false,
    val waiting: Boolean = false,
    val ended: Boolean = false,
    val error: Int = 0,
    val fullscreen: Boolean = false,
    val canFullscreen: Boolean = false,
    val pip: Boolean = false,
    val canPip: Boolean = false,
    val canVolume: Boolean = false,
    val visible: Boolean = true,
)

internal class VideoPlayback(private val viewer: ViewerState, media: MediaSummaryWire) {
    private val store = viewer.gallery.videoPreferences
    private val positionKey =
        listOf(viewer.work.stableId, media.relativePath, media.size.toString())
            .joinToString("\u0000")
    val mediaUrl = media.url
    val canTryCompatibility =
        viewer.work.platformId == "pixiv" && media.fileName.endsWith(".webm", ignoreCase = true)
    val preloadShortClip =
        media.size in 1L..(16L shl 20) && media.durationMs?.let { it in 1L..8000L } == true
    var previewUrl by mutableStateOf(mediaUrl)
        private set

    var compatibilityLoading by mutableStateOf(false)
        private set

    var usingCompatibleSource = false
        private set

    private var triedCompatibility = false
    private var element: JsAny? = null
    private var playbackFailure: ((String) -> Unit)? = null
    private var active = false
    private var lastSaved = store.position(positionKey)
    private var played = false
    private var playIntent by mutableStateOf(false)
    private var playBlocked by mutableStateOf(false)
    private var playAttempt = 0
    var status by mutableStateOf(VideoStatus())
        private set

    var tracks by mutableStateOf(emptyList<SubtitleWire>())
        private set

    var notice by mutableStateOf("")
        private set

    var activity by mutableDoubleStateOf(now())
        private set

    var menu by mutableStateOf(false)
    var scrubbing by mutableStateOf<Double?>(null)
    var hoverPosition by mutableStateOf<Double?>(null)
    val preferences
        get() = store.value

    val savedPosition
        get() = lastSaved.takeIf { !played && it >= 5 && it + 3 < status.duration }

    val playbackPaused
        get() = status.paused && (!playIntent || playBlocked)

    fun attach(node: JsAny, failure: (String) -> Unit) {
        element = node
        playbackFailure = failure
        applyOptions()
    }

    fun detach() {
        activate(false)
        element = null
        playbackFailure = null
    }

    fun activate(value: Boolean) {
        if (value == active) return
        active = value
        if (!value) {
            playIntent = false
            playBlocked = false
            playAttempt++
            rememberPosition()
            element?.let { pauseVideo(it, exitModes = true) }
            menu = false
            scrubbing = null
            hoverPosition = null
        } else {
            activity()
            val continuation = viewer.consumeVideoContinuation(mediaUrl)
            if (continuation || preferences.autoplay) play() else startPlayback()
        }
    }

    fun update(value: String) {
        val old = status
        status = json.decodeFromString(value)
        if (!status.paused && status.hasFrame) {
            if (active && !compatibilityLoading) playIntent = true
            played = true
        } else if (
            status.paused &&
                !old.paused &&
                old.hasFrame &&
                status.hasFrame &&
                !compatibilityLoading &&
                !status.ended &&
                status.error == 0
        ) {
            playIntent = false
        }
        if (status.visible && !old.visible && status.paused) startPlayback()
        if (
            active &&
                (status.paused && !old.paused || kotlin.math.abs(status.time - lastSaved) >= 5)
        )
            rememberPosition()
    }

    private fun rememberPosition() {
        if (!played) return
        val seconds =
            if (status.ended || status.time < 5 || status.duration - status.time <= 3) 0.0
            else status.time
        val recorded = kotlin.math.floor(seconds)
        store.rememberPosition(positionKey, recorded)
        lastSaved = recorded
    }

    fun setTracks(value: List<SubtitleWire>) {
        tracks = value
        applyCaptions()
    }

    fun change(next: VideoPreferences) {
        store.change(next)
        applyOptions()
        activity()
    }

    private fun applyOptions() {
        element?.let {
            val p = preferences
            setVideoOptions(
                it,
                p.volume.coerceIn(0.0, 1.0),
                p.muted,
                p.rate,
                p.afterEnd == VideoEnd.Loop,
            )
        }
        applyCaptions()
    }

    private fun applyCaptions() {
        element?.let { setVideoCaptions(it, json.encodeToString(tracks), preferences.captions) }
    }

    fun setVolume(volume: Double) {
        if (status.canVolume)
            change(preferences.copy(volume = volume.coerceIn(0.0, 1.0), muted = false))
    }

    fun toggleMute() {
        val p = preferences
        when {
            p.muted -> change(p.copy(muted = false, volume = if (p.volume > 0) p.volume else .5))
            p.volume == 0.0 && status.canVolume -> change(p.copy(volume = .5))
            else -> change(p.copy(muted = true))
        }
    }

    fun togglePlay() {
        if (!active) return
        if (playbackPaused) play()
        else {
            playIntent = false
            playAttempt++
            element?.let { pauseVideo(it, exitModes = false) }
        }
        activity()
    }

    private fun play() {
        playIntent = true
        playBlocked = false
        startPlayback()
    }

    private fun startPlayback() {
        val node = element ?: return
        if (!active || !playIntent || playBlocked || !status.visible || compatibilityLoading) return
        notice = ""
        val attempt = ++playAttempt
        playVideo(node) { code ->
            if (
                attempt == playAttempt &&
                    active &&
                    !compatibilityLoading &&
                    !(code == "NotSupportedError" && tryCompatibility())
            ) {
                playBlocked = code == "NotAllowedError"
                if (!playBlocked) playIntent = false
                notice = if (playBlocked) "点按播放以开始" else "无法开始播放，请重试"
                activity()
            }
        }
    }

    fun seek(seconds: Double) {
        if (!active || compatibilityLoading || status.duration <= 0 || status.seekable.isEmpty())
            return
        element?.let { seekVideo(it, seconds.coerceIn(0.0, status.duration)) }
        activity()
    }

    fun jump(offset: Double) = seek(status.time + offset)

    fun resume() {
        savedPosition?.let(::seek)
        play()
    }

    fun ended() {
        if (compatibilityLoading) return
        playIntent = false
        rememberPosition()
        if (active && status.visible && preferences.afterEnd == VideoEnd.Continue)
            viewer.continueVideo(mediaUrl)
    }

    fun tryCompatibility(resume: Boolean = false): Boolean {
        val node = element ?: return false
        val failed = playbackFailure ?: return false
        if (
            !canTryCompatibility ||
                triedCompatibility ||
                viewer.closing ||
                viewer.current?.url != mediaUrl
        )
            return false
        triedCompatibility = true
        compatibilityLoading = true
        playIntent = resume || playIntent || !status.paused || status.ended
        playBlocked = false
        playAttempt++
        scrubbing = null
        hoverPosition = null
        notice = ""
        pauseVideo(node, exitModes = false)
        loadCompatibleVideo(
            node,
            mediaUrl,
            { url ->
                usingCompatibleSource = true
                previewUrl = url
                compatibilityLoading = false
                applyOptions()
                activity()
                startPlayback()
            },
            { code ->
                compatibilityLoading = false
                playIntent = false
                failed(
                    when (code) {
                        "VIDEO_COMPAT_LIMIT" -> "视频超出兼容播放的时长或大小限制"
                        "VIDEO_COMPAT_BUSY" -> "正在准备另一段兼容视频，请稍后重试"
                        "VIDEO_COMPAT_TOOL_UNAVAILABLE" -> "兼容播放需要支持 H.264 编码的 FFmpeg"
                        else -> "无法准备兼容播放，可下载原文件"
                    }
                )
            },
        )
        return true
    }

    fun activity(clicked: Boolean = false, touch: Boolean = false) {
        if (!active) return
        if (clicked && (!touch || playbackPaused)) togglePlay()
        else if (now() - activity > 200 || clicked) activity = now()
    }

    fun fullscreen() {
        if (active && status.canFullscreen)
            element?.let {
                toggleVideoFullscreen(it, { status = status.copy(fullscreen = it) }) {
                    notice = "无法进入全屏"
                }
            }
        activity()
    }

    fun pictureInPicture() {
        if (active && status.canPip) element?.let { toggleVideoPip(it) { notice = "无法打开画中画" } }
        activity()
    }
}
