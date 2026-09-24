# Catalog/Search generation

Catalog Schema v4 与 Search v5 共同组成一代数据，不是两个可以独立配置的数据库文件。

发布顺序：

1. 创建全新 BUILDING 目录。全库 full 从空 Catalog 流式构建；增量/局部更新从已验证 READY 复制 Catalog 后只写 candidate，原 READY 始终只读。
2. SQLite checkpoint(TRUNCATE)，切换 DELETE journal，关闭连接，无 WAL/SHM/journal。
3. 从最终 Catalog 构建 Search，记录 Catalog SHA-256、大小、mtime、计数与版本；收口 Search。
4. 外键、完整性、业务计数、物理完整性、交叉绑定验证。
5. 对最终文件 hash，写 VALIDATED/READY manifest。
6. 同目录临时指针写入并 fsync，再通过 rename 原子替换 `active-generation.json`。

READY 后没有正式的原地修改/重建出口。Runtime 使用只读连接；thumbnail/cache/state/log 不属于 generation。主 DB hash 对应已收口的全部权威内容。

启用实时更新时，`instance/live/catalog.sqlite` 是活动 READY 的实例级可变工作副本；它带独立 epoch、单调 revision、base generation 和 ID 高水位，并使用 `live_*` Search 命名空间。它不属于 generation、不参与 READY hash，也不是损坏 READY 时的 fallback。最终 candidate 仍走完整 Catalog/Search 验证和原子 active pointer 发布，成功发布后才把已确认删除应用到 live 并推进 base generation。

局部 candidate 仍包含固定九平台的完整 Catalog/Search。scope 外事实继承自基线；scope 内只有完整目录枚举后才应用删除。任何 scope 不完整、取消、进程中断、Catalog/Search 验证失败都不替换 active pointer。Search 仍生成独立文件，但兼容增量基线仅维护变化文档；进度中的 `search`、最终报告中的 `searchBuild` 明示 `buildMode/reusedWorks/updatedWorks/removedWorks`。旧 `searchRebuilt=true` 只表示生成了新 Search 文件，不代表全部文档重建；最终报告 `search` 继续保存已验证文件事实。

```powershell
npm run validate -- --config <配置>
npm run publish -- <已验证generationId> --config <配置>
npm run rollback -- <先前READY的generationId> --config <配置>
```

发布与回滚通过相同验证。失败不替换当前指针。已有数据时缺失、损坏或非 READY 指针 fail closed，不猜测最新目录。静态 Runtime 在后台验证新指针对应的 READY，再完整替换读取上下文；每个在途请求固定使用原上下文，完成后释放，不混用两代 Catalog/Search。验证失败保留当前服务。live 正常扫描由同一事务推进检查点；显式回滚或检查点恢复涉及替换 live 工作副本时仍需重启。

发布后保守执行 retention，也可显式 `npm run retain -- --config <配置>`。active pointer 保留 previousGenerationId；active、loaded、当前构建、最近回滚 READY 和显式 pin 永远保留。更旧未引用的 READY/废弃 candidate 超过配置期限后可移除；unknown manifest、owner 不可核验、文件正在使用时不删除。清理失败不把已成功发布误报成扫描失败，结果写实例 reports。维护与 Runtime 解析/发布共用独占 lease，不删除正常 Runtime 正在打开的代。

Search v5 使用完整字符 FTS 候选和精确子串校验处理 1–2 字符查询；较长查询使用 trigram FTS。没有按正文长度或字符数量截断短词覆盖。标签筛选按精确标签 identity 关联，和综合搜索分开，组合时取交集。
