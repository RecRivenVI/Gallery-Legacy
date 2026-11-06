# 本机与读取协议

公共读取、本机管理及 Go 子进程是三条不同边界。协议、Catalog、Search、Adapter 与 shape 各自版本不能互换。

Node 替代的精确边界与差分范围见[后端行为合同](protocol-backend.md)。

## 公共 HTTP

[api/protocol.json](../../api/protocol.json)定义排序、筛选及状态集合；实际路由在[internal/httpservice](../../internal/httpservice)。手工路由与 DTO 尚未由契约生成，列入[技术债](../project/debt-runtime.md)。

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

[Go 管理会话](../../internal/host/session.go)通过继承管道接收 Tauri 的固定命令；[原生桥](../../src-tauri/src/main.rs)校验窗口、文档和白名单。实例控制仍核对 PID、创建时间、exe、实例及令牌，公开浏览器没有本机身份。

## Go 扫描

[Go 管理会话](../../internal/host/session.go)拥有服务与任务，扫描直接使用既有遍历、准备和唯一 writer；不启动 Node runner。全量／增量可限定平台或作者。

Tauri 真正退出关闭继承输入，Go 协作取消、保留已提交事务并等待服务及扫描结束。关闭窗口只是隐藏，不放弃实例所有权。不把进程存在当成任务仍运行，也不把失败当成功。
