package gallery

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.unit.*
import androidx.compose.ui.window.*

@Composable
fun ReadingMenu(state: ViewerState) {
    val reading = state.reading
    val options = reading.options
    ModalLayer("阅读方式", { reading.menu = false }) {
        Box(
            Modifier.fillMaxSize().clickable(
                interactionSource =
                    remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                indication = null,
            ) {
                reading.menu = false
            }
        )
        GlassSurface(
            (if (browserWidth() < 700)
                Modifier.align(Alignment.BottomCenter).padding(8.dp).width((browserWidth() - 16).dp)
            else Modifier.align(Alignment.TopEnd).padding(top = 50.dp, end = 8.dp).width(240.dp)),
            opacity = Metrics.panelGlassOpacity,
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("single" to "单页", "double" to "双页", "continuous" to "纵向连续").forEach {
                    (mode, label) ->
                    Action(
                        label,
                        selected = mode == options.mode,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        reading.change(options.copy(mode = mode))
                    }
                }
                Rule()
                Toggle("从右到左", options.rtl, enabled = options.mode != "continuous") {
                    reading.change(options.copy(rtl = it))
                }
                Toggle("封面单独", options.coverAlone, enabled = options.mode == "double") {
                    reading.change(options.copy(coverAlone = it))
                }
            }
        }
    }
}

@Composable
fun PersonalDetails(state: ViewerState) {
    val people = state.gallery.people
    if (people.account == null || !state.work.stableId.startsWith("/p/")) return
    val work = state.work
    var tag by remember(work.stableId) { mutableStateOf("") }
    var adding by remember(work.stableId) { mutableStateOf(false) }
    Rule()
    Label("我的", color = LocalPalette.current.faint, size = 11)
    Stars(work.personal?.rating ?: 0) {
        people.perform { people.change(work, "rating", number = it) }
    }
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        work.personal?.tags.orEmpty().forEach { value ->
            Action("$value ×", selected = true) {
                people.perform {
                    people.change(work, "tag.remove", text = value)
                    people.refresh()
                }
            }
        }
        if (!adding) Action("＋", description = "添加我的标签") { adding = true }
    }
    if (adding) {
        fun add() {
            if (tag.isNotBlank()) {
                val value = tag.trim()
                people.perform {
                    people.change(work, "tag.add", text = value)
                    people.refresh()
                }
                tag = ""
                adding = false
            }
        }
        Field(
            tag,
            { tag = it },
            "我的标签",
            Modifier.fillMaxWidth(),
            autoFocus = true,
            onEnter = { add() },
            onEscape = { adding = false },
        )
        people.tags
            .filter { it.label.contains(tag, true) && it.label !in work.personal?.tags.orEmpty() }
            .take(8)
            .forEach { suggestion ->
                Action(suggestion.label) {
                    tag = suggestion.label
                    add()
                }
            }
    }
    if (people.error.isNotEmpty()) Label(people.error, color = LocalPalette.current.error)
}
