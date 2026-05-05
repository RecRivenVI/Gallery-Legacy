# 配置

公开仓库只包含 `config/runtime.example.json` 和字段说明，不包含本机路径或密钥。

结构约定见 `config/runtime.schema.json`，实际路径与边界验证由 `internal/instance/config.js` 执行。

本地实例配置必填：`instanceRoot`、`sources` 中固定八个平台的绝对物理根。ID/family/Adapter 版本只来自代码。库根不可互相重叠、不可包含实例，实例不可包含库根。注册目录不允许 symlink/reparse alias。

`host` 默认为 `127.0.0.1`，`port` 默认为 `18104`，`mode` 默认为 `local`。可信 LAN 必须显式 `mode: "lan"`，并绑定具体的私网 IPv4 地址；不允许 `0.0.0.0` 或默认公网暴露。

可选路径：`generationsRoot`、`cacheRoot`、`logsRoot`、`tempRoot`、`stateRoot`、`reportsRoot`、`desktopDataRoot`。它们都必须位于实例内；可写目录互不重叠，且不能与 generation 重叠。不接受直接指定 Catalog/Search 文件的旧式配置。

启动配置通过 `--config` 指定；扫描按钮要求实例根中保留同一份 `config.json`。不要将实例数据库、配置、日志、session 或真实样本复制回公开 Git tree。
