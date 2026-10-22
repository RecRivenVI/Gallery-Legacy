# WasmJS 技术栈范围补充评估

2026-10-22

92 号决定收敛为 **Kotlin `wasmJs`＋Compose Multiplatform＋Skiko／Skia，不采用 Miuix 组件与视觉体系**。原[85 号调查](survey-tauri_wasmjs.md)保持原样；其中 Miuix 候选、控件复用、费用及待选择的结论，以本补充为准。[已接受决定](../design/adr-7-wasmjs_scope.md)是当前方向的唯一记录。本次没有实现新前端或 Tauri。

## 问题

“与 Miuix 一致的技术栈”具体是哪几层？不使用其组件后，如何保留现有设计、修正依赖和工作量，并如实说明不能消除的浏览器边界？

## 方法

只读核对 Miuix 官方发行元数据、固定发布标签和开发分支构建、示例入口，以及 JetBrains 官方 Kotlin／Compose／Skiko 源码与 Maven 元数据。没有下载工具链、安装依赖、运行 CMP 样机或改动现有前端；85 号 Go 合成差分和浏览器结果不因文档补充重跑。

## 发现

### 1. 官方技术链与版本

| 层                 | 官方可核实的实现                                                                                                      | 本项目方向                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 源语言／编译       | Miuix 用 Kotlin Multiplatform、Compose 编译插件；声明 `wasmJs { browser() }`，Web 示例再声明 `binaries.executable()`  | Kotlin 应用业务编译为浏览器 Wasm；不是 WASI 或 JVM                     |
| Compose 运行时／UI | 示例以 `ComposeViewport` 承载 `@Composable`，依赖 Compose Foundation；重组、状态、布局、焦点与手势由 Compose 体系承接 | 使用 Runtime、UI、Foundation、动画等实际需要的底层能力，不引入 Miuix   |
| 绘制               | Compose Web 场景调用 Skiko `SkiaLayer`；Skiko 暴露 Skia，并建立 HTML Canvas 的 WebGL 上下文                           | Skiko／Skia 绘制链，不继续从 JS 直接驱动现有 CanvasKit；不承诺 WebGPU  |
| 产品组件／主题     | Miuix UI、Preference、Theme、Icons、Blur、Squircle、Nav、Shader 是上层库或独立模块，不是 `wasmJs` 的组成条件          | 全部不自动迁入；不照搬其控件、颜色、圆角、动效或示例字体 CDN           |
| 宿主               | 浏览器与 Web API 提供事件、输入、媒体和绘图上下文；Tauri 另提供系统 WebView 和原生桥                                  | Wasm 页面可以承载于浏览器／Tauri WebView，但宿主替换与前端重写独立验收 |

依据：[发布版 UI 构建](https://github.com/compose-miuix-ui/miuix/blob/v0.9.4/miuix-ui/build.gradle.kts)、[Web 构建](https://github.com/compose-miuix-ui/miuix/blob/v0.9.4/example/web/build.gradle.kts)、[示例入口](https://github.com/compose-miuix-ui/miuix/blob/v0.9.4/example/web/src/webMain/kotlin/Main.web.kt)、[Compose Web 场景源码](https://github.com/JetBrains/compose-multiplatform-core/blob/jb-main/compose/ui/ui/src/webMain/kotlin/androidx/compose/ui/window/ComposeWindowInternal.web.kt)、[Skiko 发布源码](https://github.com/JetBrains/skiko/blob/v0.150.1/skiko/src/webMain/kotlin/org/jetbrains/skiko/SkiaLayer.web.kt)。Compose 链接为开发分支，用于确认职责，不将它的全部行为当作固定发布版的运行证明。

调查时 [Miuix 最新正式发行](https://github.com/compose-miuix-ui/miuix/releases/tag/v0.9.4)是 v0.9.4（2026-09-20，非 prerelease），其[版本定义](https://github.com/compose-miuix-ui/miuix/blob/v0.9.4/gradle/libs.versions.toml)为 Kotlin 2.4.20／CMP 1.12.0。[CMP UI 发布元数据](https://repo.maven.apache.org/maven2/org/jetbrains/compose/ui/ui/1.12.0/ui-1.12.0.module)声明 Skiko 0.150.1。原调查所述 Kotlin 2.4.21／CMP 1.12.2 来自当时的[开发分支版本定义](https://github.com/compose-miuix-ui/miuix/blob/685dceb7bc1e4e3b60fe0ec040697c676c91a983/gradle/libs.versions.toml)，不是本项目已锁定的组合。

上述版本是调查对象，不是安装或升级决定。同技术栈不要求跟随 Miuix main 的所有版本、Android 插件或可选库。实施样机时应锁定一组公开发行且相互兼容的 Kotlin／Compose 版本，让其声明解析 Skiko，先验关键链；不能单独追新 Skiko。发布标签存在也不等于 Web 全部边界已稳定或本项目已验收。

### 2. 保留设计的承接路径

Go HTTP／WebSocket、稳定链接、查询及媒体契约不因 Kotlin 改变；保持一个 Go 服务所有者，Tauri 不增加 SQLite writer。Tauri 窗口、托盘、目录选择、固定 IPC 和服务独立存活的映射，仍采用[原调查第 2 节](survey-tauri_wasmjs.md#2-electron--tauri-能力映射)。

现有 `public/gallery` 的状态、路由、布局、命中与动画要迁为 Kotlin；`public/manager` 四页不是换壳后自然变为 Wasm，也需要迁移。现有 JS 实现只能作为过渡和对照，不把它长期作为隐藏的业务引擎。公共协议可复用，现有 JS 对象和 CanvasKit 句柄不能直接作为 Kotlin／Skiko 的共享状态或纹理。

界面用 Compose 基础排版、焦点、输入、语义、手势和动画实现现有设计合同。标准基础控件满足时直接用；只有需要保持现有外观的部件才封装项目组件，不另造输入／语义引擎，也不为取得控件而引入 Miuix 或改成 Material 外观。MiSans Global、Fluent System Icons、固定比例、侧边栏平移、卡片内隐私模糊、无新增浏览记忆等用户要求均保留。模糊、遮罩、共享元素与中断动画需要按原画面／行为重新实现和核对，不能借用 Miuix 特效默认效果充当等价。

建议实施顺序仍是完成 Go 本机控制／生命周期，再以薄 Tauri 桥和一条 Kotlin 合成 UI 链分别验证；前后不强制绑定。关键链选择现有一页 120 卡片、搜索输入、看大图及设置／管理桥，不在这一检查点开工。

### 3. 胶水及验证边界

建议“全面”指应用业务、状态、路由、布局、控件和绘制主逻辑编译为 Wasm；允许编译器启动器、Skiko 运行时和下列受限互操作。胶水不承载第二套业务／布局状态机。[Kotlin 官方](https://kotlinlang.org/docs/wasm-overview.html)与[JS interop](https://kotlinlang.org/docs/wasm-js-interop.html)明确浏览器 API 通过互操作调用；用 Kotlin 声明调用不等于消除了 JS／DOM。

| 边界                 | 承接和必须验证的内容                                                                                                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 中文输入／选择／复制 | 先用 Compose 文本输入和选择能力，核对 IME composition、候选窗坐标、撤销／剪切／粘贴、移动端键盘、RTL／CJK 与浏览器选区；必要 DOM 输入可保留为桥，不将自动 fill 算真实 IME 验收                                                                                                                                    |
| 无障碍／焦点         | Compose semantics 到浏览器语义节点、Tab、弹层焦点恢复、滑块值和读屏；开发分支 [Viewport](https://github.com/JetBrains/compose-multiplatform-core/blob/jb-main/compose/ui/ui/src/webMain/kotlin/androidx/compose/ui/window/ComposeWindow.web.kt)仍创建 canvas、a11y 与 interop 容器，不能承诺零 DOM 或自动 AA 合规 |
| 图片／动图／视频     | 浏览器解码与 HTML video／字幕、Range、全屏／画中画继续经桥；验证叠层、裁切、缩放同步和释放。Skiko Canvas 全屏接口不能代替浏览器媒体全屏 API；不加入 VLC 或新的编解码范围                                                                                                                                          |
| 长列表／动效         | 用 Lazy 布局及稳定 key 承接现有结果与锚点，控制图片生命周期；120 卡片、快速筛选、拖动大小、模糊、动画打断逐项比较；不能因 Wasm 自动认定没有重组／上传／缓存开销                                                                                                                                                   |
| 浏览器               | 官方 Kotlin/Wasm 基础要求为 WasmGC 等能力；[配置文档](https://kotlinlang.org/docs/wasm-configuration.html)列 Chromium 119、Firefox 120、Safari 18.2 起默认支持。具体组合还需核对 WebGL／WebView2 等要求，旧 iOS 不能靠本项目胶水获得 WasmGC                                                                       |
| 宿主／网络           | fetch、WebSocket、URL 历史、下载、剪贴板与 Tauri commands 经类型明确的桥；保留既有白名单和身份核验，不将页面开放为通用 shell。WebView2 字体／输入／GPU 与普通浏览器分别验收                                                                                                                                       |

不能将 Kotlin/JS 回退称作 Wasm。是否提供回退会增加一条编译和验收路径，不擅自新增；浏览器底线与胶水接受范围仍需用户决定。

### 4. 依赖、成本与预期修正

未来可能新增 Gradle／Kotlin 编译器及 Compose 插件、Runtime／UI／Foundation／动画和资源模块；Skiko／Skia 随选定 Compose 依赖解析。HTTP 与 DTO 优先用已有 Web API interop／类型定义，不预先引入整套客户端框架。无 Miuix 的直接或“只借特效”间接依赖；具体锁文件与第三方声明在实施时补齐。本次只新增 Go WebSocket 依赖，见[现行依赖](../reference/dependency-runtime.md)。

以下为单开发者、Windows x64、同功能及保留现有设计的估计，未实测：

| 工作包                                     | 补充估计              | 与原估计的关系                                                                                |
| ------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------- |
| Tauri 薄宿主与桥／系统集成／合成验收       | 2～4 人周             | 未变；不含 Go 余项、其他系统、正式签名分发与自动更新                                          |
| Kotlin／Compose 基础关键合成链             | 1～2 人周             | 用现有设计，不用 Miuix；不是完整前端                                                          |
| 两端同功能迁移与输入／语义／媒体／动效回归 | 10～16 人周，含关键链 | 取代原调查的 8～14；不再假定现成 Miuix 控件可复用，需要承接既有控件外观与状态。样机后才能收窄 |

不导入 Miuix 可避免其库及主题适配，但不能按库大小推算最终节约：树摇、Compose／Skiko、字体和媒体桥才决定实际分发内容。Tauri 的包体比较仍须区分系统共享与离线 WebView2；Wasm 不保证首包更小、运行更快或毛玻璃更省。不提供未测量的百分比。具体测量方法沿用原调查，不把本轮 Go 功能测试记作 Wasm 性能证据。

## 结论

- **一致**：官方源码支持 Kotlin `wasmJs`／Compose／Skiko／Skia 与 Miuix 上层库分离；采用底层链不要求采用其视觉设计。
- **有差异**：原评估的 Miuix 候选、现成组件收益及 8～14 人周估计不再适用，由本补充修正；Tauri 能力映射与 Go 原检查点不变。
- **无法比较**：新栈下本项目的真实 IME、读屏、媒体与 GPU 行为、性能和包体，没有样机或真机证据。

剩余待用户决定：① 浏览器支持底线及是否需要 JS 回退；② 是否接受上述必要胶水；③ Tauri 先薄宿主还是与 UI 同迁；④ 何时授权关键样机及锁定版本。建议保持原设计、先薄宿主后 UI，并先用最小关键链验证边界；不再把“是否采用 Miuix 控件”列为待选。
