# Go 管理会话

Go 候选由 Electron 管理器拥有，不再以独立服务启动。生命周期按 [adr-8](adr-8-manager_lifecycle.md)，协议按[本机合同](../reference/protocol-backend.md)。旧 Node 源码和仓外冻结构建保留到迁移计划第六步，不进入本轮 Go 写入链。

## 职责

| 模块                            | 职责                                                                    |
| ------------------------------- | ----------------------------------------------------------------------- |
| cmd/gallery-runtime             | 显式配置与组装；外部只提供 connection／status，启动命令拒绝             |
| internal/host                   | 管理器会话、HTTP 启停、任务调度、配置与访问管理、恢复切换、日志和清理   |
| internal/control                | 原生进程身份、实例／scope 排它、命名管道令牌与回复归属核验              |
| internal/task                   | 全量／增量与范围选择、协作取消、运行状态、报告和静态检查点组装          |
| internal/inspection             | 私有检查结果、过滤／导出、只读范围抽查；不修改 Catalog                  |
| internal/indexing、catalog      | 既有有界准备、单 writer、完整作品事务、WAL/FULL、Search／revision／签名 |
| src/desktop/backend.js          | 管理器拥有的 Go 子进程和请求／回复关联；不启动脱离会话的服务            |
| src/desktop/main.js、preload.js | 原窗口、托盘、精确文档／主 frame／操作白名单及系统对话框                |

## 启动与关闭

1. Electron 用显式配置取得实例信息，设置独立用户数据目录并获取应用单实例锁；随后创建 Go 会话。
2. Go 核验直接父进程完整身份和继承的输入管道，获取本实例 manager 排它租约；管理命令只在该会话接收。管理器状态同样从该会话读取，不用公开 HTTP 状态代替本机身份。
3. 开始服务时获取 runtime 与维护租约，验证 READY／工作库后开放 HTTP；扫描任务直接复用 Go 流水线，另取 scan 与原生 writer 租约，不能同时写同一实例。
4. 输入通道关闭或核验到管理器消失时取消任务并等待结束；扫描提交中保留完整事务，再排空 HTTP、关闭队列／数据库并释放租约。不强杀其他实例或按进程名结束程序。
5. 静态扫描只在完整校验后发布 READY，处理器排它切换数据集；live 工作库不被运行时替换。live 恢复基线变更要求重启，失败切换保留旧数据集并按既有间隔等待。

关闭窗口隐藏与真正退出仍是不同操作。产品启动方式见[管理指南](../usage/guide-manager.md)；独立 gallery-read／gallery-scan 命令保留为开发验收工具，不是产品后台入口，也不允许用它接管在用实例。

## 验证边界

合成场景见[管理会话验证](../../validations/scene-management/validation.md)。数据、认证与失败码以冻结 Node 为对照；101 号明确修改的独立存活行为不要求一致。机器真实输入、托盘点击、真机、性能与生产部署不是本组自动证明。
