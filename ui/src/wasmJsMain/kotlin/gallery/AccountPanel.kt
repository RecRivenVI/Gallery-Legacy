package gallery

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.*

@Composable
fun AccountPanel(state: GalleryState) {
    val p = LocalPalette.current
    val people = state.people
    val current = people.account
    var selected by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    when (people.profilePage) {
        "new" -> {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconAction("left", "返回登录") { people.profilePage = "list" }
                Label("新建账号", size = 16, bold = true)
            }
            Field(name, { name = it }, "名称", Modifier.fillMaxWidth())
            Field(
                password,
                { password = it },
                "密码（可选）",
                Modifier.fillMaxWidth(),
                password = true,
                onEnter = { if (name.isNotBlank()) people.create(name, password) },
            )
            Action("创建", primary = true, enabled = name.isNotBlank() && !people.busy) {
                people.create(name, password)
            }
        }
        "settings" ->
            if (current != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconAction("left", "返回账号") { people.profilePage = "list" }
                    Label("账号设置", size = 16, bold = true)
                }
                AccountAvatar(current.name, people.draftAvatar, 48)
                Action("更换头像") { people.profilePage = "avatar" }
                Field(people.draftName, { people.draftName = it }, "名称", Modifier.fillMaxWidth())
                Field(
                    people.draftPassword,
                    { people.draftPassword = it },
                    "新密码",
                    Modifier.fillMaxWidth(),
                    password = true,
                )
                Action(
                    "保存",
                    primary = true,
                    enabled = !people.busy && people.draftName.isNotBlank(),
                ) {
                    people.update(
                        people.draftName,
                        people.draftAvatar,
                        people.draftPassword.takeIf { it.isNotEmpty() },
                    )
                }
                if (current.hasPassword)
                    Action("移除密码", enabled = !people.busy) {
                        people.update(people.draftName, people.draftAvatar, "")
                    }
                Rule()
                if (people.confirming == "account") {
                    Label("删除账号和它的个人数据？", color = p.fg2)
                    Row {
                        Action("取消") { people.confirming = "" }
                        Action("删除", enabled = !people.busy) {
                            people.update(current.name, current.avatar, null, delete = true)
                        }
                    }
                } else Action("删除账号") { people.confirming = "account" }
            }
        "avatar" -> {
            Action("使用名称首字") {
                people.draftAvatar = ""
                people.profilePage = "settings"
            }
            WorkImagePicker(
                state,
                "选择头像",
                people.draftAvatar,
                "返回账号设置",
                { people.profilePage = "settings" },
            ) { _, media ->
                people.draftAvatar = media.thumbnailUrl
                people.profilePage = "settings"
            }
        }
        else -> {
            Label(if (current == null) "登录" else "账号", size = 16, bold = true)
            people.accounts
                .reversed()
                .sortedByDescending { it.id == current?.id }
                .forEach { account ->
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        AccountAvatar(account.name, account.avatar, 20)
                        Action(
                            account.name + if (account.id == current?.id) " ✓" else "",
                            modifier = Modifier.weight(1f),
                            enabled = !people.busy,
                        ) {
                            password = ""
                            if (account.hasPassword) selected = account.id
                            else people.login(account.id, "")
                        }
                    }
                    if (selected == account.id) {
                        Field(
                            password,
                            { password = it },
                            "密码",
                            Modifier.fillMaxWidth(),
                            password = true,
                            onEnter = { people.login(account.id, password) },
                        )
                        Action("登录", primary = true, enabled = !people.busy) {
                            people.login(account.id, password)
                        }
                    }
                }
            Rule()
            Action("新建账号", enabled = !people.busy) {
                name = ""
                password = ""
                people.profilePage = "new"
            }
            if (current != null) {
                Action("账号设置") {
                    people.draftName = current.name
                    people.draftAvatar = current.avatar
                    people.draftPassword = ""
                    people.confirming = ""
                    people.profilePage = "settings"
                }
                Action("退出登录", enabled = !people.busy) { people.logout() }
            }
        }
    }
    if (people.error.isNotEmpty()) Label(people.error, color = p.error)
}

@Composable
fun AccountAvatar(name: String, url: String, size: Int) {
    var failed by remember(url) { mutableStateOf(false) }
    Box(
        Modifier.size(size.dp)
            .clip(GalleryShape((size / 2).dp))
            .background(LocalPalette.current.tint),
        contentAlignment = Alignment.Center,
    ) {
        if (url.isNotEmpty() && !failed)
            MediaImage(
                url,
                Modifier.fillMaxSize(),
                placeholder = false,
                onError = { failed = true },
            )
        else Label(initial(name), size = (size / 2).coerceAtLeast(12), bold = true)
    }
}

@Composable
fun CollectionAssignment(state: GalleryState) {
    val people = state.people
    val work = people.selectedWork ?: return
    var name by remember { mutableStateOf("") }
    Label("添加到收藏夹", size = 16, bold = true)
    people.collections.forEach { collection ->
        Toggle(
            collection.name,
            collection.id in work.personal?.collections.orEmpty(),
        ) { checked ->
            val ids = work.personal?.collections.orEmpty()
            people.assign(work, if (checked) ids + collection.id else ids - collection.id)
        }
    }
    Rule()
    Field(
        name,
        { name = it },
        "新建收藏夹",
        Modifier.fillMaxWidth(),
        onEnter = {
            if (name.isNotBlank()) {
                people.createCollection(name)
                name = ""
            }
        },
    )
    Action("创建", enabled = name.isNotBlank() && !people.busy) {
        people.createCollection(name)
        name = ""
    }
    if (people.error.isNotEmpty()) Label(people.error, color = LocalPalette.current.error)
}

@Composable
fun CollectionEditor(state: GalleryState) {
    val people = state.people
    val collection = people.selectedCollection ?: return
    var name by remember(collection.id) { mutableStateOf(collection.name) }
    Label("收藏夹", size = 16, bold = true)
    Field(name, { name = it }, "收藏夹名称", Modifier.fillMaxWidth())
    Action("保存", primary = true, enabled = name.isNotBlank() && !people.busy) {
        people.editCollection(collection.id, name)
        state.panel = ""
    }
    if (people.confirming == "collection") {
        Label("删除收藏夹？作品仍保留在全部收藏中。", color = LocalPalette.current.fg2)
        Row {
            Action("取消") { people.confirming = "" }
            Action("删除", enabled = !people.busy) {
                people.editCollection(collection.id, name, true)
                state.panel = ""
            }
        }
    } else Action("删除收藏夹") { people.confirming = "collection" }
}
