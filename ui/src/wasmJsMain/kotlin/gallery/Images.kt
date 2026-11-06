@file:OptIn(
    kotlin.io.encoding.ExperimentalEncodingApi::class,
    kotlin.js.ExperimentalWasmJsInterop::class,
)

package gallery

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.*
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import kotlin.io.encoding.Base64
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import org.jetbrains.skia.Image as SkiaImage

private val imageQueue = Semaphore(6)

private class CachedImage(
    val image: SkiaImage,
    val info: ImagePayloadWire,
    var references: Int = 0,
) {
    val bitmap = image.toComposeImageBitmap()
    val bytes = image.width.toLong() * image.height * 4
}

private val imageCache = LinkedHashMap<String, CachedImage>()

private class ImageLoad(val deferred: Deferred<CachedImage>, var waiters: Int = 0)

private val imageLoads = mutableMapOf<String, ImageLoad>()
private val imageScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

private fun trimImages() {
    var bytes = imageCache.values.sumOf { it.bytes }
    val iterator = imageCache.iterator()
    while (bytes > 96L * 1024 * 1024 && iterator.hasNext()) {
        val row = iterator.next()
        if (row.value.references == 0) {
            bytes -= row.value.bytes
            row.value.image.close()
            iterator.remove()
        }
    }
}

private suspend fun acquireImage(url: String, nearby: Boolean = false): CachedImage {
    val cached =
        imageCache[url]
            ?: imageLoads
                .getOrPut(url) {
                    ImageLoad(
                        imageScope.async {
                            try {
                                imageQueue.withPermit {
                                    val payload =
                                        imagePayload(url + if (nearby) "&priority=nearby" else "")
                                    CachedImage(
                                            SkiaImage.makeFromEncoded(
                                                Base64.decode(payload.encoded)
                                            ),
                                            payload.copy(encoded = ""),
                                        )
                                        .also {
                                            imageCache[url] = it
                                        }
                                }
                            } finally {
                                imageLoads.remove(url)
                                imageScope.launch {
                                    yield()
                                    trimImages()
                                }
                            }
                        }
                    )
                }
                .let { load ->
                    load.waiters++
                    try {
                        load.deferred.await()
                    } finally {
                        load.waiters--
                        if (load.waiters == 0 && !load.deferred.isCompleted) load.deferred.cancel()
                    }
                }
    cached.references++
    trimImages()
    return cached
}

suspend fun prefetchImage(url: String) {
    if (url.isEmpty()) return
    val image = acquireImage(url, true)
    image.references--
    trimImages()
}

@Composable
fun Thumbnail(media: MediaSummaryWire?, modifier: Modifier = Modifier, fit: Boolean = false) {
    if (media == null) return
    BoxWithConstraints(modifier) {
        val density = androidx.compose.ui.platform.LocalDensity.current.density
        val shortest = minOf(maxWidth.value, maxHeight.value) * density
        val url =
            if (shortest > 360f) media.thumbnails?.m ?: media.thumbnailUrl
            else media.thumbnails?.s ?: media.thumbnailUrl
        val tone = remember(media.thumbHash) { thumbHashAverage(media.thumbHash) }
        Box(
            Modifier.fillMaxSize()
                .background(
                    tone?.let { Color(it[0], it[1], it[2], it[3]) } ?: LocalPalette.current.tint
                )
        )
        var videoDuration by remember(url) { mutableStateOf(media.durationMs ?: 0L) }
        var coverReady by remember(url) { mutableStateOf(imageCache[url] != null) }
        MediaImage(
            url,
            Modifier.fillMaxSize(),
            fit = fit,
            placeholder = false,
            onLoaded = { coverReady = true },
            onDuration = { if (it > 0 || media.durationMs == null) videoDuration = it },
        )
        if (media.type == "video" && coverReady && videoDuration > 0)
            Box(
                Modifier.align(Alignment.BottomEnd)
                    .padding(7.dp)
                    .background(Color.Black.copy(alpha = .6f), GalleryShape(4.dp))
                    .padding(horizontal = 6.dp, vertical = 2.dp)
            ) {
                Label(
                    "${videoDuration/60000}:${((videoDuration/1000)%60).toString().padStart(2,'0')}",
                    color = Color.White,
                    size = 11,
                )
            }
    }
}

@Composable
fun MediaImage(
    url: String,
    modifier: Modifier = Modifier,
    fit: Boolean = false,
    description: String? = null,
    onLoaded: (() -> Unit)? = null,
    onError: (() -> Unit)? = null,
    placeholder: Boolean = true,
    onSize: ((Int, Int) -> Unit)? = null,
    onInfo: ((Int, Int, Boolean) -> Unit)? = null,
    onDuration: ((Long) -> Unit)? = null,
) {
    var bitmap by remember(url) { mutableStateOf<ImageBitmap?>(imageCache[url]?.bitmap) }
    var failed by remember(url) { mutableStateOf(false) }
    val loadedCallback by rememberUpdatedState(onLoaded)
    val errorCallback by rememberUpdatedState(onError)
    val sizeCallback by rememberUpdatedState(onSize)
    val infoCallback by rememberUpdatedState(onInfo)
    val durationCallback by rememberUpdatedState(onDuration)
    LaunchedEffect(url) {
        if (url.isEmpty()) return@LaunchedEffect
        var image: CachedImage? = null
        try {
            image = acquireImage(url)
            durationCallback?.invoke(image.info.durationMs)
            bitmap = image.bitmap
            if (image.info.width > 0)
                infoCallback?.invoke(image.info.width, image.info.height, image.info.animated)
            sizeCallback?.invoke(image.bitmap.width, image.bitmap.height)
            loadedCallback?.invoke()
            awaitCancellation()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            failed = true
            errorCallback?.invoke()
        } finally {
            image?.let {
                it.references--
                trimImages()
            }
        }
    }
    val value = bitmap
    if (value != null)
        Image(
            value,
            description,
            modifier,
            contentScale = if (fit) ContentScale.Fit else ContentScale.Crop,
        )
    else
        Box(
            modifier.background(if (placeholder) LocalPalette.current.tint else Color.Transparent)
        ) {
            if (failed)
                Box(
                    Modifier.fillMaxSize().clickable {
                        failed = false
                        imageLoads.remove(url)
                    },
                    contentAlignment = androidx.compose.ui.Alignment.Center,
                ) {
                    Fluent("gallery", color = LocalPalette.current.faint)
                }
        }
}
