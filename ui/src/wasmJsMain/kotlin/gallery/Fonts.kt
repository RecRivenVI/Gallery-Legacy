@file:OptIn(
    kotlin.io.encoding.ExperimentalEncodingApi::class,
    kotlin.js.ExperimentalWasmJsInterop::class,
    androidx.compose.runtime.InternalComposeApi::class,
)

package gallery

import androidx.compose.runtime.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.*
import androidx.compose.ui.text.platform.Font
import androidx.compose.ui.text.withStyle
import kotlin.io.encoding.Base64
import kotlin.js.JsString
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

class Fonts(private val scope: CoroutineScope, private val resolver: FontFamily.Resolver) {
    var family: FontFamily by mutableStateOf(FontFamily.Default)
    var failure by mutableStateOf("")
    private var manifest: List<FontFamilyWire> = emptyList()
    private val loaded = mutableStateMapOf<String, FontFamily>()
    private val pending = mutableSetOf<String>()
    private val failed = mutableSetOf<String>()
    private var revision by mutableIntStateOf(0)
    private var webFonts: AutoCloseable? = null

    fun close() {
        webFonts?.close()
    }

    fun retry() {
        failed.clear()
        failure = ""
        revision++
    }

    suspend fun start() {
        val value =
            if (isDesktop()) host("resourceText", document("path" to "misans/manifest.json")).text()
            else
                resourceText("/frontend/assets/canvas/misans/manifest.json")
                    .await<JsString>()
                    .toString()
        val document = json.decodeFromString<FontManifestWire>(value)
        manifest = document.families
        document.latin.forEachIndexed { index, file ->
            val latin =
                webfont.createVariableFontFamily(
                    "misans-" + file,
                    resourceBytes("misans-cdn/" + file),
                    FontStyle.Normal,
                ) ?: throw IllegalStateException("FONT_UNAVAILABLE")
            resolver.preload(latin)
            if (index == 0) family = latin
        }
        val base =
            if (isDesktop()) "http://gallery-font.localhost/misans-cdn/"
            else "/frontend/assets/canvas/misans-cdn/"
        webFonts?.close()
        webFonts =
            webfont.installOnDemandWebFonts(
                base + "index.css",
                resolver,
                scope,
                latinUrl = "",
                localFontBase = base,
            )
    }

    private fun script(code: Int): String =
        when (code) {
            in 0x600..0x8ff,
            in 0xfb50..0xfdff,
            in 0xfe70..0xfeff -> "misansarabic"
            in 0x900..0x97f -> "misansdevanagari"
            in 0xa00..0xa7f -> "misansgurmukhi"
            in 0xa80..0xaff -> "misansgujarati"
            in 0xe00..0xe7f -> "misansthai"
            in 0xe80..0xeff -> "misanslao"
            in 0xf00..0xfff -> "misanstibetan"
            in 0x1000..0x109f,
            in 0xa9e0..0xa9ff,
            in 0xaa60..0xaa7f -> "misansmyanmar"
            in 0x1780..0x17ff,
            in 0x19e0..0x19ff -> "misanskhmer"
            in 0x1f000..0x1ffff,
            in 0x2600..0x27ff -> "emoji"
            else -> "cdn"
        }

    private fun runs(value: String): List<Pair<String, String>> {
        val runs = mutableListOf<Pair<String, String>>()
        var index = 0
        while (index < value.length) {
            val size =
                if (
                    value[index].isHighSurrogate() &&
                        index + 1 < value.length &&
                        value[index + 1].isLowSurrogate()
                )
                    2
                else 1
            val code =
                if (size == 2)
                    0x10000 +
                        ((value[index].code - 0xd800) shl 10) +
                        (value[index + 1].code - 0xdc00)
                else value[index].code
            val key =
                if (code in listOf(0xfe0f, 0x200d)) runs.lastOrNull()?.first ?: "cdn"
                else script(code)
            val text = value.substring(index, index + size)
            if (runs.lastOrNull()?.first == key) {
                val last = runs.removeAt(runs.lastIndex)
                runs.add(key to last.second + text)
            } else runs.add(key to text)
            index += size
        }
        return runs
    }

    fun ready(value: String) = runs(value).all { it.first == "cdn" || it.first in loaded }

    fun annotated(value: String): AnnotatedString = buildAnnotatedString {
        for ((key, text) in runs(value)) withStyle(SpanStyle(fontFamily = loaded[key] ?: family)) {
            append(text)
        }
    }

    fun ensure(value: String) {
        revision
        if (manifest.isEmpty()) return
        runs(value)
            .map { it.first }
            .toSet()
            .filter { it != "cdn" && it !in loaded && it !in failed && pending.add(it) }
            .forEach { key ->
                scope.launch {
                    try {
                        load(key)
                    } finally {
                        pending.remove(key)
                    }
                }
            }
    }

    private suspend fun load(key: String) {
        try {
            val file = manifest.find { it.key == key }?.files?.singleOrNull()
            val relative =
                if (key == "emoji") "fonts/noto-color-emoji.ttf"
                else
                    file?.url.orEmpty().substringAfter("assets/canvas/").ifEmpty {
                        throw IllegalStateException("FONT_UNAVAILABLE")
                    }
            val bytes = resourceBytes(relative)
            val family =
                if (key == "emoji") FontFamily(Font("emoji", bytes))
                else
                    webfont.createVariableFontFamily(key, bytes, FontStyle.Normal, scriptWeights)
                        ?: throw IllegalStateException("FONT_UNAVAILABLE")
            resolver.preload(family)
            loaded[key] = family
        } catch (e: Exception) {
            failed.add(key)
            failure = "字体加载失败：" + humanError(e.message.orEmpty())
        }
    }

    private suspend fun resourceBytes(relative: String): ByteArray {
        val encoded =
            if (isDesktop()) host("resource", document("path" to relative)).text()
            else fetchBase64("/frontend/assets/canvas/$relative").await<JsString>().toString()
        return Base64.decode(encoded)
    }
}

val LocalFonts = staticCompositionLocalOf<Fonts?> { null }

// The nine local script fonts declare these named instances in their fvar tables.
private val scriptWeights =
    listOf(
            100 to 150,
            200 to 200,
            300 to 250,
            350 to 305,
            400 to 330,
            500 to 380,
            550 to 450,
            600 to 520,
            700 to 630,
            800 to 700,
            900 to 700,
        )
        .map { (css, axis) -> FontWeight(css) to axis }
