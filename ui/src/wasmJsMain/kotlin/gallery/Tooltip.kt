package gallery

import androidx.compose.foundation.*
import androidx.compose.foundation.interaction.*
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.*
import kotlinx.coroutines.delay

internal data class TooltipEntry(
    val owner: Any,
    val text: String,
    val rect: Rect,
    val backdrop: Backdrop?,
    val masks: MutableMap<Any, GlassMask>?,
)

class Tooltips {
    internal var entry by mutableStateOf<TooltipEntry?>(null)
}

val LocalTooltips = staticCompositionLocalOf<Tooltips?> { null }

@Composable
fun Tooltip(text: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val host = LocalTooltips.current
    val backdrop = LocalBackdrop.current
    val masks = LocalGlassMasks.current
    val owner = remember { Any() }
    val source = remember { MutableInteractionSource() }
    val hover by source.collectIsHoveredAsState()
    var rect by remember { mutableStateOf(Rect.Zero) }
    LaunchedEffect(hover, text) {
        if (hover) {
            delay(500)
            host?.entry = TooltipEntry(owner, text, rect, backdrop, masks)
        } else if (host?.entry?.owner === owner) host.entry = null
    }
    DisposableEffect(owner) { onDispose { if (host?.entry?.owner === owner) host.entry = null } }
    Box(modifier.hoverable(source).onGloballyPositioned { rect = it.boundsInWindow() }) {
        content()
    }
}

@Composable
fun TooltipHost(host: Tooltips) {
    val entry = host.entry ?: return
    val density = LocalDensity.current
    var size by remember { mutableStateOf(IntSize.Zero) }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val w = with(density) { maxWidth.roundToPx() }
        val h = with(density) { maxHeight.roundToPx() }
        val x =
            (entry.rect.center.x.toInt() - size.width / 2).coerceIn(
                0,
                (w - size.width).coerceAtLeast(0),
            )
        val gap = with(density) { 8.dp.roundToPx() }
        val y =
            if (entry.rect.bottom + gap + size.height < h) entry.rect.bottom.toInt() + gap
            else (entry.rect.top.toInt() - size.height - gap).coerceAtLeast(0)
        CompositionLocalProvider(
            LocalBackdrop provides entry.backdrop,
            LocalGlassMasks provides entry.masks,
        ) {
            GlassSurface(
                Modifier.offset { IntOffset(x, y) }
                    .widthIn(max = 320.dp)
                    .onSizeChanged { size = it }
                    .then(semanticControl("tooltip", entry.text)),
                radius = 6.dp,
            ) {
                Label(entry.text, Modifier.padding(8.dp))
            }
        }
    }
}
