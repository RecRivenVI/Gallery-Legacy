package gallery

private val inspectionLabels =
    mapOf(
        "filesystem.incomplete" to "目录读取不完整",
        "filesystem.unreadable" to "目录无法读取",
        "filesystem.ignored" to "不支持的文件或链接",
        "media.none" to "没有图片或视频",
        "media.all_hidden" to "没有可看内容",
        "media.unknown_extension" to "其他附件",
        "cover.multiple" to "有多个封面",
        "cover.conflict" to "封面设置不一致",
        "metadata.missing" to "缺少作品信息",
        "metadata.unreadable" to "作品信息无法读取",
        "metadata.invalid" to "作品信息已损坏",
        "metadata.fields" to "作品信息格式有差异",
    )

fun inspectionLabel(id: String) = inspectionLabels[id] ?: "作品需要检查"
