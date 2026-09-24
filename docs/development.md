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

`tests/disposition.json` 仅为历史覆盖审计，不参与 runner。旧实现测试仍退休，但增量／定向更新的用户行为已由 `tests/indexing/incremental.test.js` 等新物理身份测试恢复；不能用“旧实现退休”代替功能覆盖。全部新测试默认运行。

`fixtures/metadata/` 包含九个平台人工基准、35 份重构结构样本、异常输入及冻结 shape hash。Venera 使用人工书籍/章节目录测试，不从真实下载库复制内容。保留类型、长 ID、Unicode、富文本和冲突行为，不保留真实作者、正文、URL 或来源路径。

构建输出为 ignored `dist/gallery`，包含当前源码及锁定的生产依赖；它不是运行数据目录。旧 dist 必须显式移走后才能重新构建。`npm run package:windows -- --out <新的绝对目录> --config <私有配置> --node-license <同版本官方Node的LICENSE文件>` 将锁定 Electron、当前 Node 和 runtime 组成独立 Gallery.exe 分发目录；保留依赖许可，不升级依赖、不修改已存在安装目录。依赖/build/安装包不提交到 Git。

可用 `node tools/package-smoke.js --package <安装目录> --report <报告文件>` 验证真实 portable 可执行文件；它只创建系统临时人工库，核验 bundled Node、窗口、托盘及 Manager 退出后 Runtime 继续运行，然后清理测试实例。

Manager 的测试用浏览器宿主只允许显式 staging 回环实例，见 [test-manager.md](test-manager.md)。不是 Computer Use，也不对生产开放管理 HTTP。
