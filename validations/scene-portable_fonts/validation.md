# 本地官方字体与旧链接

## 目标

验证两端使用原始官方字体、本地按需加载、断开外部网络时中文正常；稳定作者和媒体别名继续可用。真实原生窗口与浏览器分别记录，不能用单元测试或浏览器模拟宿主代替。

## 运行

1. 构建当前候选，仅使用 tools/demo 生成的独立合成实例，通过更新或验收扫描器入库。
2. 设置 GALLERY_TEST_CONFIG、GALLERY_REVIEW_OUTPUT，按开发流程运行合成公共读取入口；原生验证另设置 GALLERY_TEST_CDP。
3. 执行 `node tools/validation/compatibility.mjs`，浏览器阻断所有非回环请求；截图后实看中文、多语种和 Emoji。
4. 核对 resources/misans-cdn 的 CSS/190 子集与 tools/fonts/misans.lock.json；确认没有第三方 misans_latin.woff2、完整 CJK TTF 或 L3。
5. 原生管理器中停止画廊服务、切换页面，确认字体仍正常。不能执行时明确记录未验证。

## 通过标准

- 官方原始字体与 lock 一致，未转换格式或自行制作子集。
- 运行时无小米 CDN 请求；断网页面的中文和九种本地小语种可见，Emoji 保持彩色，应用内有 MiSans 标注。
- 旧稳定作者别名打开相应作品流，media 参数定位指定原图。
- 原生服务停止不影响管理器字体；未做原生运行不记为通过。
