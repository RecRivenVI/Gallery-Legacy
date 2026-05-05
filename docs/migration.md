# 未来技术迁移边界

当前仍为 Node / Electron / JavaScript。未实现 Go、Compose Multiplatform、WasmJS、Miuix 新前端或 Tauri；没有空实现、双 Runtime 或语言桥。

- Go 可逐职责替换 internal/library、metadata、catalog、search、indexing、publication、runtime、server；保持 physical identity、Catalog v4 和 publication 的行为契约。
- Compose Multiplatform + WasmJS + Miuix 根据 protocol 和前端 query/result/preferences/viewer 行为测试重新实现，不继承旧失败客户端工程。
- Tauri 只替换 desktop 宿主：窗口、tray、Runtime 进程、必要 IPC。Manager 业务状态继续属于 frontend 和服务协议。

此前 Flutter 工程不再是正式技术路线，Miuix 实验也不是未来实现基线。保留的产品经验是：取消过期请求、统一 URL/query、筛选与搜索分离、键盘/鼠标可用的 viewer、跨页返回定位、布局偏好和断线恢复。对应行为应以人工测试而非旧客户端代码作为回归依据。

八个平台以外的需求出现时直接增加对应代码和测试；不预建插件发现、metadata DSL、微服务或大型依赖注入框架。
