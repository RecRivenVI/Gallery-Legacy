package gallery

import kotlinx.serialization.json.*

val json = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
}
val emptyDocument = JsonObject(emptyMap())

fun JsonElement?.text(default: String = ""): String =
    (this as? JsonPrimitive)?.contentOrNull ?: default

fun document(vararg entries: Pair<String, Any?>): JsonObject =
    JsonObject(entries.associate { it.first to element(it.second) })

fun element(value: Any?): JsonElement =
    when (value) {
        null -> JsonNull
        is JsonElement -> value
        is Boolean -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is Collection<*> -> JsonArray(value.map(::element))
        is Map<*, *> ->
            JsonObject(value.entries.associate { it.key.toString() to element(it.value) })
        else -> JsonPrimitive(value.toString())
    }

fun JsonElement.with(name: String, value: Any?): JsonObject =
    JsonObject((this as JsonObject) + (name to element(value)))

fun grouped(value: Long): String =
    value.toString().reversed().chunked(3).joinToString(",").reversed()

val workSorts =
    linkedMapOf(
        "date_desc" to "最新发布",
        "date_asc" to "最早发布",
        "title_asc" to "标题 A→Z",
        "title_desc" to "标题 Z→A",
        "name_asc" to "文件夹名 A→Z",
        "name_desc" to "文件夹名 Z→A",
        "bookmarks_desc" to "收藏最多",
        "views_desc" to "浏览最多",
        "likes_desc" to "点赞最多",
        "rating_desc" to "我的评分最高",
        "favorite_desc" to "最近收藏",
    )
val workTypeNames =
    mapOf(
        "illust" to "插画",
        "manga" to "漫画",
        "ugoira" to "动图",
        "video" to "视频",
        "article" to "文章",
        "file" to "文件",
        "image" to "图片",
        "photo" to "照片",
        "image_file" to "图片",
        "text_only" to "文章",
    )
val authorSorts =
    linkedMapOf(
        "name_asc" to "名称 A→Z",
        "name_desc" to "名称 Z→A",
        "latest_desc" to "最近更新",
        "latest_asc" to "最早更新",
        "posts_desc" to "作品最多",
        "posts_asc" to "作品最少",
    )

fun changedFields(a: JsonElement?, b: JsonElement?): Int {
    if (a == b) return 0
    if (a is JsonObject && b is JsonObject)
        return (a.keys + b.keys).sumOf { changedFields(a[it], b[it]) }
    if (a is JsonArray && b is JsonArray)
        return (0 until maxOf(a.size, b.size)).sumOf {
            changedFields(a.getOrNull(it), b.getOrNull(it))
        }
    return 1
}

fun humanError(code: String): String =
    when (code.substringBefore(':')) {
        "FILESYSTEM_INCOMPLETE" -> "部分目录未能完整读取，请检查扫描记录后重试"
        "DIRECTORY_CHANGED_DURING_SCAN",
        "METADATA_CHANGED_DURING_READ",
        "METADATA_CHANGED_SINCE_LISTING" -> "文件在扫描时发生变化，请重新扫描"
        "FILESYSTEM_MISSING_EXISTING_WORK",
        "FILESYSTEM_MISSING_EXISTING_MEDIA" -> "文件清单与磁盘不一致，请更新清单后重试"
        "PATH_REPARSE" -> "目录包含链接，请检查平台目录后重试"
        "AUTHOR_DIRECTORY_INVALID" -> "作者目录名不正确，请重新填写"
        "SCAN_ISSUES_WRITE_FAILED" -> "扫描记录无法保存，请检查实例目录空间后重试"
        "EVERYTHING_CONFIRMATION_REQUIRED" -> "文件清单不可用，请选择是否遍历目录"
        "PHYSICAL_ORDER_UNAVAILABLE" -> "无法取得文件物理位置，已按目录顺序读取"
        "EVERYTHING_NATIVE_FALLBACK" -> "文件清单不可用，已按确认遍历目录"
        "METADATA_MALFORMED",
        "METADATA_NON_OBJECT" -> "作品信息格式不正确，修正后重新扫描"
        "METADATA_PARTIAL" -> "部分作品信息无法识别，请检查作品信息文件"
        "METADATA_UNREADABLE" -> "作品信息文件无法读取，请检查文件后重试"
        "SCAN_IN_USE" -> "扫描正在进行，请等待结束"
        "THUMBNAILS_IN_USE" -> "封面任务正在进行，请先暂停或等待结束"
        "ACCESS_SETTING_INVALID" -> "数值不在可用范围，请修改后重试"
        "AUTHOR_SCOPE_UNSUPPORTED" -> "这个平台没有作者扫描，请选择平台扫描"
        "ACCOUNT_CHANGED" -> "登录的账号已改变，请重新登录"
        "COLLECTION_NOT_FOUND" -> "这个收藏夹已不存在，请重新选择"
        "PASSWORD_INCORRECT" -> "密码不正确，请重新输入"
        "ACCOUNT_NAME_REQUIRED" -> "请输入账号名称"
        "COLLECTION_NAME_REQUIRED" -> "请输入收藏夹名称"
        "LOGIN_REQUIRED" -> "请先登录"
        "ACCOUNT_NOT_FOUND" -> "这个账号已不存在，请选择其他账号"
        "SEARCH_CONDITION_REQUIRED" -> "请填写搜索条件"
        "PORT_INVALID" -> "端口需要是 1–65535 之间的数字"
        "LAN_URL_REQUIRED" -> "请在对外地址里填写局域网地址"
        "INSTANCE_SOURCE_OVERLAP" -> "这个目录和程序数据目录重叠了，请换一个目录"
        "SOURCE_ROOT_OVERLAP" -> "这个目录和其他平台的目录重叠了，请换一个目录"
        "CONFIG_REVISION_CHANGED" -> "设置已改变，请重新打开设置"
        "INSTANCE_IN_USE",
        "HOST_BUSY" -> "已有操作正在进行，请稍后重试"
        "SOURCE_UNAVAILABLE",
        "FILE_ROOT_UNAVAILABLE" -> "目录无法读取，请检查目录"
        "WORK_NOT_FOUND",
        "MEDIA_NOT_FOUND",
        "NOT_FOUND" -> "内容已不存在，请返回列表"
        "CONTROL_FORBIDDEN",
        "HOST_CALL_FORBIDDEN",
        "LOCAL_CONTROL_REQUIRED" -> "无法执行操作，请从管理器重试"
        "CONFIG_REQUIRED" -> "尚未选择配置文件，请重新打开管理器"
        "INVALID_INPUT",
        "CURSOR_CONTEXT_MISMATCH" -> "网址里的筛选条件无法识别"
        "GENERATION_CHANGED",
        "CONTENT_CHANGED" -> "图库已更新，请重试"
        "THUMBNAIL_FAILED",
        "MEDIA_UNREADABLE" -> "文件无法读取，请检查文件后重试"
        else -> "服务没有响应，请重试"
    }
