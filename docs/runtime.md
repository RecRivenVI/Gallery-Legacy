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
  state/{runtime.json,scan.json,runtime.lock,scan.lock}
  desktop-data/{session/,crashes/}
```

默认只监听 loopback。Manager 可以连接已启动的同一实例，或通过薄宿主启动 Runtime。连接时校验实例标识，不能把占用相同端口的另一实例误认成自己。

状态机：`STARTING → READY → STOPPING → STOPPED`；启动异常进入 `FAILED`。READY 是进程状态，不是“磁盘上曾存在 READY 字样”就代表在线。

所有权由独占 Windows 命名管道和磁盘锁共同保护。锁记录 PID、进程创建时间、可执行文件身份、随机 owner token；PID 重用不会被当成同一 owner。身份无法验证时拒绝抢占。进程退出后 OS 自动释放命名管道，下次启动可纠正 stale lock/READY。

正常关闭释放 HTTP、WebSocket、Catalog/Search、缩略图任务和锁。Electron 只关闭自己启动的 Runtime；连接已有 Runtime 时退出 Manager 不停止它。独立扫描进程拥有自己的 scan lock，可继续完成；其退出状态通过扫描状态及进程身份核验判断，不依赖 Manager 存活。

缓存、日志、临时数据、Electron session/crash 数据均属于实例，绝不写到 generation 或 source roots。实例不能位于 source root 内，source 也不能位于实例内。
