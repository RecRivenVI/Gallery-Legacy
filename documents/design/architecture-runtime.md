# 运行架构

Go 承担日常 live 扫描；Node 提供尚未替代的读取、HTTP／媒体、schema／恢复和本机控制。CanvasKit 是 JavaScript 驱动 WebGL 的界面，不是 Compose 产品。Electron 只负责原生窗口、托盘和 IPC。

| 位置                               | 职责                                                     |
| ---------------------------------- | -------------------------------------------------------- |
| cmd/gallery-scan                   | Go 薄入口，配置、取消和流式聚合遥测                      |
| internal/library                   | 标准库遍历、物理身份、路径／句柄／设备核验               |
| internal/metadata                  | 固定九平台纯解析与 shape                                 |
| internal/indexing                  | 预算、联合准入、增量签名、平台 spool／FIFO               |
| internal/catalog                   | 完整作品事务、作者权威、FTS／计数／revision／账本        |
| src/catalog、search、media、server | Node 读取服务与媒体，不能导入测试工具                    |
| src/instance、runtime、desktop     | 实例所有权、服务、本机管理和 Electron                    |
| src/indexing、publication          | 必需的静态恢复／差分残余；替代范围见技术债               |
| bin                                | Node CLI；日常 live 扫描路由到 Go                        |
| public/gallery、manager、platform  | 唯一浏览／四页管理界面和协议／字体／图标模块             |
| api                                | 独立版本的跨实现协议                                     |
| test、tools、validations           | 合成单元、可复用工具及场景定义；不进入产品服务的反向依赖 |

浏览器只访问协议，不读 SQLite；Electron 不重写索引逻辑。Go scanner 与 Node Reader 分进程、共用受控工作库，一个 writer，不能同时运行 Node live writer。静态恢复不隐式发布新日常快照。

新实例示例显式启用 liveUpdates；本轮不偷偷转换已有静态配置。显式关闭 liveUpdates 的静态构建／恢复仍走 Node，不能将这种配置下的扫描称作 Go。后续删除静态链所需合同见技术债。

入口和构建见[工作流](../development/workflow-development.md)，数据流见[扫描](flow-scanning.md)。来源存在性、声明／actual media 分离、完整性传播与取消保留提交不因语言或目录变化而改变。
