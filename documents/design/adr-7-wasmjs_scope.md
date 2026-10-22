# WasmJS 技术方向与现有设计分离

## 状态

已接受。

## 背景

用户在 2026-10-22 的 92 号补充中明确：目前不迁移 Miuix，只采用与其一致的 WasmJS 技术栈。85 号原评估把 Miuix 控件列入候选，不能继续作为当前方向；[原调查](../research/survey-tauri_wasmjs.md)保留为当时记录。

## 决策

后续前端方向为 Kotlin `wasmJs`、Compose Multiplatform 运行时／UI／Foundation 及其 Skiko／Skia 浏览器绘制链；不是 Kotlin/JS、Compose HTML，也不是继续让旧 JavaScript 承担主要业务后仅换 Wasm 包装。

不迁入 Miuix 的组件库、主题、图标、配色、字体加载器及特效模块，不更换产品视觉设计。[用户设计决定](adr-1-user_design_decisions.md)及后续明确要求继续有效。控件如何由 Compose 基础能力承接既有外观与交互，见[补充评估](../research/survey-wasmjs_stack_scope.md)。

这是技术方向和评估范围决定，不批准立即重写前端、替换 Electron／生产入口或迁移 Runtime。Go 原检查点继续，Tauri 仍只评估；实际版本锁定、关键样机和正式实施待另行安排。

## 后果

不能再要求用户从 Miuix 与其他 UI 库之间重选。仍需决定浏览器支持底线、必要 JS／DOM／媒体胶水范围，以及 Tauri 与 UI 的实施次序；这些未定项不延伸为现在实施的授权。

迁移需要重写业务、状态、布局与交互源代码，并验证原生输入、文字选择、无障碍与媒体桥。沿用相同绘制家族不保证自动提速、缩小包体或获得 WebGPU。本次没有新增 Kotlin、Compose、Skiko 或 Tauri 产品依赖。
