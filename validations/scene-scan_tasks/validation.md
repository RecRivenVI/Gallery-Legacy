# 扫描与封面任务

## 目标

在独立 Tauri 合成实例验证确认范围、多选记忆、逐文件增量、作者页和手动封面任务；不扫描真实图库，不向桌面发送输入。

## 运行

1. 在 SSD 生成带标记的九平台合成实例，启动自己的 Debug Tauri 候选，设置 `GALLERY_VALIDATION_NO_ACTIVATE=1` 和独立 WebView2 CDP 端口。
2. 按开发工作流设置 `GALLERY_TEST_CONFIG`、`GALLERY_TEST_CDP`、`GALLERY_REVIEW_OUTPUT`，执行 `node tools/validation/scan_tasks.mjs`。
3. 执行 `node tools/validation/video_duration.mjs`，核对三秒合成视频的封面与时长同步，以及自动封禁设置即时应用且本机豁免。
4. `node tools/validation/scan_streaming.mjs` 在合成来源内加入 2,000 件小作品，经真实管理任务扫描，核对平台提前提交、两端帧间隔和状态响应。
5. 查看深浅色截图；结果留在仓外。

## 通过标准

全量和增量的确认范围与实际任务相同；刷新后选择保持；未变作品不重新提交。作者扫描独立且不出现 Venera。封面只在手动启动后生成，范围正确，无失败。截图未出现裁切或不可读文字。此场景不证明真实 HDD 性能、输入法或真机体验。
