# 配置、读取与恢复验证

## 目标

确认 Go 从显式合成配置读取空库、工作库及 READY 恢复；坏库不被当空库，不从真实实例获取测试输入。

## 运行

1. 执行 npm run test:go、npm run test:race；数据库测试自行创建九平台合成空库，不依赖产品 Node CLI。
2. 受影响时单独运行 node tools/go/run.mjs test -count=1 ./internal/instance ./internal/dataset ./internal/reading ./internal/catalog。
3. 历史配置／读取差分按提交 20ff819 在仓外捕获固定黄金输入，再以相应 GALLERY_*_GOLDEN 环境变量重放。未提供黄金文件的跳过项不算已比较。
4. 复核来源绑定、空／坏／错误结构、修订、只读与关闭恢复结果；输出与失败证据放仓外。

## 通过标准

同一事实读取一致；已提交记录保留，来源、身份、READY 和事务检查不放宽。迁移不创建第二个 writer、不改生产或旧 Runtime。真实多盘长任务不由合成测试推定通过。
