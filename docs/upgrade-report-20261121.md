# Aa Browser v0.7.0 升级验证报告

日期：2026-11-21。基线：`9c06e4f792e14ecfe5796a9ed3f29b674237c71e`；基线公开版本是不可变发行 [v0.6.12](https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.12)。本报告区分源码结论、实际运行、替身验证和未完成门槛，不把候选包视作已发布版本。按用户要求，宣传网页不属于本轮更新范围；本轮对 `site/` 的修改和新增网页内容检查已撤回，原有页面、资源和网页测试保持基线。

## 1. 项目盘点和兼容边界

| 部分 | 入口 / 职责 | 本轮边界 |
| --- | --- | --- |
| 桌面应用 | `src/main/` 的 BaseWindow / WebContentsView、标签/会话、下载、授权、更新、设置、历史、证据；`src/preload/` 的命名 IPC；`src/renderer/` 的外壳和新标签页 | Electron 45.3.2、TS、electron-vite 构建。普通页面没有特权 preload。保留浏览、隔离/普通标签、找页内文本、地址草稿、下载、打印、主题、中英文、新标签向导及更新流程。 |
| MCP | `cli/mcp.mjs` 的 stdio JSON-RPC 经一次启动一枚随机令牌的回环 WebSocket 转发；主进程调用工具并回传进度 | 共享目录维持 42 个工具；保留 SDK 客户端消费的文本、分页、引用、审批与取消。不是对外 REST 或 Streamable HTTP 服务。 |
| 数据和配置 | Chromium 管理网页会话；设置、历史、恢复会话、连接发现与证据用本机文件；应用配置入口与零依赖 CLI 分开 | 无业务数据库，不要求用户迁移。隔离会话不等于完全不写磁盘；取消不会撤销已分派的副作用。 |
| 安装和生态 | `install.mjs`、CLI setup、WorkBuddy connector、DSH 插件、独立零依赖 `site/` | 正式支持 Windows x64 NSIS 和 Linux x86_64 AppImage。官网不是 Web 版浏览器。第三方客户端的配置写入成功与实际连通分开判定。 |
| 工程与发行 | `.github/workflows/ci.yml`、CodeQL、测试脚本、`electron-builder.yml`、版本专用发行说明 | 发布须同 SHA 的主线与标签版本校验、实际平台包测试、发行资产与哈希核验。手工 Release 不是 CI 的替代品。 |

应用外壳盘点覆盖标签栏、工具栏、历史建议、查找、审批、Agent HUD/记录、下载抽屉、更新和五区设置；新标签是实际接入向导。官网盘点覆盖首页、42 项手册、404、移动菜单、FAQ 和演示。静态盘点不代表每个业务路径都经过真实第三方网站或真实设备验证。

## 2. 独立开源调研与采用结果

| 项目（固定源码） | 核对细节与许可证 | 本轮采用 / 不采用 |
| --- | --- | --- |
| [Min](https://github.com/minbrowser/min/tree/5a02a666b9a4812f11fc21327979bc186ac9bf2e) v1.35.8 | Apache-2.0；`main/permissionManager.js`、`main/prompt.js`、设置主进程模块；发布历史与 #2387 | 借鉴由主进程持有权限和配置状态，不移入 Min 的 hostname 粒度策略。 |
| [node-jsonc-parser](https://github.com/microsoft/node-jsonc-parser/tree/3c9b4203d663061d87d4d34dd0004690aef94db5) v3.3.1 | MIT；`modify`、`applyEdits`、`src/impl/edit.ts`；有后续 4.0.0-next.2 分支 | 保留 App 已有局部编辑，不升级至预发行、不把 App 测试等同于 CLI 解析安全。 |
| [write-file-atomic](https://github.com/npm/write-file-atomic/tree/b5546a225c9065b4418ad806f48d6a564efd9035) v8.0.0 | ISC；`lib/index.js` 的临时文件、fsync、rename 与同文件串行 | 作为存储保证对照；不加运行依赖。配置备份与原子替换解决不同问题。 |
| [Electron](https://github.com/electron/electron/tree/deaded07eebdfe9a3737884933b1acbe65971f64) v45.4.1 | MIT；Session 权限实现和 `safe-storage.md`，Linux 后端行为并不等同于 Windows | 沿用页面/外壳不同 WebContents 的隔离；保留当前锁文件，不盲升、不声称本机存储不可读。 |
| [Firefox](https://github.com/mozilla-firefox/firefox/tree/893a7ba9f78f4680d50b1485c3b703bbfddda940) | 核对 `Troubleshoot.sys.mjs`、`aboutSupport.js`、`JSONFile.sys.mjs`；相关文件 MPL-2.0、仓库多许可证，版本源为 160.0.1 | 借鉴诊断的共享字段最小化，独立实现字段白名单；不复制源码、素材或许可证义务不明的部分。 |

没有引入以上项目的源码或新依赖。未核验 Gitee 源码；其他 MCP 参考项目的第二路固定源码调查因上游中断未闭环，不计入这五项。

## 3. 实际变更

- **AI 连接诊断**：新增启动/失败、未连接、认证未验证、已验证、缺桥/需配置等状态及下一步建议。仅成功执行 `browser_tabs` 的 `list` 才验证连接。端口、发现路径可在设置本机展开查看；分享文本只含版本、平台、服务和桥状态及数量，不复制端口、路径、令牌或浏览数据。桥状态不保证第三方配置、版本或可运行性。
- **数据完整性**：显式 PDF/HAR、右键截图和无标记历史文件不参与自动删除。不改覆盖策略；无标记文件不按名字认领。缺失或被替换的文件可退休旧登记，不代表文件被删除。新受管的自动产物仍核验身份/hash 后按 TTL/配额回收；索引上限只截断非受管查询历史，不遗忘受管文件。
- **审批**：`browser_cookies` 只接受明确 `get` / `set` / `clear`，不合法参数在执行前拒绝；保持已有写入与清除审批。没有实施对外目标的漏洞利用或复现。
- **键盘和原生视图**：活动标签切换不再双重挂载；标签结构不变时保留节点与 DOM 焦点。AI 详情进入设置 Tab 循环，有主题一致的焦点环。
- **工程与发行**：Electron SBOM 使用精确锁版本，同名同版本依赖含生产路径时 `required` 优先。Linux 桥只新增安装器默认 `~/Applications/AaBrowser.AppImage` 查找和名称支持，不扫描任意目录。新增离线 SBOM、证据和桥路径回归。Linux 自定义 `--dir` 未自动持久化冷启动路径的既有边界已写进接入指南，未宣称修好。

## 4. 性能、数据与安全核验

| 夹具 | 基线完整返回 JSON | 候选 MCP 文本路径返回 JSON | 结论 |
| --- | ---: | ---: | --- |
| 3,000 按钮 / `maxNodes=100` / 60 页 | 16,880,734 B | 227,374 B | 减少 98.65%，首屏树保持 3,042 B；全树 ref 始终有效。 |
| 3,000 按钮 / `maxNodes=200` / 30 页 | 8,535,809 B | 209,129 B | 减少 97.55%，游标走到末页，生产点击脚本可操作末项。 |

单台 Windows、真实 Electron、本地确定性 DOM。测量是页面到主进程未压缩返回 JSON，不是 MCP 线上字节。耗时有小样本与调度噪声，不承诺普遍提速；启动、内存、CPU 和外部网站未测。保留引擎默认结构化结果与页面内部全量引用。历史 100 次新增仍有 100 次原子写，不更改落盘策略。

npm 官方 registry 基线的运行及全依赖审计均为 0 已知告警；Linux 候选 `npm ci` 也报告 0 已知漏洞。镜像审计 API 返回 404 后换官方接口。最后测试编辑后的 Windows `check-delivery-final.log` 通过，lint 仍有 48 warnings / 503 infos，不抑制规则；无新依赖。依赖扫描不代表应用无漏洞。基线 CodeQL 无开放告警不能代替候选扫描。

### 逆向暴露面：1. 总览

对最终 Windows `win-unpacked` 做只读静态复扫：启发式评分 28，与基线相同，8 类旧信号仍在，没有新增类别；不是安全认证。扫描跳过约 250 MB 主 EXE，另用 Electron 官方 fuse 读取接口检查开关，不能据此声称已穷尽二进制内容。

### 逆向暴露面：2. 发现清单

| 信号 | 人工判定 |
| --- | --- |
| Authenticode / PDB / CFG | 安装包未签名；第三方运行库含调试路径信号，`elevate.exe` 的 CFG 信号仍在。未擅改第三方二进制或伪造签名。 |
| sourceMappingURL / unpacked / 未压缩桥 | ASAR 全目录检查没有 `.map` 文件；引用字符串来自依赖。桥必须供外部 Node 使用，MIT 开源实现可读不是凭证泄露。 |
| 回环地址 / `BSJB` | `127.0.0.1` 是本机 MCP 设计需要，不是泄漏内部生产网关；`d3dcompiler_47.dll` 的字符串命中不足以证明存在本项目的 C# 业务程序集。 |

### 逆向暴露面：3. 证据与处置

`package-structure-final-recheck.log` 确认包版本 0.7.0、桥文件存在、无实际 source map 或 `default_app.asar`；主 EXE 禁用 Node options 和 Node CLI inspect，启用仅从 ASAR 加载，保留桥所需 Run-as-Node。ASAR 不是加密或防篡改保证。原始扫描及基线差异保留在 `v0.7.0-windows/final-exposure-comparison.md`；未通过关闭扫描或删功能消除告警。

### 逆向暴露面：4. 客户端无法解决的问题

随包源码不能保密，也不能把长期服务凭证或最终订阅判定当作可信客户端秘密。本项目没有因此新增云端授权服务；本机随机令牌、会话和第三方客户端配置仍需用户与操作系统共同保护，不承诺对本机同权限攻击者保密。

### 逆向暴露面：5. 修复顺序

先保护用户数据与令牌边界；正式发行前取得同 SHA 的双平台门禁结果；后续有签名身份时配置 Authenticode。保留许可证、必要桥和现有功能，不采用混淆、删除桥、改远程服务等低收益或破坏兼容的手段遮盖扫描信号。

## 5. 真实 UI 与回归记录

- **Windows 真实桌面**：二审增强后的 `desktop-view-ownership-round2.log` 为 48/48。新增断言独立按夹具 URL 对应 WebContents，精确检查原生窗口只附着目标页面且位于外壳下方，并区分鼠标选择聚焦页面与 MCP 选择保留外壳焦点。首轮在后续独立的历史面板尺寸夹具超时；补齐该夹具原生外壳焦点前置条件后通过，未在连续键盘操作路径插入强制聚焦。实际走过设置、导航/恢复、查找、下载面板、许可、语言和主题。诊断连接通过实际回环调用从认证变为已验证；剪贴板成功/失败使用替身，并断言写出的字段和内容。
- **UI 增强复测**：阶段结果曾为 83/83。二审后增加同 URL 新标签与独立 WebContents 配对、Right/Left/Home/End 后精确原生附着检查，以及不中断历史建议键盘序列的原生/DOM 焦点与 ARIA 检查。Windows 首次 `ui-ux-view-ownership-final.log` 为 83/84：这些新增检查通过，但深色按钮样式采样时 hover 已丢失，整套不计通过。独立二审认可将真实 mouseMove 后的 hover 与完整样式合为同一次采样：只接受首份 hovered 样本，对渐变及 4.5:1 断言不重试、不放宽，仍使用原 15 秒时限。最终 Windows `ui-ux-view-ownership-round2.log` 和 Linux `ui-ux-view-ownership-final.log` 均为 **84/84，0 失败**。这只证明 Electron 输入后可进入 hover，不证明首次事件或持续悬停；稍后截图是补充证据。捕获保留附着与非空断言、失败诊断和 bounds 的 finally 恢复；不声称已证明早期 UnknownVizError 的根因。Linux 增强后的桌面门禁同样为 **48/48**。
- **Linux 冷启动**：最终 AppImage 置于测试 HOME 的安装器默认 `Applications/AaBrowser.AppImage`，桥置于安装器相同 XDG 稳定位置，使用真实 MCP 冷启动并核验候选 0.7.0、生产格式标签列表和活动行；`default-appimage-autolaunch-final.log` 通过。隔离的源码冷启动也通过。没有修改日常安装、用户配置或禁用 Chromium sandbox。Windows 源码冷启动在隔离已安装应用的发现目录后同样通过；早先误连已安装 0.6.12 的失败保留，不计通过。
- **宣传网页**：按用户要求从更新范围移除。此前对候选网页的原生测量保留为本地历史证据，但网页更新、对应内容门禁及网页测试新增诊断都已撤回；不把这些历史结果列为最终网页更新的验收。
- **独立二审**：发现新详情漏进 Tab 环。首轮 79/83，明确失败四项；修正 `tabindex`、可见焦点与测试保护后 83/83。复核了中英深浅设置截图及路径折行。数据二审发现右键保存图片仍进入自动清理，补保护及过期/超配额回归。
- **DPI 与模拟边界**：Windows 强制 100/125/150/200% 以及 960px 最小窗口已检查，一台物理显示器。更新 UI 用模拟提供者；打印用替身；真实打印设备、现场升级重启、macOS / ARM、多个物理显示器及所有第三方客户端不标通过。
- **离线回归**：类型/构建、42 工具合约、提示词、DSH、存储、更新、发行、安装完整性、WS 生命周期、取消、权限、审批、配置文件、证据、i18n、冻结防护、帧元素及客户端校验；具体候选日志分批记录。符号链接受 Windows `EPERM` 限制的个案不计通过，junction 已验证。

## 6. 证据、Git 与发布状态

本地证据位于隔离工作树忽略的 `.local-verification/`，不提交用户配置、连接发现、原始截图或包缓存。首轮失败和阶段通过日志均保留，最终日志集中在 `v0.7.0-windows/` 与 `v0.7.0-linux/`。候选根目录已有 `release-notes-v0.7.0.md`。原工作区 `docs/screenshots/page-find-toolbar.png` 的已有修改不纳入提交或清理；既有 detached 工作树不修改或删除。

| 本地候选验收 | 真实结果 / 证据 |
| --- | --- |
| Windows x64 NSIS | `dist-final.log` 构建成功；安装包 121,841,723 B。元数据版本、大小、SHA-512 与 URL 通过，最终 unpacked 包实际 MCP smoke 145 项通过。未在日常 Windows 上安装/卸载。 |
| Linux x86_64 AppImage | `dist-final.log`、`prepare-assets-final.log` 成功；最终 AppImage 实际 MCP smoke 145 项通过；默认安装路径冷启动另测通过。 |
| 平台一致性 | Linux 持久隔离树的 `src/`、`cli/mcp.mjs`、`package.json` 与锁文件均与 Windows 候选一致；本机 Node 环境不同不冒充同环境复现。 |
| 七项候选资产 | `.local-verification/v0.7.0-candidate-assets.0dknfl/release/` 含 EXE、blockmap、AppImage、两平台更新元数据、CycloneDX SBOM 和 SHA256SUMS。清单逐项校验通过，PE/ELF 文件头正确；SBOM 根版本 0.7.0、Electron 45.3.2 / required。 |
| 安装包身份 | `authenticode-final.json` 实测 `NotSigned`；无签名身份，不伪造签名，也不把 GitHub 证明当 Authenticode。 |
| 最终结构化快照兼容 | `structured-snapshot.log` 六组 refs 检查通过，默认结构化返回保持；未以紧凑 MCP 路径替换默认引擎 API。 |
| 远端只读预检 | 正式远端 main 仍为基线 SHA，最新不可变正式发行 v0.6.12，无 v0.7.0 远程标签；预检没有执行发布。 |

**发行门槛尚未满足**：本地候选资产不是同一候选提交 SHA 的远端 CI 资产；候选同 SHA 双平台 CI、CodeQL 和隔离 Windows NSIS 安装 → MCP → 卸载尚未执行。没有推送、远程标签或 GitHub Release。正式发行还需要展示仓库、版本、精确目标 SHA、标题与发行状态后的明确确认；不得用自动推标签绕过此门槛。

## 7. 剩余优先级

1. 取得候选同 SHA 的远端双平台 CI / CodeQL 与 Windows 隔离 NSIS 安装/卸载结果；精确 SHA 和发行状态取得明确确认后再进入不可变正式发行。Linux 默认路径打包冷启动已通过，不再列为未完成。
2. 优先补装桥路径/version 对齐、连接回退/恢复状态和异步重开回归；诊断不自动修复本机 MCP 客户端配置。
3. 改进地址栏拒绝反馈、下载打开/重试反馈。按真实用户路径与二审验收，不隐藏原功能；宣传网页不纳入本轮更新。
4. 评估 CLI 配置写入兼容、视觉解码预算、下载归属、连接间快照增量基线，单独实测历史写盘和可恢复升级。Windows Authenticode 需要签名身份；GitHub 证明不是替代品。
