# 管理会话与桌面宿主

Tauri 管理器拥有 Go 会话和其中的服务、扫描任务。真正退出时等待它们正常结束；隐藏窗口不影响运行。[生命周期决定](adr-8-manager_lifecycle.md)继续有效，宿主替换见 [adr-9](adr-9-full_stack_migration.md)。

## 边界

- `src-tauri/src/backend.rs` 启动 Go，关联请求 ID 与回复，检查 ready 中的实例、子 PID 和父 PID。
- `src-tauri/src/main.rs` 仅接收 manager 窗口、精确的本地应用文档所发固定命令；外部导航不进入管理文档。目录访问来自 Go 返回的位置或原生文件夹选择器。
- `internal/host/session.go` 核验直接父进程 Gallery.exe 的完整身份、继承管道和实例租约。公开 HTTP 不能替代本机管理通道。
- `internal/control` 保留创建时间、可执行路径、实例、令牌与回复归属检查。不能仅凭 PID 或端口推断所有者。

## 启动与关闭

1. Tauri 根据显式配置启动一个 Go 管理会话；用户数据位于该实例的 desktopDataRoot。
2. Go 取得 manager 租约，再由会话内操作启动 runtime、更新和检查。
3. 关闭窗口只隐藏到托盘；托盘可以重新显示管理器、打开画廊或退出。
4. 退出关闭继承输入管道；Go 协作取消、等待任务/事务、关闭 WebSocket 和服务、释放租约。Rust 等待 Go 退出后结束应用，不按进程名杀进程。
5. 父进程身份丢失走相同的 Go 取消路径。新实例不接管身份不明确的旧所有者。

设置保存后仍由 Go 校验修订并持久化；需要重启时由会话正常停/启。打开画廊使用当前会话地址，不能缓存旧端口。四页 UI 的保存条仅在设置页出现，封禁立即生效。
