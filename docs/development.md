# 开发与验证

当前技术栈为 Node 22、Electron、原生 ES modules；根 package/lockfile 是唯一依赖权威。

```powershell
npm ci
npx playwright install chromium
npm run check
npm run check:electron
npm test
npm run build
```

源码公开前运行 `npm run audit:tree`。真实验收只能显式执行 `npm run accept -- --config <私有配置> --confirm-private-read-only`，它连接已启动实例，不扫描、不发布，只写实例内聚合报告；不截图或导出私人内容。

`npm test` 递归运行 tests 中全部 `.test.js`，没有排除名单、旧素材 manifest 或私有 corpus 依赖。`npm run test:core` 仅供开发时快速检查 library/metadata/media/catalog，不替代完整验收。

测试分为物理观察、Metadata、媒体、SQLite、索引、发布、Runtime、API、浏览器和 Electron。浏览器/Electron 测试只使用临时人工树，不截图、不录屏。需要 Playwright Chromium、Node、PowerShell；视频验收需要 FFmpeg/ImageMagick。所有测试数据库均清理。

`tests/disposition.json` 仅为旧覆盖重新评估的记录，不参与 runner：30 个旧排除单元文件的有效行为在当前模型中重写，15 个仅涉及废弃 source-keyed 增量 mutation/diff 的文件退休。它们不再留在主测试目录中。

`fixtures/metadata/` 包含八个平台人工基准、35 份重构结构样本、异常输入及冻结 shape hash。保留类型、长 ID、Unicode、富文本和冲突行为，不保留真实作者、正文、URL 或来源路径。

构建输出为 ignored `dist/gallery`，只包含产品源码及锁定的生产依赖；它不是运行数据目录。旧 dist 必须显式移走后才能重新构建。Electron 分发需要安装相同 lockfile 的开发依赖，本项目不把本地依赖/build 产物提交到 Git。
