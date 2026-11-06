# 合成夹具

[metadata 固定夹具](../../internal/metadata/testdata/README.md)保存从提交 20ff819 的 Node Adapter 冻结的人工输入和黄金结果，覆盖数字精度、类型漂移、Unicode 与富文本。不含真实身份、媒体或私有路径，不由待测 Go 实现更新期望。

[Go 生成器](../../tools/demo/main.go)创建九平台抽象图片、动图、可选短视频、48 页作品、独立文件根和空工作库。作品通过管理器自己的扫描入库。

测试临时树、数据库、截图与失败证据在仓外。场景见[新栈验证](../../validations/scene-full_stack/validation.md)。
