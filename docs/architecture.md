# 架构

```text
cmd/                 薄 CLI
internal/
  library/           固定平台、物理身份、只读观察、路径安全
  metadata/          九个显式 Adapter、来源证据、结构签名
  media/             实际媒体资格、声明匹配、缩略图与文件读取
  catalog/           Schema v4、映射、事务写入、只读读取、验证
  search/            Search v5 构建与查询
  indexing/          全量/增量/定向候选更新、完整性与任务进度
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
固定九平台 + 本地 source bindings
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

静态 Runtime 读取活动指针指定的 READY 代；显式实时模式从它初始化独立 live 数据库，完整批次与搜索同事务可见。READY 本身始终不可变。正式代码不导入 tests、fixtures 或 extensions。UI 不导入后端模块、不读 SQLite；Electron 不实现索引或数据管理逻辑。详见 [实时更新](live-updates.md)。

增量/定向更新复制已验证 Catalog 到新 candidate，完整观察所选范围后才确认删除，scope 外继承基线。顶层平台支持多选；提取版本变化可扩大必要重提取范围。Search 对兼容基线复用未变文档，只维护变化的全文索引；旧格式首次升级和全量重提取仍完整构建。发布仍为单一原子指针，READY 文件不可变。

Runtime 可在没有数据的首次启动时提供空视图、状态和前端，不制造空 READY 数据库，也不读取 BUILDING candidate。新检查点发布后在后台验证 Catalog/Search，成功才把新请求切到同一数据版本；已开始的请求继续使用原读者直到响应结束。不是改写正在读取的数据库。live 模式的正常提交仍在同一个 epoch 内可见；损坏或显式切换 live 基线仍走保守恢复流程。

本机验证、日志和缓存运维在 runtime 中调用既有事实层，私有结果只写 instance。测试浏览器 Manager 是 tools 中的独立回环宿主，不进入正式 Server 管理链。

Venera 下载库遵循同一物理观察链，目录分别代表书籍/章节；没有可证明的上游 ID 时保持 null。Venera 客户端保留 `local_gallery` source key 和 `/p/<platform>/<author>/<work>` 收藏身份，经当前 Catalog 路径索引解析，不使用 rowid 作为持久 ID。

`internal/library/file-browser.js` 只读显式文件根，不是第十个平台；复用媒体响应与缩略图服务。媒体默认展示顺序按自然数字排序，观察/身份顺序不变。封面隐藏、提取预览和 `.nocover` 使用展示事实，不删除实际媒体。
