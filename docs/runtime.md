# Runtime 与实例

实例与源码完全分离，`instanceRoot` 可以位于任何通过安全检查的独立物理目录。Windows 路径会先解析到实际物理位置，避免应用容器重定向造成所有权或写入边界分裂。

实例配置/锁/原子 JSON 操作归属 `internal/instance`，启动组合归属 `internal/runtime`。CLI 将 SQLite、PowerShell 和编码器临时文件定向到实例 temp。

```text
instance/
  config.json
  generations/<id>/{catalog/,search/,manifest.json}
  active-generation.json
  cache/
  logs/
  temp/
  reports/
  state/{runtime.json,scan.json,runtime.lock,scan.lock,maintenance.lock}
  desktop-data/{session/,crashes/}
```

默认只监听 loopback。Manager 可以连接已启动的同一实例，或通过薄宿主启动 Runtime。连接时校验实例标识，不能把占用相同端口的另一实例误认成自己。

状态机：`STARTING → READY → STOPPING → STOPPED`；启动异常进入 `FAILED`。READY 是进程状态，不是“磁盘上曾存在 READY 字样”就代表在线。

全新空实例可以启动：`libraryReady=false` 表示服务在线但尚无已发布图库，UI/扫描状态可用，列表为空；扫描仍由本机管理器发起。已有 READY 而活动指针丢失/损坏不会猜测最新目录。首次扫描完成后自动接入有效版本。

静态读取服务在后台验证新发布的 Catalog/Search 后自动应用，不重启 HTTP/WebSocket，不中断已开始的媒体传输。失败继续服务旧数据并报告 `applyError`，不会读取未验证候选。媒体链接额外绑定稳定物理路径和身份摘要，避免跨代整数 ID 重用。实时模式正常扫描在原 live epoch 提交；手工回滚、损坏恢复仍可能要求停服重置。

所有权由独占 Windows 命名管道和磁盘锁共同保护。锁记录 PID、进程创建时间、可执行文件身份、随机 owner token；PID 重用不会被当成同一 owner。身份无法验证时拒绝抢占。进程退出后 OS 自动释放命名管道，下次启动可纠正 stale lock/READY。

关闭 Manager 窗口只隐藏到托盘；托盘退出只退出 Manager，后台 Runtime 继续运行。明确的“停止服务”才释放 HTTP、WebSocket、Catalog/Search、缩略图任务和锁。Manager 可以管理由 CLI 或另一 Manager 启动的同一实例，必须通过进程创建时间、可执行文件、instanceId 和随机 token 验证，不能按 PID 直接 kill。独立扫描进程可继续完成，不依赖 Manager 存活。

开发 CLI 支持 `node cmd/gallery/main.js start|stop|restart|status --config <配置>`。`start` 生成脱离终端的后台进程；`serve` 是前台/宿主无关入口。Manager 先展示本地 UI，启动失败后窗口仍保留错误码和重试操作。正常退出解除 managerPid；异常退出后 Runtime 在状态检查时核验并清除失效身份。

发布、启动解析和 retention 共用实例 maintenance lease。运行中的旧代始终受保护。Windows 分发目录与实例目录独立，`Gallery.exe` 旁的私有 `gallery.instance.json` 只指定实例配置位置。无效配置的诊断窗口使用用户本地应用数据中的独立 failure 目录，不使用被拒绝的源路径。

缓存、日志、临时数据、Electron session/crash 数据均属于实例，绝不写到 generation 或 source roots。实例不能位于 source root 内，source 也不能位于实例内。

本机 Manager 的配置、日志、版本、访问、存储、诊断能力见 [管理中心](management.md)。关闭窗口仍隐藏到托盘，退出 Manager 仍不隐式停止独立服务。
