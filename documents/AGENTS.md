# 项目规范

本文件补充根目录[仓库规范](../AGENTS.md)，不能放宽它。

## 项目信息

| 项                 | 值                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| 产品显示名         | 画廊（Gallery）                                                                                                 |
| 一句话             | 将固定九平台的本地只读作品整理成可浏览、搜索和阅读的个人画廊                                                    |
| 核心路径           | 选择平台更新图库 → 查看进度 → 浏览作品／作者 → 打开图片、动图或视频                                             |
| 技术栈附则         | Go 运行会话／扫描／读取／媒体、CanvasKit Web、Electron 管理宿主；旧 Node 后端待退役                             |
| 支持的平台         | 当前实际验证目标 Windows x64；其他系统未验收                                                                    |
| 标识               | npm 见 package.json；Go 模块见 go.mod；保持现有实例身份和 Venera source key                                     |
| 设计语言与组件库   | 用户冻结设计及最新明确决定；CanvasKit 自绘、原生输入／表单、Fluent System Icons；不是 Fluent UI 组件或 CMP 产品 |
| 测试框架           | Go testing、node:test、Playwright；浏览器只用合成数据                                                           |
| 文档主语言         | 简体中文                                                                                                        |
| 首页语言           | 简体中文                                                                                                        |
| 上游               | 无；独立 Gallery 仓库不是本项目上游或已迁入目标                                                                 |
| 常用测试设备或环境 | 本机 Windows x64；自动实例默认 1920×1080、静音；响应式测试按其目标尺寸运行                                      |

## 技术栈

| 组成             | 版本                                       | 唯一来源                                            |
| ---------------- | ------------------------------------------ | --------------------------------------------------- |
| Go 与 Go 依赖    | 使用 go/toolchain 与 require 声明          | go.mod、go.sum                                      |
| Node 与 npm 依赖 | 使用 engines.node 与锁定依赖               | package.json、package-lock.json                     |
| 产品名／版本     | 沿用 npm 产品包；Go 可执行使用构建注入版本 | package.json；Go 正式版本按标签注入，不另设源码常量 |
| 外部媒体程序     | 要求见依赖说明                             | reference/dependency-runtime.md                     |

## 补充规则

- **X-01** 九平台固定为 pixiv、pixivFANBOX、Gank、Fantia、Patreon、Pawchive、X、微博、Venera；只读文件浏览独立，不增加动态平台注册、metadata DSL、多租户或插件机制。
- **X-02** 文件系统存在性决定作品／媒体；metadata 只补充。缺失／坏 metadata、重复／缺源 ID 不得丢物理实体；声明不能授权或删除 actual media。
- **X-03** 保持 Catalog v4、Search、Adapter、shape 与公共协议各自版本语义。完整作品批次同事务更新事实、Search、计数、revision、处理签名；失败／取消保留已提交事务。删除须完整范围且原生确认不存在。
- **X-04** READY 恢复检查点不可变，不读 BUILDING；日常 live 不复制候选、不全量重建 Search 或发布 generation。真实源严格只读，所有配置／数据库／缓存／日志／会话留实例内，与源码／source 分离。
- **X-05** 标准库遍历，不恢复 Everything／NTFS 索引依赖；保持全局与物理设备预算、有界成员／签名暂存、原生路径与竞态核验；不能用目录 mtime 单独复用，只有已提交合格签名可复用。
- **X-06** 用户设计原文只移动／改名，不改正文；后来的用户要求优先，不把开发默认项写作已获用户认可。新决定另写 ADR。既有兼容只保留用户指定的 Venera 收藏及稳定 /p、/f、短链。
- **X-07** 真实验收只输出聚合，不请求或输出私人媒体／作者／正文／metadata，不截图／录屏；所有自动素材与界面验收采用新合成数据。禁止 Computer-Use，不控制在用服务，不移动 Runtime，除非另获明确授权。
- **X-08** Go 尚未替代的 Node HTTP、Reader、媒体、schema／恢复和本机认证保留，依赖边界必须写清；不得把 Go 扫描器称作完整 Go 后端。CMP、Tauri、VLC 新引擎不是本轮范围。
- **X-09** Node 存量 CommonJS 与原生 Canvas 实现按本轮“不大规模重写”的授权登记 NJ-04／U-01 债务；后续不继续扩大混用。类型目标为统一 JSDoc／ts-check，完成范围以技术债为准，不宣称已全量启用。

模块位置见[运行架构](design/architecture-runtime.md)，当前验证边界见[进度](project/status-repository_standard.md)。
