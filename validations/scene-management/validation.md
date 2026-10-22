# 管理会话与任务迁移

## 目标

用同一新合成输入和冻结 Node 核对任务、配置、诊断、恢复及本机所有权；101 号的管理器绑定按新决定验证，不沿用独立存活。最可能的失败是退出残留任务、已提交事务丢失和外部绕过管理器启动。

## 运行

1. 在仓外构建 gallery-runtime 与用于冻结 Node 对照的 gallery-scan；后者只是验收工具，不进入产品构建。源码入口分别为 cmd/gallery-runtime 和 cmd/gallery-scan。
2. 显式设置 GALLERY_TEST_ROOT 为本轮 Scratches 合成根，GALLERY_LIFECYCLE_EVIDENCE 为本轮 Artifacts 结果目录，GALLERY_NODE_REFERENCE_ROOT 为冻结 Node 构建；不得使用仓库当前 Node 冒充冻结对照。
3. 设置 GALLERY_RUNTIME_EXE、GALLERY_SCANNER 指向上述仓外可执行；设置 GALLERY_ASSETS_ROOT 为已准备且合法的界面资源，不含真实图库或配置。
4. 运行 `npm run test:lifecycle-reference` 生成 Node 参考和小合成素材，再运行 `test:manager-lifecycle`、`test:management`、`test:inspection`、`test:static-task`、`test:static-schema`。最后一项在冻结 Node 的 Catalog 上比较同源 DDL 的现行 Node Search 与旧 Search。
5. 运行 `npm run test:interruption`，只对自建实例注入退出与进程崩溃。重用已有本轮大合成源时，GALLERY_INTERRUPTION_INPUT 指向其生成根；不复制真实源。
6. 用已配置 raceCompiler 构建带 `-race` 的 gallery-runtime，对受影响任务与控制包运行 race；标准 Go 构建／测试入口见工作流。
7. 设置 GALLERY_NATIVE_LOADER 为仓外验证启动器：只把测试窗口 show 改为 showInactive、禁止 focus，再加载当前 src/desktop/main.js；不更改 IPC、URL、frame 或进程核验。运行 `npm run test:manager-browser`，只通过 Playwright 与应用命令接口操作自有窗口，不发送桌面键鼠。
8. 打开并查看每张截图；截图前等待界面本身进入目标状态，而不是仅等待后端完成。结果与未验证项写进仓外摘要，旧报告不改写。

## 通过标准

- 与冻结 Node 比较正常数据、拒绝码、真实管道请求／回复和身份关系；时间、PID、UUID、日志格式与采样计时不要求位一致。结论用一致／有差异／无法比较。
- 管理器内完成启停、全量／增量、范围选择、取消、配置保存、检查、只读 scope、清理计划和恢复发布；不在新 Go 链中调用 Node writer。
- 错误令牌／实例、伪回复、重复所有者和外部启动被拒绝。进程仍活着而任务租约已结束时不能继续报运行中。
- 进行中退出保留完整已提交事务，Catalog／Search／revision 仍一致；崩溃重开保留事务并报告原任务结束；完成后退出并重新打开可读取结果。
- 关闭窗口隐藏仍保持服务；真正退出等待扫描／服务／队列关闭，不留该实例的后台进程或租约，不控制其他实例。
- 当前网页与管理四页可通过 Go 候选使用；看过深浅色、窄窗口与放大字号截图。自动截图不代替真实托盘、目录对话框、输入法、读屏、真机与性能验收。
- 清理只涉及自有合成数据并进入回收站；生产、真实源和历史 Runtime 不参与。
