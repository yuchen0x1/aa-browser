## 📢 版本概述

本版把 Aa Browser 从「能驱动浏览器」推进到「能自检 UI 与长任务」：新增视觉评审闭环、MCP 进度通知与多客户端并发管理、工具定义单一来源，并补齐长页面分页、下载取消/重试、站点权限审批、证据文件生命周期、closed shadow DOM 与原生右键菜单的中文化。MCP 工具集由 34 个扩展到 42 个；同时修复了浅色主题下窗口标题栏仍为深色的问题。仓库中 `v0.3.1`–`v0.6.3` 为历史遗留标签，并非正式发行版，本版是 `v0.3.0` 之后的正式版本。

## ✨ 新增功能

- **视觉评审闭环**：新增 `browser_visual_diff`（基线保存 / 逐像素对比 / 红色差异图，差异超阈值返回 `isError`，可直接作视觉断言）、`browser_contrast_audit`（WCAG AA/AAA 文本对比度审计，输出选择器与比值）、`browser_viewport_matrix`（一次在 320/480/768/桌面与 2x 高 DPI 截图并报告横向溢出；走 CDP 设备指标模拟，不受窗口 960×640 最小尺寸限制）。
- **MCP 进度通知与并发管理**：导航、等待、整页截图、多视口矩阵、视觉对比等长操作按 MCP 规范回传 `notifications/progress`，进度通知不会提前结束工具调用；多客户端并发时右下角 HUD 列出每个调用及其进度，可单独「停止」某个调用而不影响其他客户端。工具栏「中断」仍保留全局暂停语义。
- **工具定义单一来源**：`name / title / description / inputSchema / annotations` 统一维护在 `src/shared/tool-defs.mjs`，主进程只保留 `name + handler`，桥直接导入同一份定义。`npm run check` 断言唯一来源、主进程、桥与 README 四方一致，并阻止任何一方重新手写 schema。
- **长页面快照分页**：`browser_snapshot` 支持 `maxNodes` 与 `cursor`，响应给出 `totalLines / nextCursor`；分页时仍为整棵树分配 ref，跨页 ref 持续有效。
- **下载取消与重试**：`browser_downloads` 新增 `action: cancel / retry`；取消后状态立即变为 `cancelled`，重试生成带 `-r` 的新文件而不覆盖原文件，且重新校验站点白名单。下载面板同步增加「取消 / 重试」按钮。
- **站点权限审批**：摄像头 / 麦克风 / 定位 / 桌面通知不再静默拒绝，而是进入现有审批面板；允许后仅在该浏览器会话内对该站点生效，剪贴板读取等其余敏感权限继续硬拒绝。
- **证据文件生命周期**：新增 `browser_evidence`（`list / sweep / hash / forget`）与 `src/main/evidence.ts`。截图、视口图、HAR、PDF、视觉基线与差异图写入后自动登记 sha256、大小与 TTL；启动时与按需 `sweep()` 按 TTL（临时证据 7/30 天）和 500MB 配额清理，基线与下载等用户数据默认保留。
- **closed shadow DOM 可见性**：document-start 注入补丁记录 `attachShadow({mode:'closed'})` 返回的 root，仅暴露一个 `Symbol.for('aa.closedRoots')` 查询函数、不提供任何 Electron/Node 能力；快照可看到并点击 closed shadow 内的元素。
- **原生右键菜单补全**：菜单文案跟随语言设置（中英双语），新增「复制图片地址 / 图片另存为 / 打印」；图片下载同样经过站点白名单，右键截图保存纳入证据管理。

## 🔧 改进与优化

- **中断真正取消长操作**：工具每一步检查中断信号；导航中断立即 `wc.stop()`，等待轮询每轮检查，拖拽用 `try/finally` 补发 `mouseUp`，截图与 `evaluate` 与取消信号竞速，避免「用户已中断但副作用仍继续执行」。
- **跨域 iframe 可操作**：新增 `browser_frame`（`list / text / elements / evaluate / click / type / select`），在帧自己的上下文里执行，支付、OAuth、第三方编辑器等跨域嵌入不再是快照盲区。
- **整页截图**：`browser_screenshot` 支持 `fullPage: true`，用 CDP 抓完整文档（上限 8000px），长页面评审一次看全。
- **断言与弹窗应答**：新增 `browser_assert`（url/title/text/selector/count/value/checked/attribute/console/network，失败返回 `isError` 并给出期望 vs 实际）与 `browser_dialog_respond`（预设 confirm/prompt 返回值），让网站测试形成可证伪的闭环。
- **发布与验证工程**：新增 `npm run test:evidence` 并并入 `npm run check`；冒烟测试新增快照分页、证据登记/校验、closed shadow、下载取消/重试、MCP 进度通知等断言；桌面回归新增权限审批、多调用 HUD、单调用取消与标题栏主题跟随断言。

## 🐛 问题修复

- **浅色主题标题栏仍为深色**：原生 `titleBarOverlay` 的颜色此前写死为深色，不受 CSS 主题覆盖；本版按主题（含 `system` 跟随系统）设置覆盖层颜色与符号色，切换主题时即时更新。
- **中断后长操作继续跑完**：见上「中断真正取消长操作」，等待与导航类调用现在会在中断后快速失败。
- **跨域 iframe 内容不可见/不可操作**：由 `browser_frame` 修复，冒烟以两个端口的真跨域页面验证。
- **工具定义漂移风险**：此前主进程与桥各维护一份 schema，靠脚本比对；现在从源头消除重复，并保留四方一致性检查作为回归防线。

## 🔒 安全与兼容性

- 权限审批不允许 Agent 自行点击自己的审批面板；下载重试与右键图片另存都会重新经过站点白名单；证据登记只写入本地文件并记录 sha256，不上传任何数据。
- closed shadow 捕获补丁仅驻留页面主世界、只暴露 DOM 查询函数，不引入特权桥；页面视图依旧没有 preload。
- 工具集从 34 增至 42，新增能力均为追加；`browser_snapshot` 的 `maxNodes/cursor`、`browser_downloads` 的 `action/id` 都是可选参数，不传时行为不变。`browser_downloads` 的 annotations 因新增取消/重试改为非只读、破坏性。
- 设置、历史、Cookie、下载记录与标签恢复数据沿用原有存储键，升级后继续生效。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
|---|---|---|
| `aa-browser-setup-0.6.4.exe` | Windows x64 | 安装程序，用于首次安装或覆盖升级 |
| `aa-browser-setup-0.6.4.exe.blockmap` | Windows x64 | electron-updater 增量更新所需分块信息 |
| `latest.yml` | Windows x64 | Windows 自动更新版本与校验元数据 |
| `aa-browser-0.6.4-linux-x86_64.AppImage` | Linux x86_64 | 免安装可执行文件 |
| `latest-linux.yml` | Linux x86_64 | Linux 自动更新版本与校验元数据 |
| `sbom.cdx.json` | 全平台 | CycloneDX 1.5 软件物料清单 |
| `SHA256SUMS.txt` | 全平台 | 本次发布文件的 SHA-256 校验清单 |

- 首次安装：Windows 双击安装程序；Linux 下载 AppImage 后 `chmod +x` 并从桌面会话启动，安装要求见 [平台指南](https://github.com/yuchen0x1/aa-browser/blob/v0.6.4/docs/PLATFORMS.md)。
- 已安装用户：可在「设置 → 软件更新」检查升级；也可直接下载本页安装包覆盖安装。

## 🔄 升级与数据迁移

- **兼容性**：可从 v0.3.0 直接覆盖升级，无需先卸载；工具参数向后兼容。
- **配置和数据**：设置、历史、下载记录、标签恢复数据与 MCP 配置全部保留，无需迁移。新版本会自动创建 `~/.aabrowser/baselines/` 与证据登记表，不影响既有目录。
- **回退方式**：Linux 更新会在替换前保留按版本命名的旧 AppImage；Windows 回退需重新安装旧版安装包。

## 🧪 验证结果

- `npm run check`：类型检查、工具四方一致（42 个）、提示词、DSH 包、页面脚本转义、证据生命周期单测、README 12 语言与发行正文索引全部通过。
- `npm run build`、`npm run test:tools`、`npm run test:bridge`、`npm run test:bridge-autolaunch`：通过；桥产物已重建并内联 42 个工具定义。
- `npm run smoke`：全部通过，含新增的分页 / 证据 / closed shadow / 下载取消重试 / MCP 进度通知断言。
- `npm run test:desktop`：34 项通过，含权限审批、多客户端 HUD、单调用取消、右键菜单中英文与标题栏主题跟随。
- 双平台安装包与公开更新链路以本次标签触发的 CI 结果为准；本地未对 Windows 安装包做真实旧版升级与回退验收。

## ⚠️ 已知问题

- Windows 安装包未配置 Authenticode 代码签名，首次运行可能触发 SmartScreen 提示。
- 仓库中 `v0.3.1`–`v0.6.3` 为历史遗留标签，不代表正式发行；正式序列为 v0.1.0 → v0.2.0 → v0.3.0 → v0.6.4。
- macOS、Android、iOS 与 Web 版不在支持范围内，原因见 [平台指南](https://github.com/yuchen0x1/aa-browser/blob/v0.6.4/docs/PLATFORMS.md)。

---

**项目地址：** https://github.com/yuchen0x1/aa-browser
**问题反馈：** https://github.com/yuchen0x1/aa-browser/issues
**版本下载：** https://github.com/yuchen0x1/aa-browser/releases/tag/v0.6.4
