package gallery

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.*
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp

@Composable
internal fun VideoSeekBar(player: VideoPlayback, phone: Boolean) {
    val p = LocalPalette.current
    val focus = remember { FocusRequester() }
    val status = player.status
    val hasSeek = status.duration > 0 && status.seekable.isNotEmpty()
    val value = (player.scrubbing ?: status.time).toFloat()
    DisposableEffect(player) { onDispose { player.hoverPosition = null } }
    Canvas(
        Modifier.fillMaxWidth()
            .height(if (phone) 28.dp else 24.dp)
            .then(
                semanticControl(
                    "slider",
                    "视频进度",
                    hasSeek,
                    min = 0f,
                    max = status.duration.toFloat(),
                    value = value,
                )
            )
            .semantics {
                if (hasSeek) {
                    progressBarRangeInfo =
                        ProgressBarRangeInfo(value, 0f..status.duration.toFloat())
                    setProgress {
                        player.seek(it.toDouble())
                        true
                    }
                    stateDescription = videoTime(value.toDouble())
                }
            }
            .keyboardFocus()
            .focusRequester(focus)
            .onKeyEvent {
                if (it.type != KeyEventType.KeyDown || !hasSeek || it.isShiftPressed) false
                else
                    when (it.key) {
                        Key.DirectionLeft -> {
                            player.jump(-5.0)
                            true
                        }
                        Key.DirectionRight -> {
                            player.jump(5.0)
                            true
                        }
                        Key.MoveHome -> {
                            player.seek(0.0)
                            true
                        }
                        Key.MoveEnd -> {
                            player.seek(player.status.duration)
                            true
                        }
                        else -> false
                    }
            }
            .focusable()
            .onWebPointerEvent(PointerEventType.Move) {
                if (!phone && hasSeek && player.scrubbing == null) {
                    val point = it.changes.firstOrNull()?.position?.x ?: return@onWebPointerEvent
                    player.hoverPosition =
                        player.status.duration * (point / size.width).coerceIn(0f, 1f)
                }
                player.activity()
            }
            .onWebPointerEvent(PointerEventType.Exit) { player.hoverPosition = null }
            .pointerInput(player, hasSeek) {
                if (!hasSeek) return@pointerInput
                fun at(x: Float) = player.status.duration * (x / size.width).coerceIn(0f, 1f)
                awaitEachGesture {
                    val down = awaitFirstDown()
                    down.consume()
                    focus.requestFocus()
                    player.hoverPosition = null
                    try {
                        player.scrubbing = at(down.position.x)
                        do {
                            val event = awaitPointerEvent()
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (change.isConsumed) break
                            val target = at(change.position.x)
                            change.consume()
                            if (!change.pressed) {
                                player.seek(target)
                                break
                            }
                            player.scrubbing = target
                        } while (true)
                    } finally {
                        player.scrubbing = null
                    }
                }
            }
    ) {
        val width = size.width
        val y = center.y
        val line = 3.dp.toPx()
        val end = status.duration.takeIf { it > 0 } ?: 1.0
        fun x(seconds: Double) = (seconds / end).toFloat().coerceIn(0f, 1f) * width
        drawLine(p.divider, Offset(0f, y), Offset(width, y), line, StrokeCap.Round)
        for (range in status.buffered) {
            drawLine(p.faint, Offset(x(range[0]), y), Offset(x(range[1]), y), line)
        }
        drawLine(p.accent, Offset(0f, y), Offset(x(value.toDouble()), y), line, StrokeCap.Round)
        drawCircle(
            p.accent,
            if (player.scrubbing != null || player.hoverPosition != null) 5.dp.toPx()
            else 4.dp.toPx(),
            Offset(x(value.toDouble()), y),
        )
    }
}
