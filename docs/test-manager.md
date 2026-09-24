# 测试用回环 Manager

`node tools/manager-test.js --config <staging 实例配置> --port 18108`

这是显式启动的测试宿主，用同一 Manager 页面、同一本机管理用例验证功能。正式 Runtime 不导入它，正常 `/manage` 仍只读。只接受实例内的 staging 配置，拒绝 production 和端口 8081；只绑定 `127.0.0.1`。公网/LAN不能访问此监听器。

访问地址必须使用启动时打印的 `http://127.0.0.1:<port>/`。严格核对 Host、Origin、回环 peer 和代理头；操作必须携带 HttpOnly/SameSite cookie 及页面一次启动周期的随机 CSRF token，无 CORS 放行。它通过实例认证管道/本机用例管理指定测试实例，不能切换去生产实例。返回安全错误码，不返回 stack。

浏览器能验证配置、扫描、验证、版本、日志、存储等工作流。目录选择使用测试用文本输入；打开系统文件位置需要原生 Gallery.exe，测试网页不能模拟 Windows 原生文件选择或托盘。

自动化仅在人工临时库上用 DOM/HTTP 验证，不截图、录屏或输出媒体。真实数据测试时只检查 Manager 控件、数量、状态、响应码；不要抓取作品标题、作者、正文、metadata 或媒体画面。端口、状态、锁均与生产隔离，不共享可写 instance state。

测试结束后关闭这个独立进程即可。关闭测试宿主不会停止 Runtime。不要把该命令设为生产启动项。
