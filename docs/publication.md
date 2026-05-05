# Catalog/Search generation

Catalog Schema v4 与 Search v5 共同组成一代数据，不是两个可以独立配置的数据库文件。

发布顺序：

1. 创建全新 BUILDING 目录，流式构建 Catalog；Writer 全部关闭。
2. SQLite checkpoint(TRUNCATE)，切换 DELETE journal，关闭连接，无 WAL/SHM/journal。
3. 从最终 Catalog 构建 Search，记录 Catalog SHA-256、大小、mtime、计数与版本；收口 Search。
4. 外键、完整性、业务计数、物理完整性、交叉绑定验证。
5. 对最终文件 hash，写 VALIDATED/READY manifest。
6. 同目录临时指针写入并 fsync，再通过 rename 原子替换 `active-generation.json`。

READY 后没有正式的原地修改/重建出口。Runtime 使用只读连接；thumbnail/cache/state/log 不属于 generation。主 DB hash 对应已收口的全部权威内容。

```powershell
npm run validate -- --config <配置>
npm run publish -- <已验证generationId> --config <配置>
npm run rollback -- <先前READY的generationId> --config <配置>
```

发布与回滚通过相同验证。失败不替换当前指针。缺失、损坏或非 READY 指针 fail closed，不猜测最新目录。旧代不会自动 GC。运行中 Runtime 固定使用启动时打开的代，新发布代在下次启动才生效。

Search v5 使用完整字符 FTS 候选和精确子串校验处理 1–2 字符查询；较长查询使用 trigram FTS。没有按正文长度或字符数量截断短词覆盖。标签筛选按精确标签 identity 关联，和综合搜索分开，组合时取交集。
