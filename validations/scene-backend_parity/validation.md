# 后端合同验证

## 目标

核对 Go 与迁移前冻结合同的一致性，保持单 writer、源只读、WAL/FULL、身份及恢复边界。只使用合成输入。

## 运行

1. 将 GALLERY_CONTROL_ROOT、GALLERY_UNIT_ROOT 指向仓外新的合成结果目录，执行 npm run test:go、npm run vet:go、npm run test:race。
2. metadata 使用 internal/metadata/testdata 中从提交 20ff819 冻结的 36 项黄金结果。不能由待测 Go 实现重写期望。
3. 如需重放完整历史 Node 差分，从 Git 提交 20ff819 在仓外提取代码，按该提交的命令生成黄金结果，向当前相应 Go 测试显式提供 GALLERY_*_GOLDEN。正常测试未提供时会跳过这些历史差分，不能记作已经比较。
4. 在[新栈场景](../scene-full_stack/validation.md)运行实际 Tauri、Compose 两端主要操作；证据留在仓外，保留失败。

## 通过标准

固定输入的顺序、稳定 DTO、错误码、数据库完整性与身份边界一致。未重放的历史批次写“无法比较”；已知 HTTP 差异单列，不用测试数量冒充功能完成。
