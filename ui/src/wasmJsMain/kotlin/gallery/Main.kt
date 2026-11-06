@file:OptIn(
    androidx.compose.ui.ExperimentalComposeUiApi::class,
    kotlin.js.ExperimentalWasmJsInterop::class,
)

package gallery

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.platform.LocalFontFamilyResolver
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.ComposeViewport
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

fun main() {
    ComposeViewport {
        val scope = rememberCoroutineScope()
        val resolver = LocalFontFamilyResolver.current
        val fonts = remember(resolver) { Fonts(scope, resolver) }
        DisposableEffect(fonts) { onDispose { fonts.close() } }
        val gallery = remember { GalleryState(scope) }
        val manager = remember { ManagerState(scope) }
        val tooltips = remember { Tooltips() }
        var width by remember { mutableIntStateOf(browserWidth()) }
        var height by remember { mutableIntStateOf(browserHeight()) }
        var keyboard by remember { mutableStateOf(false) }
        var systemTheme by remember { mutableStateOf(systemDark()) }
        var startupError by remember { mutableStateOf("") }
        var fontsReady by remember { mutableStateOf(false) }
        var start by remember { mutableIntStateOf(0) }
        DisposableEffect(Unit) {
            val resize = listenResize {
                width = browserWidth()
                height = browserHeight()
            }
            val modality = listenModality { keyboard = it }
            val system = listenSystemTheme { systemTheme = systemDark() }
            onDispose {
                resize()
                modality()
                system()
            }
        }
        LaunchedEffect(start) {
            try {
                val icons = resourceText("fluent-icons.json").await<kotlin.js.JsString>().toString()
                fluentPaths =
                    json.decodeFromString<Map<String, List<String>>>(icons) +
                        json.decodeFromString<Map<String, List<String>>>(
                            resourceText("fluent-personal.json")
                                .await<kotlin.js.JsString>()
                                .toString()
                        )
                fonts.start()
                fontsReady = true
                startupError = ""
            } catch (e: Exception) {
                startupError = "加载失败：" + humanError(e.message.orEmpty())
            }
        }
        if (isDesktop()) LaunchedEffect(Unit) { manager.start() }
        else {
            LaunchedEffect(Unit) {
                try {
                    gallery.refreshSources()
                } catch (e: Exception) {
                    gallery.error = e.message.orEmpty()
                }
                gallery.reload()
                gallery.restoreViewer()
            }
            DisposableEffect(Unit) {
                val close = listenHistory { hash ->
                    val route = routeFromBrowser(hash)
                    gallery.panel = ""
                    gallery.drawer = false
                    if (route != gallery.route) {
                        gallery.pageDirection = if (route.page > gallery.route.page) 1 else -1
                        gallery.route = route
                        gallery.search.sync(route, history = true)
                        gallery.reload()
                    }
                    gallery.restoreViewer(hash)
                }
                onDispose { close() }
            }
            DisposableEffect(Unit) {
                val close = listenSearchShortcut {
                    if (gallery.viewer == null && gallery.panel.isEmpty() && !gallery.drawer)
                        gallery.search.focus()
                }
                onDispose { close() }
            }
            LaunchedEffect(Unit) {
                while (isActive) {
                    val ended = CompletableDeferred<Unit>()
                    val close =
                        listenStatus("/api/v1/events", gallery::changedStatus) {
                            gallery.connected = false
                            ended.complete(Unit)
                        }
                    try {
                        ended.await()
                    } finally {
                        close()
                    }
                    delay(2000)
                }
            }
        }
        CompositionLocalProvider(
            LocalGalleryFont provides fonts.family,
            LocalFonts provides fonts,
            LocalKeyboard provides keyboard,
            LocalReducedMotion provides gallery.reduceMotion,
            LocalTooltips provides tooltips,
        ) {
            ThemeTransition(
                if (gallery.theme == "dark" || (gallery.theme == "system" && systemTheme)) Dark
                else Light,
                gallery.reduceMotion,
            ) {
                if (startupError.isNotEmpty())
                    Box(
                        Modifier.fillMaxSize().background(LocalPalette.current.bg),
                        contentAlignment = androidx.compose.ui.Alignment.Center,
                    ) {
                        ErrorNotice(startupError) { start++ }
                    }
                else if (!fontsReady)
                    Box(Modifier.fillMaxSize().background(LocalPalette.current.bg))
                else if (isDesktop()) ManagerApp(manager) else GalleryApp(gallery, width, height)
                TooltipHost(tooltips)
                if (fontsReady && fonts.failure.isNotEmpty())
                    Box(
                        Modifier.fillMaxSize(),
                        contentAlignment = androidx.compose.ui.Alignment.BottomCenter,
                    ) {
                        Section(modifier = Modifier.widthIn(max = 420.dp).padding(16.dp)) {
                            ErrorNotice(fonts.failure, fonts::retry)
                        }
                    }
            }
        }
    }
}

@Composable
private fun ThemeTransition(target: Palette, reduced: Boolean, content: @Composable () -> Unit) {
    var palette by remember { mutableStateOf(target) }
    val layer = rememberGraphicsLayer()
    var snapshot by remember { mutableStateOf<ImageBitmap?>(null) }
    val alpha = remember { Animatable(1f) }
    LaunchedEffect(target) {
        if (palette != target) {
            if (!reduced) snapshot = layer.toImageBitmap()
            palette = target
            browserTheme(if (target.dark) "dark" else "light")
            if (!reduced) {
                alpha.snapTo(0f)
                alpha.animateTo(1f, tween(300))
            }
            snapshot = null
        }
    }
    Box(
        Modifier.fillMaxSize().drawWithContent {
            layer.record { this@drawWithContent.drawContent() }
            drawLayer(layer)
        }
    ) {
        snapshot?.let { androidx.compose.foundation.Image(it, null, Modifier.fillMaxSize()) }
        Box(Modifier.fillMaxSize().alpha(alpha.value)) {
            CompositionLocalProvider(LocalPalette provides palette) { content() }
        }
    }
}
