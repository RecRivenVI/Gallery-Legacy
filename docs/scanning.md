# 全库扫描

```powershell
npm run scan -- --config <实例配置文件> --confirm-read-only
```

Manager 的全库扫描按钮调用相同用例，并要求明确勾选只读确认。扫描只读八个平台 source roots，所有候选数据库与报告只写当前实例。不存在旧 Scanner、文件改名、metadata 编辑或源文件删除入口。

拓扑固定为平台根的直接作者目录、作者目录的直接作品目录；作品内安全递归观察 regular files，不跟随 symlink/reparse。真实 `mtimeNs` 使用 BigInt stat，媒体不读内容、不 hash。metadata 以严格 UTF-8 读取并保留原文；读取竞争、不完整枚举具有明确诊断。

Metadata 缺失、不可读、损坏、非 object、缺 ID，都保留物理作品。重复源 ID 保留多个物理身份。声明媒体和实际文件分离，计数只来自实际文件。

任意所需目录范围观察不完整，会向作者/平台及构建结果传播。**不完整 Catalog 不能成为 READY generation**，失败候选保留为实例内证据，当前活动指针不变。

扫描按作品流式处理，按固定批量提交；每位作者仅保留必要的当前权威候选，不建立全平台作品快照。进度状态独立于 Runtime 状态机：IDLE、SCANNING、BUILDING_SEARCH、VALIDATING、PUBLISHING、READY、FAILED。

Manager 展示平台、generation、作品/实际媒体计数、metadata 状态、耗时、吞吐、RSS/heap、诊断、已加载与已发布代的差异。报告位于实例 reports，只含聚合事实。

mtime 权威有已接受的限制：外部工具改变内容却刻意保留 mtime，未来增量策略不会额外用媒体内容 hash 弥补。当前产品全库构建不提供增量 diff、rename 推断或删除生命周期。
