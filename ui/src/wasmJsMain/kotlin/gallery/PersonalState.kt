package gallery

import androidx.compose.runtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

@Stable
class GalleryPeople(private val gallery: GalleryState) {
    var account by mutableStateOf<AccountWire?>(null)
    var accounts by mutableStateOf<List<AccountWire>>(emptyList())
    var counts by mutableStateOf<Map<String, Long>>(emptyMap())
    var collections by mutableStateOf<List<CollectionWire>>(emptyList())
    var tags by mutableStateOf<List<TagWire>>(emptyList())
    var error by mutableStateOf("")
    var busy by mutableStateOf(false)
    var selectedWork by mutableStateOf<WorkSummaryWire?>(null)
    var selectedCollection by mutableStateOf<CollectionWire?>(null)
    var draftName by mutableStateOf("")
    var draftAvatar by mutableStateOf("")
    var draftPassword by mutableStateOf("")
    var profilePage by mutableStateOf("list")
    var confirming by mutableStateOf("")
    private val mutations = Mutex()
    private var pending = 0
    private var preferenceJob: Job? = null
    private var readJob: Job? = null
    var guestPreferences: AccountPreferencesWire? =
        try {
            stored("gallery_guest_preferences")
                .takeIf { it.isNotEmpty() }
                ?.let { json.decodeFromString<AccountPreferencesWire>(it) }
        } catch (_: IllegalArgumentException) {
            null
        }
    private var pendingFavorite: WorkSummaryWire? = null

    suspend fun refresh(apply: Boolean = false) {
        val session = readApi<AccountSessionWire>("session")
        if (account == null && session.account != null && guestPreferences == null)
            guestPreferences = gallery.accountPreferences()
        account = session.account
        counts = session.counts
        accounts = readApi<PageWire<AccountWire>>("accounts").items
        if (account != null) {
            if (apply) {
                if (
                    session.preferences is JsonObject && session.preferences.jsonObject.isNotEmpty()
                )
                    gallery.applyPreferences(
                        json.decodeFromJsonElement<AccountPreferencesWire>(session.preferences)
                    )
                else
                    postApi(
                        "account",
                        document(
                            "action" to "preferences",
                            "accountId" to account?.id,
                            "preferences" to json.encodeToJsonElement(gallery.accountPreferences()),
                        ),
                    )
            }
            collections = readApi<PageWire<CollectionWire>>("collections").items
            tags = readApi<PageWire<TagWire>>("personal-tags").items
        } else {
            collections = emptyList()
            tags = emptyList()
        }
    }

    fun perform(action: suspend () -> Unit) {
        gallery.scope.launch {
            pending++
            busy = true
            error = ""
            try {
                action()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = humanError(e.message.orEmpty())
            } finally {
                pending--
                busy = pending > 0
            }
        }
    }

    fun openLogin() {
        gallery.drawer = false
        gallery.panel = "account"
        profilePage = "list"
        confirming = ""
        error = ""
        perform { refresh() }
    }

    fun login(id: String, password: String) = perform {
        readJob?.cancel()
        preferenceJob?.cancel()
        if (account == null) rememberGuest()
        postApi("session", document("id" to id, "password" to password))
        finishLogin()
    }

    fun create(name: String, password: String) = perform {
        readJob?.cancel()
        preferenceJob?.cancel()
        if (account == null) rememberGuest()
        postApi(
            "accounts",
            document(
                "name" to name,
                "password" to password,
                "preferences" to json.encodeToJsonElement(gallery.accountPreferences()),
            ),
        )
        finishLogin()
    }

    fun logout() = perform {
        readJob?.cancel()
        preferenceJob?.cancel()
        postApi("session", document("action" to "logout"))
        account = null
        gallery.viewer = null
        guestPreferences?.let { gallery.applyPreferences(it) }
        refresh()
        gallery.panel = ""
        gallery.reload()
    }

    fun update(name: String, avatar: String, password: String?, delete: Boolean = false) = perform {
        val input = buildJsonObject {
            put("action", if (delete) "delete" else "update")
            put("accountId", account?.id)
            put("name", name)
            put("avatar", avatar)
            password?.let { put("password", it) }
        }
        postApi("account", input)
        if (delete) {
            account = null
            gallery.viewer = null
            guestPreferences?.let { gallery.applyPreferences(it) }
        }
        refresh()
        gallery.panel = ""
        gallery.reload()
    }

    fun savePreferences() {
        val owner = account?.id ?: return
        val value = gallery.accountPreferences()
        preferenceJob?.cancel()
        preferenceJob =
            gallery.scope.launch {
                delay(250)
                try {
                    postApi(
                        "account",
                        document(
                            "action" to "preferences",
                            "accountId" to owner,
                            "preferences" to json.encodeToJsonElement(value),
                        ),
                    )
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    error = humanError(e.message.orEmpty())
                }
            }
    }

    suspend fun change(
        work: WorkSummaryWire,
        action: String,
        value: Boolean = false,
        number: Int = 0,
        text: String = "",
        values: List<String> = emptyList(),
        options: ReadingOptions? = null,
    ) {
        val owner = account?.id ?: return
        mutations.withLock {
            if (account?.id != owner) return@withLock
            val request =
                PersonalChangeWire(
                    accountId = owner,
                    work = work.stableId,
                    action = action,
                    value = value,
                    number = number,
                    text = text,
                    values = values,
                    rtl = options?.rtl ?: false,
                    coverAlone = options?.coverAlone ?: true,
                )
            val updated =
                sendApi<WorkSummaryWire>("personal", json.encodeToJsonElement(request).jsonObject)
            if (account?.id != owner) return@withLock
            gallery.items =
                gallery.items.map {
                    if (it.stableId == work.stableId)
                        it.copy(work = it.work.copy(personal = updated.personal))
                    else it
                }
            gallery.viewer?.updatePersonal(work.stableId, updated.personal)
            counts = readApi<AccountSessionWire>("session").counts
            val remove =
                (action == "favorite" &&
                    !value &&
                    gallery.route.kind in listOf("favorites", "collection")) ||
                    (action == "collections" &&
                        gallery.route.kind == "collection" &&
                        gallery.route.path.substringAfterLast('/') !in values) ||
                    (action == "read" &&
                        gallery.route.kind == "continue" &&
                        number >= (updated.personal?.totalPages ?: updated.counts.media))
            if (remove && gallery.items.any { it.stableId == work.stableId }) {
                gallery.items = gallery.items.filter { it.stableId != work.stableId }
                gallery.total = (gallery.total - 1).coerceAtLeast(0)
                gallery.workTotal = gallery.total
                gallery.totalPages =
                    ((gallery.total + gallery.route.pageSize - 1) / gallery.route.pageSize).toInt()
            }
        }
    }

    fun favorite(work: WorkSummaryWire) {
        if (account == null) {
            pendingFavorite = work
            openLogin()
            return
        }
        perform { change(work, "favorite", value = work.personal?.favorite != true) }
    }

    private fun rememberGuest() {
        guestPreferences = gallery.accountPreferences()
        saveStored("gallery_guest_preferences", json.encodeToString(guestPreferences))
    }

    private suspend fun finishLogin() {
        refresh(true)
        selectedWork = null
        val pending = pendingFavorite
        pendingFavorite = null
        if (pending != null) {
            change(pending, "favorite", value = true)
            gallery.viewer?.let { viewer -> viewer.accountWork(resolveWork(pending.stableId)) }
        } else gallery.viewer = null
        gallery.panel = ""
        gallery.reload()
    }

    fun collectionPanel(work: WorkSummaryWire) {
        if (account == null) {
            openLogin()
            return
        }
        selectedWork = work
        gallery.panel = "collection-work"
        perform { refresh() }
    }

    fun createCollection(name: String) = perform {
        postApi("collections", document("accountId" to account?.id, "name" to name))
        refresh()
    }

    fun editCollection(id: String, name: String, delete: Boolean = false) = perform {
        postApi(
            "collections",
            document(
                "accountId" to account?.id,
                "id" to id,
                "name" to name,
                "action" to if (delete) "delete" else "rename",
            ),
        )
        refresh()
        gallery.reload()
    }

    fun assign(work: WorkSummaryWire, ids: List<String>) {
        val before = selectedWork
        selectedWork =
            work.copy(
                personal =
                    (work.personal ?: PersonalStateWire()).copy(
                        collections = ids,
                        favorite = ids.isNotEmpty() || work.personal?.favorite == true,
                    )
            )
        perform {
            try {
                change(work, "collections", values = ids)
                refresh()
            } catch (e: Exception) {
                if (
                    selectedWork?.stableId == work.stableId &&
                        selectedWork?.personal?.collections == ids
                )
                    selectedWork = before
                throw e
            }
        }
    }

    fun clearHistory() = perform {
        readJob?.cancel()
        postApi("history/clear", document("accountId" to account?.id))
        refresh()
        confirming = ""
        gallery.reload()
    }

    fun removeHistory(work: WorkSummaryWire) = perform {
        change(work, "read.remove")
        gallery.reload()
    }

    fun record(work: WorkSummaryWire, page: Int) {
        if (account == null || !gallery.recordHistory || !work.stableId.startsWith("/p/")) return
        readJob?.cancel()
        readJob =
            gallery.scope.launch {
                delay(250)
                try {
                    change(work, "read", number = page + 1)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    error = humanError(e.message.orEmpty())
                }
            }
    }

    fun link(left: String, right: String, action: String) = perform {
        val closePanel = gallery.panel == "author-link"
        postApi("author-links", document("left" to left, "right" to right, "action" to action))
        gallery.authorPage?.let {
            gallery.authorPage = readApi<AuthorPageWire>("author-pages/" + it.author.id)
        }
        if (gallery.route.filters.containsKey("linkedAuthor")) gallery.reload()
        if (closePanel && gallery.panel == "author-link") gallery.panel = ""
    }
}
