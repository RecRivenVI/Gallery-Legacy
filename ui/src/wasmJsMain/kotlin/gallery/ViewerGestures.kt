package gallery

import androidx.compose.foundation.gestures.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.*
import androidx.compose.ui.platform.LocalDensity
import kotlin.math.abs
import kotlinx.coroutines.*

@Composable
internal fun Modifier.viewerGestures(
    state: ViewerState,
    phone: Boolean,
    video: VideoPlayback? = null,
): Modifier {
    val density = LocalDensity.current
    return this.pointerInput(state, phone, video) {
            var lastTap = 0.0
            var tap: Job? = null
            coroutineScope {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val start = down.position
                    var end = start
                    var multi = false
                    var moved = false
                    state.dragging = true
                    do {
                        val event = awaitPointerEvent()
                        multi = multi || event.changes.count { it.pressed } > 1
                        val change = event.changes.first()
                        end = change.position
                        moved = moved || (end - start).getDistance() > viewConfiguration.touchSlop
                        if (multi) {
                            state.setScale(
                                state.zoom * event.calculateZoom(),
                                event.calculateCentroid() -
                                    Offset(size.width / 2f, size.height / 2f),
                            )
                            state.move(event.calculatePan())
                            event.changes.forEach { it.consume() }
                        } else if (moved) {
                            if (state.zoom > 1.01f)
                                state.move(change.position - change.previousPosition)
                            event.changes.forEach { it.consume() }
                        }
                    } while (event.changes.any { it.pressed })
                    state.dragging = false
                    if (!multi && moved) {
                        val delta = end - start
                        if (
                            state.zoom <= 1.01f &&
                                abs(delta.x) > 64 * density.density &&
                                abs(delta.x) > abs(delta.y)
                        )
                            state.flip(state.reading.physicalDelta(if (delta.x < 0) 1 else -1))
                        else if (
                            phone &&
                                abs(delta.y) > 64 * density.density &&
                                abs(delta.y) > abs(delta.x)
                        )
                            state.details = delta.y < 0
                    } else if (!multi && !moved) {
                        val media = state.current
                        val fit =
                            fittedMediaRect(
                                size.width.toFloat(),
                                size.height.toFloat(),
                                (state.imageWidth.takeIf { it > 0 } ?: media?.width ?: 0).toFloat(),
                                (state.imageHeight.takeIf { it > 0 } ?: media?.height ?: 0)
                                    .toFloat(),
                            )
                        val insideImage =
                            fit == androidx.compose.ui.geometry.Rect.Zero ||
                                fit.contains(
                                    fit.center + (start - fit.center - state.pan) / state.zoom
                                )
                        if (!insideImage) {
                            tap?.cancel()
                            state.close()
                        } else if (video != null) {
                            video.activity(clicked = true, touch = phone)
                        } else if (now() - lastTap < 300) {
                            tap?.cancel()
                            if (state.split) state.split = false
                            else
                                state.setScale(
                                    if (state.zoom < 1.5f) 2f else 1f,
                                    end - Offset(size.width / 2f, size.height / 2f),
                                )
                            lastTap = 0.0
                        } else {
                            lastTap = now()
                            tap = launch {
                                delay(300)
                                state.toggleHidden()
                            }
                        }
                    }
                }
            }
        }
        .onWebPointerEvent(PointerEventType.Scroll) { e ->
            if (
                video != null ||
                    e.keyboardModifiers.isCtrlPressed ||
                    e.keyboardModifiers.isMetaPressed
            )
                return@onWebPointerEvent
            val change = e.changes.first()
            state.setScale(
                state.zoom * if (change.scrollDelta.y < 0) 1.15f else 1 / 1.15f,
                change.position - Offset(state.areaWidth / 2, state.areaHeight / 2),
            )
            change.consume()
        }
}
