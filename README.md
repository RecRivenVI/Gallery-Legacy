# Gallery

只读整理固定九平台的本地作品，浏览、搜索并阅读图片、动图和视频。Go 扫描器、CanvasKit 网页、四页管理端与 Electron；读取、媒体和本机控制仍由 Node 提供。不是完整 Go 后端。

## 支持的平台

当前验收目标为 Windows x64。九平台及产品边界见[项目范围](documents/project/overview-gallery.md)。真实源始终只读，实例与源码分离。

## 快速开始

Node、Go 与依赖要求分别以 [package.json](package.json)、[go.mod](go.mod) 和[依赖说明](documents/reference/dependency-runtime.md)为准。

```powershell
npm ci
```

参照 [本机路径示例](tools/build/paths.example.json)填写被忽略的 `tools/build/paths.local.json`，指定 Go、仓库外输出及合法字体资源。浏览器验证需 Playwright Chromium。

```powershell
npm run build
```

将[实例示例](src/config/runtime.example.json)复制到源码外，填写九平台目录、实例路径及独立端口；日常 Go 扫描配置使用 `liveUpdates: true`。

```powershell
npm start -- --config <实例配置文件>
npm run manager -- --config <实例配置文件>
```

管理端“更新图库”执行增量；“全部重新扫描…”执行全量。可复现合成准备与测试见[开发工作流](documents/development/workflow-development.md)。构建不安装、不替换在用实例。

## 文档

- [使用管理端](documents/usage/guide-manager.md)
- [运行架构](documents/design/architecture-runtime.md)
- [实例配置](documents/reference/configuration-instance.md)
- [当前状态](documents/project/status-repository_standard.md)
- [技术债与未验证边界](documents/project/debt-runtime.md)
- [冻结设计依据](documents/design/overview-ui_baseline.md)

## 许可

使用 [AGPL-3.0-or-later](LICENSE)。第三方材料说明见 [NOTICE](NOTICE)。
