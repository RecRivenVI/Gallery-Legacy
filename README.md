# Gallery

将固定九平台的本地作品只读整理成画廊，浏览、搜索并阅读图片、动图和视频。业务由 Go 实现，桌面管理器采用 Tauri，两端界面采用 Kotlin Compose/WasmJS，维持既有设计，不使用 Miuix。

## 支持的平台

当前构建与验收目标为 Windows x64、WebView2 和支持 WasmGC 的现代浏览器。其他系统未验收。产品边界见[项目范围](documents/project/overview-gallery.md)。

## 快速开始

开发环境、字体准备和工具要求见[依赖说明](documents/reference/dependency-runtime.md)。

```powershell
npm ci
```

根据[本机路径示例](tools/build/paths.example.json)填写被忽略的 `tools/build/paths.local.json`。需要 JDK、Go、Rust/MSVC、WebView2，以及合法的 MiSans Global 和 Noto Color Emoji 资源。构建输出必须在仓库外。

```powershell
npm run build -- -Output <外部构建目录>
```

根据[实例示例](api/runtime.example.json)在源码外准备实例配置；字段定义见[实例配置](documents/reference/configuration-instance.md)。

```powershell
npm start -- -Product <外部构建目录>/Gallery -Config <实例配置文件>
```

画廊服务和扫描由管理器启动；关闭窗口收起到托盘，真正退出会正常结束任务和服务。构建不会替换在用安装。

## 文档

- [产品总览与功能状态](documents/project/overview-gallery.md)
- [使用管理器](documents/usage/guide-manager.md)
- [浏览画廊](documents/usage/guide-gallery.md)
- [构建与验证](documents/development/workflow-development.md)
- [运行架构](documents/design/architecture-runtime.md)
- [完整迁移决定](documents/design/adr-9-full_stack_migration.md)
- [当前进度](documents/project/status-repository_standard.md)
- [冻结设计](documents/design/overview-ui_baseline.md)与[用户后续决定](documents/design/adr-1-user_design_decisions.md)

## 许可

原创代码采用 [AGPL-3.0-or-later](LICENSE)。第三方说明见 [NOTICE](NOTICE)。官方 MiSans 子集随应用分发，运行时不访问外部字体 CDN；字体原文件和许可一同打包。
