# 依赖与工具

版本分别锁定在 [Go](../../go.mod)、[UI 版本目录](../../ui/gradle/libs.versions.toml)、[Gradle Wrapper](../../ui/gradle/wrapper/gradle-wrapper.properties)、[Cargo](../../src-tauri/Cargo.toml)及各自锁文件；此处不重复版本号。产品运行不依赖 Node/Electron。

| 依赖 | 用途及缺失影响 |
| --- | --- |
| Go、modernc SQLite、x/sys、x/text、x/net | 业务、数据库、原生核验及文本/Host 归一化；无法构建时不能以旧后端回退 |
| Gorilla WebSocket、go-winio | 状态事件、本机管道；不放宽来源或所有权检查 |
| Kotlin、Compose UI/Foundation、Skiko/Skia | 两端 WasmJS、输入、语义和绘制；需要支持 WasmGC 的浏览器 |
| Tauri、Rust、MSVC、WebView2 | Windows 桌面窗口、托盘和系统对话框；不能用进程名替代 Go 身份核验 |
| Tauri Single Instance 官方插件 | 同一实例重复启动时唤回已有管理窗口；以实例身份分组，不替代 Go 所有权检查。来源：[官方文档](https://v2.tauri.app/plugin/single-instance/) |
| JDK 17、Gradle Wrapper | 构建 Kotlin；工具与缓存不进入产品目录 |
| Node、Playwright、Prettier | 开发时图标生成、浏览器验证、格式化；无生产 Node 依赖 |
| libvips | 官方 Windows web DLL 包，图片进程内解码、缩放与 WebP；固定来源和摘要见 tools/media/libvips.lock.json |
| ThumbHash | 占位图编解码使用 go.n16f.net/thumbhash，版本在 go.mod；ISC 许可，原项目推荐的 Go 实现 |
| FFmpeg | 可配置的视频首帧提取；缺失时提示工具不可用，不丢弃作品。ImageMagick 仅用于合成夹具与开发截图 |
| MiSans、Noto Color Emoji | 原样内置官方 CSS/190 子集，按 Unicode 范围从本地加载；九种小语种可变字体和可见表情按需加载 |
| Everything HTTP 与 IPC | 本机 54321 的完整清单加速增量；HTTP 不可用、未加载或不合格时要求用户确认后才原生遍历 |
| Fluent System Icons | 矢量图标，MIT 原文随浏览器资源保留 |

MiSans 加载实现和来源见 [上游记录](upstream-miuix_webfont.md)，分发决定见 [adr-11](../design/adr-11-bundled_misans.md)。不发行完整中文 TTF 和 L3，不使用第三方拉丁子集。原文件校验值唯一保存在 tools/fonts/misans.lock.json，副本随资源分发。九个小语种文件均保留官方 VF 原文件及命名实例，官方 MiSans 协议随字体提供；Emoji 的 OFL、Miuix 加载代码的 Apache-2.0、Fluent 的 MIT 和 Skia 的 BSD 通知分别随包保留。逐语言排版仍需实际使用验收。

Kotlin/Wasm 未声明 npm 产品依赖；当前 kotlin-js-store 没有项目 lock，由插件管理工具链依赖，见 [Kotlin 官方说明](https://kotlinlang.org/docs/whatsnew2220.html#elimination-of-empty-yarn-lock-files)。不手工制造空锁文件。

FFmpeg/ImageMagick 沿用环境中的工具，不由本轮安装。libvips 官方包来自 [Windows 发行页](https://github.com/libvips/build-win64-mxe/releases/tag/v8.18.7)，随包保留 LGPL 原文、依赖通知和源码获取位置；使用可替换 DLL，不静态链接。确切最低兼容版本尚未穷举，不虚构跨系统支持范围。

## Windows race

使用 MinGW-w64 的 UCRT 工具链，以 `raceCompiler` 或当前进程 CC 配置，不替换系统工具。其来源为 [MinGW-w64 官方目录](https://www.mingw-w64.org/downloads/)列出的 MinGW-Builds；实际工具仍在工作区 Scratches。Go 模块和源码不因编译器路径改变。

新增心形、星形、阅读和历史图标直接取自 Microsoft Fluent System Icons 官方源码；固定提交及原文件 SHA 在 tools/icons/personal.lock.json，第三方原文件在 third_party/fluent_personal。它们使用相同 MIT 许可，未引入另一套图标样式。
