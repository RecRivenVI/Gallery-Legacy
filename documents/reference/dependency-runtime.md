# 运行与构建依赖

版本唯一来源是 [Go 模块](../../go.mod)、[npm 声明](../../package.json)及各自锁文件；此处不复制版本号。

| 依赖                          | 用途与缺失影响                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| Go 工具链                     | 构建／测试扫描器；可在本机路径配置中指定官方 portable 工具，不改系统安装               |
| modernc SQLite、x/sys、x/text | 工作库、Windows 原生核验和文本归一化；受模块锁约束                                     |
| Node、better-sqlite3          | 残余读取、schema／恢复、本机控制；不能用 Electron ABI 的 native 模块代替普通 Node 模块 |
| CanvasKit                     | 自绘浏览界面，构建时从锁定 npm 包取得 JS／WASM，产物不入源码                           |
| ws                            | 公共只读状态事件与合成验证代理                                                         |
| Electron                      | 窗口、托盘、目录选择；不是扫描器或数据库服务                                           |
| Playwright                    | 合成浏览器／原生窗口验证及图标构建；不用于控制在用服务                                 |
| Prettier                      | 开发时格式化，使用默认设置，不作为自建门禁                                             |
| FFmpeg                        | 视频信息、首帧／媒体相关处理；缺失时报对应工具不可用                                   |
| ImageMagick                   | 缩略图和封面处理；缺失不能据此丢弃实际媒体                                             |

外部编码器的确切最低版本尚未验证，不虚构统一兼容范围。它们由运行环境提供，输出进入实例临时／缓存目录，不写源文件。

MiSans／回退字体采用用户合法提供的原始外部资源；源码只含加载器，不附带字体二进制，也不隐式从 CDN 下载。Fluent System Icons 的选用素材及 MIT 声明保持来源，见根 NOTICE。字体实际语言覆盖与正式再分发是独立未决项，不按资源数量宣称全语言验收。

## Windows race 编译器

本轮实际验证使用 MinGW-Builds GCC 16.2.0、POSIX/SEH、UCRT、mingw-w64 v14、rev1。渠道来自 [MinGW-w64 官方下载目录](https://www.mingw-w64.org/downloads/)列出的 [MinGW-Builds](https://github.com/niXman/mingw-builds-binaries/releases/tag/16.2.0-rt_v14-rev1)。下载文件 x86_64-16.2.0-release-posix-seh-ucrt-rt_v14-rev1.7z 的 SHA256 为 26788998d615856a915e1eeacb0854fce87bc608fa9a0c16f96bcbfdcf3415c0，与发行元数据一致。

免安装目录位于工作区 Scratches/Toolchains，不替换既有 gcc。设置本机路径文件的 raceCompiler，或仅当前命令的 CC；Go 包版本不因编译器配置改变。工具链归其原许可所有，不进入产品源码。
