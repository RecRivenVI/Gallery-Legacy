# 合成 metadata 标准答案

normalized.json 是合成公开格式样例的固定标准答案，由提交 20ff819 的 Node 适配器/shape 及当时的 tools/validation/prepare.cjs 生成。它包含原始合成 JSON 与期望规范化结果，不含图库、账号或本机路径。

该文件不是 Go 解析器自身生成的答案，不手工修改。需要重新生成时从该 Git 提交在仓外恢复原工具和测试夹具，再核对来源；不能用待测 Go 输出覆盖它来使测试通过。运行时不依赖 Node。
