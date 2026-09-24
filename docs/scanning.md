# 全量、增量与定向扫描

## 执行模型

全量和增量使用同一个异步执行器 `internal/indexing/engine.js`，不同之处是候选是否从已有事实复制以及作品是否复用；不再各自维护一套同步目录扫描循环。

`library/scan-producer.js` 按磁盘调度异步目录枚举、BigInt stat 和 metadata 读取。拓扑检查融入扫描，不在扫描前再次完整遍历作者/作品目录。媒体仅 stat，不读取内容。同一作者按路径顺序交付；不同物理磁盘可并行。所有子任务完成后才结束作者/平台范围，任何所需范围不完整仍阻止 READY。

Windows 启动时只读识别卷对应的物理磁盘及 SSD/HDD 类型。共享物理盘的多个平台共用预算：SSD 默认最多 32 个在途 I/O、8 个作品预取；HDD 默认 2 个 I/O、1 个作品预取。无法可靠识别时采用保守预算，不把盘符当作独立硬盘。扫描子进程在启动前配置 64 个 libuv I/O 工作槽，实际并发仍受磁盘调度限制，不修改 Web Runtime 的线程池。

Metadata/shape/映射通过最多 8 个按需创建的解析线程完成，线程只接收观察事实，运行阶段禁止文件、网络和数据库 I/O。解析结果按作者观察顺序归并，完整作品仍由唯一写入协调器批提交。任务窗口和估计字节软水位限制积压；单个大作品可以独占窗口，软水位不是硬 RSS 保证。取消会停止派发并等待有限在途任务/线程结束，不让后台任务泄漏到下一次扫描。

READY 检查点、最终 Search 构建、SQLite 收尾及发布仍是明确的后置阶段；本次重写不把这些耗时隐藏为“扫描已经结束”，也不宣称已经验证真实全库的加速倍数。

RSS 是扫描进程整体常驻内存，包含解析线程；原 `heapUsed` 是主协调器线程堆，不应当作所有 Worker 的总堆。执行报告另外记录 Worker 上报的堆与操作耗时。并行阶段的耗时可重叠，不能把它们简单相加当作总 wall time。

```powershell
npm run scan -- --config <实例配置文件> --confirm-read-only
npm run scan -- --config <实例配置文件> --mode incremental --confirm-read-only
npm run scan -- --config <实例配置文件> --mode full --platform pixiv --confirm-read-only
npm run scan -- --config <实例配置文件> --mode incremental --platform pixiv --author <单个作者目录名> --confirm-read-only
```

Manager 顶层平台多选直接决定更新范围，日常“更新图库”默认增量，一次点击发起；只读说明常驻，不反复勾选确认。强制全量/作者范围在高级选项中。CLI 默认 `mode=full` 保持显式全库行为，支持 `--platforms '["pixiv","X"]'`；与旧 `--platform` 互斥。首次全部平台增量降级为 full；没有基线的局部选择拒绝，不擅自扩大到全部平台。所有扫描只读 source roots，只写当前实例。

增量 Search 使用新候选文件，比较完整查询事实并复用未变化全文记录；变化、删除、作者/标签变化保持与全量构建相同结果。较旧的 contentless Search 需要首次完整升级，报告明确记录 fallbackReason。Catalog Schema v4 与 Search 查询语义不变。仍需复制/比较数据和完成完整性验证，不承诺少量更新是零全库开销。

任务报告记录准备、Catalog、Search、验证、发布各阶段 wall time。进度文件是非权威状态，短暂 Windows sharing 错误有限重试、合并更新；持久写入失败明确报错。此重试不用于活动指针或 READY 证据写入，不能把发布失败视为成功。

拓扑固定为平台根的直接作者目录、作者目录的直接作品目录；作品内安全递归观察 regular files，不跟随 symlink/reparse。真实 `mtimeNs` 使用 BigInt stat，媒体不读内容、不 hash。metadata 以严格 UTF-8 读取并保留原文；读取竞争、不完整枚举具有明确诊断。

Metadata 缺失、不可读、损坏、非 object、缺 ID，都保留物理作品。重复源 ID 保留多个物理身份。声明媒体和实际文件分离，计数只来自实际文件。

Venera 下载库以书籍目录作为作者级物理容器、章节目录作为作品，标题可回退到书籍目录名，缺失上游 ID 不伪造。页序在读取/展示时自然排序。隐藏封面/预览只影响默认展示，Catalog 仍保存所有合法 actual media。九平台 registry 扩充了 Schema v4 的固定平台 CHECK 集合，不改变物理身份、计数或可空源 ID 的语义；旧八平台 generation 不能修改 manifest 冒充新代。

任意所需目录范围观察不完整，会向作者/平台及构建结果传播。**不完整 Catalog 不能成为 READY generation**，失败候选保留为实例内证据，当前活动指针不变。

增量和定向更新先把活动 READY Catalog 复制到独立 BUILDING candidate，scope 外事实继续保留，READY 文件本身从不打开写连接。扫描仍按作品流式观察，按固定批量提交；每位作者仅保留必要的当前权威候选，不建立全平台作品快照。新增、移除、改名都以 `(platform, relative_path_key)` 物理身份处理，不以可空、可重复的 source ID 跳过。作者范围完成枚举后才确认该作者删除；平台范围完成枚举后才确认作者删除。

增量变化判据使用作品目录 `mtimeNs`、metadata 的 `mtimeNs+size+state`、每个实际媒体的相对路径/`mtimeNs+size+type`，以及 `.nocover`/Gank preview 等 `media.*` presentation facts。目录和文件仍完整枚举/stat；只有提取版本、作者资料权威锚点、metadata stat、实际媒体和展示事实均可确认未变时，才跳过 metadata 读取/解析。无法证明时回退完整读取，不能用目录 mtime 跳过嵌套检查。报告区分 `metadataObserved`、`metadataRead`、`metadataReused`、`metadataReparsed` 与 `worksRebuilt`。Search 仍生成完整的新候选文件，但兼容基线的未变索引记录可以复用；“无变化”不表示零 I/O 或免去最终验证。metadata 缺失/损坏仍保留 physical work，只有实际观察到且符合资格的文件成为 media。

旧 READY 中不高于当前代码的 Adapter/shape 版本可以作为只读基线。若当前 Adapter、shape policy 或 source root 已变化，对应平台自动扩展为 full refresh，并在报告的 `invalidatedPlatformIds/effectivePlatformIds` 明示；future version 基线拒绝读取。候选中任何作品 Adapter 版本落后于平台版本都会阻止 READY。

进度状态独立于 Runtime 状态机：IDLE、SCANNING、BUILDING_SEARCH、VALIDATING、PUBLISHING、READY、FAILED、CANCELLED。

## 实时分批可见

实例显式启用 `liveUpdates` 后，Runtime 读取 `instance/live/catalog.sqlite`。它由已验证活动 READY 初始化，但不是 READY 文件，也不会反向修改 generation。每个 filesystem/media 完整的作品批次将 Catalog 事实、`live_*` Search 行和 `live_meta.revision` 放在同一 SQLite 事务提交；Web 请求在同一连接事务内读取固定 revision。长作者不必等全部作品枚举完才显示已完整观察的批次，作者最终资料仍在作者枚举完成时校准。

live Search 只刷新变更作品、相关作者/标签行；作者名称查询引用当前 `live_authors`，不会因大作者资料变化而在单批重写其全部历史作品 FTS。`live_work_sort.has_readable` 与当前媒体/presentation facts 同事务更新，实时 hideEmpty 不依赖启动时快照。

失败或取消不会撤回已经提交的完整 live 批次；下次局部/incremental candidate 从 checkpoint 后的 live Catalog 快照开始，避免用较旧 READY 撤回 scope 外已显示作品。不完整作品永远不提交 live。删除只在完整 scope 的最终 candidate 成功成为 READY 后执行 live checkpoint；随后 `baseGenerationId` 才更新。若重启时 active generation 与 live base 不同，视为显式发布/回滚选择并从该 READY 重置 live。

`live_id_high_water` 为 author/work/media/tag 防止删除后的 ID 重用；未变物理媒体路径在作品更新时保留 media ID，消失后重新出现的路径取得新 ID。live source bindings 必须与 Runtime 启动配置完全一致，根变化 fail closed，不能在继续服务旧根时静默改写 platform root。

本机管理中心可请求取消：通过 generation 绑定的请求文件在安全检查点停止，不强杀进程，不撤销已提交的发布。扫描启动有独立互斥，离线 Manager 也调用同一构建入口。只读 scope check 仍只是聚合抽查；带 mode/scope 的 scan 才会生成完整候选代。

热路径取消检查每 200 毫秒最多读取一次控制文件，其余调用只检查内存标记；确认取消后标记不会被文件删除或其他代请求撤回。发布阶段和活动指针原子替换前强制重新读取，不能因缓存绕过已请求的取消。该间隔是轮询频率，不是长时间原生操作的硬取消时限。

Manager 展示平台、generation、作品/实际媒体计数、metadata 状态、耗时、吞吐、RSS/heap、诊断、已加载与已发布代的差异。报告位于实例 reports，只含聚合事实。

mtime 权威有已接受的限制：外部工具改变媒体内容却刻意保留相同 `mtimeNs+size` 时，增量不会读取或 hash 媒体内容来识别变化。改名表现为旧物理身份删除和新物理身份新增，不推断 rename 关系。
