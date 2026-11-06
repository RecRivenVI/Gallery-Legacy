# 搜索与个人阅读场景

## 目标

只在 SSD 标记合成实例上验证搜索往返、账号隔离、个人数据和漫画阅读。对照第二阶段界面设计；不读取真实图库，不以浏览器组件验收代替原生宿主或中文输入法。

## 运行

先按[开发流程](../../documents/development/workflow-development.md)启动自有合成读取服务。设置 `GALLERY_TEST_CONFIG` 为其配置、`GALLERY_REVIEW_OUTPUT` 为新的仓外结果目录。每次只运行一个浏览器脚本：

```powershell
node tools/validation/search_filters.mjs
node tools/validation/personal_reading.mjs
node tools/validation/personal_actions.mjs
node tools/validation/account_actions.mjs
node tools/validation/guest_login.mjs
node tools/validation/author_actions.mjs
node tools/validation/personal_scenes.mjs
```

场景需要 tools/demo 的九平台夹具、48 页漫画、系列、候选作者链接及单页作品；作者确认与忽略会改变合成实例的共享关联，首次对照使用新的个人库。账号场景创建独立账号，不访问真实账号。录屏需设置 `GALLERY_FFMPEG`。管理组件场景另设 `GALLERY_TEST_ASSETS`，执行 `manager_preview.mjs`，它使用明确的内存协议。

## 通过标准

- 语法、条件标签、高级字段和网址往返一致；包含与排除、多平台和作者视图范围正确。
- 收藏、评分、逗号标签、收藏夹、历史和继续阅读正确；账号切换不混用数据、偏好与缓存。访客登录后完成原收藏动作并开始记录阅读。
- 候选确认、忽略持久化，手动关联及解除正确；关联作品只在选定范围混排。
- 单页、双页、连续、RTL 键盘和真实模拟触屏方向正确，系列切换可达；弹层覆盖图片、可关闭且输入不受下层焦点限制。
- 截图覆盖深浅色、电脑与手机；说明写前实际查看。浏览器错误、失败原图或未完成状态不写成一致。
- 原生窗口、托盘、系统对话框、输入法、真机与首次真实扫描留人工验收。

`browser.mjs` 可设 `GALLERY_BROWSER_PART=additional` 只执行搜索、背景、媒体与错误回归，不重复已经有结论的六种主题/尺寸矩阵。旧脚本的“标签 全部”和“搜索”定位需随第二阶段控件名称调整，失败原记录保留，不能写成产品场景失败已通过。
