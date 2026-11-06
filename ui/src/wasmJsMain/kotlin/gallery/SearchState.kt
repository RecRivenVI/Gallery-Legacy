package gallery

import androidx.compose.runtime.*
import kotlinx.coroutines.*

@Stable
class GallerySearch(private val gallery: GalleryState) {
    var text by mutableStateOf(gallery.route.query)
        private set

    var expanded by mutableStateOf(false)
    var focusRequest by mutableIntStateOf(0)
        private set

    private var job: Job? = null
    private var composing = false
    private var active = false
    private var pushed = false

    fun focus() {
        expanded = true
        focusRequest++
    }

    fun begin() {
        if (!active) {
            active = true
            pushed = false
        }
    }

    fun composition(value: Boolean) {
        composing = value
        if (value) job?.cancel()
    }

    fun edit(value: String) {
        text = value
        gallery.filters.parse(value)
        begin()
        job?.cancel()
        if (!composing)
            job =
                gallery.scope.launch {
                    delay(250)
                    job = null
                    submit(false)
                }
    }

    fun draft(value: String) {
        job?.cancel()
        job = null
        text = value
        gallery.filters.parse(value)
    }

    fun pause() {
        job?.cancel()
        job = null
    }

    fun submit(finish: Boolean = true, force: Boolean = false) {
        job?.cancel()
        job = null
        if (!composing && (force || text != gallery.route.query)) {
            val next = gallery.route.copy(query = text, page = 1)
            if (next != gallery.route) {
                val replace = active && pushed
                active = true
                pushed = true
                gallery.navigate(next, replace = replace)
            }
        }
        if (finish) {
            active = false
            pushed = false
        }
    }

    fun clear() {
        text = ""
        submit(force = true)
    }

    fun sync(route: Route, history: Boolean = false) {
        job?.cancel()
        job = null
        text = route.query
        gallery.filters.parse(text)
        if (history) {
            active = false
            pushed = false
        }
    }
}
