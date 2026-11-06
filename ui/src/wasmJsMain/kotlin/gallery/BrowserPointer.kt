package gallery

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.onPointerEvent

// Compose Web has no stable wheel/hover event modifier in this version.
@OptIn(ExperimentalComposeUiApi::class)
internal fun Modifier.onWebPointerEvent(
    type: PointerEventType,
    action: AwaitPointerEventScope.(PointerEvent) -> Unit,
): Modifier = onPointerEvent(type, onEvent = action)
