package gallery

import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

private val rates = listOf(.25, .5, .75, 1.0, 1.25, 1.5, 1.75, 2.0)
private val endOptions =
    mapOf(
        VideoEnd.Stop to "停止播放",
        VideoEnd.Loop to "单片循环",
        VideoEnd.Continue to "作品内连播",
    )

@Composable
internal fun VideoControls(player: VideoPlayback, phone: Boolean, modifier: Modifier = Modifier) {
    var timedOut by remember(player) { mutableStateOf(false) }
    var focused by remember(player) { mutableStateOf(false) }
    val waiting by
        remember(player) {
            derivedStateOf { player.status.waiting && !player.compatibilityLoading }
        }
    val paused by remember(player) { derivedStateOf { player.playbackPaused } }
    var waitingLongEnough by remember(player) { mutableStateOf(false) }
    LaunchedEffect(waiting) {
        waitingLongEnough = false
        if (waiting) {
            delay(400)
            waitingLongEnough = true
        }
    }
    val buffering = waiting && waitingLongEnough
    val holding =
        paused ||
            buffering ||
            player.menu ||
            player.scrubbing != null ||
            (focused && LocalKeyboard.current)
    LaunchedEffect(player.activity, holding) {
        timedOut = false
        if (!holding) {
            delay(2400)
            timedOut = true
        }
    }
    Box(modifier) {
        if (paused || buffering) {
            GlassSurface(Modifier.align(Alignment.Center), radius = 32.dp, opacity = .96f) {
                if (buffering) {
                    Label("缓冲中…", Modifier.padding(horizontal = 18.dp, vertical = 12.dp))
                } else {
                    Action(
                        icon = "play",
                        description = if (player.status.ended) "重播" else "播放视频",
                        modifier = Modifier.size(56.dp),
                        centered = true,
                        onClick = player::togglePlay,
                    )
                }
            }
        }
        Column(
            Modifier.align(Alignment.BottomCenter)
                .widthIn(max = 1000.dp)
                .fillMaxWidth()
                .padding(8.dp)
                .onFocusChanged { focused = it.hasFocus }
                .focusGroup(),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (player.menu) VideoMenu(player, phone)
            val position = player.savedPosition
            if (position != null || player.notice.isNotEmpty()) {
                GlassSurface {
                    if (position != null)
                        Action("从 ${videoTime(position)} 继续", onClick = player::resume)
                    else Label(player.notice, Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                }
            }
            if (!timedOut || holding) {
                val preview =
                    if (player.compatibilityLoading) null
                    else player.scrubbing ?: player.hoverPosition
                if (preview != null && player.status.duration > 0) {
                    VideoScrubPreview(player, preview, phone)
                }
                GlassSurface(Modifier.fillMaxWidth(), opacity = .96f) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 3.dp)) {
                        VideoSeekBar(player, phone)
                        VideoButtons(player, phone)
                    }
                }
            }
        }
    }
}

@Composable
private fun VideoButtons(player: VideoPlayback, phone: Boolean) {
    val state = player.status
    val settings = player.preferences
    Row(
        Modifier.fillMaxWidth().heightIn(min = if (phone) 42.dp else 34.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(if (phone) 2.dp else 6.dp),
    ) {
        IconAction(
            if (player.playbackPaused) "play" else "pause",
            if (player.playbackPaused) "播放" else "暂停",
            onClick = player::togglePlay,
        )
        IconAction(
            if (settings.muted || settings.volume == 0.0) "mute" else "volume",
            if (settings.muted || settings.volume == 0.0) "取消静音" else "静音",
            onClick = player::toggleMute,
        )
        if (state.canVolume && !phone)
            Range(settings.volume.toFloat(), 0f, 1f, "视频音量", Modifier.width(80.dp)) {
                player.setVolume(it.toDouble())
            }
        Label(
            "${videoTime(player.scrubbing ?: state.time)} / ${videoTime(state.duration)}",
            size = 12,
            maxLines = 1,
        )
        Spacer(Modifier.weight(1f))
        if (!phone && state.canPip)
            IconAction(
                "picture-in-picture",
                "画中画",
                selected = state.pip,
                onClick = player::pictureInPicture,
            )
        IconAction("settings", "播放设置", selected = player.menu) { player.menu = !player.menu }
        if (state.canFullscreen)
            IconAction(
                "expand",
                if (state.fullscreen) "退出全屏" else "全屏",
                selected = state.fullscreen,
                onClick = player::fullscreen,
            )
    }
}

@Composable
private fun VideoMenu(player: VideoPlayback, phone: Boolean) {
    val settings = player.preferences
    GlassSurface(Modifier.widthIn(max = 316.dp), opacity = .98f) {
        Column(
            Modifier.padding(12.dp).widthIn(min = 230.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Toggle("打开时自动播放", settings.autoplay) { player.change(settings.copy(autoplay = it)) }
            Label("播放结束后", size = 12, color = LocalPalette.current.muted)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                for ((choice, label) in endOptions) {
                    Action(label, selected = settings.afterEnd == choice) {
                        player.change(settings.copy(afterEnd = choice))
                    }
                }
            }
            Label("播放倍速", size = 12, color = LocalPalette.current.muted)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                for (rate in rates) {
                    val label = rate.toString().removeSuffix(".0") + "×"
                    Action(label, selected = settings.rate == rate) {
                        player.change(settings.copy(rate = rate))
                    }
                }
            }
            if (player.tracks.isNotEmpty()) {
                Label("字幕", size = 12, color = LocalPalette.current.muted)
                FlowRow {
                    Action(
                        "关闭字幕",
                        selected = player.tracks.none { it.language == settings.captions },
                    ) {
                        player.change(settings.copy(captions = ""))
                    }
                    for (track in player.tracks) {
                        Action(track.label, selected = settings.captions == track.language) {
                            player.change(settings.copy(captions = track.language))
                        }
                    }
                }
            }
            if (phone && player.status.canVolume) {
                Label("视频音量", size = 12, color = LocalPalette.current.muted)
                Range(settings.volume.toFloat(), 0f, 1f, "视频音量", Modifier.fillMaxWidth()) {
                    player.setVolume(it.toDouble())
                }
            }
            if (phone && player.status.canPip)
                Action("画中画", selected = player.status.pip) {
                    player.menu = false
                    player.pictureInPicture()
                }
        }
    }
}

internal fun videoTime(seconds: Double): String {
    val total = seconds.toLong().coerceAtLeast(0)
    val hours = total / 3600
    val minutes = (total / 60 % 60).toString()
    val remainder = (total % 60).toString().padStart(2, '0')
    return if (hours == 0L) "$minutes:$remainder"
    else "$hours:${minutes.padStart(2, '0')}:$remainder"
}
