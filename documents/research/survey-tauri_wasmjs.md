# Tauri 与全面 WasmJS 的迁移评估

2026-10-22

建议先完成 Go 本机控制与生命周期，再迁 Tauri 薄宿主；前端另以 Kotlin `wasmJs`＋Compose Multiplatform＋Miuix 做一条关键合成样机，再决定是否整体迁移。这是技术建议，不是用户已经选定的技术栈。当前产品仍为 Electron、JavaScript 驱动 CanvasKit 和原生输入／媒体元素。

## 问题

85 号安排要求继续实现 Go 公共读取，同时评估两个独立替换：Electron → Tauri；业务、布局与绘制 → WasmJS。不能将 CanvasKit 已有的 Wasm、Tauri 的 WebView 包装或把 JavaScript 改成 TypeScript 称为“全面 WasmJS”。

用户历史方向及必须保留的布局、字体、图标、卡片内隐私模糊、侧边栏平移与无新增浏览记忆，见[用户决定](../design/adr-1-user_design_decisions.md)。采用 Miuix 不自动撤销这些要求。

## 方法

只读本仓库宿主、前端、打包与协议，并阅读下列官方公开资料；没有安装或运行 Tauri／CMP 样机，没有使用真实媒体、配置、其他 Gallery 仓库或用户浏览器。能力映射是源码／文档判断，不是运行验收；性能、包体和中文输入均未实测。

本次静态计量：`public/gallery` 14 个 JS／HTML／CSS 文件约 7,086 行，`public/manager` 7 个约 1,919 行，`public/platform` 5 个约 552 行，`src/desktop` 3 个约 443 行。行数包含空行，只用于判断重写面，不用它估算功能完成率。

## 发现

### 1. 当前依赖边界

| 层         | 当前实现／依据                                                                                                                          | 可复用与需重做                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 数据与任务 | Go 扫描、SQLite、逐事务签名；公共协议见[行为合同](../reference/protocol-backend.md)                                                     | Go 与 HTTP／稳定链接不因前端工具链变化重写；本机所有权及认证迁移尚未完成                              |
| 网页       | [app.js](../../public/gallery/app.js)、[paint.js](../../public/gallery/paint.js)、[interaction.js](../../public/gallery/interaction.js) | 状态、布局、命中、动画和事件仍是 JS；Wasm 主要在 CanvasKit 底层；迁 Kotlin 要重写这些源代码           |
| 输入与语义 | [projection.js](../../public/gallery/projection.js)、[viewer.js](../../public/gallery/viewer.js)                                        | 原生输入、焦点／读屏投影、图片与 `<video>`、字幕和剪贴板依赖 Web API，不能简单删除                    |
| 管理 UI    | [main.js](../../public/manager/main.js)和四页 DOM／表单                                                                                 | Tauri 薄宿主可以先复用；管理 UI 也要求 Wasm 时须再迁一遍，不是换壳自动完成                            |
| 桌面桥     | [main.js](../../src/desktop/main.js)、[preload.js](../../src/desktop/preload.js)、[trusted-page.js](../../src/desktop/trusted-page.js)  | 白名单 IPC、精确页面／frame 核验、目录选择、托盘和生命周期需要 Rust／Tauri 适配                       |
| 分发       | [打包工具](../../tools/package/run.cjs)                                                                                                 | 目前是便携 Electron／Node 运行目录，没有现成自动更新服务；不能把 Tauri updater 算作已有能力的直接复用 |

### 2. Electron → Tauri 能力映射

| 能力                                     | 迁移方式                                                                    | 等价性与主要验证                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 四页页面、主题、图标、原生表单           | 先保留现有静态资源，只换宿主                                                | 源可复用；WebView2 的字形、缩放、Canvas／Wasm、CSP、资源 URL、IME 必须重新运行验证                                                                             |
| 默认／最小窗口、关闭隐藏、重开、单实例   | Tauri window、close request、single-instance 插件与事件                     | 显式重做，不能让关闭事件直接退出；检查隐藏、托盘重开和重复启动是否仍只有一窗                                                                                   |
| 托盘菜单／双击                           | Tauri tray／menu API                                                        | Windows 有对应能力；不是各系统天然一致，Linux 不支持同样的托盘点击事件；[官方托盘文档](https://v2.tauri.app/learn/system-tray/)                                |
| 选择目录、打开目录／定位文件、打开浏览器 | dialog／opener 与必要的 Windows 原生定位                                    | 可桥接；选择取消、Unicode 路径、默认目录和错误反馈需复验；[dialog](https://v2.tauri.app/plugin/dialog/)、[opener](https://v2.tauri.app/plugin/opener/)         |
| `galleryHost` 白名单                     | 保持前端方法名；Rust commands 调用 Go 本机命令／管道                        | 不是把全部 shell／文件系统权限交给页面；只允许管理窗口的已打包内容调用，外部网页无权限                                                                         |
| 页面／frame 与实例身份                   | capabilities 限窗＋Rust 逐项核验；Go 继续验 token、实例、PID／创建时刻／exe | capabilities 不是管道认证替代品。官方提示注册的自定义命令默认可能对所有窗可用，应显式声明命令权限；[capabilities](https://v2.tauri.app/security/capabilities/) |
| Go 进程与后台服务                        | 打包 Go 可执行；管理器只调用已认证服务，不持有数据库 writer                 | Tauri 支持 externalBin，需按目标 triple 打包；[sidecar](https://v2.tauri.app/develop/sidecar/)不证明服务在管理器退出后自动存活                                 |
| 退出管理器但服务继续                     | Go CLI 启动独立服务，管理窗口只注册／注销；显式“停止服务”才停服务           | 必须做进程退出／重开／取消／崩溃合成验收；不能依赖 sidecar 子进程句柄存活，也不能把扫描放进 Rust 主线程                                                        |
| 打包与更新                               | 替换便携包组装；若需要安装器再选 NSIS／MSI                                  | Tauri Windows 依赖 WebView2；共用系统运行时或打包离线／固定运行时会产生不同包体；[Windows 分发](https://v2.tauri.app/distribute/windows-installer/)            |
| 自动更新                                 | 当前无；将来如用户要求再设计                                                | 需要签名、版本清单与更新源，不在本次迁移顺手新增；[updater](https://v2.tauri.app/plugin/updater/)                                                              |

建议保持一个服务所有者：Go 负责工作库、扫描、控制管道与恢复；Rust 只负责窗口和系统集成，不直接写 SQLite。Tauri 退出后保留服务是本项目要求，不是官方 sidecar 用法自带的承诺。[Tauri 进程模型](https://v2.tauri.app/concept/process-model/)使用系统 WebView，Windows 为 WebView2；不再随应用携带完整 Electron Chromium，但也不保证零运行时成本。

### 3. “全面 WasmJS”的可执行定义

建议定义为：**应用业务、状态、路由、布局、控件与绘制主逻辑编译为 Wasm；允许编译器运行时和必要的浏览器／宿主胶水。** 网络、DOM、IME、读屏树、剪贴板、视频解码与系统窗口仍通过宿主 API。若要求最终包里完全没有 JS 或 DOM，不符合当前浏览器／Tauri 这条路线。

| 候选                        | 能实现什么                                                    | 代价／建议                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kotlin `wasmJs`＋CMP＋Miuix | Kotlin 状态与布局、自绘控件，最贴近用户历史的 CMP／Miuix 意向 | 推荐先验证；现有 JS 不会自动转换，需重写两套 UI 与手势／动画映射                                                                                       |
| Rust Wasm＋自绘引擎         | 业务／几何／绘制控制可进 Wasm；浏览器桥另写                   | 能做，但没有直接的 Miuix Compose 控件复用；若目标是减少自造控件，不优先                                                                                |
| Go `js/wasm`＋自绘          | 可共享部分 Go 数据结构／算法，仍需浏览器桥和 UI 工具          | Go 后端可编译不等于前端可复用；当前目录／SQLite／外部编码器不能搬进浏览器，且不提供 Miuix 控件；[Go 官方 WebAssembly](https://go.dev/wiki/WebAssembly) |
| 保留 JS＋CanvasKit          | 保留现状，局部计算可另移 Wasm                                 | 改动最少，但不是本次“全面”目标                                                                                                                         |

[Kotlin 官方概述](https://kotlinlang.org/docs/wasm-overview.html)明确区分 `wasmJs` 和 WASI，浏览器 API 通过 JS interop；[interop 文档](https://kotlinlang.org/docs/wasm-js-interop.html)是桥接依据。Kotlin/JS 是另一个 JS 输出目标，不是 Wasm；双目标回退有兼容价值，但不能把回退路径也称为纯 Wasm。

[Miuix 官方 README](https://github.com/compose-miuix-ui/miuix/blob/main/README.md)标明实验性质、Web 演示及 Apache-2.0；[miuix-ui 构建](https://github.com/compose-miuix-ui/miuix/blob/main/miuix-ui/build.gradle.kts)同时声明 `wasmJs` 和 JS。调查时 main 的[依赖目录](https://github.com/compose-miuix-ui/miuix/blob/main/gradle/libs.versions.toml)为 Kotlin 2.4.21／CMP 1.12.2；这不是本项目已锁定的发布版组合。采用前须选定公开发行版本并核对所有控件、模糊和 shader 的 Web 行为，不以桌面截图推定等价。

### 4. 必须实测的前端边界

| 范围            | 风险与一次关键样机的通过标准                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 中文输入        | composition 期间不触发错误搜索、不吞字；候选框在实际输入处；中英切换、撤销、粘贴、移动端键盘正常；必须用户实际输入，自动 fill 不算 IME 验收                                                                       |
| 文字选择／复制  | 详情标题、简介、链接可按现有方式选择／复制；原生输入的剪切／撤销不被画布快捷键接管；RTL／CJK 字体回退保留                                                                                                         |
| 无障碍          | 按钮、菜单、滑块、列表、弹层的语义、状态、Tab／焦点恢复与读屏逐项验证；保留必要 DOM 投影，不能因有 semantics 就声称整站可访问                                                                                     |
| 媒体            | 静态图、GIF／WebP 动图、视频／字幕、Range、全屏／画中画和下载；优先沿用浏览器解码／video interop，不在本轮引入 VLC；换壳不扩大浏览器支持的编码格式                                                                |
| 长列表／动效    | 同一 120 卡片素材、字号／DPI／深浅色／手机平板；大小滑块、毛玻璃、打开到一半关闭、缩放与跨作品切换；复用既有验收目标，不先承诺更快                                                                                |
| 浏览器／WebView | 当前官方 [Kotlin/Wasm 配置](https://kotlinlang.org/docs/wasm-configuration.html)列 Chrome／Chromium 119、Firefox 120、Safari 18.2 起默认支持；实际所选 CMP／Miuix 组合可能还有约束，旧 iOS 无法只靠更新浏览器解决 |

官方[无障碍说明](https://kotlinlang.org/docs/multiplatform/compose-accessibility.html)描述 semantics；[CMP 1.9 系列发布说明](https://kotlinlang.org/docs/multiplatform/whats-new-compose-190.html)记录 Web 初始支持及当时的滚动容器／滑块等缺口。它是历史风险依据，不用它断言当前 main 仍有相同缺陷，也不反向假定已修好。选定版本后应对照其发布说明再做样机。

Wasm 不等于 WebGPU。当前 CanvasKit WebGL 调用、未来 Skiko 或 Miuix shader 的 GPU 后端，需要分别核实与测量；不能因编译成 Wasm 就承诺 WebGPU、零拷贝、低内存或毛玻璃不卡。

### 5. 工作量与性能／包体预期

以下为单开发者、Windows x64、保留现有功能、Go 生命周期已完成的工程估计，不是日程或实测结果：

| 工作包                                                     | 区间       | 不包含／主要不确定性                                                      |
| ---------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| Tauri 薄宿主、固定桥、托盘／窗口／目录、便携打包和合成验收 | 2～4 人周  | 其他系统、自动更新、正式签名／分发；服务独立存活和 WebView 资源策略最关键 |
| Kotlin／Miuix 关键合成链样机                               | 1～2 人周  | 一页 120 卡片＋一个查看器＋一个设置／中文输入＋Tauri 管理桥；不是完整前端 |
| 两前端同功能迁移、手势／动画、语义与媒体桥及回归           | 8～14 人周 | 含上面样机，不含 Go 余项；Miuix 控件与既有设计冲突、浏览器缺陷会扩大区间  |

Tauri 有望减少随包携带的 Chromium／Node，但 Go、字体、媒体工具和可选 WebView2 仍占空间；离线固定运行时可能抵消部分节约。Kotlin/Wasm 增加运行时／Skia／字体下载，未必比现有 CanvasKit 首屏更小。两者均没有本项目包体、启动、RSS 或帧率的测量值，不给“提升百分之多少”的数字。

本项目 Go 仍含 Windows 原生身份／路径核验和进程创建代码；Tauri 支持其他系统不等于本后端已经跨平台。上面的工期只针对 Windows，不包含替代这些原生边界。

比较时固定同一合成素材／功能、字体与资源分发策略，分别量首包／冷启动下载、缓存启动、解压体积、进程树总 RSS、CPU 与交互帧；Electron 对 Tauri 应扣清系统共享 WebView 成本，不能只比较主 EXE。三次重复保留全部结果，不只选最快样本。

## 结论

1. **可复用**：数据协议、Go 扫描／读取与稳定链接；迁 Tauri 可以先保留管理 UI。
2. **需重做**：桌面桥／窗口生命周期、打包；全面 WasmJS 的业务、布局、绘制和输入／语义适配。它不是 CanvasKit 的包装修改。
3. **无法比较**：Tauri 的真实生命周期、CMP／Miuix 中文输入／读屏／媒体、性能与包体。本轮没有原型运行证据。
4. 推荐顺序：Go 本机控制与生命周期 → Tauri 薄宿主单链 → Kotlin `wasmJs`／Miuix 关键链 → 用户比较后决定两端迁移；不在这一检查点自动跨入。

需要用户决定：是否以 Kotlin `wasmJs`＋CMP＋Miuix 为下一次样机首选；“全面”是否接受必要 JS／DOM／原生媒体胶水；目标浏览器是否接受所选 Wasm 运行要求（不接受时选 JS 回退或继续现有前端）；管理端先只换 Tauri 壳，还是与 UI 重写一起做。建议先薄宿主、后 UI，保留功能与回退的可核对边界。
