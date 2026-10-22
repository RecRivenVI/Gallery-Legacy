# 开发工作流

从仓库根运行；常用命令以 [package scripts](../../package.json) 为唯一入口，Go 工具和依赖版本由 go.mod 管理。缺少工具链时只使用官方 portable 版本，不改系统 PATH／注册表。

## 准备

```powershell
npm ci
```

使用被忽略的 `tools/build/paths.local.json` 指定本机 Go 可执行文件、仓库外构建输出及合法资源路径；字段见[本机路径示例](../../tools/build/paths.example.json)。运行实例不能放回源码。

resources 指向包含 `misans/manifest.json`、字体及随附许可的原始资源根。构建从锁定 npm 包取 CanvasKit，从 SVG 源生成图标，不在源码跟踪二进制。源码启动从本机文件读取资源和已构建 gallery-runtime；发行目录直接使用其自带资源与 Go 会话。

## 构建与验证

```powershell
npm run build
npm test
npm run test:go
npm run vet:go
npm run test:race
npm run format
```

Go 数据库／Adapter 测试需要合成空库与黄金输入。先通过 `npm run prepare:test -- <新合成根>` 生成，再将其 `instance/live/catalog.sqlite` 和 `golden.json` 填入本机路径文件的 testSeed／golden；`<新合成根>` 必须在 GALLERY_TEST_ROOT 环境变量指定的根下，默认是系统临时目录的 Gallery-Legacy 子目录。

`npm run test:integration` 另需 GALLERY_GO_ACCEPTANCE_EXE 指向本轮构建扫描器。合成测试不读取已有真实库或下载真实素材。完整工具／输出字段示例见 [paths.example.json](../../tools/build/paths.example.json)。

Windows race 在本机路径文件设置 raceCompiler；该命令启用 CGO，并只在子命令 PATH 前加入编译器目录。不要把旧系统 gcc 当作已验证的 race 环境，不修改系统 PATH。已验证渠道与校验值见[依赖说明](../reference/dependency-runtime.md)。

先保存迁移前结果，再运行同组迁移后检查。既有超时／身份失败不放松断言；单条长验证约二十分钟仍未完成即记录未完成。失败最多原样重试一次，不能循环跑到绿。

场景操作见 [Gallery 验证定义](../../validations/scene-gallery/validation.md)，真实性能另见 [性能定义](../../validations/performance-scanning/validation.md)。自动实例默认 1920×1080、静音，不用 Computer-Use；真实内容不截图。

后端差分用 `test:protocol`、`test:schema`、`test:reader`、`test:recovery`。GALLERY_NODE_REFERENCE_ROOT 指向独立冻结的 Node 构建，GALLERY_TEST_ROOT 指向本轮新的合成结果根；Reader 场景另以 GALLERY_SCANNER 指定已验证的扫描器。每次都生成新实例，不覆盖旧结果；附加 `-- --race` 可让黄金差分本身启用 race。范围和判断见[后端差分定义](../../validations/scene-backend_parity/validation.md)。

配置与数据集组装的独立批次使用 `test:config`、`test:dataset`，同样附加 `-- --race`；输入放 Scratches，留存摘要放 Artifacts，见[组装验证定义](../../validations/scene-dataset/validation.md)。不需要开启 HTTP 服务，也不自动读取默认实例。

公共 HTTP 组使用 `test:http -- --race`；冻结 Node、同一合成文件与实例的状态／JSON／媒体字节／响应头逐项对照，见[接入验证](../../validations/scene-http_read/validation.md)。已通过且未受影响的基础组不重跑。

独立读取命令仅是开发验收工具，不是产品启动入口，不接到在用服务。配置该验证定义中的 GALLERY_READ_EXE、GALLERY_HTTP_GOLDEN 和 GALLERY_HTTP_EVIDENCE 后可运行 `test:http-browser`；产品 `start`／`manager` 统一打开管理器：

```powershell
node tools/go/run.cjs build -o <外部候选目录>/gallery-read.exe ./cmd/gallery-read
```

独立命令的参数为 `-config <合成配置>`、`-frontend <public目录>`、`-assets <已准备资源目录>`。它只读已准备的数据库，不代替实例所有者，不负责初始化／扫描／动态恢复切换；用途与关闭边界见[架构](../design/architecture-http_read.md)。

管理会话的实际迁移验证使用 `test:lifecycle-reference`、`test:manager-lifecycle`、`test:management`、`test:inspection`、`test:static-task`、`test:interruption` 和 `test:manager-browser`。显式输入与关闭顺序见[场景定义](../../validations/scene-management/validation.md)，不从默认私有配置寻找实例。需要单独为冻结 Node 准备扫描器时，从 cmd/gallery-scan 构建到该合成根；产品构建只含管理器拥有的 gallery-runtime。

## 交付

合成评审工具的根与资源分别配置在忽略的 `tools/demo/paths.local.json`（[示例](../../tools/demo/paths.example.json)）。受保护运行时只读该合成根内的资源；不要把真实源设为 root。既有完整／空实例原样保留，不在源码中重建阶段目录。

构建先准备浏览资源，再构建 Go 会话并保留尚未退役的 Node 对照源码。生成物与发行包在仓库外；已有目标不覆盖。未实际运行的包不写作验收通过。

72 号任务已授权界面检查点及 Go 替代每批完成后，提交无正文 `Update` 并正常推送 origin/main；授权只限本任务，不改历史、不强推、不加 CI／机械门禁。
