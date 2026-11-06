# 开发与验证

从仓库根目录执行。完整构建生成 Go 运行会话、Tauri 管理器、两端 Compose/WasmJS 和合法字体资源；输出不含 Node/Electron。范围与未验证项见[进度](../project/status-repository_standard.md)。

## 环境与构建

准备 JDK 17、Go、Rust/MSVC、WebView2、Node 和 Playwright Chromium；版本声明见[依赖](../reference/dependency-runtime.md)。按[路径示例](../../tools/build/paths.example.json)填写 `paths.local.json`。资源目录包含官方小语种 manifest/files/许可与 Noto Color Emoji；miSansCdn 指向仓外官方 CSS/190 子集缓存，libvipsCache 指向仓外固定 DLL 与许可缓存。构建通过 fonts lock 核对或获取缺少的原文件，运行时不访问 CDN。

```powershell
npm ci
npx playwright install chromium
npm run build -- -Output <新的仓外目录>
```

`<新的仓外目录>` 不得已有产品；可预先仅放与 InstanceConfig 对应的 Instance。开发候选可加 `-DebugBuild`。Gradle Wrapper 固定发行版；构建先生成 Compose 浏览器资源，再构建 Go、图标与 Tauri。`paths.local.json` 可设 `buildRoot` 复用仓外构建缓存、`gradle` 指定已有 Gradle；默认使用 Wrapper。不得在运行同一路径的 Gallery.exe 时覆盖该构建。

产物为 `Gallery/Gallery.exe`、`gallery-runtime.exe`、`resources/`、LICENSE/NOTICE。两端界面分别嵌在两个可执行文件中，不发行 frontend 目录。加 `-Portable -InstanceConfig <实例配置>` 生成单顶层 Gallery 的便携 ZIP。运行时无 Node。开发与生产实例不互换配置。

```powershell
npm start -- -Product <构建目录>/Gallery -Config <显式实例配置>
```

## 单元与静态验证

```powershell
npm run test:go
npm run vet:go
npm run test:race
./ui/gradlew.bat -p ui -PgalleryBuildRoot=<仓外构建缓存> check wasmJsBrowserDistribution
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Cargo 构建需将 `CARGO_TARGET_DIR`、`GALLERY_ICON`、`GALLERY_TRAY_ICON` 指向构建工具生成的仓外缓存/图标，并以 `TAURI_CONFIG` 指定相对于 `src-tauri` 的前端目录。不能把 Windows 绝对路径直接作为 frontendDist，它会被当成 URL。完整构建入口会设置这些参数。

Go 常规数据库测试可自行创建合成空库，metadata 对照固定在 `internal/metadata/testdata`。旧黄金差分仅在显式提供对应环境变量时运行；跳过不是一致结论。原生控制及媒体场景以 `GALLERY_CONTROL_ROOT`、`GALLERY_UNIT_ROOT` 指向新的仓外合成结果根。Windows race 需独立 MinGW-w64/UCRT，设置本机路径的 raceCompiler 或 CC，不更换系统编译器。

## 接口生成与新实例

`api/runtime-config.schema.json` 定义配置类型和默认值，`api/public.json` 定义其余公共记录，protocol/catalog 定义协议值；Go 与 Compose 类型由同一生成器产生，不手工修改生成文件。变更后执行生成及格式化：

```powershell
node tools/go/run.mjs generate ./api
./ui/gradlew.bat -p ui -PgalleryBuildRoot=<仓外构建缓存> formatKotlin
node tools/go/run.mjs run ./tools/instance -config <全新实例配置>
```

实例工具只创建全新工作库，不启动服务或扫描，不覆盖已有数据库。只在已授权的根目录绑定上使用。

## 合成实例与浏览器

```powershell
node tools/go/run.mjs run ./tools/demo -root <新的仓外合成根> -port <独立回环端口> -works 32 -video-encoder <FFmpeg程序>
```

生成固定种子抽象素材、九平台、48 页作品、动图、短视频、独立文件根与空工作库；使用管理器自己的更新操作入库，不直接写作品事实。`-works 0` 生成空实例。字体只来自外部合法资源，不下载演示素材。

按[新栈场景](../../validations/scene-full_stack/validation.md)启动自己的合成候选，设置 `GALLERY_TEST_CONFIG`、`GALLERY_TEST_CDP`、`GALLERY_REVIEW_OUTPUT` 后执行：

```powershell
npm run test:native
npm run test:browser
npm run test:interactions
node tools/validation/compatibility.mjs
node tools/validation/scan_tasks.mjs
node tools/validation/scan_streaming.mjs
node tools/validation/video_duration.mjs
node tools/validation/live_updates.mjs
node tools/validation/viewer_interrupt.mjs
node tools/validation/thumbnails.mjs
node tools/validation/manager_preview.mjs
```

第二阶段的搜索、个人数据、作者关联与漫画阅读另按[个人阅读场景](../../validations/scene-personal_reading/validation.md)执行；约 39 万语料的查询测量按[搜索性能场景](../../validations/perf-search/validation.md)，不得与其他测试并行。

脚本先验证合成标记、所有来源归属、回环端口及当前 Tauri 实例身份，再操作。Playwright 使用 Compose 的语义定位取得控件位置，实际点击画布；不以修改产品状态冒充功能测试。调试候选可设置 GALLERY_VALIDATION_NO_ACTIVATE=1，以不激活窗口的方式显示；该开关在发行构建无效。网页检查也可通过显式合成公共读取测试入口运行，此时不设置 GALLERY_TEST_CDP，不冒充原生验收。截图等待图像与按需字体网络完成；写说明之前须实际查看。manager_preview 仅使用显式内存协议验证管理界面组件，不是原生 Tauri 控制验收；需要额外设置 GALLERY_TEST_ASSETS 为自有合成资源目录。升级合成实例可运行 tools/demo 的 -upgrade，仅对带合成标记的实例执行 metadata 升级，不扫描。人工系统输入法候选窗、目录对话框和托盘点击另验，不称自动通过。

## 格式

```powershell
npm run format
./ui/gradlew.bat -p ui -PgalleryBuildRoot=<仓外构建缓存> formatKotlin
cargo fmt --manifest-path src-tauri/Cargo.toml
```

不修改冻结设计原文、根 AGENTS.md 或第三方许可正文。无提交/推送授权时只保留工作区变更。
