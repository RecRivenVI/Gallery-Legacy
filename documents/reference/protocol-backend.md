# 后端替换的行为合同

本合同冻结 Node 读取／控制的可观察行为，供 Go 差分对照；不是宣称 Go 已替代。排序及状态集合仍由 [protocol.json](../../api/protocol.json)定义，实例字段仍由[配置合同](configuration-instance.md)定义。不增加账号、协议升级或新界面。

## 公共请求和响应

JSON 返回 protocolVersion、generationId，工作库增加 revision；成功为 data，失败为 error.code／message。64 位数据库 ID 一律十进制字符串，计数为数字，缺失字段按现有 DTO 保持 null，不将 null、空串、空数组混换。HTTP 错误不输出异常栈。

| 方法／路由                                                                                     | 数据与边界                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GET /api/v1/health、status、platforms                                                          | 就绪／实例／版本、服务与扫描聚合、固定九平台计数；health 的 ready 保持现有静态检查点语义，不偷换为 live 状态 |
| GET /api/v1/works、authors、tags                                                               | 分页 items／total／page／pageSize／totalPages／cursor／mode；过滤、排序、游标和修订见下节                    |
| GET /api/v1/works/:id                                                                          | 完整作品、自然顺序页与 description；g 不匹配为 GENERATION_CHANGED，缺失为 WORK_NOT_FOUND                     |
| GET /api/v1/resolve、chapters                                                                  | path 为稳定 /p 身份；作者／作品解析及章节自然顺序；不以整数 ID 替代永久身份                                  |
| GET、HEAD /api/v1/media/:id、thumbnails/:id、subtitles/:id                                     | g／k／p 身份校验；跨版本通过稳定物理路径恢复后仍校验 k；工作库每次校验媒体身份                               |
| GET /api/v1/file-roots、files、file-search                                                     | 独立 /f 根与目录、文件名自然排序、分页、过滤、取消和部分目录不可读反馈                                       |
| GET、HEAD /api/v1/file-media、file-thumbnails、file-subtitles                                  | root／path 被限定到已配置根；不接受任意绝对路径或链接越界                                                    |
| POST /api/v1/short-links、/api/shorten                                                         | JSON 不超过 4096 字节，校验目标存在；稳定目标 SHA256 前 32 位为 code，写入实例；旧接口没有 v1 envelope       |
| GET /api/v1/generations                                                                        | 只读检查点摘要；不暴露管理控制                                                                               |
| POST /api/v1/scans                                                                             | 即使来自 loopback 也不授权；保留 READ_ONLY_CONFIRMATION_REQUIRED／LOCAL_CONTROL_REQUIRED 的既有响应          |
| GET、HEAD /api/db-authors、db-posts、db-author-posts、search、db-entry、list、media、thumbnail | Venera 已安装源兼容；p／platformPath／authorId 保持原有稳定路径与旧 DTO                                      |
| GET、HEAD /、/manage、/frontend/\*、/protocol/protocol.json、/venera-source.js、/robots.txt    | 原有页面与本地资源；manage 只投影网页，不能获得本机 IPC 身份；Venera source key 与模板保持                   |
| GET、HEAD /s/:code                                                                             | 已配置或持久化短链，302 到原稳定 hash 目标；缺失 404                                                         |
| OPTIONS                                                                                        | 仅允许 GET／HEAD，允许请求头 Range、cache-time；其他方法 405                                                 |
| WebSocket /api/v1/events                                                                       | 连接立即及每 1500ms 发送 protocolVersion=1、type=status、data；同样校验 Host／Origin，无管理权限             |

所有公共请求保持 Host／Origin 白名单和访问封禁；代理来源不授予控制权。JSON 使用 no-store、nosniff，静态使用 no-cache 与现有 COOP／COEP；所有响应保留 X-Robots-Tag。CORS 仅对配置的跨源请求回显 Origin 并设置 Vary。未知 API 为 ENDPOINT_NOT_FOUND，其他未知资源为 NOT_FOUND。

## 列表与游标

- 仅接受 platform、author、tag、q、sort、mediaType、hideEmpty、pageSize、page、cursor、g、rev，每个参数只能出现一次。非作品列表拒绝 author／tag／mediaType／hideEmpty；tags 拒绝 sort。
- 默认 page=1、pageSize=48，范围分别 1～1000000、1～200；十进制数字可有前导零，不接受科学计数法或负号。ID 为 1～9223372036854775807，最多 19 位，不经浮点数转换。
- q 最多 256 Unicode 码点；tag 非空且最多 512 UTF-16 代码单元。控制字符拒绝，Tab／LF／CR 仍允许。URLSearchParams 的加号、无效百分号、分号及 UTF-8 替换语义保留。
- image 指仅图片且不含视频的作品，video 指含视频；标签精确区分大小写。短搜索完整匹配一／二码点，长搜索使用现有 trigram；不能把关键词作为任意 FTS 表达式执行。
- 所有排序用既有主键与 ID 双重顺序；游标包含 v、查询上下文 SHA256、position、revision。哈希使用 Node JSON.stringify 字节语义，不能因 Go JSON 转义方式不同使已有游标失效。
- g／rev／cursor 语境不符分别按既有 GENERATION_CHANGED、CONTENT_CHANGED、CURSOR_CONTEXT_MISMATCH 返回；静态库不接受 rev。

## 媒体与文件

- 原图、字幕与封面均支持单段 bytes= 起止／后缀 Range；多段、非法、越界为 INVALID_RANGE／416。返回 Accept-Ranges、Content-Length、Content-Range；HEAD 不发送正文。零字节非 Range 响应长度为零。
- 源文件只读；路径、重解析点、物理身份与变化检查不取消。缩略图缓存与临时文件仅写实例；命中状态用 X-Gallery-Thumbnail，失败不回假图。外部 ImageMagick／FFmpeg 有界队列与取消语义保留。
- SVG 使用 sandbox CSP；字幕仅 zh-CN／en-US 的同名 VTT、最多 4MiB。媒体 MIME、私有缓存头与失败码与 Node 对照，不直接用 Go 默认 ServeFile 替代合同。
- cover／preview／content 及 defaultVisible 按文件名和已提取预览标志决定；声明不增加实际媒体，封面停用字段不能丢失作品。

## 存储与恢复

Catalog v4、live v3、Search、Adapter、shape 分别维持现有版本。完整作品事务仍同时维护事实、搜索、计数、revision、签名与高水位；WAL／FULL 不变，只有一个 writer。读取同一响应使用一致事务，不因连接池混出多个修订的数据。

已有工作库必须核对结构、版本、来源绑定、聚合与账本；坏库不能被新空库覆盖。新库可从已验证 READY 恢复检查点初始化；不读 BUILDING、不改写 READY。静态快照、manifest、哈希、SQLite sidecar、active 指针及保留策略的验证，沿用现有恢复合同，不能仅因 Go 主链可启动而删除。

## 本机控制与生命周期

- 命名管道路径仍为 instanceRoot 规范化小写加 /scope 的 SHA256 前 32 位。锁记录包含 kind、instanceId、identity、token；identity 必须同时核对 PID、创建时刻、exe。活进程无法核实仍拒绝，PID 重用不获授权。
- 单请求换行 JSON，4096 字节上限、10 秒服务端空闲期限；请求含 instanceId／token／operation。成功含 ok=true、instanceId、identity、data；失败 ok=false、稳定 code。客户端继续验证回复身份，控制超时 15 秒，不放宽。
- status、manager 注册、scan、stop、访问封禁走认证管道；配置、日志、报告、缓存、检查点、scope、验证与诊断操作仍由固定白名单调用。不能公开成 HTTP 管理接口。
- Electron 只接受本窗口顶层 frame 与精确管理文档（hash 为页内路由），保留白名单；系统目录选择／打开文件／托盘留在 Electron，其他工作调用 Go。
- 启动就绪／停止／重启、管理器退出服务存活、隐藏再打开、取消保留已提交、父控制程序退出的协作取消与陈旧锁恢复都必须差分。切换只在新合成实例中进行，不抢用现有实例。

## 差分边界

可重复定义见[后端差分场景](../../validations/scene-backend_parity/validation.md)。原始 Node 对照使用独立冻结构建；黄金结果、输入库、故障注入与日志在仓库外。必须区分“协议一致”“数据与恢复一致”“宿主／浏览器可用”，未运行的批次不写一致。
