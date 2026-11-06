# 公共 HTTP 与媒体验证

## 目标

在合成实例核对 HTTP、媒体、Venera、文件浏览、错误和状态事件，验证实际 Compose 页面可使用。生产实例与真实来源不在范围内。

## 运行

1. 按[新栈场景](../scene-full_stack/validation.md)准备拥有的独立合成实例及当前产品；运行 npm run test:native、npm run test:browser。
2. 执行 node tools/go/run.mjs test -count=1 ./internal/httpservice ./internal/media ./internal/fileview，并对并发包加 -race。使用 GALLERY_UNIT_ROOT 将测试输出限定在仓外。
3. 历史 HTTP 差分的黄金输入可从提交 20ff819 在仓外重新生成，以 GALLERY_HTTP_GOLDEN 交给相应测试；不复活旧产品入口，不改写期望。
4. 检查原图／视频、Range、VTT、缩略图、文件根边界、请求取消、WebSocket 关闭及访问控制。截图须先查看，再写说明。

## 通过标准

声明范围的稳定响应与媒体合同一致，取消与错误不改写为成功；同一响应不混修订。非法 URL 提前返回标准库 HTTP 400、旧协议空白长度的差异见[读取架构](../../documents/design/architecture-http_read.md)。未运行的黄金批次、实际输入法、读屏、真机与性能写“无法比较”。
