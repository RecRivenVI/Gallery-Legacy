# Go 公共读取差分

## 目标

在同一组合成文件／READY／工作库上比较冻结 Node 与 Go 公共 HTTP：空实例、静态库、工作库；公开状态与列表／详情、Venera、稳定媒体链接、短链、静态资源、字幕、Range、缩略图、文件浏览／搜索、Host／Origin、错误及状态 WebSocket。另核对访问封禁持久化、并发响应快照、队列去重与取消，以及未改动网页通过 Go 实际浏览。

## 运行

1. 将独立冻结 Node 构建设为 `GALLERY_NODE_REFERENCE_ROOT`；其中须有原后端、前端、资源和普通 Node ABI 的依赖，不用候选源码充当唯一对照。
2. 将 `GALLERY_TEST_ROOT` 指向本轮新建 Scratches 根；`GALLERY_UNIT_ROOT` 指向同一拥有的临时根。产物不得指向真实实例、来源或已有演示库。
3. 运行 `npm run test:http -- --race`，生成确定性抽象图片、动图、短视频和字幕，Node 串行捕获、关闭后再由 Go 逐项比较。媒体编码器由现有环境提供，不下载安装系统工具。
4. 缺陷修正后仅重放失败批次时，将 `GALLERY_HTTP_REPLAY` 设为该合成根的 golden.json，再运行同一命令；不得改写期望掩盖差异。缓存仅移动当前任务的派生目录以复现首次生成，失败证据保留。
5. 运行 `node tools/go/run.cjs test -race -count=1 ./internal/media -v`，验证四并发队列、同目标去重、取消等待、命中与关闭收尾；新临时数据通过时进入回收站，失败时保留。
6. 将 `GALLERY_HTTP_GOLDEN` 指向捕获文件、`GALLERY_READ_EXE` 指向本轮构建的 gallery-read、`GALLERY_HTTP_EVIDENCE` 指向 Artifacts 结果目录；运行 `npm run test:http-browser`。它只启动自己的 Go 子进程和无头 Chromium，使用当前前端／合成输入，检查列表、搜索、图片开关、主题、文件浏览和合成视频解码，结束关闭自己的进程。
7. 只对受影响包运行 build／vet；扩展名词汇提取只补跑 `TestActualMediaEligibility`。不重跑已通过且未受影响的完整基础矩阵；默认入口切换后的完整验收另行进行。
8. 关闭自己的测试宿主后，核实 browser.json 的 ownedTemporaryRoot 属于本轮新建根，再将该浏览器临时目录移入回收站；保留合成输入、摘要及必要失败证据，不清理历史或其他任务目录。

## 通过标准

- 以冻结 Node 为标准，逐请求比较状态码、必要响应头、解析后 JSON 和媒体／静态资源 hash；JSON 对象属性顺序不作为语义差异，游标／短链／缓存身份保持原字节合同。
- 原图／字幕／缩略图的 GET／HEAD、单段 Range、零字节、损坏／缺失输入和实际编码器输出一致；失败不提供假图。首次生成与缓存命中分开比较。
- 列表、文件夹／递归搜索、过滤、自然排序、超大页码与 Unicode 文件名一致；取消返回既有错误；配置根、平台目录与重解析点边界不放松。
- WebSocket 立即帧和后续帧的内容一致，Host／Origin 拒绝语义一致；不比较非合同范围的传输分帧细节与时间抖动。
- 访问历史的开启、封禁、禁用和不可封禁本机对照一致；elapsedMs 为实际时钟，不要求两次运行耗时位一致；URL／查询／正文不进入持久事件。
- HTTP 在并发合成事务中 envelope／data／标题的修订始终一致；race 不报告数据竞争。
- 非法 URL 在 Go HTTP parser 提前返回 400、以及独立冻结协议文件的空白长度变化单列为“有差异”，不吞进一致结果。ACL／外部编码器被系统强制终止等未实测项写“无法比较”。
- 浏览器必须实际完成交互；截图自己看过。它不是管理 IPC、真机／输入法／读屏、性能或生产部署验收。
