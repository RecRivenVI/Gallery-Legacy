package gallery

import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.*
import androidx.compose.foundation.interaction.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.focus.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.*

var fluentPaths by mutableStateOf<Map<String, List<String>>>(emptyMap())

@Composable
fun Modifier.keyboardFocus(shape: Shape = GalleryShape(Metrics.radius.dp)): Modifier {
    var focused by remember { mutableStateOf(false) }
    return onFocusChanged { focused = it.isFocused }
        .then(
            if (focused && LocalKeyboard.current)
                Modifier.border(2.dp, LocalPalette.current.fg, shape)
            else Modifier
        )
}

@Composable
fun Label(
    value: String,
    modifier: Modifier = Modifier,
    color: Color = LocalPalette.current.fg,
    size: Int = 13,
    bold: Boolean = false,
    maxLines: Int = Int.MAX_VALUE,
) {
    val fonts = LocalFonts.current
    fonts?.ensure(value)
    if (fonts != null && !fonts.ready(value)) {
        Box(modifier.heightIn(min = (size + 4).dp).semantics { contentDescription = value })
        return
    }
    BasicText(
        fonts?.annotated(value) ?: AnnotatedString(value),
        modifier,
        style =
            TextStyle(
                color = color,
                fontSize = size.sp,
                fontFamily = LocalGalleryFont.current,
                fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal,
            ),
        maxLines = maxLines,
        overflow = TextOverflow.Clip,
    )
}

@Composable
fun Fluent(
    name: String,
    modifier: Modifier = Modifier,
    color: Color = LocalPalette.current.fg,
    size: Int = 20,
) {
    val paths =
        remember(name, fluentPaths) {
            fluentPaths[name].orEmpty().map { PathParser().parsePathString(it).toPath() }
        }
    Canvas(modifier.size(size.dp)) {
        scale(this.size.width / 20f, this.size.height / 20f, Offset.Zero) {
            paths.forEach { drawPath(it, color) }
        }
    }
}

@Composable
fun Action(
    text: String = "",
    icon: String? = null,
    selected: Boolean? = null,
    primary: Boolean = false,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
    description: String = text,
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    val p = LocalPalette.current
    val source = remember { MutableInteractionSource() }
    val hover by source.collectIsHoveredAsState()
    val press by source.collectIsPressedAsState()
    val focus by source.collectIsFocusedAsState()
    val bg =
        when {
            primary -> p.accent
            press -> p.pressed
            selected == true -> p.selected
            hover -> p.tint
            else -> Color.Transparent
        }
    val fg = if (primary) p.accentInk else p.fg
    Row(
        modifier
            .then(
                semanticControl(
                    "button",
                    if (text.isEmpty() || description != text) description else "",
                    enabled,
                    pressed = selected,
                )
            )
            .widthIn(min = if (icon != null && text.isEmpty()) 34.dp else 0.dp)
            .heightIn(min = 34.dp)
            .background(bg, GalleryShape(7.dp))
            .then(
                if (focus && LocalKeyboard.current) Modifier.border(2.dp, p.fg, GalleryShape(7.dp))
                else Modifier
            )
            .alpha(if (enabled) 1f else .4f)
            .hoverable(source, enabled)
            .combinedClickable(
                interactionSource = source,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
                onLongClick = onLongClick,
            )
            .semantics {
                if (text.isEmpty() && description.isNotEmpty()) contentDescription = description
            }
            .padding(
                horizontal = if (icon != null && text.isEmpty()) 4.dp else 10.dp,
                vertical = 5.dp,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement =
            if (icon != null && text.isEmpty()) Arrangement.Center else Arrangement.spacedBy(6.dp),
    ) {
        if (icon != null) Fluent(icon, color = fg, size = if (text.isEmpty()) 16 else 20)
        if (text.isNotEmpty())
            Label(text.removeSuffix(" ▾").removeSuffix(" ▴"), color = fg, maxLines = 1)
        if (text.endsWith(" ▾") || text.endsWith(" ▴"))
            Fluent(if (text.endsWith(" ▾")) "down" else "up", color = fg, size = 12)
    }
}

@Composable
fun IconAction(
    name: String,
    description: String,
    modifier: Modifier = Modifier,
    selected: Boolean? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Tooltip(description, modifier) {
        Action(
            icon = name,
            selected = selected,
            enabled = enabled,
            description = description,
            onClick = onClick,
        )
    }
}

@Composable
fun Field(
    value: String,
    onChange: (String) -> Unit,
    hint: String = "",
    modifier: Modifier = Modifier,
    multiline: Boolean = false,
    enabled: Boolean = true,
    onEnter: (() -> Unit)? = null,
    autoFocus: Boolean = false,
    onEscape: (() -> Unit)? = null,
    onBlur: (() -> Unit)? = null,
    onFocus: (() -> Unit)? = null,
    onComposition: ((Boolean) -> Unit)? = null,
    focusRequest: Int = 0,
    compact: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    password: Boolean = false,
) {
    val p = LocalPalette.current
    var editing by remember { mutableStateOf(androidx.compose.ui.text.input.TextFieldValue(value)) }
    val fonts = LocalFonts.current
    val focus = remember { FocusRequester() }
    var hadFocus by remember { mutableStateOf(false) }
    LaunchedEffect(autoFocus) { if (autoFocus) focus.requestFocus() }
    LaunchedEffect(focusRequest) { if (focusRequest > 0) focus.requestFocus() }
    fonts?.ensure(editing.text)
    LaunchedEffect(value) {
        if (editing.composition == null && editing.text != value)
            editing =
                androidx.compose.ui.text.input.TextFieldValue(
                    value,
                    selection = TextRange(value.length),
                )
    }
    BasicTextField(
        editing,
        { next ->
            val changed =
                next.text != editing.text ||
                    (editing.composition != null && next.composition == null)
            editing = next
            onComposition?.invoke(next.composition != null)
            if (next.composition == null && changed) onChange(next.text)
        },
        modifier
            .then(semanticControl("textbox", hint, enabled))
            .keyboardFocus()
            .focusRequester(focus)
            .onFocusChanged {
                if (!hadFocus && it.isFocused) onFocus?.invoke()
                if (hadFocus && !it.isFocused) onBlur?.invoke()
                hadFocus = it.isFocused
            }
            .heightIn(min = if (compact) 28.dp else 34.dp)
            .clip(GalleryShape(7.dp))
            .background(p.field)
            .border(1.dp, p.edge, GalleryShape(7.dp))
            .padding(horizontal = 10.dp, vertical = if (compact) 4.dp else 7.dp)
            .semantics { if (hint.isNotEmpty()) contentDescription = hint }
            .onPreviewKeyEvent {
                if (it.type == KeyEventType.KeyDown && it.key == Key.Escape && onEscape != null) {
                    onEscape()
                    true
                } else if (
                    it.type == KeyEventType.KeyDown &&
                        it.key == Key.Enter &&
                        onEnter != null &&
                        editing.composition == null &&
                        !multiline
                ) {
                    onEnter()
                    true
                } else false
            },
        enabled = enabled,
        singleLine = !multiline,
        cursorBrush = SolidColor(p.fg),
        textStyle =
            TextStyle(color = p.fg, fontFamily = LocalGalleryFont.current, fontSize = 13.sp),
        visualTransformation =
            if (password) androidx.compose.ui.text.input.PasswordVisualTransformation()
            else
                androidx.compose.ui.text.input.VisualTransformation { text ->
                    androidx.compose.ui.text.input.TransformedText(
                        fonts?.annotated(text.text) ?: text,
                        androidx.compose.ui.text.input.OffsetMapping.Identity,
                    )
                },
        decorationBox = { inner ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                leading?.invoke()
                Box(Modifier.weight(1f)) {
                    if (editing.text.isEmpty()) Label(hint, color = p.faint, maxLines = 1)
                    inner()
                }
                trailing?.invoke()
            }
        },
    )
}

@Composable
fun Toggle(label: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    val p = LocalPalette.current
    val x by
        animateFloatAsState(
            if (checked) 14f else 0f,
            if (LocalReducedMotion.current) snap()
            else spring(stiffness = Spring.StiffnessMediumLow),
        )
    Row(
        Modifier.then(semanticControl("switch", label, enabled, checked = checked))
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .keyboardFocus()
            .toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Switch,
                onValueChange = onChange,
            )
            .semantics { stateDescription = if (checked) "开启" else "关闭" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Label(label, Modifier.weight(1f))
        Canvas(Modifier.size(34.dp, 20.dp).alpha(if (enabled) 1f else .4f)) {
            drawRoundRect(
                if (checked) p.accent else p.fg.copy(alpha = .22f),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(10.dp.toPx()),
            )
            drawCircle(Color.White, 8.dp.toPx(), Offset((10 + x).dp.toPx(), 10.dp.toPx()))
        }
    }
}

@Composable
fun Range(
    value: Float,
    min: Float,
    max: Float,
    label: String,
    modifier: Modifier = Modifier,
    steps: Int = 0,
    onChange: (Float) -> Unit,
) {
    val p = LocalPalette.current
    val latest by rememberUpdatedState(onChange)
    val focus = remember { FocusRequester() }
    fun changed(f: Float) {
        val raw = min + f.coerceIn(0f, 1f) * (max - min)
        latest(if (steps > 0) kotlin.math.round(raw) else raw)
    }
    Canvas(
        modifier
            .then(semanticControl("slider", label, min = min, max = max, value = value))
            .height(34.dp)
            .widthIn(min = 80.dp)
            .semantics {
                contentDescription = label
                progressBarRangeInfo = ProgressBarRangeInfo(value, min..max, steps)
                setProgress {
                    latest(it.coerceIn(min, max))
                    true
                }
            }
            .keyboardFocus()
            .focusRequester(focus)
            .onKeyEvent {
                if (it.type != KeyEventType.KeyDown) false
                else
                    when (it.key) {
                        Key.DirectionLeft,
                        Key.DirectionDown -> {
                            latest(
                                (value - if (steps > 0) 1f else (max - min) / 20).coerceAtLeast(min)
                            )
                            true
                        }
                        Key.DirectionRight,
                        Key.DirectionUp -> {
                            latest(
                                (value + if (steps > 0) 1f else (max - min) / 20).coerceAtMost(max)
                            )
                            true
                        }
                        Key.MoveHome -> {
                            latest(min)
                            true
                        }
                        Key.MoveEnd -> {
                            latest(max)
                            true
                        }
                        else -> false
                    }
            }
            .focusable()
            .pointerInput(min, max) {
                detectTapGestures {
                    focus.requestFocus()
                    changed(it.x / size.width)
                }
            }
            .pointerInput(min, max) {
                detectDragGestures(onDragStart = { focus.requestFocus() }) { change, _ ->
                    change.consume()
                    changed(change.position.x / size.width)
                }
            }
    ) {
        val y = size.height / 2
        val x =
            ((value - min) / (max - min)).coerceIn(0f, 1f) * (size.width - 14.dp.toPx()) +
                7.dp.toPx()
        drawLine(
            p.fg.copy(alpha = .22f),
            Offset(7.dp.toPx(), y),
            Offset(size.width - 7.dp.toPx(), y),
            4.dp.toPx(),
            StrokeCap.Round,
        )
        drawLine(p.accent, Offset(7.dp.toPx(), y), Offset(x, y), 4.dp.toPx(), StrokeCap.Round)
        drawCircle(p.accent, 7.dp.toPx(), Offset(x, y))
    }
}

@Composable
fun Segment(
    items: List<String>,
    selected: Int,
    modifier: Modifier = Modifier,
    onChange: (Int) -> Unit,
) {
    val p = LocalPalette.current
    val focuses = remember(items) { List(items.size) { FocusRequester() } }
    Row(
        modifier
            .then(semanticControl("radiogroup"))
            .height(34.dp)
            .clip(GalleryShape(7.dp))
            .background(p.tint)
            .padding(3.dp)
            .onPreviewKeyEvent { e ->
                val delta =
                    when (e.key) {
                        Key.DirectionLeft,
                        Key.DirectionUp -> -1
                        Key.DirectionRight,
                        Key.DirectionDown -> 1
                        else -> 0
                    }
                if (e.type == KeyEventType.KeyDown && delta != 0) {
                    val next = (selected + delta + items.size) % items.size
                    onChange(next)
                    focuses[next].requestFocus()
                    true
                } else false
            },
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        items.forEachIndexed { index, label ->
            Box(
                Modifier.fillMaxHeight()
                    .then(semanticControl("radio", label, checked = selected == index))
                    .focusRequester(focuses[index])
                    .clip(GalleryShape(4.dp))
                    .background(if (selected == index) p.field else Color.Transparent)
                    .keyboardFocus(GalleryShape(4.dp))
                    .selectable(selected = selected == index, role = Role.RadioButton) {
                        onChange(index)
                    }
                    .semantics { this.selected = selected == index }
                    .padding(horizontal = 9.dp),
                contentAlignment = Alignment.Center,
            ) {
                Label(label, maxLines = 1)
            }
        }
    }
}

@Composable
fun Rule() {
    Box(Modifier.fillMaxWidth().height(1.dp).background(LocalPalette.current.divider))
}

@Composable
fun Section(
    title: String = "",
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val p = LocalPalette.current
    Column(
        modifier
            .fillMaxWidth()
            .clip(GalleryShape(12.dp))
            .background(p.glass)
            .border(1.dp, p.edge, GalleryShape(12.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (title.isNotEmpty()) Label(title, bold = true, size = 16)
        content()
    }
}

@Composable
fun ErrorNotice(message: String, retry: (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Label(message, Modifier.weight(1f), color = LocalPalette.current.error)
        if (retry != null) Action("重试", onClick = retry)
    }
}

@Composable
fun Skeleton(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition()
    val alpha by
        transition.animateFloat(.15f, .35f, infiniteRepeatable(tween(800), RepeatMode.Reverse))
    Box(
        modifier
            .clip(GalleryShape(6.dp))
            .background(
                LocalPalette.current.fg.copy(
                    alpha = if (LocalReducedMotion.current) .22f else alpha
                )
            )
    )
}

@Composable
fun Confirmation(
    text: String,
    confirm: String,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
    extra: Pair<String, () -> Unit>? = null,
) {
    val cancelFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { cancelFocus.requestFocus() }
    ModalLayer("确认", onCancel) {
        Box(
            Modifier.fillMaxSize()
                .background(Color.Black.copy(alpha = .4f))
                .focusProperties { canFocus = false }
                .clickable(
                    indication = null,
                    interactionSource = remember { MutableInteractionSource() },
                ) {
                    onCancel()
                },
            contentAlignment = Alignment.Center,
        ) {
            Section(
                modifier =
                    Modifier.widthIn(max = 420.dp)
                        .padding(20.dp)
                        .focusProperties { canFocus = false }
                        .clickable(
                            indication = null,
                            interactionSource = remember { MutableInteractionSource() },
                        ) {}
            ) {
                Label(text)
                Row(
                    Modifier.align(Alignment.End),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Action(
                        "取消",
                        modifier = Modifier.focusRequester(cancelFocus),
                        onClick = onCancel,
                    )
                    if (extra != null) Action(extra.first, onClick = extra.second)
                    Action(confirm, primary = true, onClick = onConfirm)
                }
            }
        }
    }
}

// Compose Web tracks only the last semantics owner and loses the main owner
// after Dialog/Popup removal. Overlays stay in one scene until upstream fixes it.
@Composable
fun ModalLayer(
    name: String,
    onDismiss: () -> Unit,
    active: Boolean = true,
    autoFocus: Boolean = true,
    content: @Composable BoxScope.() -> Unit,
) {
    val focus = remember { FocusRequester() }
    val manager = androidx.compose.ui.platform.LocalFocusManager.current
    LaunchedEffect(name, active) { if (active && autoFocus) focus.requestFocus() }
    val keys = Modifier.onPreviewKeyEvent { e ->
        if (!active || e.type != KeyEventType.KeyDown) false
        else if (e.key == Key.Escape) {
            onDismiss()
            true
        } else if (e.key == Key.Tab) {
            if (
                !manager.moveFocus(
                    if (e.isShiftPressed) FocusDirection.Previous else FocusDirection.Next
                )
            )
                focus.requestFocus()
            true
        } else false
    }
    Box(
        Modifier.fillMaxSize()
            .then(semanticControl("dialog", name, hidden = !active))
            .then(keys)
            .focusRequester(focus)
            .focusProperties { onExit = { if (active) cancelFocusChange() } }
            .focusable()
            .focusGroup(),
        content = content,
    )
}
