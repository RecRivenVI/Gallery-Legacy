package gallery

import androidx.compose.ui.input.key.*

internal fun videoShortcut(player: VideoPlayback, event: KeyEvent): Boolean {
    if (event.isShiftPressed) return false
    when (event.key) {
        Key.Spacebar,
        Key.K -> player.togglePlay()
        Key.DirectionLeft -> player.jump(-5.0)
        Key.DirectionRight -> player.jump(5.0)
        Key.J -> player.jump(-10.0)
        Key.L -> player.jump(10.0)
        Key.DirectionUp -> player.setVolume(player.preferences.volume + .05)
        Key.DirectionDown -> player.setVolume(player.preferences.volume - .05)
        Key.M -> player.toggleMute()
        Key.F -> player.fullscreen()
        Key.C -> {
            val prefs = player.preferences
            val track = player.tracks.firstOrNull() ?: return false
            val enabled = player.tracks.any { it.language == prefs.captions }
            player.change(prefs.copy(captions = if (enabled) "" else track.language))
        }
        else -> return false
    }
    return true
}
