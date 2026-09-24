# 配置

公开仓库只包含 `config/runtime.example.json` 和字段说明，不包含本机路径或密钥。

结构约定见 `config/runtime.schema.json`，实际路径与边界验证由 `internal/instance/config.js` 执行。

本地实例配置必填：`instanceRoot`、`sources` 中固定九个平台的绝对物理根（包含 `Venera`）。ID/family/Adapter 版本只来自代码。库根不可互相重叠、不可包含实例，实例不可包含库根。注册目录不允许 symlink/reparse alias。

`listenAddress`（兼容 `host`）默认为 `127.0.0.1`，`port` 默认为 `18104`，`mode` 默认为 `local`。可信 LAN 使用 `mode: "lan"` 和具体私网 IPv4。公网只读使用显式 `mode: "public"`、监听地址及 `allowedHosts`，不会默认开放公网。

`allowedHosts` 是精确 authority（域名及端口），`allowedOrigins` 是精确 HTTP/HTTPS origin，`publicUrl` 是 Venera source 的默认服务 origin。localhost 的本机访问仍保留。只对明确允许的跨源读取响应 CORS，绝不使用 `*`。管理能力不依赖 HTTP Host 或源 IP，始终走实例私有 token 保护的本机管道。

`fileBrowserRoots: [{id,name,path}]` 只读指定目录及媒体；不能与实例重叠，不跟随链接，不开放任意路径。允许文件根包含注册图库，但它不进入 Catalog/平台列表。`shortLinks` 是短码到本站相对 URL 的私有映射，禁止外站重定向。

`retention: {enabled:true, staleAfterMs:86400000}` 默认保留 active/loaded/building/最近回滚 READY/显式 pin；更旧且未引用的代至少经过 24h 才可能清理。未知身份或无法验证的目录一律保留。

`deployment` 为 `development`、`staging` 或 `production`，只标识实例用途，不改变安全权限；staging Manager 明确显示 TEST INSTANCE。

可选路径：`generationsRoot`、`cacheRoot`、`logsRoot`、`tempRoot`、`stateRoot`、`reportsRoot`、`desktopDataRoot`。它们都必须位于实例内；可写目录互不重叠，且不能与 generation 重叠。不接受直接指定 Catalog/Search 文件的旧式配置。

启动配置通过 `--config` 指定；扫描按钮要求实例根中保留同一份 `config.json`。不要将实例数据库、配置、日志、session 或真实样本复制回公开 Git tree。
