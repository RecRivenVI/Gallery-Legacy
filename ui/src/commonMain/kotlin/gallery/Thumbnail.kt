@file:OptIn(kotlin.io.encoding.ExperimentalEncodingApi::class)

package gallery

import kotlin.io.encoding.Base64

// ThumbHash's DC channels encode the mean LPQ color; no image decode is needed.
fun thumbHashAverage(value: String): FloatArray? {
    if (value.isEmpty()) return null
    val bytes = Base64.decode(value)
    if (bytes.size < 5) return null
    val header =
        (bytes[0].toInt() and 255) or
            ((bytes[1].toInt() and 255) shl 8) or
            ((bytes[2].toInt() and 255) shl 16)
    val l = (header and 63) / 63f
    val p = ((header shr 6) and 63) / 31.5f - 1f
    val q = ((header shr 12) and 63) / 31.5f - 1f
    val b = l - 2f * p / 3f
    val r = (3 * l - b + q) / 2f
    val alpha =
        if (header and 0x800000 != 0 && bytes.size > 5) (bytes[5].toInt() and 15) / 15f else 1f
    return floatArrayOf(r.coerceIn(0f, 1f), (r - q).coerceIn(0f, 1f), b.coerceIn(0f, 1f), alpha)
}
