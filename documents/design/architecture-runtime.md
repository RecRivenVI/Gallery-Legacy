# 运行架构

Go 候选承担读取、HTTP／媒体、扫描、恢复及本机任务；由 Electron 管理器拥有，[会话边界](architecture-management.md)独立定义。Node 旧模块保留作迁移对照，在用部署未切换。CanvasKit 是 JavaScript 驱动 WebGL 的界面，不是 Compose 产品。Electron 负责原生窗口、托盘和固定白名单 IPC。

| 位置                                                          | 职责                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| cmd/gallery-scan                                              | 扫描流水线的开发验收入口；不进入产品构建                                                     |
| cmd/gallery-runtime、internal/host、control、task、inspection | 管理器拥有的服务／任务、原生所有权、协作关闭及私有管理，见[会话](architecture-management.md) |
| internal/httpservice、fileview、media、cmd/gallery-read       | 公共读取、文件浏览与媒体；最后一项只作开发验收，[边界](architecture-http_read.md)            |
| internal/library                                              | 标准库遍历、物理身份、路径／句柄／设备核验                                                   |
| internal/metadata                                             | 固定九平台纯解析与 shape                                                                     |
| internal/indexing                                             | 预算、联合准入、增量签名、平台 spool／FIFO                                                   |
| internal/catalog                                              | 完整作品事务、作者权威、FTS／计数／revision／账本                                            |
| internal/protocol、reading、recovery                          | Go 查询／游标、事务读取、READY 校验、组装和发布                                              |
| src/catalog、search、media、server                            | Node 读取服务与媒体，不能导入测试工具                                                        |
| src/instance、runtime、desktop                                | 实例所有权、服务、本机管理和 Electron                                                        |
| src/indexing、publication                                     | 必需的静态恢复／差分残余；替代范围见技术债                                                   |
| bin                                                           | 薄只读 connection／status CLI；启动与任务必须在管理器内执行                                  |
| public/gallery、manager、platform                             | 唯一浏览／四页管理界面和协议／字体／图标模块                                                 |
| api                                                           | 独立版本、平台合同、DDL 与事实校验 SQL；Node／Go 同源                                        |
| test、tools、validations                                      | 合成单元、可复用工具及场景定义；不进入产品服务的反向依赖                                     |

浏览器只访问协议，不读 SQLite；Electron 不重写索引逻辑。Go 候选在一个管理会话内复用流水线与只读 Reader，一个 writer，不能同时运行 Node live writer。静态恢复不隐式发布新日常快照。

新实例示例显式启用 liveUpdates，不自动转换已有静态配置。Go 候选也实现静态扫描与 READY 组装；原 Node 静态链保留作对照，不由新 Go 任务调用。后续删除旧链须完成迁移计划第六步。

剩余替代方向见[决定](adr-6-go_backend.md)，基础组装见[数据集](architecture-dataset.md)。Go Reader 的一个公共响应由同一个只读事务提供，不跨连接拼接修订；恢复校验只读快照，不查询源内容。格式与边界对照见[行为合同](../reference/protocol-backend.md)。Tauri／WasmJS 目前仅有[原评估](../research/survey-tauri_wasmjs.md)与[范围补充](../research/survey-wasmjs_stack_scope.md)，不是现行产品实现；当前方向按[adr-7](adr-7-wasmjs_scope.md)，不迁 Miuix 组件或视觉。

入口和构建见[工作流](../development/workflow-development.md)，数据流见[扫描](flow-scanning.md)。来源存在性、声明／actual media 分离、完整性传播与取消保留提交不因语言或目录变化而改变。
