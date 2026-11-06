# Miuix Web 字体实现

当前仅移植字体加载代码，不引入 Miuix 依赖、主题或控件。来源为 compose-miuix-ui/miuix，提交 `a1ce560e32fce2a5b4b66cc5fc20c087ac0e9f18`，Apache-2.0。

- 上游 `example/shared/src/webMain/kotlin/webfont/` 三文件在 `third_party/miuix_webfont/` 保留版权行与 LICENSE。
- 源代码适配：WebFontPreload.kt 的 createVariableFontFamily 从 private 改为 internal，供 Gallery 的本地拉丁预载复用同一权重/变体创建方法；同时为工厂增加可选权重映射参数，默认行为不变，本地九种小语种使用其 fvar 命名实例的实际权重。增加可选的本地字体基地址和拉丁预载地址参数；Gallery 已同步预载官方 ASCII 组合，禁用加载器的重复拉丁预载。原始 CSS 不修改，字形监听、Unicode 范围匹配与按需并发加载不变。
- 不使用上游自带的 misans_latin.woff2；官方来源与文件身份见 [adr-11](../design/adr-11-bundled_misans.md) 和 tools/fonts/misans.lock.json。管理器和网页使用同一官方字库。
- CSS 来源与 SHA256 由字体 lock 定义，运行时读取本地副本。额外保留 Emoji 与九种小语种可变字体，不打包完整 CJK TTF 或 L3。

正式发行通知见根 NOTICE；本机资源位置只在忽略的 paths.local.json，构建不修改上游仓库。

上游依赖 Compose 的 `InternalComposeApi` 未解析字形监听和字体预载。当前 Compose 版本下没有相同的稳定接口可在 Skia 自绘文本解析失败时补载 Unicode 子集；相关调用集中在移植字体模块与 Gallery 字体互操作入口，不用于业务或页面布局。Wasm/DOM 的实验互操作声明仅用于浏览器能力胶水。升级 Compose 时按本记录核对，不另加第二套字体回退实现。

Compose 1.12.2 的 `ComposeViewport` 仍要求实验声明，集中在入口 Main；滚轮/悬停的实验 `onPointerEvent` 集中在 BrowserPointer。其余页面不声明 Foundation/Layout/Compose 实验 API。相关直接调用没有稳定的 Web 等价入口，窗口输入适配不承担业务或布局。
