# 本机与读取协议

公共读取、本机管理及 Go 子进程是三条不同边界。协议、Catalog、Search、Adapter 与 shape 各自版本不能互换。

Node 替代的精确边界与差分范围见[后端行为合同](protocol-backend.md)。

## 公共 HTTP

[api/protocol.json](../../api/protocol.json)定义排序、筛选及状态集合；实际路由在[src/server/http.js](../../src/server/http.js)。手工路由与 DTO 尚未由契约生成，列入[技术债](../project/debt-runtime.md)。

JSON envelope 为 `{protocolVersion,generationId,data}`，错误含 `error:{code,message}`，不输出内部栈或源绝对路径。实时读取增加 revision；列表修订不符返回 CONTENT_CHANGED，稳定媒体链接通过物理身份解析。

| 路由组                                                                      | 用途                                         |
| --------------------------------------------------------------------------- | -------------------------------------------- |
| health、status、platforms                                                   | 服务与聚合状态、九平台                       |
| works、authors、tags、chapters、resolve                                     | 列表、详情、章节与稳定路径解析               |
| media、thumbnails、subtitles                                                | 实际文件、缓存封面和字幕；媒体支持单段 Range |
| file-roots、files、file-search、file-media、file-thumbnails、file-subtitles | 独立只读文件浏览                             |
| /p、/f、短链、Venera                                                        | 既有收藏和公开路径                           |
| /api/v1/events                                                              | 只读 WebSocket 修订／状态；不传私人作品正文  |

## 本机管理

[src/runtime/management.js](../../src/runtime/management.js)通过实例认证管道执行管理；[Electron preload](../../src/desktop/preload.js)仅暴露所需操作。普通浏览页面不能获得管理身份。测试 Manager 的 loopback／CSRF 工具不能用于控制生产。

## Go 扫描

[src/indexing/runner.cjs](../../src/indexing/runner.cjs)负责实例所有权、已验证工作库初始化、启动 Go 与取消请求，配置写入实例 state；Go 只输出逐行聚合状态，标准输入 `cancel`请求取消。COMPLETE 映射为 Manager READY，不能将失败退出当成功。

Go 接受完整九平台绑定，可限定一次扫描的所选平台／作者。历史配置字段 `testOnly`仍是子进程握手要求，不代表正式应用只在离线运行；删除这一历史标识需另行协调契约。扫描器不提供 HTTP。

控制管道关闭同样请求协作取消，避免控制器消失后留下孤立扫描。已确认事务保留，Go 自身的独占 lease 仍阻止第二个 writer；不会因父进程退出而放宽数据库或来源检查。
