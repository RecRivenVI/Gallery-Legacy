# 项目范围

画廊面向个人拥有者与日常浏览者：将固定九平台已落盘的作品只读整理，提供作品／作者／标签搜索和图片、动图、视频阅读。

当前产品由 Go 标准库扫描器、CanvasKit 浏览界面、原生表单四页管理端和 Electron 宿主组成。默认读取、HTTP、媒体、schema／静态恢复与本机控制仍由 Node 提供；独立 Go 读取入口按[迁移计划](plan-go_backend.md)验收，尚未接管产品入口。

九个平台是 pixiv、pixivFANBOX、Gank、Fantia、Patreon、Pawchive、X、微博、Venera；独立只读文件浏览不是第十个平台。保留用户指定的 Venera 收藏和 /p、/f、短链。

不做账户社交、动态平台注册、插件、任意规则 DSL 或多租户。本轮不迁 Runtime，不替换在用安装，不改独立 Gallery。85 号只授权评估 Tauri／全面 WasmJS，不是立即切换；92 号[技术方向](../design/adr-7-wasmjs_scope.md)排除 Miuix 组件与视觉迁移，只采用相同底层栈。CMP、Tauri、自主 VLC 引擎均未迁入。

核心路径、约束与当前开放项分别见[项目规范](../AGENTS.md)、[当前进度](status-repository_standard.md)和[技术债](debt-runtime.md)。用户操作完成任务才是可用，测试和入口齐全不替代验收。
