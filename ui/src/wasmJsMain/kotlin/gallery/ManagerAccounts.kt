package gallery

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.unit.*

@Composable
fun ManagerAccounts(state: ManagerState) {
    var reset by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { state.loadAccounts() }
    Rule()
    Label("账号", size = 16, bold = true)
    if (state.accounts.isEmpty()) Label("还没有账号", color = LocalPalette.current.fg2)
    state.accounts.forEach { account ->
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AccountAvatar(account.name, account.avatar, 24)
            Label(account.name, Modifier.weight(1f))
            Action("重设密码", enabled = !state.busy) {
                reset = account.id
                password = ""
                deleting = ""
            }
            Action("删除", enabled = !state.busy) {
                deleting = account.id
                reset = ""
            }
        }
        if (reset == account.id) {
            Field(password, { password = it }, "新密码", Modifier.fillMaxWidth(), password = true)
            Row {
                Action("取消") { reset = "" }
                Action(if (password.isEmpty()) "移除密码" else "保存密码", enabled = !state.busy) {
                    state.accountChange("accounts.reset", account.id, password)
                    reset = ""
                }
            }
        }
        if (deleting == account.id) {
            Label("删除这个账号和它的个人数据？", color = LocalPalette.current.fg2)
            Row {
                Action("取消") { deleting = "" }
                Action("删除", enabled = !state.busy) {
                    state.accountChange("accounts.delete", account.id)
                    deleting = ""
                }
            }
        }
    }
}
