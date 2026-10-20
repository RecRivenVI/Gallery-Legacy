# 项目范围

画廊面向个人拥有者与日常浏览者：将固定九平台已落盘的作品只读整理，提供作品／作者／标签搜索和图片、动图、视频阅读。

正式目标组成是 Go 标准库扫描器、CanvasKit 浏览界面、原生表单四页管理端和 Electron 宿主。尚需 Node 提供 Reader、HTTP、媒体、schema／静态恢复、本机认证与控制；本轮不另写 Go HTTP。

九个平台是 pixiv、pixivFANBOX、Gank、Fantia、Patreon、Pawchive、X、微博、Venera；独立只读文件浏览不是第十个平台。保留用户指定的 Venera 收藏和 /p、/f、短链。

不做账户社交、动态平台注册、插件、任意规则 DSL 或多租户。本轮不迁 Runtime，不替换在用安装，不改独立 Gallery。CMP/Miuix、Tauri、自主 VLC 引擎仍是后续方向，不算已经迁入。

核心路径、约束与当前开放项分别见[项目规范](../AGENTS.md)、[当前进度](status-repository_standard.md)和[技术债](debt-runtime.md)。用户操作完成任务才是可用，测试和入口齐全不替代验收。
