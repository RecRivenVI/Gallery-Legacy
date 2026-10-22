# 实例配置

实例格式见 [schema](../../api/runtime-config.schema.json)，公开例子见 [example](../../src/config/runtime.example.json)。本机真实值放仓库外实例，路径工具设置用被忽略的本地文件，不提交。

| 字段                                                                                    | 作用／范围                                                                             |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| instanceRoot                                                                            | 独立可写实例根；与所有真实来源互不包含                                                 |
| sources                                                                                 | 固定九平台绝对物理根；不能增加平台／改变 Adapter 身份，根之间不重叠                    |
| liveUpdates                                                                             | 日常 Go 扫描使用工作库；静态恢复合同另见恢复文档                                       |
| mode／listenAddress／port                                                               | local／可信 LAN／显式公开读部署；管理能力不由地址推定                                  |
| allowedHosts／allowedOrigins／publicUrl                                                 | 读取／管理使用精确 authority／origin；公共字体资源允许跨来源加载，不授予 API／管理能力 |
| fileBrowserRoots                                                                        | 独立只读文件范围，不进入平台 Catalog，不开放任意路径                                   |
| shortLinks                                                                              | 本站相对目标，不能外站重定向                                                           |
| retention                                                                               | 静态恢复数据保留；不能清理在用／未确认身份的数据                                       |
| generationsRoot／cacheRoot／logsRoot／tempRoot／stateRoot／reportsRoot／desktopDataRoot | 都在实例内，按职责隔离，不与来源重叠                                                   |

Go 扫描配置限定实例工作库路径，固定 sources 与 Node 绑定一致；workers／slowDeviceWorkers／batchSize／metadataLimit 的默认和边界在 [Go Config](../../internal/library/config.go)。无 Everything provider，不用旧清单配置作为回退。处理签名只随成功事务保存。

Go 读取组装使用相同实例 schema，见[读取组装](../design/architecture-dataset.md)。默认服务尚未切换；非空旧 `everything` 字段在新 Go 配置入口返回 CONFIG_FIELD_UNSUPPORTED，而不是静默启用或忽略。

改变源根或恢复数据库前须确认无其他所有者；不能让已有记录静默指向新的真实文件。本机路径／字体／工具资源通过本地配置或显式参数传入，不在源码写死用户目录。
