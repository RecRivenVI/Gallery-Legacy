package gallery

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.serialization.json.*

class DocumentTest {
    @Test
    fun authorSelectionUsesAnObjectInTheManagementRequest() {
        val request = document("authors" to mapOf("pixiv" to listOf("700", "701")))
        assertEquals(json.parseToJsonElement("""{"pixiv":["700","701"]}"""), request["authors"])
    }
}
