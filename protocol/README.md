# Local protocol v1

协议版本独立于 Catalog Schema、Search 和 Adapter 版本。不提供账户或公网部署模型。

HTTP JSON envelope：`{protocolVersion:1,generationId,data}`；错误为 `{protocolVersion:1,generationId,error:{code,message}}`。不返回内部 stack 或绝对 source/instance 路径。

| Method / path | Request | Data |
|---|---|---|
| GET `/api/v1/health` | 无 | ready、instanceId、schemaVersion、searchVersion |
| GET `/api/v1/status` | 无 | runtime state、loaded/active generation、restartRequired、scan、counts、localControl |
| GET `/api/v1/platforms` | 无 | items: id/family/adapterVersion/聚合规模 |
| GET `/api/v1/generations` | 无 | items: id/state/works/createdAtMs |
| GET `/api/v1/works` | platform、author、q、tag、sort、mediaType、pageSize、page/cursor、g | items、total、page、pageSize、totalPages、cursor、mode |
| GET `/api/v1/authors` | platform、q、sort、pageSize、page/cursor、g | 分页作者 |
| GET `/api/v1/tags` | platform、q、pageSize、page/cursor、g | 分页标签 |
| GET `/api/v1/works/:id` | 可选 g | 作品及实际媒体列表 |
| GET/HEAD `/api/v1/media/:id` | 必填 g；可选单个 bytes Range | 文件字节/媒体 Content-Type；200/206 |
| GET/HEAD `/api/v1/thumbnails/:id` | 必填 g | 缓存 WebP 封面/视频首帧 |
| POST `/api/v1/scans` | JSON `{confirmReadOnly:true}`；仅本机 | 202 accepted；正式全库扫描用例 |

作品：`id, platformId, authorId, sourceWorkId, title, authorName, publishedAtMs, sortAtMs, metadataState, enrichmentState, counts{images,videos,media}, tags[], cover`。作者：`id, platformId, sourceAuthorId, name, handle, workCount, latestAtMs, profileState, cover`。标签：`id, label, workCount`。媒体：`id, fileName, relativePath, type, size, url, thumbnailUrl`；relativePath 仅相对作品目录。

所有实体/源 ID 都以字符串传输，包括大于 JS 安全整数范围的源 ID。缺失源 ID 为 null。没有 metadata 不代表没有作品/媒体。

实体 ID 属于响应 envelope 的 generation，并不是跨 generation 的源 ID。持久化作品/作者链接时同时保留 g；UI 对过时代的实体链接明确提示重新选择，不把旧 ID 静默解释成新实体。作品 flags（adult/aiGenerated）为可空 metadata 补充，不参与实际媒体计数。

`q` 是作品/作者/标签/正文的综合搜索（authors/tags 资源则搜索自身）。`tag` 是**精确标签 label identity**，对应 Catalog 唯一 display value，区分大小写，不做文本综合搜索；它不要求 q 存在，与 q 组合时取交集。

排序/媒体枚举及 Runtime/scan 状态以 `protocol.json` 为准。图片筛选要求存在图片且不存在视频；视频筛选要求存在实际视频；不查看 metadata 声明。pageSize 为 1–200。连续页优先用 opaque cursor，任意页使用 page；不能自行解析/拼接 cursor。cursor 绑定资源、generation、过滤和排序条件，条件变化必须重置。

稳定客户端错误：`INVALID_PARAMETER`、`INVALID_PLATFORM`、`INVALID_NUMBER`、`INVALID_ID`、`QUERY_TOO_LONG`、`INVALID_SORT`、`INVALID_MEDIA_FILTER`、`INVALID_CURSOR`、`CURSOR_CONTEXT_MISMATCH`（400）；`GENERATION_CHANGED`、`SCAN_IN_USE`（409）；`HOST_FORBIDDEN`、`ORIGIN_FORBIDDEN`、`LOCAL_CONTROL_REQUIRED`（403）；`WORK_NOT_FOUND`、`MEDIA_UNAVAILABLE`、`ENDPOINT_NOT_FOUND`（404）；`INVALID_RANGE`（416）；`BODY_TOO_LARGE`（413）。非预期内部错误为 `REQUEST_FAILED`（500），不输出底层错误。

WebSocket `/api/v1/events` 推送 `{protocolVersion:1,type:"status",data}`，data 与只读状态模型一致。scan 使用 `startedAtMs/finishedAtMs/elapsedMs`，不混用 startedAt。事件不包含原始 metadata 或进程 executable path。

Desktop 仅暴露 `galleryHost.openGallery()` 与 `galleryHost.restart()`；后者只作用于宿主自己启动的 Runtime。UI 不使用 Node、SQLite 或扫描 IPC。CLI/host 的私有 stdin 生命周期通道不向普通 renderer 暴露。
