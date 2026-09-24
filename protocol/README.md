# Local protocol v1

协议版本独立于 Catalog Schema、Search 和 Adapter 版本。明确配置的公网读取和本机管理是两条不同的授权边界，不提供账户体系。

HTTP JSON envelope：`{protocolVersion:1,generationId,data}`；错误为 `{protocolVersion:1,generationId,error:{code,message}}`。不返回内部 stack 或绝对 source/instance 路径。

实时模式增加 `revision`；此时 generationId 为稳定 live epoch，检查点 ID 从 status.live.baseGenerationId 获取。Catalog/Search/响应修订在同一读事务内确定。列表可传 `rev`，旧 revision/cursor 返回 `CONTENT_CHANGED` (409)，不能混页；媒体通过 epoch 和物理身份 k 保持跨批有效。普通静态模式不要求这些参数。WS status.live 推送修订，不携带作品标题/正文。

| Method / path | Request | Data |
|---|---|---|
| GET `/api/v1/health` | 无 | ready、instanceId、schemaVersion、searchVersion |
| GET `/api/v1/status` | 无 | runtime state、loaded/active generation、restartRequired、scan、counts、localControl |
| GET `/api/v1/platforms` | 无 | items: id/family/adapterVersion/聚合规模 |
| GET `/api/v1/generations` | 无 | items: id/state/works/createdAtMs |
| GET `/api/v1/works` | platform、author、q、tag、sort、mediaType、hideEmpty、pageSize、page/cursor、g | items、total、page、pageSize、totalPages、cursor、mode |
| GET `/api/v1/authors` | platform、q、sort、pageSize、page/cursor、g | 分页作者 |
| GET `/api/v1/tags` | platform、q、pageSize、page/cursor、g | 分页标签 |
| GET `/api/v1/works/:id` | 可选 g | 作品及实际媒体列表 |
| GET/HEAD `/api/v1/media/:id` | 必填 g；可选单个 bytes Range | 文件字节/媒体 Content-Type；200/206 |
| GET/HEAD `/api/v1/thumbnails/:id` | 必填 g | 缓存 WebP 封面/视频首帧 |
| GET `/api/v1/resolve` | path：稳定物理路径 | kind、item；跨 generation 解析作品/作者 |
| GET `/api/v1/chapters` | path：稳定物理路径 | items：自然页序的作品/章节及 stableId |
| GET `/api/v1/file-roots` | 无 | items：显式文件浏览根 id/name，不含物理根路径 |
| GET `/api/v1/files` | root、相对 path、page/pageSize、mediaType、order | 当前目录及媒体，数字自然顺序，不递归建立索引 |
| GET `/api/v1/file-search` | root、相对 path、q、page/pageSize、mediaType、order | 名称搜索；total、items、complete、truncated、diagnostics |
| GET/HEAD `/api/v1/file-media`、`/api/v1/file-thumbnails` | root、相对 path、可选 Range | 复用正式媒体响应与缩略图 |
| GET/HEAD `/api/v1/subtitles/:mediaId` | g、lang=zh-CN/en-US | 已授权视频旁的同名 VTT；不是实际媒体 |
| GET/HEAD `/api/v1/file-subtitles` | root、path（视频）、lang | 文件浏览根内视频的 VTT；同样执行平台排除与路径校验 |
| POST `/api/v1/short-links`（兼容 `/api/shorten`） | JSON `{path,media?}`，path 是稳定 /p 或 /f 路径 | code、相对 url、target；无 generation 绑定 |
| POST `/api/v1/scans` | 已退休的 HTTP 管理调用 | 403 LOCAL_CONTROL_REQUIRED；请由本机宿主使用私有管道 |

作品：`id, platformId, authorId, sourceWorkId, title, authorName, publishedAtMs, sortAtMs, metadataState, enrichmentState, counts{images,videos,media}, tags[], cover`。作者：`id, platformId, sourceAuthorId, name, handle, workCount, latestAtMs, profileState, cover`。标签：`id, label, workCount`。媒体：`id, fileName, relativePath, type, size, url, thumbnailUrl`；relativePath 仅相对作品目录。

所有实体/源 ID 都以字符串传输，包括大于 JS 安全整数范围的源 ID。缺失源 ID 为 null。没有 metadata 不代表没有作品/媒体。

数字实体 ID 属于响应 envelope 的 generation，并不是永久身份。作品/作者新增 `stableId=/p/<URL-encoded platform>/<original relative path>`，用于收藏及跨代解析；无上游 ID 时也稳定成立。旧数字链接必须同时保留 g，不得静默解析到新实体。媒体 DTO 的 `role=content|cover|preview`、`defaultVisible` 只控制默认展示；全部媒体仍保留、计数不变。页序在读取时自然排序，不修改 Catalog 物理路径或观察排序。

作品可包含 `sourceUrl`（null 或安全 HTTP(S) 来源链接），只来自明确 metadata 证据，不以站点模板猜测。Adapter 将它保存在 supplementary `source_link` plain text fact，对应 Schema v4 的 work_text_sources，不是正文／媒体声明。旧 generation 未提取此事实时返回 null，刷新数据后补齐。X/微博使用有时区的 metadata 时间生成 ISO 日期标题；只有目录时间时保留目录日期文本，不臆造时区。

Web 新复制链接基于 stableId 创建持久短码，已有配置短码仍可读取。动态短码只写本机 state，最多 10000 条，目标须为当前可解析的本图库作品或文件路径；拒绝外站目标、控制字符、越界和不存在的媒体。路径改名/删除后无法继续解析是物理身份的限制，不静默转向其他作品。

文件搜索只递归当前显式 root/path，按 NFKC/大小写不敏感名称匹配，默认最多检查 50000 条、返回 5000 个候选、深度 64。达到上限或读取失败时 complete=false，UI 不得宣称完整无结果；取消请求停止遍历。不跟随链接，不搜索 metadata 正文、不扫描实际媒体内容；已注册平台子树在列表、搜索、媒体/字幕入口全部排除。

字幕只支持已授权视频同目录的 `.zh-CN.vtt` / `.en-US.vtt`，上限 4 MiB，Content-Type 为 text/vtt。不能借字幕接口读取任意 JSON/metadata。bmp/ico/tif/tiff/avi/ogv 保留正确 MIME，但能否解码仍取决于客户端。

`q` 是作品/作者/标签/正文的综合搜索（authors/tags 资源则搜索自身）。`tag` 是**精确标签 label identity**，对应 Catalog 唯一 display value，区分大小写，不做文本综合搜索；它不要求 q 存在，与 q 组合时取交集。

`hideEmpty=1` 在计数和分页前隐藏没有任何 `defaultVisible` 媒体的作品，复用详情页的封面／预览展示规则；`0` 或省略则不过滤。仅适用于作品列表，与搜索、标签及媒体筛选取交集，且绑定 cursor。Web 设置“隐藏无可阅览媒体作品”默认开启并在本机浏览器保存，也可通过 URL 的 `hideEmpty=0|1` 分享查询状态。关闭即可重新查看全部物理作品；直接详情、Catalog 实际媒体数量及作者／标签物理计数不变。不要求重建 Catalog/Search。

排序/媒体枚举及 Runtime/scan 状态以 `protocol.json` 为准。图片筛选要求存在图片且不存在视频；视频筛选要求存在实际视频；不查看 metadata 声明。pageSize 为 1–200。连续页优先用 opaque cursor，任意页使用 page；不能自行解析/拼接 cursor。cursor 绑定资源、generation、过滤和排序条件，条件变化必须重置。

稳定客户端错误：`INVALID_PARAMETER`、`INVALID_PLATFORM`、`INVALID_NUMBER`、`INVALID_ID`、`QUERY_TOO_LONG`、`INVALID_SORT`、`INVALID_MEDIA_FILTER`、`INVALID_CURSOR`、`CURSOR_CONTEXT_MISMATCH`（400）；`GENERATION_CHANGED`、`SCAN_IN_USE`（409）；`HOST_FORBIDDEN`、`ORIGIN_FORBIDDEN`、`LOCAL_CONTROL_REQUIRED`（403）；`WORK_NOT_FOUND`、`MEDIA_UNAVAILABLE`、`ENDPOINT_NOT_FOUND`（404）；`INVALID_RANGE`（416）；`BODY_TOO_LARGE`（413）。非预期内部错误为 `REQUEST_FAILED`（500），不输出底层错误。

WebSocket `/api/v1/events` 推送 `{protocolVersion:1,type:"status",data}`，data 与只读状态模型一致。scan 使用 `startedAtMs/finishedAtMs/elapsedMs`，不混用 startedAt。事件不包含原始 metadata 或进程 executable path。

scan 还包含 mode/effectiveMode 和 changes 聚合；公开 scope 仅包含平台、是否作者范围及版本失效平台，不包含作者目录名。本机 Manager 可查看完整私有 scope。metadataReparsed 与 worksRebuilt 分开：复用数据库记录不等于没有读取/解析 metadata。

本机 `scan.start` 接受 `platformIds` 非空、无重复的固定平台数组；不与旧 `platformId` 同时提供。省略表示全部，空数组拒绝，作者范围要求唯一平台。日常 UI 直接调用增量，并保持底层只读确认字段；公网仍无管理权限。

Runtime `libraryReady=false` 表示服务在线但尚无发布数据，不是数据库损坏的 fallback。静态新版本完成后台验证后自动接入；`applyingGeneration`、`applyError` 区分接入中与失败。媒体 URL 可带稳定物理路径 `p` 与身份摘要 `k`，跨代必须两者验证匹配，绝不把旧整数 ID 当作新文件。查询游标仍绑定版本，用户地址由前端做过期恢复。

扫描的 `stage/stageStartedAtMs/stageDurationsMs` 记录 preparing/catalog/search/validation/publication；`search` 包含全文重用/更新/删除数与格式升级原因。阶段时长是顺序 wall time，不把各并行线程累计 CPU 时间混加。

Desktop 暴露有限的 `galleryHost.status/openGallery/start/stop/restart/scan`；仅信任随包本地 Manager 页面，不对远程页面开放。宿主通过正式 CLI 调用带 instanceId、随机 owner token 和已核验进程 identity 的本机命名管道，可管理同实例的独立 Runtime。UI 不使用 Node/SQLite，不传任意文件或执行命令。HTTP `localControl` 永远为 false；本机宿主验证连接后才给 Manager 管理能力。

本机另有 `galleryHost.admin(operation,input)` 固定操作白名单、`pickDirectory()`、`openDirectory(kind)`（只允许实例/config/logs/reports/cache）。配置、版本、日志、存储与诊断用例不经公网 HTTP。配置保存要求 revision 和确认，冲突为 `CONFIG_REVISION_CHANGED`；运行中清理拒绝为 `STOP_RUNTIME_BEFORE_CLEANUP`。扫描取消为 `scan.cancel`，安全停止结果 `CANCELLED`；发布提交中拒绝为 `SCAN_COMMIT_IN_PROGRESS`。这些版本含义独立于 Catalog v4 和 Adapter。

`/venera-source.js` 保留生产 `local_gallery` key，新源使用 v1 API 和稳定物理路径。升级前已安装源所需的有限 GET 路由（`/api/db-entry`、`/api/list`、`/api/db-authors`、`/api/db-posts`、`/api/db-author-posts`、`/api/search`、`/api/media`、`/api/thumbnail`）仅将旧请求翻译到当前 Catalog/Search/媒体服务，没有 Old Catalog/Scanner fallback。收藏的 comicId/epId 沿用旧物理路径。`/s/<code>` 只读取实例私有相对 URL 映射，不允许外站跳转。
