# 生产替换前 staging

旧生产继续运行；staging 使用新的安装目录、instanceRoot 和端口。不要覆盖旧安装、旧数据库或真实图库，不修改反向代理或启动项。

1. 从旧配置迁入九个平台真实物理根、显式文件浏览根、生产 Host/Origin 和仍有效的本站短链，保存到仓库外的 staging config。绑定独立端口，设置 `deployment: "staging"`。
2. `npm run scan -- --config <staging-config> --confirm-read-only`。使用唯一正式九平台流式构建、完整性检查、SQLite 收口、READY 和原子发布流程；不能把旧八平台 manifest 改成九平台。
3. 完成 build/package，普通启动 `Gallery.exe`。Manager 显示 TEST INSTANCE；公网只能读取，管理仅限本机身份验证通道。
4. `node tools/production-acceptance.js --config <staging-config> --production-url <旧生产的loopback地址> --confirm-private-read-only`。它只读旧 API 比较九平台稳定路径，并核验新版 Web、媒体、Venera、短链和 Host/Origin。报告仅为聚合结果，不截图、录屏或输出私人内容。
5. 正常停启 staging，核验 READY generation 的文件集合、SHA-256、mtime 不变；不操作生产进程。
6. `node tools/soak.js --config <staging-config> --confirm-private-read-only`，作为独立后台进程运行。`reports/soak.json` 每分钟更新，记录成功次数、故障、Runtime PID、generation、内存、最长检查间隔。只有真实经过至少 24h、至少 1440 次检查、无失败/重启且检查间隔小于 3 分钟，才标记 `24H_OBSERVED`。机器睡眠或中断不能冒充有效观测。

未满 24h 只能报告 **STAGING READY / SOAK STARTED**。验收通过和用户另行授权后才切换生产端口；保留旧安装和数据作为无需重建的回退路径。

Venera source 保持生产 `local_gallery` key 和已有收藏路径。staging 客户端可临时指定 staging 服务地址；不要自动改用户客户端设置或生产地址。
