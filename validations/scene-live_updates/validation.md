# 连续提交与定时刷新

## 目标

实际扫描 SSD 合成作品并逐作品提交；两端不整页重载，画廊五秒合并刷新且可关闭，设置可交互。采集本次浏览器与自有 Tauri WebView 的帧间隔，不外推真实大库和 HDD 性能。

## 运行

使用 demo 合成实例，先扫描入库，打开自有调试 Tauri 管理器。设置 GALLERY_TEST_CONFIG、GALLERY_REVIEW_OUTPUT、GALLERY_TEST_CDP 和 GALLERY_TEST_SCANNER（同源码的 gallery-scan），执行 `node tools/validation/live_updates.mjs`。脚本只改合成 metadata，结束恢复原文；扫描进程保持 stdin，失败协作取消。禁止指向真实来源。

## 通过标准

至少 24 件作品分别提交，平台未结束前可见提交；自动刷新发生，关闭后不再产生列表请求；没有页面跳转，提示条仍在，设置可开关且没有页面错误。报告实际帧间隔和环境限制；系统输入和真机另验收。
