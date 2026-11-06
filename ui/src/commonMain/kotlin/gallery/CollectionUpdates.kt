package gallery

import kotlinx.serialization.json.JsonElement

class CollectionUpdates {
    private var initialized = false
    private var epoch = ""
    private var revisions = emptyMap<String, Long>()
    private var counts = emptyMap<String, Long>()

    fun receive(status: JsonElement, platform: String) =
        receive(ServiceStatusWire(status), platform)

    fun receive(status: ServiceStatusWire, platform: String): Pair<Boolean, Long> {
        val live = status.live ?: LiveStateWire()
        val nextEpoch = live.epoch.ifEmpty { status.loadedGenerationId }
        val rows = status.platforms
        val nextRevisions =
            (platforms + "@all").associateWith {
                if (it == "@all") live.revision else live.platformRevisions[it] ?: 0L
            }
        val nextCounts = rows.associate { it.id to it.works } + ("@all" to rows.sumOf { it.works })
        val changed =
            initialized && (nextEpoch != epoch || nextRevisions[platform] != revisions[platform])
        val added =
            if (changed && nextEpoch == epoch)
                ((nextCounts[platform] ?: 0L) - (counts[platform] ?: 0L)).coerceAtLeast(0L)
            else 0L
        initialized = true
        epoch = nextEpoch
        revisions = nextRevisions
        counts = nextCounts
        return changed to added
    }
}
