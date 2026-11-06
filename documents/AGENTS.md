# 项目规范

补充根目录[仓库规范](../AGENTS.md)，不修改根规范。字体分发以 [adr-11](design/adr-11-bundled_misans.md) 为准。当前范围见[项目定位](project/overview-gallery.md)，验证边界见[进度](project/status-repository_standard.md)。

## 项目信息

| 项 | 值 |
| --- | --- |
| 产品 | 画廊（Gallery），固定九平台的本地只读画廊 |
| 核心路径 | 管理器更新图库 → 浏览/搜索作品或作者 → 阅读图片、动图或视频 |
| 技术栈 | Go 业务后端；Tauri/Rust 桌面宿主；Kotlin Compose/WasmJS 两端 UI |
| 设计 | 按 adr-14 前端冻结已解除；本轮仅做必要界面修改；MiSans、Fluent System Icons；不引入 Miuix 依赖 |
| 验收目标 | Windows x64、WebView2、支持 WasmGC 的现代浏览器；其他系统未验收 |
| 主语言/首页 | 简体中文 |
| 上游 | 独立项目；独立 Gallery 仓库不是本项目上游 |

## 项目约定

- 配置与 DDL 定义在 `api/`；既有实例和 Venera 标识不改。
- 构建、本机工具路径和合法资源位置：被忽略的 `tools/build/paths.local.json`；示例同目录。产物/实例在仓外 Artifacts，缓存可放仓外 Scratches。
- Node 仅用于开发工具，无生产 Node 依赖；版本、布局与构建遵循根规范的 Go/CMP/Tauri 附则。

## 补充约束

- **X-01** 固定九平台；不增加动态平台注册、DSL、多租户、插件或社交。本地账号与个人阅读数据按 [adr-13](design/adr-13-stage_two.md) 实现。
- **X-02** 文件存在、名称、大小、数量和类型只取磁盘；metadata 仅补充作品/作者/平台信息，不存媒体声明。坏/缺 metadata 和重复/缺来源 ID 不得丢物理实体。
- **X-03** 保持格式各自版本、完整作品事务、单 writer、WAL/FULL、Search/计数/revision/文件清单一致提交。取消保留已提交事务，删除要求完整范围与原生确认不存在。
- **X-04** READY 恢复基线不可变；日常 live 不复制候选、不全量重建 Search、不发布 generation。来源只读；实例数据/配置/缓存/用户数据不与源码或来源重叠。
- **X-05** 按 [adr-14](design/adr-14-scan_inventory.md) 优先 Everything HTTP 清单，失败需用户确认才原生遍历。持久清单逐文件比较 size/mtime，不算哈希、不以目录时间判断增量；未完成作品不推进清单。每块 HDD 一个读取者，允许 NTFS 特化；删除仍须完整范围和磁盘不存在依据。
- **X-06** 冻结设计原文及用户原话不改正文；新决定另写 ADR，不把开发默认项写成用户确认。
- **X-07** 自动扫描和功能验证只用 SSD 合成数据，不在 G: 测试。允许只读生产配置提取九平台根目录及 adr-14 指定的便携配置项；不得读取真实作品或扫描真实图库。不使用 Computer-Use、不操作生产、不迁历史 Runtime。
- **X-08** Go 会话由管理器拥有。隐藏不结束任务，真正退出协作取消并等待服务/扫描结束，不用按名称杀进程或身份回退。
- **X-09** CJK、字体、浏览器媒体和原生互操作不得通过残留旧 UI/旧后端回退实现。可复用测试定义在 `validations/`，运行数据和截图在仓外。
- **X-10** 产品运行时清理自身缓存、临时文件、轮转日志及旧版本直接删除；Agent 开发清理仍送回收站。本次阶段一允许按用户批准的保留白名单和准确对象清单整理、归位及回收本项目仓外历史资料；排除其他项目、生产与真实图库，后续清理须另获授权。

## 格式与验证

Kotlin 使用 ktfmt 的 Kotlin 官方风格，由 Gradle `formatKotlin` 执行；开发脚本/资源用 Prettier。Kotlin 与 Rust 文件采用 4 空格；其余按 `.editorconfig`。人工输入法、托盘、系统对话框和真机不以自动测试代替。
