# 存量技术债

按可见影响排序；位置为本轮整理后的职责路径。这里只登记未获本轮功能修复授权的存量问题，不放宽根规范。

| 优先级 | 规则                      | 位置                                                                     | 影响与证据                                                                                                                                 | 建议                                                                                          |
| ------ | ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 高     | T-04、C-09                | test/desktop、src/runtime/control.js、src/desktop/main.js                | 整理前存在 OWNER_UNVERIFIABLE、管理宿主超时；整理后的原生窗口访问／日志页仍出现“服务没有响应”，直接 IPC 单次调用可成功；不宣称全套验收通过 | 单独调查 Windows 身份查询、并发控制请求与生命周期等待；不降低进程核验，不把错误截图当加载完成 |
| 高     | C-08、R-04                | src/indexing、src/publication、internal/indexing                         | Go live 主链与尚用于静态恢复／差分的 Node 构建共存；不是完整 Go 后端                                                                       | 明确静态／恢复替代合同后再移除 Node 构建，不做隐式双 writer                                   |
| 高     | U-01、U-07、U-08          | public/gallery、public/manager                                           | Canvas 自绘、固定 UI 尺寸、原生输入投影未有全量读屏／系统缩放／真机验收                                                                    | 保持用户现有视觉要求；单独评估可访问性与未来 CMP，不借本轮重写                                |
| 高     | R-03、NJ-07               | public/platform/fonts.js、运行资源                                       | 完整字体仅来自用户已有外部合法资源；公开源码不内置；字形／RTL／全部语言没有完整验收                                                        | 先确认分发方式，再做字体／连字／方向和真机检查                                                |
| 中     | C-07                      | public/gallery/app.js                                                    | 约三千行混合状态、布局、绘制、语义和事件                                                                                                   | 后续按导航／视图／交互职责拆分，不在搬目录时改状态机                                          |
| 中     | C-07、C-08                | internal/indexing/pipeline.go、internal/catalog/writer.go                | 各约一千二百行，聚合调度／FTS／删除／作者权威／计时                                                                                        | 固定差分测试后按职责拆分，保持事务和作者排序                                                  |
| 中     | NJ-04、C-01               | src、bin、tools、test 的存量 JS                                          | CommonJS 存量未整体迁 ESM，也未全量启用 JSDoc／ts-check                                                                                    | 独立迁移模块制度；本轮只搬移与格式化，不大规模语言重写                                        |
| 中     | GO-09、C-09               | internal/、cmd/gallery-scan                                              | 部分错误为稳定码而非完整 %w 链；遥测不统一 slog                                                                                            | 保留外部稳定码，后续统一内部错误链和日志，不吞失败                                            |
| 中     | C-02、C-03                | src/desktop、src/server、src/runtime                                     | 仍有 best-effort catch、fallback；存在历史关闭／状态转换原因                                                                               | 逐个找可达失败证据，删除无证据分支；不机械去掉必要安全边界                                    |
| 中     | F-01、GO-01、GO-06、NJ-08 | go.mod、package.json、api                                                | Go／Node 混合产品的版本与手工 API 合同仍需统一生成责任                                                                                     | Go 版本用标签注入，Node 包元信息保留；API 生成迁移另列需求，不新建机械门禁                    |
| 中     | F-02、NJ-04               | src/config、src/instance/config.js                                       | 公开 schema 与运行验证／默认值仍部分重复                                                                                                   | 以现有 schema 为入口逐步收敛，保留物理路径边界测试                                            |
| 中     | G-03、C-08                | src/library/platforms.js、internal/metadata                              | Node Reader 与 Go 扫描分别有九平台提取版本知识                                                                                             | 用既有差分合同约束；后续统一生成，不让配置任意注册平台                                        |
| 中     | T-02、T-07                | test/core-isolation.test.js、test/frontend                               | 存量源码字符串／mock 断言能防结构回退，不能证明视觉或帧率                                                                                  | 保留具体缺陷测试，真实交互和性能按验证定义单独运行                                            |
| 中     | G-02、C-08                | src/indexing/inventory.js、listing.js、src/library/everything.js         | 静态 Node／差分残余仍保留已不再采用的清单提供者；正式 Go 扫描无此依赖                                                                      | 与静态构建合同一起退役，不从 Go 入口暴露备用 provider                                         |
| 中     | GO-12                     | internal/library、internal/indexing                                      | 增量仍枚举整个所选范围；属性摘要不能识别保留 size/mtime 的内容改写                                                                         | 明示检测模型；新 watcher／内容 hash 需用户另定，不承诺冷 HDD 时间                             |
| 中     | C-07、R-04                | internal/indexing                                                        | 单件准备、条目数／深度有上限；超大作品 spool 尚缺                                                                                          | 后续有界大作品通道，保留完整性与失败语义                                                      |
| 低     | U-03、GO-04               | internal/library/config.go                                               | 历史 testOnly 字段仍是内部 scanner 配置握手，不是产品部署限制                                                                              | 保持本轮格式兼容；单独清理命名，不删除实例／路径核验                                          |
| 低     | D-04、D-10、W-05          | documents/design/overview-ui_baseline.md、adr-1-user_design_decisions.md | 用户要求原文保留，含历史小节、旧路径和不同命名；不满足新固定 ADR 小节                                                                      | 原文不改；现行解释放另一个 ADR／架构文档，不造旧目录兼容壳                                    |
| 低     | G-07、W-05                | 根 AGENTS.md                                                             | 规范原稿含正式来源的本机绝对路径，用户同时要求逐字复制                                                                                     | 本项目不擅改规范；由来源统一处理                                                              |

另有 L-02／C-07 存量：src/metadata/helpers.js 混合字段转换与诊断，bin/gallery.cjs 含较多实例组装。后续按字段规范化／诊断和命令职责拆分；本轮不借改名改写解析行为。

C-06 存量：public/gallery/app.js 的 window.\_\_galleryCanvas.measure 和管理端调试句柄仍在正常脚本中。后续集中到显式开发开关；本轮只保留已有优化，不把合成检查写成性能达标。

C-12／W-05 例外：冻结设计原文末尾空行和原换行字节按用户要求保留，Git 不做换行归一；不能为了 diff 检查而改写原文。

GO-11／T-04 环境项：race 测试进程启动返回 0xc0000139；仓库外只有 main 的最小程序也同样失败，Windows 将该值解释为 STATUS_ENTRYPOINT_NOT_FOUND。普通构建／测试通过，但本机 Cgo／race 运行环境尚不能验收，未将其当作竞态检测通过。

公开发行前还需核对 Go 静态链接依赖的完整许可材料，以及用户字体资源的正式分发授权；本轮仓库外开发构建不是发行验收。

本轮低风险处理：退役被替代的 DOM Gallery／九页 Manager／旧 CSS、无引用主题／标签模块和无产品引用附件规划；移出固定真实路径的旧手动试用工具；移除自建语法／公开树检查器、旧测试 wrapper 和无引用夹具审计记录。完整原件和文件去向保留在仓库外，不丢弃未提交成果。
