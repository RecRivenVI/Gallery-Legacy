# 桌面与浏览器安全策略

桌面只授予主窗口实际调用的命令；Go 会话由宿主拥有，退出时协作结束，不按进程名称回收。具体权限与 CSP 的唯一来源是 `src-tauri/capabilities/`、`permissions/` 和 `tauri.conf.json`。

浏览器的 HTML CSP 响应头由同一 tauri.conf.json 生成到 api/security_generated.go；模板不手写第二份策略。worker 的 blob 来源用于 Skiko 的浏览器线程，字体由 fetch 读取并交给 Skia，不开放远程脚本。

## Compose 样式

`dangerousDisableAssetCspModification` 仅包含 `style-src`。Compose/Skiko 会在运行时创建画布、输入与语义元素的内联样式；Tauri 自动插入的样式 nonce 会阻止这些运行时样式，导致输入位置与缩放布局失效。因此保留 `style-src 'self' 'unsafe-inline'`，不自动改写样式指令。脚本仍只允许自身与 Wasm 编译，不开启全局 Tauri 对象，也不放开远程脚本。

## 字体与媒体

字体全部本地读取，不放行小米 CDN。Tauri 的 gallery-font 虚拟协议仅开放 misans-cdn 资源，字体读取不依赖 Go 服务；网页使用同源资源路由。源媒体通过 Go 的只读授权路径访问，宿主不获得任意路径读写命令。
