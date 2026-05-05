# 架构

```text
cmd/                 薄 CLI
internal/
  library/           固定平台、物理身份、只读观察、路径安全
  metadata/          八个显式 Adapter、来源证据、结构签名
  media/             实际媒体资格、声明匹配、缩略图与文件读取
  catalog/           Schema v4、映射、事务写入、只读读取、验证
  search/            Search v5 构建与查询
  indexing/          唯一流式构建、完整性与任务进度
  publication/       收口、验证、READY、活动指针与回滚
  instance/          私有配置、所有权、统一原子文件操作
  runtime/           启动/关闭与服务组合
  server/            HTTP/WebSocket、输入校验、统一错误边界
frontend/            ES modules；Gallery 与 Manager
desktop/             Electron 薄宿主
protocol/            独立版本的接口约定
extensions/          不进入主运行链的纯附件规划函数
tests/               全部默认运行的人工数据测试
fixtures/            可公开的人工结构样本
tools/               检查、测试、构建及显式验收工具
config/              安全示例与 fixture 政策
docs/                当前产品文档
```

```text
固定八平台 + 本地 source bindings
  → filesystem observation
  → physical author/work/media + metadata enrichment
  → streaming Catalog writer
  → SQLite finalization → Search → validation → READY
  → atomic active-generation pointer
  → Runtime → HTTP/WebSocket → Gallery / Manager
```

根不包含任何真实图库配置。平台注册身份与 Adapter 版本来自代码，路径只来自实例。配置不能增加平台、改变 family 或禁用其中一个平台。

Observer 不解析 JSON，不判断封面，不写数据库。Metadata Adapter 不访问文件系统，不能授权实际媒体。Mapper/Writer 接受准备好的物理事实。媒体声明即便不匹配、有歧义或类型冲突，也不能删除实际文件。

作品使用 `(platform, relative_path_key)` 标识，作者同理。源 ID 是可空、可重复的文本补充信息。作者当前资料只来自最终选中的最新作品，缺字段不向旧作品回填。

Runtime 仅读取活动指针指定的 READY 代。正式代码不导入 tests、fixtures 或 extensions。UI 不导入后端模块，不读取 SQLite。Electron 不实现索引、搜索、数据管理或 Manager 业务状态。
