# 安全与隐私

目标是个人、localhost、可信 LAN，不提供账户、OAuth、RBAC、多租户或公网安全承诺。

- source roots 严格只读；JS 写入口有实例 write guard，SQLite/编码器输出另由显式路径边界约束。没有源文件修改能力。
- Host 必须对应已配置的本地地址；带 Origin 的请求必须同源。没有 wildcard CORS。管理操作仅允许来自本机网络边界。
- 输入非法返回稳定 4xx/error code；响应不输出内部 stack、私人绝对路径。内部数据库中的原始 metadata 是私有实例数据，不属于公开源码。
- READY generation 只读、没有原地修改出口。cache/temp/log/session 与 generation 分离。
- 只在可信机器上运行；路径/owner 检查不是抵御拥有同等 OS 文件权限的恶意进程的沙箱。
- 本地验收只记录聚合计数、状态、hash 和性能。禁止截图/录屏、私人作品/作者/正文/metadata 日志。

公开 tree 不包含认证材料、真实 metadata/media、SQLite、截图、session、缓存、日志或私人配置。旧项目与真实样本只在仓库外留存。

当前公开可达 Git 历史已重建为唯一根提交，公开 tree 已通过公私数据审计，并已替换远端旧分支历史。历史重写不能撤回已有 clone、fork、第三方缓存或曾经复制出去的数据。任何曾经暴露且仍有效的 credential 都需要独立轮换或失效；本项目不擅自联系外部认证服务，也不宣称所有旧数据已从互联网消失。

字体分发（2026-09-05 复核）：小米[官方许可协议](https://hyperos.mi.com/font-download/MiSans%E5%AD%97%E4%BD%93%E7%9F%A5%E8%AF%86%E4%BA%A7%E6%9D%83%E8%AE%B8%E5%8F%AF%E5%8D%8F%E8%AE%AE.pdf)第 2 节限制字体软件及副本的单独进一步分发；[官方 FAQ](https://hyperos.mi.com/font/zh/faq/)允许应用内嵌入，但没有明确授权公共源码仓库直接再分发字体文件。采用保守策略，仓库和构建不附带 MiSans 或其他字体二进制，也不从 CDN 或构建脚本下载字体。界面仅优先使用本机已安装的 MiSans（版权归小米），否则使用 Noto、微软雅黑、苹方或系统字体。字体权利不受 Gallery 代码许可覆盖；当前 tree 的清理也不能撤回历史下载副本或平台缓存。

锁定依赖审计（2026-09-05）：生产依赖无已知 npm 告警；Electron 安装器 `@electron/get` 的可选 HTTP 依赖 undici 7.28.0 有高危告警。它不在 Gallery 服务读取链中，也不是应用的账户/代理客户端。保留锁定版本，未自动执行 audit fix；维护时应单独更新并验证安装工具链。该检查不等同于对 Node/Electron 内核、FFmpeg 或 ImageMagick 的完整安全审计。
