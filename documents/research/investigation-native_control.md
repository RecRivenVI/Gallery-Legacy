# 原生管理控制与生命周期调查

2026-10-21

## 问题

结论为“有差异”：四页切换后的控制失败可稳定复现，Windows 身份查询存在并发超时，生命周期自动场景的等待条件及退出清理顺序会掩盖原异常。三者不能合并解释成扫描器或数据库阻塞。

## 方法

只使用新建合成实例。旧检查点构建与修复候选使用相同页面切换、控制调用、关闭／再打开、重启／停止脚本；独立比较 CIM 与本机进程对象的身份字段和并发查询。证据留在仓库外本次 NativeControl 产物目录，不读取生产配置或真实作品。

## 发现

### 页内路由被当成其他文档

`src/desktop/main.js` 的 IPC 守卫原来逐字比较 frame URL 与管理首页。初始无 fragment 的页面调用成功；`public/manager/main.js` 换页写入 `#access`、`#settings`、`#diagnose` 后，调用在约 16～56 毫秒即返回 HOST_CALL_FORBIDDEN。页面将它显示成服务没有响应，并非真正等待网络超时。

`trusted-page.js` 只忽略同一管理文档的 fragment；本窗口 webContents、顶层 frame、精确文件路径和操作白名单继续核验，其他文件、查询串、远程 URL 仍拒绝。修复后同一组四页请求均成功；自动原生场景另覆盖扫描、访问范围和开关、保存重启、环境检查、停止再启动及两轮四页轮询。

证据：before.json、after.json、native-operations.log；回归位于 test/desktop/trusted-page.test.js、host.test.js。

### CIM 服务是身份查询的额外等待点

同 PID 的普通查询，两种方法返回相同 PID、创建时刻和可执行路径。24 个并发 CIM 查询有 16 个在原有 10 秒边界被终止；同组 System.Diagnostics.Process 查询没有超时，最慢约 6.70 秒。原始 JSON 的 signal 才能确认终止；早期控制台只按 code 计数，遗漏了 code 为 null 的 SIGTERM，不能作为零失败证据。

查询改用本机进程对象，保留旧创建身份的微秒精度、原 10 秒超时及每次新查询，不缓存身份、不重试、不按 PID 兜底。查询活进程失败仍返回 OWNER_UNVERIFIABLE，并保留 cause。压力复现说明 CIM 等待可以导致波动；历史每一次 OWNER_UNVERIFIABLE 缺少原提供者诊断，不能逐次断言都由同一原因造成。

证据：identity-before.json、identity-related.log；回归位于 test/runtime/status-latency.test.js。Go race 不能检测 Node/Electron IPC，因此不把 race 通过写成上述修复的依据。

### 生命周期的真实完成与自动等待混在一起

旧原生场景在 180 秒边界取消；定位到等待停止按钮时可能在节点尚未存在时抛异常，随后失败清理先等待 Electron 启动壳退出、再停止独立 Runtime。Windows 的启动壳及继承进程句柄使清理长等待，原始失败不易显现。单独运行的相同生命周期脚本可以正常退出，不能据此认定所有长等待都是产品死锁。

场景现在等待真实节点和非忙状态；失败清理先停止本测试拥有的 Runtime，再等待 Playwright.close。正常管理器退出路径仍先验证服务存活、同 PID 重连，最后才显式停止。Manager PID 从 Electron 主进程取得，不把 Playwright 启动壳 PID 当作管理器身份。缺失图标另用有效合成 PNG 解决测试夹具的启动失败，没有增加产品 fallback。

相同脚本的前后实测：

| 完成点             |        修复前 |        修复后 |
| ------------------ | ------------: | ------------: |
| 首次启动至页面就绪 |      10.50 秒 |       7.33 秒 |
| 隐藏／重新显示     | 4.9／9.1 毫秒 | 5.7／8.9 毫秒 |
| 管理器退出         |       1.75 秒 |       1.16 秒 |
| 重新连接已有服务   |       7.11 秒 |       5.34 秒 |
| 重启到可操作       |      11.27 秒 |       7.42 秒 |
| 停止服务           |       2.03 秒 |       2.06 秒 |

这是本机有界诊断，不是统计性能承诺。单独停止没有明显改善，不能只列变快的项目。没有延长产品超时。OS 内核句柄的精确持有者未独立追踪，不把等待机制的推断扩展为已证明的内核根因。

证据：native-before.log、native-trace-detail.log、lifecycle-comparable-before.json、lifecycle-comparable-after.json；正式验证定义见 [原生管理场景](../../validations/scene-native_manager/validation.md)。

### race 环境与界面状态

独立免安装 MinGW-w64 可以运行最小 race 程序及相关 Go 包；版本、来源和 SHA256 只在[依赖说明](../reference/dependency-runtime.md)维护。不替换旧工具或修改系统环境。本次未改 Go 流水线，race 不替代进程身份的回归。

服务状态读取失败时，页面统一为无法读取，保留上次确认的非服务统计，避免总数错误归零。访问／日志的错误与空状态互斥，重试在对应面板；环境检查从呼吸占位转成对勾／叉。B 组细节只作为[待确认决定](../design/adr-4-manager_details.md)，不是用户批准。

## 结论

针对已复现的边界与等待点修复，没有放宽身份或实例认证。自动原生功能与人工日常体验分开：真实托盘点击、目录选择、输入法候选窗、读屏和真机仍需用户或专项验收；生产及历史 Runtime 没有迁移或切换。
