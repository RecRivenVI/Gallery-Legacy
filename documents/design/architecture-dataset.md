# Go 读取组装

配置、恢复选择与事务读取已组装为 `internal/dataset`，不包含 HTTP 宿主，也没有切换默认入口。[既有运行架构](architecture-runtime.md)仍描述在用 Node／Electron 边界。

## 入口与职责

| 入口                                    | 职责                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `instance.Load(file)`                   | 从显式文件读取配置；默认值与字段目录来自 [schema](../../api/runtime-config.schema.json)，不寻找真实配置 |
| `dataset.Load(ctx, file)`               | 加载配置和活动 READY 指针；缺少指针表示空静态实例，损坏指针不降级为空                                   |
| `dataset.Open(ctx, config, checkpoint)` | 组装已验证检查点与已准备工作库；校验来源、格式和工作库基础版本绑定                                      |
| `Dataset.State`、`Dataset.Page`         | 同一只读事务返回计数、修订和 DTO；空实例仍校验查询参数                                                  |
| `Dataset.Reader.Snapshot`               | 供详细读取复用既有 Reader；空实例无数据库连接                                                           |
| `Dataset.Close`                         | 关闭连接；关闭后不再提供数据库查询                                                                      |

只读入口不创建、升级、替换数据库，也不争抢 writer。显式新建仍使用 `catalog.CreateLiveFrom`；已有库升级、所有者排他及进程控制留待生命周期批次，不在此处增加临时桥接或第二个 writer。

## 配置边界

Node 与 Go 共用 API 目录的配置 schema。Go 与冻结 Node 对照路径隔离、九平台绑定、网络 authority／origin、短链、保留参数与失败码；不宣称完整 WHATWG URL 实现或已覆盖所有畸形类型组合。

Everything 已按用户决定退出产品范围。Go 拒绝非空旧 `everything` 字段；旧 Node 尚保留的空属性不参与 DTO 对照，不恢复清单集成。该差异不是新的用户确认。

## 独立验收

按[配置与读取组装场景](../../validations/scene-dataset/validation.md)对照冻结 Node。它证明基础读取组装，不是 Go HTTP、媒体、生命周期或用户浏览验收。新建库仍保持 WAL/FULL；请求侧只读，既有扫描流程与持久化参数未改。
