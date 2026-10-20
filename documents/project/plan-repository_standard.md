# 仓库规范落实计划

## 目标

以当前未提交成果为基础，将 Go 扫描器、CanvasKit 界面和四页管理端转为正式源码；整理规范、文档和产物，一次 `Update` 检查点并正常推送 main。不迁运行实例、不重写 Go HTTP、不改独立 Gallery。

## 范围

### 三处风险

1. 路径移动使 CJS/import、CLI、静态资源和测试夹具引用失效：整理前后执行同组测试，迁移按文件映射核对。
2. 误把产品依赖或差分基准当实验丢弃：先保存当前树和逐文件去向，保留 Go 尚依赖的 Node Reader、HTTP、媒体、schema 及必要差分基准。
3. 替换旧规则丢失源只读、物理权威、事务与恢复约束：转入项目规范和设计合同，冻结设计两文只改位置／名称，不改内容。

### 目录与文件去向

所有实际文件的完整去向清单在本轮仓库外整理产物中保留；下表定义归类规则。未提交内容不是缓存。

| 当前位置                                                                | 处理                 | 目标／依据                                                                               |
| ----------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------- |
| AGENTS.md                                                               | 替换，原文留存仓库外 | 逐字采用规范 `AGENTS-go_node.md`；有效独有约束转 documents/AGENTS.md                     |
| README.md                                                               | 重写                 | 只留简介、平台、快速开始、文档和许可                                                     |
| design-review/go-backend/acceptance/{catalog,indexing,library,metadata} | 移动／改名           | internal/ 同职责 Go 包；原地测试随包                                                     |
| design-review/go-backend/cmd/acceptance                                 | 移动／改名           | cmd/gallery-scan；只保留正式扫描入口                                                     |
| design-review/go-backend/go.mod、go.sum                                 | 移动                 | 根 Go 模块，来源依赖锁不丢失                                                             |
| design-review/go-backend 的旧 probe                                     | 移出仓库             | Artifacts/Gallery-Legacy/DesignReview 原件，实验不进正式模块                             |
| internal/ 下 Node 实现                                                  | 移动／按依赖处理     | src/ 同职责目录；完全替代的扫描路径移除，剩余 HTTP、Reader、媒体、schema／恢复保留并说明 |
| cmd/gallery/main.js                                                     | 移动                 | bin/gallery.cjs，保留未替代的 CLI 行为，扫描接 Go                                        |
| desktop/                                                                | 移动                 | src/desktop，窗口／托盘／IPC 继续 Electron，不新增 Tauri                                 |
| frontend/gallery/canvas/                                                | 移动                 | public/gallery，成为唯一浏览界面                                                         |
| frontend/manager/candidate/                                             | 移动                 | public/manager，成为唯一管理界面                                                         |
| frontend/shared/ 中仍引用模块                                           | 移动／改名           | public/platform，消除 shared 泛称                                                        |
| frontend/venera/source.js                                               | 移动                 | public/venera，兼容收藏路径保留                                                          |
| frontend/assets/                                                        | 分类                 | SVG 源保留 public/assets；二进制移出，用构建资源生成／复制                               |
| 旧 DOM Gallery／九页 Manager／旧 CSS                                    | 删除或移出           | 完全替代部分不保留产品入口；受跟踪内容由 Git 保存，当前原件另有仓库外快照                |
| config/                                                                 | 移动                 | src/config，实例 schema 与公开配置归一                                                   |
| protocol/                                                               | 移动                 | api/ 契约；说明转 documents/reference                                                    |
| tests/、fixtures/                                                       | 移动                 | test/、test/fixtures；Go 测试与包同目录，纯人工夹具保留                                  |
| extensions/                                                             | 按引用处理           | 无产品引用的附件实验移出，不作为下载器保留                                               |
| tools/                                                                  | 移动／分类           | tools/<职责>/；自建检查器／gate 移除，有效构建／验证工具保留                             |
| design-review/sandbox 及可复用验收代码                                  | 移动／重组           | tools/demo、tools/validation；场景定义进 validations/                                    |
| design-review 的阶段 ZIP／截图／压缩／delivery／阶段 README             | 移出仓库             | Artifacts/Gallery-Legacy/DesignReview，保留原件与差异，不覆盖                            |
| dist/                                                                   | 移出仓库             | Artifacts/Gallery-Legacy/Builds，本轮不清理历史产物                                      |
| node_modules/                                                           | 保留 ignored         | 本地依赖，不入库                                                                         |
| .github/ 如有                                                           | 移除 CI              | 不增加工作流或检查器                                                                     |

### 文档新名称

| 原文                                    | 新位置／处理                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| docs/design/设计说明*画廊系统*最终版.md | documents/design/overview-ui_baseline.md；内容逐字保留                                        |
| docs/design/设计变更记录.md             | documents/design/adr-1-user_design_decisions.md；内容逐字保留，原历史结构作为用户原文例外注明 |
| docs/architecture.md                    | documents/design/architecture-runtime.md，重写为当前 Go＋Node 关系                            |
| docs/configuration.md                   | documents/reference/configuration-instance.md                                                 |
| docs/development.md                     | documents/development/workflow-development.md                                                 |
| docs/live-updates.md                    | documents/design/mechanism-live_updates.md                                                    |
| docs/management.md                      | documents/usage/guide-manager.md，按四页写当前功能                                            |
| docs/migration.md                       | 有效方向进 project/backlog-runtime.md 和 ADR；原流水移出                                      |
| docs/publication.md                     | documents/design/mechanism-recovery.md                                                        |
| docs/runtime.md                         | documents/design/lifecycle-instance.md                                                        |
| docs/scanning.md                        | documents/design/flow-scanning.md，只描述标准库 Go 当前链                                     |
| docs/security.md                        | documents/design/security-boundaries.md，删除过时发布／审计断言                               |
| docs/staging.md、test-manager.md        | 验证定义和开发说明，不保留旧门禁流水                                                          |
| docs/go-feasibility.md、go-pipeline.md  | 当前事实写架构／扫描／技术债；原始调查移出，必要研究结论独立成文                              |
| protocol/README.md                      | documents/reference/protocol-runtime.md                                                       |
| 其余历史 README／索引                   | 随原证据移出；有效限制写 debt/backlog                                                         |

## 步骤

1. 完成：盘点、保存当前树／映射，记录整理前 Node／Go 构建与测试；既有失败不修功能。
2. 完成：逐字安装根规范、完成项目补充；迁入 Go 主链和两前端，保留 Node 尚需部分，校正路径与启动／构建接线。
3. 完成：移出阶段产物和旧 probe，迁文档、保留用户设计原文，删除低风险替代旧入口。
4. 完成：按规则逐组登记债务，格式化，整理后运行同组测试及合成界面／扫描检查。
5. 完成：自查与暂存范围复核；本轮检查点提交／推送结果以 Git 和仓库外交付说明为准。

## 结果

整理完成；验证边界与产品开放项已记录，未部署。当前状态见 [进度](status-repository_standard.md)。
