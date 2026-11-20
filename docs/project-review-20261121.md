# Aa Browser · 本轮项目盘点与开源对照

日期：2026-11-21（UTC+8；GitHub UTC 时间可能为 2026-11-20）。分析基线：`main` 的 `e5554cd` / 正式版 v0.6.8。本文区分源码证据、测试证据和待量化候选；不是全仓安全认证。

## 能力与架构清单

| 层级 | 实际能力 / 代码入口 | 数据与边界 |
| --- | --- | --- |
| 桌面外壳 | `src/renderer/src/chrome.ts`：标签、地址栏、历史建议、查找、下载、设置、审批、更新、Agent 活动与中断；中英双语、明暗主题、键盘导航 | 特权 preload 只供外壳使用，普通页面不挂 preload |
| 主进程 | `src/main/index.ts`、`tabs.ts`：原生窗口、WebContentsView、导航与 IPC 编排 | 页面和特权 UI 分离；IPC 校验外壳身份 |
| 浏览状态 | `settings.ts`、`history.ts`、`session-store.ts`、`atomic-json.ts` | 本地 JSON，无服务端数据库；设置/会话原子写入；历史上限 1000，恢复普通网页标签最多 20 |
| 浏览会话 | `tabs.ts`、`sessions.ts`：普通标签共享登录态；隔离标签独立分区、关闭清理与启动残留清理 | 隔离不是内存专用或绝不落盘的承诺；站点权限需要单独管理 |
| Agent 通道 | `agent-server.ts`、`cli/mcp.mjs`、`src/shared/tool-defs.mjs` | 随机 token、回环 WebSocket、stdio MCP；42 个工具；请求 ID 只在连接内唯一 |
| 页面能力 | `tools.ts`、`actions.ts`、`src/snapshot/engine.js` | 快照、增量/分页 ref、真实输入、iframe、closed shadow、断言、网络/控制台/性能、截图/HAR/PDF |
| 人工监督 | `approvals.ts`、`sensitive.ts`、活动 HUD | 敏感输入、操作与权限审批、全局中断和单调用停止；停止不能撤销已完成的副作用 |
| 证据治理 | `evidence.ts`、`visual.ts` | 文件 hash、大小、TTL、配额、基线与视觉对比；用户指定路径的生命周期仍需更精细的归属校验 |
| 安装接入 | `install.mjs`、`src/main/clients.ts`、`packages/dsh/`、`installer/` | 配置备份、稳定桥路径、下载校验、连接验证与自动启动；不应将真实客户端配置用于测试 |
| 官网 | `site/` | 独立静态站点，不是 Web 浏览器产品版 |

技术栈为 Electron 45、TypeScript、electron-vite；运行依赖为 `ws` 和 `electron-updater`。`npm ci` 安装锁定依赖，`npm run dev` 开发，`npm run build` 生成应用和桥，`npm run dist` / `dist:linux` 生成 Windows x64 NSIS / Linux x64 AppImage。不存在需要本轮迁移的远程数据库或业务服务。

## 已确认问题与路线

| 优先级 | 证据 / 问题 | 本轮处理或后续验收 |
| --- | --- | --- |
| P1 | HUD 用全局请求 ID 取消，而 ID 实际只在单连接内唯一 | 本轮改为 `(client,id)`；真实双 WS 同 ID、原生 HUD 点击、过期目标与歧义拒绝回归 |
| P1 | 等价输入/求值工具的人工审批路径不一致 | 本轮核实并统一敏感输入与求值审批；保留明确授权后的求值能力，补否定路径测试 |
| P1 | 待决站点权限按全局 origin 去重，未包含隔离会话/媒体子能力 | 本轮修正会话与能力作用域，并验证导航/销毁后的审批失效 |
| P2 | 地址栏聚焦编辑缩略文本，丢协议和 fragment；切换标签可能保留其他标签草稿 | 本轮分离编辑/显示值，补真实 Electron 红→绿回归；用户信息不进入编辑值 |
| P1 | 证据清理未确认路径上的文件仍是原登记产物；失败删除后配额计算不准确 | 本轮增加文件身份/hash 核验、保守遗忘旧临时登记和失败删除回归；显式输出与应用管理目录拆分仍待后续，未修改的输出仍沿用原 TTL |
| P1 | 桥连接建立未单飞，旧 socket 关闭可能影响新 socket 的 pending 请求 | 下一轮通过确定性连接竞态测试确认影响面，再做连接归属与单飞修复 |
| P2 | 客户端 JSONC 注释剥离与重复 Codex 接入存在幂等性/原子性欠缺 | 用临时配置覆盖 URL 字符串、注释、重复 env 段与失败写盘，禁止碰日常配置 |
| P2 | 分页快照每页仍传整页元素元数据 | 固定大页面度量序列化字节和耗时，保留动作查找与跨页 ref；未量化前不宣称收益 |
| P2 | 自动化策略覆盖仍不等于不可信 Agent 沙箱 | 明确能力边界、逐项增加审批与取消否定测试，勿把站点导航规则称为网络防火墙 |
| P3 | 导航历史同步 fsync、进度推送重建无关 UI | 量化写盘次数、主线程/输入延迟后决定批写与局部渲染，不为架构名词重写 |
| P3 | SBOM Electron 条目应从精确 lock 解析，自动启动未完整接入 CI | 增加锁版本漂移测试、打包后冷启动回归；现有打包连接测试不能冒充冷启动 |

其余静态候选（下载重试归属、视觉解码资源上限、恢复索引过滤映射）须逐项增加确定性测试后排期。本轮不把未测试候选写成已利用漏洞，也不将有价值问题从后续清单移除。

## 七个开源项目的真实对照

研究使用官方仓库、许可证、文档和源码；未运行竞品做性能基准，未复制代码/品牌/素材，未引入竞品依赖。

| 项目 / 许可证 | 实际研究内容 | 与 Aa 的差异与可吸收方向 |
| --- | --- | --- |
| [Min](https://github.com/minbrowser/min) · [Apache-2.0](https://github.com/minbrowser/min/blob/master/LICENSE.txt) | WebContentsView 浏览器、任务/历史、地址编辑器、跨标签切换 | 最贴近桌面外壳；吸收显示值和编辑值分离、切换标签重置编辑状态；不移植其页面 preload 安全配置 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) · [Apache-2.0](https://github.com/microsoft/playwright-mcp/blob/main/LICENSE) | 快照驱动、持久/隔离/已有浏览器会话、输出限制、明确非安全边界 | Aa 已有登录态和人工监督；借鉴会话身份、限额和错误契约，不重复新增已有工具 |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) · [Apache-2.0](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/LICENSE) | Puppeteer/DevTools 诊断、trace、网络/控制台；统计与 CrUX 外发披露 | 将轻量摘要和重型诊断分开；明确本地存储、向模型传输、外部网络请求三种数据流。不能假定其 Chrome 支持等于 Electron 支持 |
| [Playwright](https://github.com/microsoft/playwright) · [Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE) | actionability、隔离 fixture、条件等待、trace；Electron API 标为实验性 | 吸收按状态等待而非任意延时、红→绿回归；浏览器页面测试不能替代原生外壳/安装验收 |
| [Electron](https://github.com/electron/electron) · [MIT](https://github.com/electron/electron/blob/main/LICENSE) | WebContentsView、session、权限与官方安全清单 | 以运行时 API 为权威核对权限子类型、IPC/sandbox；独立分区不等于内存专用 |
| [Zen Browser](https://github.com/zen-browser/desktop) · [MPL-2.0](https://github.com/zen-browser/desktop/blob/dev/LICENSE) | Firefox 工作区与相关测试、跨平台发行 | 未来参考可见任务/工作区身份；分组并非 Cookie 隔离，无须迁移引擎 |
| [Agregore](https://github.com/AgregoreWeb/agregore-browser) · [AGPL-3.0](https://github.com/AgregoreWeb/agregore-browser/blob/master/LICENSE) | 本地优先、快捷键、恢复、归档、协议和扩展边界 | 学习命令发现与经用户确认的导出；额外协议/扩展执行会增加权限面，本轮不集成 |

直接参考的 Min 源码（修订 `ef39979f39a6cc6b578736d951eac7f5aa31db93`）：[紧凑显示](https://github.com/minbrowser/min/blob/ef39979f39a6cc6b578736d951eac7f5aa31db93/js/navbar/tabBar.js#L164-L169)、[从存储 URL 编辑](https://github.com/minbrowser/min/blob/ef39979f39a6cc6b578736d951eac7f5aa31db93/js/navbar/tabEditor.js#L30-L38)、[切换标签关闭编辑器](https://github.com/minbrowser/min/blob/ef39979f39a6cc6b578736d951eac7f5aa31db93/js/browserUI.js#L215-L224)。Aa 独立实现相同的状态所有权原则，并非复制这些函数。

Wexond 的公开源码不代表可复用开源许可，其 README 限制代码/素材使用且仓库已归档，因此未计入七项。若未来复制代码须重新检查许可证/NOTICE；MPL 文件级义务与 AGPL 义务不能视同 MIT。没有任何受控性能数据支持“优于竞品”的结论。

## 工程、兼容与安全边界

- 主线与标签 CI 均跑 Windows/Linux；标签流水线检查版本与 main 祖先，使用双平台验收产物，生成 SBOM / SHA256SUMS，上传并验证不可变正式 Release。CodeQL 独立运行，本轮也须观察其结果。
- 已有测试涵盖真实 Electron、MCP/WS、持久化、安装器、更新模拟、站点/主题/键盘/DPI、发行资产；`test:security` 主要是安装器完整性验证，不能代表后端授权全覆盖。本轮增加针对性否定路径测试，而不是依赖测试脚本数量。
- Windows 代码签名取决于发布密钥，当前正式版说明为未签名；本轮不得声称签名已完成。macOS/ARM/移动端、真实打印机和多物理显示器未作为本轮受支持验收范围。
- 开源客户端与 ASAR 不是秘密容器。无订阅/计费最终授权逻辑，本轮不做混淆、防调试或破坏桥 Run-as-Node 的 fuse 变更来制造安全感。长期密钥不应下发；不能用客户端混淆解决凭证保密。
- 认证 Agent 本来可以显式执行页面表达式并读取授权页面数据。局部审批防护不等于抵御恶意 Agent 的沙箱；页面内容仍是不可信输入，外发/破坏性动作仍须用户授权。
- 已有未提交截图留在原工作树；开发/测试使用独立 worktree、profile 和回环 fixture，不混入用户数据，不扩大工具权限。
