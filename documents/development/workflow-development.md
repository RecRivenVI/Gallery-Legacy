# 开发工作流

从仓库根运行；常用命令以 [package scripts](../../package.json) 为唯一入口，Go 工具和依赖版本由 go.mod 管理。缺少工具链时只使用官方 portable 版本，不改系统 PATH／注册表。

## 准备

```powershell
npm ci
```

使用被忽略的 `tools/build/paths.local.json` 指定本机 Go 可执行文件、仓库外构建输出及合法资源路径；字段见[本机路径示例](../../tools/build/paths.example.json)。运行实例不能放回源码。

resources 指向包含 `misans/manifest.json`、字体及随附许可的原始资源根。构建从锁定 npm 包取 CanvasKit，从 SVG 源生成图标，不在源码跟踪二进制。源码启动也从本机文件读取资源和已构建 scanner；发行目录直接使用其自带资源／scanner。

## 构建与验证

```powershell
npm run build
npm test
npm run test:go
npm run vet:go
npm run format
```

Go 数据库／Adapter 测试需要合成空库与黄金输入。先通过 `npm run prepare:test -- <新合成根>` 生成，再将其 `instance/live/catalog.sqlite` 和 `golden.json` 填入本机路径文件的 testSeed／golden；`<新合成根>` 必须在 GALLERY_TEST_ROOT 环境变量指定的根下，默认是系统临时目录的 Gallery-Legacy 子目录。

`npm run test:integration` 另需 GALLERY_GO_ACCEPTANCE_EXE 指向本轮构建扫描器。合成测试不读取已有真实库或下载真实素材。完整工具／输出字段示例见 [paths.example.json](../../tools/build/paths.example.json)。

先保存迁移前结果，再运行同组迁移后检查。既有超时／身份失败不放松断言；单条长验证约二十分钟仍未完成即记录未完成。失败最多原样重试一次，不能循环跑到绿。

场景操作见 [Gallery 验证定义](../../validations/scene-gallery/validation.md)，真实性能另见 [性能定义](../../validations/performance-scanning/validation.md)。自动实例默认 1920×1080、静音，不用 Computer-Use；真实内容不截图。

## 交付

合成评审工具的根与资源分别配置在忽略的 `tools/demo/paths.local.json`（[示例](../../tools/demo/paths.example.json)）。受保护运行时只读该合成根内的资源；不要把真实源设为 root。既有完整／空实例原样保留，不在源码中重建阶段目录。

构建先准备浏览资源、再构建 Go 扫描器和 Node 运行目录。生成物与发行包在仓库外；已有目标不覆盖。未实际运行的包不写作验收通过。

本轮检查点允许一个无正文 `Update` 并正常推送 main；后续提交／推送仍需用户授权，不改历史、不强推、不加 CI／机械门禁。
