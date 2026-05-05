# Gallery

面向固定八个平台的个人本地画廊，适用于 Windows、localhost 和少量可信局域网用户。

**文件系统是事实源；metadata 仅用于补充信息。** 作者/作品目录决定物理实体，真实文件决定媒体。缺失或损坏的 metadata、缺失或重复的源 ID 都不会删除物理作品。

## 使用

需要 Node.js 22.23.2、npm、Windows PowerShell，以及可从 PATH 调用的 FFmpeg 和 ImageMagick（封面/视频首帧）。依赖版本由根 `package-lock.json` 锁定。

```powershell
npm ci
npx playwright install chromium
npm test
```

复制 `config/runtime.example.json` 到**源码目录以外**的实例目录，填写该实例路径和八个平台的真实物理根。默认配置位置为 `%LOCALAPPDATA%/gallery-legacy/config.json`，也可以始终使用 `--config` 指定。

首次建立数据：

```powershell
npm run scan -- --config <实例配置文件> --confirm-read-only
```

启动浏览器服务或 Windows 管理器：

```powershell
npm start -- --config <实例配置文件>
npm run manager -- --config <实例配置文件>
```

Gallery 位于配置的服务地址；Manager 页面为 `/manage`。默认绑定 `127.0.0.1:18104`。Manager 可启动同一全库扫描用例并显示进度；新 generation 发布后，通过重启加载，不进行运行中热替换。

空实例必须先通过扫描建立 READY generation。启动失败不会回退到旧数据库或猜测最新目录。

## 功能

- 作品、作者、标签；综合搜索与独立精确标签筛选。
- 1–2 字符搜索、排序、游标/分页、图片/视频筛选。
- 图片筛选排除任何含实际视频的作品；视频筛选包含实际视频作品。
- 磁盘文件封面、视频首帧、图片/视频查看器、媒体 GET/HEAD/Range。
- 有界流式全库构建；Catalog Schema v4；独立 Search v5。
- Catalog/Search 同代绑定、发布前 SQLite 收口、原子活动指针、人工回滚。
- 实例所有权、进程身份核验、异常退出恢复、只读真实图库。

这不是通用平台、插件系统、下载器、多人账户服务或面向公网的 SaaS。

## 工程

正式代码位于 `internal/`；浏览器与管理 UI 位于 `frontend/`；Electron 仅为 `desktop/` 宿主；协议位于 `protocol/`。

当前实现为 Node/Electron/JavaScript。Go、Compose Multiplatform + WasmJS + Miuix、Tauri 是未来路线，**当前未实现**。

- [架构与目录](docs/architecture.md)
- [实例与启动](docs/runtime.md)
- [全库扫描](docs/scanning.md)
- [generation 发布](docs/publication.md)
- [配置](docs/configuration.md)
- [开发与测试](docs/development.md)
- [安全与隐私](docs/security.md)
- [未来迁移边界](docs/migration.md)

界面可使用本机已安装的 MiSans（归小米所有），否则回退到 Noto、微软雅黑、苹方或系统字体。仓库和构建不附带或下载字体文件，详见[字体分发说明](docs/security.md)。
