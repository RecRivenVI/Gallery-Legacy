# 合成夹具

[test/fixtures/metadata](../../test/fixtures/metadata)只存人工重建的公开安全输入，不含真实身份、路径、媒体地址或私有正文。保留数字精度、类型漂移、Unicode 和富文本结构。

corpus.json 定义结构样本，shapes.json 固定对应签名；Go 测试黄金输入由现有 Node Adapter 在这些样本上生成，不读取真实库。坏 JSON、非对象、缺失 metadata 及源 ID 冲突不应丢弃物理作品。

测试临时树和数据库留仓库外。场景与通过标准见[验证定义](../../validations/scene-gallery/validation.md)，不使用历史实例清单排除测试。
